import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ExecutionState, RunPlanSchema } from '@devlaunch/shared';
import { runSmokeTest } from '../services/verification/SmokeTest.js';
import { SessionManager } from '../services/session/SessionManager.js';
import type { ExecutionManager, ReadyOutcome } from '../services/execution/ExecutionManager.js';
import { LogManager } from '../services/logs/LogManager.js';

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
});
/** A local server answering every request with `status`; its base URL. */
async function serving(status: number): Promise<string> {
  const s = createServer((_q, r) => { r.statusCode = status; r.end(status >= 500 ? 'Internal Server Error' : 'ok'); });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  servers.push(s);
  return `http://localhost:${(s.address() as AddressInfo).port}`;
}
/** A port nothing listens on. */
async function deadUrl(): Promise<string> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as AddressInfo).port;
  await new Promise((r) => s.close(r));
  return `http://localhost:${port}`;
}

describe('the end-to-end smoke test', () => {
  it('passes when every service answers without a server error', async () => {
    const v = await runSmokeTest({ services: [{ name: 'app', url: `${await serving(404)}/`, runtime: 'node', environment: [] }], backing: [] });
    expect(v.passed).toBe(true);
    expect(v.checks[0]).toMatchObject({ kind: 'http', passed: true });
  });

  it('fails on a server error, and on no answer at all, naming each', async () => {
    const v = await runSmokeTest({
      services: [
        { name: 'web', url: `${await serving(500)}/`, runtime: 'node', environment: [] },
        { name: 'api', url: `${await deadUrl()}/`, runtime: 'node', environment: [] },
      ],
      backing: [],
    });
    expect(v.passed).toBe(false);
    expect(v.checks.map((c) => [c.name, c.passed])).toEqual([['web answers', false], ['api answers', false]]);
    expect(v.checks[0]!.detail).toMatch(/answered 500/);
    expect(v.checks[1]!.detail).toMatch(/no answer/);
  });

  it('waits for a dev server that is busy building, and still fails fast when nothing listens (RishiBakshii/mern-ecommerce)', async () => {
    // React's dev server holds every request until its first build is done. That build
    // outlasted the 5 s the check gave it, and a working page was reported broken.
    const buildDoneAt = Date.now() + 8_000;
    const s = createServer((_q, r) => {
      setTimeout(() => r.end('<html>shop</html>'), Math.max(0, buildDoneAt - Date.now()));
    });
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const busy = `http://localhost:${(s.address() as AddressInfo).port}/`;
    const v = await runSmokeTest({ services: [{ name: 'frontend', url: busy, runtime: 'node', environment: [] }], backing: [] });
    expect(v.checks[0], v.checks[0]?.detail).toMatchObject({ name: 'frontend answers', passed: true });

    const started = Date.now();
    const dead = await runSmokeTest({ services: [{ name: 'api', url: `${await deadUrl()}/`, runtime: 'node', environment: [] }], backing: [] });
    expect(dead.passed).toBe(false);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 60_000);

  it('asks an API at the path readiness used, there and through the address its page was given (fastapi/full-stack-fastapi-template)', async () => {
    // The template's backend serves a built frontend at `/`, which development does not
    // have: `/` answers 500 while `/docs` and every API route answer.
    const s = createServer((q, r) => {
      r.statusCode = q.url === '/docs' ? 200 : 500;
      r.end(q.url === '/docs' ? 'docs' : 'Internal Server Error');
    });
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const api = `http://localhost:${(s.address() as AddressInfo).port}`;
    const v = await runSmokeTest({
      services: [
        { name: 'backend', role: 'api', url: `${api}/`, healthPath: '/docs', runtime: 'python', environment: [] },
        { name: 'frontend', role: 'web', runtime: 'node', environment: [{ key: 'VITE_API_URL', value: api }] },
      ],
      backing: [],
    });
    expect(v.checks.map((c) => [c.name, c.target, c.passed])).toEqual([
      ['backend answers', `${api}/docs`, true],
      ['frontend → backend (VITE_API_URL)', `${api}/docs`, true],
    ]);
    // Without one, the root is asked, as before.
    const root = await runSmokeTest({ services: [{ name: 'backend', url: `${api}/`, runtime: 'python', environment: [] }], backing: [] });
    expect(root.passed).toBe(false);
  });

  it('checks the API address a frontend was given, from this machine and from inside it', async () => {
    const api = await serving(200);
    const inside: string[][] = [];
    const v = await runSmokeTest({
      services: [
        {
          name: 'web', role: 'web', url: `${await serving(200)}/`, runtime: 'node',
          environment: [{ key: 'VITE_API_URL', value: api }, { key: 'API_PROXY', value: 'http://api:8000' }, { key: 'OTHER', value: 'x' }],
          exec: async (argv) => { inside.push(argv); return 'OK\n'; },
        },
        { name: 'api', role: 'api', url: `${api}/`, runtime: 'python', environment: [] },
      ],
      backing: [],
    });
    expect(v.passed).toBe(true);
    const wiring = v.checks.filter((c) => c.kind === 'wiring');
    expect(wiring.map((c) => c.name)).toEqual(['web → api (VITE_API_URL)', 'web → api (API_PROXY)']);
    expect(inside[0]![0]).toBe('node');
    expect(inside[0]!.join(' ')).toMatch(/connect\(8000,"api"\)/);
  });

  it('checks every service can reach every database, from inside its container', async () => {
    const v = await runSmokeTest({
      services: [
        { name: 'api', url: `${await serving(200)}/`, runtime: 'python', environment: [], exec: async () => 'ERR ConnectionRefusedError [Errno 111]' },
        { name: 'worker', runtime: 'node', environment: [] },
      ],
      backing: [{ kind: 'postgres', alias: 'postgres' }],
    });
    const deps = v.checks.filter((c) => c.kind === 'dependency');
    expect(deps.map((c) => [c.name, c.passed, c.skipped ?? false])).toEqual([
      ['api → postgres', false, false],
      ['worker → postgres', false, true],
    ]);
    expect(deps[0]!.detail).toMatch(/could not reach postgres:5432: ERR ConnectionRefusedError/);
    expect(v.passed).toBe(false);
  });

  it('does not pass when there was nothing to check', async () => {
    // Audit A-23: `every` over no checks is true, so a project whose web service had no
    // address, beside workers, was verified by construction.
    const v = await runSmokeTest({ services: [{ name: 'web', role: 'web', environment: [] } as never], backing: [] });
    expect(v.passed).toBe(false);
    expect(v.checks.at(-1)?.detail).toMatch(/nothing about the application was checked/);
  });

  it('refuses to run a check against a host name that is not one', async () => {
    const v = await runSmokeTest({
      services: [{ name: 'api', runtime: 'node', environment: [], exec: async () => 'OK' }],
      backing: [{ kind: 'postgres', alias: 'x;rm -rf /' }],
    });
    expect(v.checks[0]!.passed).toBe(false);
  });
});

describe('a deployment that answered', () => {
  async function run(url: string) {
    const ready: ReadyOutcome = { state: ExecutionState.READY, hostPort: '1', url, readiness: { ready: true, attempts: 1, elapsedMs: 1 } as ReadyOutcome['readiness'] };
    const exec = {
      async launch(o: { logs?: LogManager }) {
        return { container: { id: 'c' }, logs: o.logs ?? new LogManager(), waitForReady: async () => ready, clearStartupBudget: () => undefined, cleanup: async () => ({ errors: [] }) };
      },
    } as unknown as ExecutionManager;
    const m = new SessionManager(exec, {
      smokeTest: true,
      analyzer: { analyze: async () => ({ warnings: [], envExample: [], lockfiles: [], frameworkConfigs: [] }) } as never,
      planner: { planRepository: async () => ({ plan: RunPlanSchema.parse({ runtime: { language: 'node', version: '20' }, packageManager: 'npm', installCommand: null, buildCommand: null, startCommand: 'node s.js', workingDirectory: '.', expectedPort: 3000, planSource: 'rule-based' }), detected: 'node', warnings: [] }) } as never,
    });
    const s = await m.launch({ sourceDir: '/tmp/repo', image: 'devlaunch/node:20' });
    for (let i = 0; i < 400 && ![ExecutionState.READY, ExecutionState.PARTIALLY_READY, ExecutionState.FAILED].includes(s.state as never); i++) await new Promise((r) => setTimeout(r, 10));
    const snapshot = { state: s.state, failure: s.failure, verification: s.verification };
    await m.shutdown();
    return snapshot;
  }

  it('is READY only after its smoke test passed', async () => {
    const r = await run(`${await serving(200)}/`);
    expect(r.state).toBe(ExecutionState.READY);
    expect(r.verification?.passed).toBe(true);
  });

  it('is not READY when the smoke test fails, and says which check failed', async () => {
    const r = await run(`${await serving(500)}/`);
    expect(r.state).toBe(ExecutionState.PARTIALLY_READY);
    expect(r.failure).toMatchObject({ code: 'APPLICATION_UNHEALTHY' });
    expect(r.failure?.message).toMatch(/end-to-end check failed: app answers/);
    expect(r.failure?.evidence).toMatch(/answered 500/);
  });
});
