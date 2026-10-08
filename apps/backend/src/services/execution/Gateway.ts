import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { readCapped } from '../analysis/readCapped.js';

/**
 * One address for a frontend and the API behind it, as the project's own reverse proxy
 * would give.
 *
 * Many projects are written to sit behind nginx: the page calls `/api/...` on its own
 * address and nginx sends that path to the backend. DevLaunch runs the frontend and the
 * backend as separate services, without the nginx, so those calls reached the frontend's
 * dev server and came back 404 — the page opened, and nothing it did worked
 * (`jamall-mahmoudi-dev/django-react-production-stack`: `POST /api/create_post/` → "Cannot
 * POST"). This does the nginx's job: requests on the routed paths go to the API, the rest
 * to the frontend, websocket upgrades included. The repository is not changed.
 *
 * It runs in DevLaunch's own process, listens on this machine only, and forwards only to
 * the services' own published addresses — what a person could already open directly.
 */

export interface GatewayRoute {
  /** A path prefix (`/api`), or a pattern read from an nginx `location ~` block. */
  match: string | RegExp;
  /** The service the matching requests go to. */
  to: string;
}

/** Where a request goes: the first route that matches its path, or the fallback. */
export function routeFor(path: string, routes: readonly GatewayRoute[], fallback: string): string {
  const p = path.split('?')[0] ?? '/';
  for (const r of routes) {
    if (typeof r.match === 'string') {
      const prefix = r.match.replace(/\/+$/, '');
      if (p === prefix || p.startsWith(`${prefix}/`)) return r.to;
    } else if (r.match.test(p)) {
      return r.to;
    }
  }
  return fallback;
}

/** A `location` that proxies somewhere, as read from an nginx configuration. */
export interface NginxRoute {
  match: string | RegExp;
  host: string;
  port?: number;
}

/**
 * The proxying `location` blocks of an nginx configuration: `location /api/ { proxy_pass
 * http://django:8000; }`, `location ~ ^/(admin|api|ws) { ... }`. Exact (`=`) and
 * case-insensitive (`~*`) matches are read as their nearest equivalent; a pattern that is
 * not a valid JavaScript expression is skipped rather than guessed at.
 */
export function parseNginxRoutes(conf: string): NginxRoute[] {
  const text = conf.replace(/#[^\n]*/g, '');
  const out: NginxRoute[] = [];
  const head = /location\s+(=|~\*|~|\^~)?\s*([^\s{]+)\s*\{/g;
  for (let m = head.exec(text); m; m = head.exec(text)) {
    // The block's body, to its matching brace.
    let depth = 1;
    let i = head.lastIndex;
    for (; i < text.length && depth > 0; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') depth--;
    }
    const body = text.slice(head.lastIndex, i - 1);
    const pass = /proxy_pass\s+https?:\/\/([A-Za-z0-9_.-]+)(?::(\d+))?/.exec(body);
    if (!pass) continue;
    const [, modifier, pattern] = m;
    let match: string | RegExp;
    if (modifier === '~' || modifier === '~*') {
      try {
        match = new RegExp(pattern!, modifier === '~*' ? 'i' : '');
      } catch {
        continue;
      }
    } else {
      match = pattern!;
    }
    out.push({ match, host: pass[1]!, ...(pass[2] ? { port: Number(pass[2]) } : {}) });
  }
  return out;
}

/** nginx configurations a repository ships: in the usual places, a few levels deep at most. */
export async function findNginxConfigs(root: string): Promise<string[]> {
  const found: string[] = [];
  const isConf = (name: string) => /^(?:nginx|default|app|site)\.conf$/i.test(name) || /\.conf$/i.test(name);
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 3 || found.length >= 10) return;
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        // Only folders an nginx config conventionally lives in, and the root.
        if (/^(?:nginx|conf|conf\.d|docker|deploy|proxy|config|sites-(?:available|enabled))$/i.test(e.name)) {
          await walk(join(dir, e.name), depth + 1);
        }
      } else if (isConf(e.name) && (depth > 0 || /nginx/i.test(e.name))) {
        found.push(join(dir, e.name));
      }
    }
  };
  await walk(root, 0);
  return found;
}

/** The services a gateway can choose between, with what nginx may call them by. */
export interface GatewayService {
  name: string;
  role?: string;
  /** The port the service listens on in its container. */
  port?: number | null;
  /** Its folder in the repository, which a compose service is usually named after. */
  dir?: string;
}

/**
 * The routes for a project: from its nginx configuration when it has one, each target
 * matched to a service by port or by name; else, when the frontend calls `/api` on its own
 * address, the one conventional route. Null when nothing needs routing — a frontend that
 * calls its API by full address, or a project with no API.
 */
export function planGateway(input: {
  services: readonly GatewayService[];
  nginx: readonly NginxRoute[];
  /** Whether the frontend's source calls a relative `/api` path. */
  callsRelativeApi: boolean;
}): { web: string; routes: GatewayRoute[] } | null {
  const web = input.services.find((s) => s.role === 'web');
  const apis = input.services.filter((s) => s.role === 'api');
  if (!web || apis.length === 0) return null;

  const routes: GatewayRoute[] = [];
  for (const r of input.nginx) {
    const target =
      input.services.find((s) => r.port !== undefined && s.port === r.port) ??
      input.services.find((s) => [s.name, s.dir ? basename(s.dir) : ''].some((n) => n && n.toLowerCase() === r.host.toLowerCase()));
    if (target && target.role === 'api') routes.push({ match: r.match, to: target.name });
  }
  if (routes.length === 0 && input.callsRelativeApi && apis.length === 1) {
    routes.push({ match: '/api', to: apis[0]!.name });
  }
  return routes.length > 0 ? { web: web.name, routes } : null;
}

/** Read a project's nginx routes, from every configuration it ships. */
export async function readNginxRoutes(root: string): Promise<NginxRoute[]> {
  const out: NginxRoute[] = [];
  for (const file of await findNginxConfigs(root)) {
    const text = await readCapped(file);
    if (text) out.push(...parseNginxRoutes(text));
  }
  return out;
}

export interface Gateway {
  url: string;
  routes: GatewayRoute[];
  close(): Promise<void>;
}

/**
 * Start a gateway on this machine. `targets` are the services' published addresses
 * (`http://localhost:PORT/`), by service name; `fallback` is where unrouted requests go.
 */
export async function startGateway(opts: {
  routes: GatewayRoute[];
  fallback: string;
  targets: Record<string, string>;
  port?: number;
}): Promise<Gateway> {
  const target = (path: string): URL | undefined => {
    const name = routeFor(path, opts.routes, opts.fallback);
    const url = opts.targets[name];
    return url ? new URL(url) : undefined;
  };

  // Addressed to the service as it would be opened directly, so a dev server's host check
  // and a backend's allowed hosts see what they already accept; the original is kept in
  // X-Forwarded-Host, as nginx would.
  const headersFor = (req: IncomingMessage, to: URL) => ({
    ...req.headers,
    host: to.host,
    'x-forwarded-host': req.headers.host ?? '',
    'x-forwarded-proto': 'http',
  });

  const server: Server = createServer((req, res) => {
    const to = target(req.url ?? '/');
    if (!to) {
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('DevLaunch gateway: no service for this path.');
      return;
    }
    const upstream = httpRequest(
      { host: to.hostname, port: to.port, method: req.method, path: req.url, headers: headersFor(req, to) },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('error', (err) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`DevLaunch gateway: ${to.host} did not answer (${err.message}).`);
    });
    req.pipe(upstream);
  });

  // Upgraded connections leave the HTTP server's bookkeeping, so they are tracked here and
  // ended when the gateway closes; otherwise a stopped run kept a live-reload socket open.
  const upgraded = new Set<Socket>();

  // Websockets: a dev server's live reload, or the app's own. Passed through as bytes.
  server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    upgraded.add(socket);
    socket.on('close', () => upgraded.delete(socket));
    const to = target(req.url ?? '/');
    if (!to) {
      socket.destroy();
      return;
    }
    const up = connect(Number(to.port || 80), to.hostname, () => {
      upgraded.add(up);
      up.on('close', () => upgraded.delete(up));
      const headers = headersFor(req, to);
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (const [k, v] of Object.entries(headers)) {
        for (const value of Array.isArray(v) ? v : [v]) if (value !== undefined) lines.push(`${k}: ${value}`);
      }
      up.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://localhost:${port}/`,
    routes: opts.routes,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of upgraded) s.destroy();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
