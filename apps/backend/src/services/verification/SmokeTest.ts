import { ReadinessChecker } from '../readiness/ReadinessChecker.js';

/**
 * Whether a deployment that answered actually works, end to end.
 *
 * READY used to mean "an HTTP server returned a response". A frontend whose API address
 * pointed nowhere, or an API that could not reach the database provisioned for it, was
 * shown green with a URL. This runs after readiness and before READY is declared:
 *
 *  - every service's URL answers, and not with a server error;
 *  - every address a frontend was given for an API answers — from this machine for one the
 *    browser reads (`http://localhost:PORT`), from inside the frontend's own container for
 *    one its dev server reads (`http://api:8000`);
 *  - every application container can open a connection to every database provisioned for
 *    the deployment, from inside itself.
 *
 * Connectivity, not credentials: DevLaunch provisions the databases and injects the
 * addresses, so reaching them is what it can verify without the application's own
 * secrets. A failed check is named, with what was tried and what came back.
 */
export interface SmokeCheck {
  name: string;
  kind: 'http' | 'wiring' | 'dependency';
  service?: string;
  target: string;
  passed: boolean;
  /**
   * Not run: nothing could run it here (no exec into the container). Reported as such —
   * neither a pass nor a failure.
   */
  skipped?: boolean;
  detail: string;
}

export interface Verification {
  passed: boolean;
  checks: SmokeCheck[];
  startedAt: number;
  durationMs: number;
}

export interface SmokeService {
  name: string;
  role?: string;
  url?: string;
  runtime: 'node' | 'python';
  environment: { key: string; value: string | null }[];
  /** Runs a command inside this service's container and returns what it printed. */
  exec?: (argv: string[]) => Promise<string>;
}

export interface SmokeBacking {
  kind: string;
  alias: string;
}

/** The port each provisioned database listens on, on the container network. */
export const BACKING_PORTS: Record<string, number> = { postgres: 5432, mysql: 3306, mongodb: 27017, redis: 6379 };

/** One request, short; a server error or no answer at all is a failure. */
async function answers(url: string): Promise<{ ok: boolean; detail: string }> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, detail: `not a URL: ${url}` };
  }
  if (u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') return { ok: false, detail: `${url} is not on this machine` };
  const r = await new ReadinessChecker().waitForReady({
    port: u.port || (u.protocol === 'https:' ? 443 : 80),
    protocol: u.protocol === 'https:' ? 'https' : 'http',
    healthCheck: { path: `${u.pathname}${u.search}` || '/', method: 'GET', expectedStatusCodes: [] },
    timeoutMs: 5000,
  });
  if (!r.ready) return { ok: false, detail: `no answer from ${url} (${r.lastError ?? 'nothing listening'})` };
  if ((r.status ?? 0) >= 500) return { ok: false, detail: `${url} answered ${r.status}${r.body ? `: ${r.body}` : ''}` };
  return { ok: true, detail: `${url} answered ${r.status}` };
}

/** A TCP connection to host:port, made from inside a container by its own runtime. */
function connectCommand(runtime: 'node' | 'python', host: string, port: number): string[] {
  if (!/^[a-z0-9][a-z0-9.-]{0,62}$/i.test(host) || !Number.isInteger(port)) throw new Error('bad target');
  return runtime === 'python'
    ? ['python', '-c', `import socket\ntry:\n  socket.create_connection((${JSON.stringify(host)}, ${port}), 3).close(); print("OK")\nexcept Exception as e:\n  print("ERR", type(e).__name__, e)`]
    : [
        'node',
        '-e',
        `const s=require('net').connect(${port},${JSON.stringify(host)});s.setTimeout(3000);` +
          `s.on('connect',()=>{console.log('OK');s.destroy()});` +
          `s.on('error',e=>console.log('ERR',e.code||e.message));s.on('timeout',()=>{console.log('ERR timeout');s.destroy()})`,
      ];
}

async function reachesFromInside(service: SmokeService, host: string, port: number): Promise<{ ok: boolean; skipped?: boolean; detail: string }> {
  if (!service.exec) return { ok: false, skipped: true, detail: 'no way to run a command inside this container' };
  try {
    const out = (await service.exec(connectCommand(service.runtime, host, port))).trim();
    return out.startsWith('OK')
      ? { ok: true, detail: `${service.name} reached ${host}:${port}` }
      : { ok: false, detail: `${service.name} could not reach ${host}:${port}: ${out.slice(0, 160) || 'no output'}` };
  } catch (err) {
    return { ok: false, detail: `${service.name} could not run a connection check: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** The origin of every other service's URL, so a frontend's API address can be recognised. */
function apiTargets(services: SmokeService[], self: SmokeService) {
  const out: { name: string; origin: string; internal: RegExp }[] = [];
  for (const other of services) {
    if (other === self || !other.url) continue;
    const u = new URL(other.url);
    out.push({ name: other.name, origin: u.origin, internal: new RegExp(`^https?://${other.name}(?:-[a-z0-9-]+)?:(\\d+)`, 'i') });
  }
  return out;
}

export async function runSmokeTest(input: { services: SmokeService[]; backing: SmokeBacking[] }): Promise<Verification> {
  const startedAt = Date.now();
  const checks: SmokeCheck[] = [];

  for (const s of input.services) {
    if (!s.url) continue;
    const r = await answers(s.url);
    checks.push({ name: `${s.name} answers`, kind: 'http', service: s.name, target: s.url, passed: r.ok, detail: r.detail });
  }

  // What the frontend was told about its API, checked the way it will be used.
  for (const s of input.services.filter((x) => x.role === 'web')) {
    for (const t of apiTargets(input.services, s)) {
      for (const v of s.environment) {
        if (!v.value) continue;
        if (v.value.startsWith(t.origin)) {
          const r = await answers(v.value);
          checks.push({ name: `${s.name} → ${t.name} (${v.key})`, kind: 'wiring', service: s.name, target: v.value, passed: r.ok, detail: r.detail });
          continue;
        }
        const m = t.internal.exec(v.value);
        if (m) {
          const host = new URL(v.value).hostname;
          const r = await reachesFromInside(s, host, Number(m[1]));
          checks.push({ name: `${s.name} → ${t.name} (${v.key})`, kind: 'wiring', service: s.name, target: v.value, passed: r.ok, ...(r.skipped ? { skipped: true } : {}), detail: r.detail });
        }
      }
    }
  }

  // Every application container can reach every database provisioned for it.
  for (const b of input.backing) {
    const port = BACKING_PORTS[b.kind];
    if (!port) continue;
    for (const s of input.services) {
      const r = await reachesFromInside(s, b.alias, port);
      checks.push({ name: `${s.name} → ${b.kind}`, kind: 'dependency', service: s.name, target: `${b.alias}:${port}`, passed: r.ok, ...(r.skipped ? { skipped: true } : {}), detail: r.detail });
    }
  }

  return {
    passed: checks.every((c) => c.passed || c.skipped),
    checks,
    startedAt,
    durationMs: Date.now() - startedAt,
  };
}
