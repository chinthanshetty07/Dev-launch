import { describe, it, expect, afterEach } from 'vitest';
import { createServer, request, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseNginxRoutes, planGateway, readNginxRoutes, routeFor, startGateway, type Gateway } from '../services/execution/Gateway.js';
import { callsRelativeApi } from '../services/analysis/ServiceDiscovery.js';
import { samplePath } from '../services/verification/SmokeTest.js';

/**
 * One address for a frontend and the API paths behind it — the project's own nginx, done by
 * DevLaunch. From `jamall-mahmoudi-dev/django-react-production-stack`: its page calls
 * `/api/create_post/` on its own address, and without the nginx that reached the React dev
 * server and came back "Cannot POST".
 */

// That repository's nginx.conf, as it ships.
const CONF = `server {
  listen 80;
  location /api_static/ { alias /srv/app/static; }
  location /api_media/ { alias /srv/app/media; }
  # Redirect Django admin or api or websockets
  location ~ ^/(admin|api|ws) {
    proxy_pass http://django:8000;
    proxy_redirect default;
    include /etc/nginx/app/include.websocket;
  }
  location / {
    proxy_pass http://react:3000;
  }
}`;

const services = [
  { name: 'frontend', role: 'web', port: 3000, dir: 'frontend' },
  { name: 'backend', role: 'api', port: 8000, dir: 'backend' },
];

describe('reading the project\'s own routing', () => {
  it('reads the proxying locations of an nginx configuration, and only those', () => {
    const routes = parseNginxRoutes(CONF);
    expect(routes.map((r) => [String(r.match), r.host, r.port])).toEqual([
      ['/^\\/(admin|api|ws)/', 'django', 8000],
      ['/', 'react', 3000],
    ]);
  });

  it('sends the API paths to the service on that port, and leaves the rest to the frontend', () => {
    const plan = planGateway({ services, nginx: parseNginxRoutes(CONF), callsRelativeApi: false });
    expect(plan?.web).toBe('frontend');
    expect(plan?.routes.map((r) => r.to)).toEqual(['backend']);
    expect(routeFor('/api/create_post/', plan!.routes, plan!.web)).toBe('backend');
    expect(routeFor('/admin/login/?next=/', plan!.routes, plan!.web)).toBe('backend');
    expect(routeFor('/static/js/bundle.js', plan!.routes, plan!.web)).toBe('frontend');
    expect(routeFor('/', plan!.routes, plan!.web)).toBe('frontend');
  });

  it('matches by name when the port says nothing, and uses /api when the page calls it with no nginx', () => {
    const byName = planGateway({ services, nginx: [{ match: '/api', host: 'backend' }], callsRelativeApi: false });
    expect(byName?.routes).toEqual([{ match: '/api', to: 'backend' }]);
    const conventional = planGateway({ services, nginx: [], callsRelativeApi: true });
    expect(conventional?.routes).toEqual([{ match: '/api', to: 'backend' }]);
    expect(routeFor('/apiary', conventional!.routes, 'frontend')).toBe('frontend');
  });

  it('routes nothing when nothing needs it', () => {
    expect(planGateway({ services, nginx: [], callsRelativeApi: false })).toBeNull();
    expect(planGateway({ services: [services[0]!], nginx: parseNginxRoutes(CONF), callsRelativeApi: true })).toBeNull();
  });

  it('finds the configuration where projects keep it, and a page that calls /api on its own address', async () => {
    const root = mkdtempSync(join(tmpdir(), 'devlaunch-gw-'));
    const write = (p: string, body: string) => {
      mkdirSync(dirname(join(root, p)), { recursive: true });
      writeFileSync(join(root, p), body);
    };
    write('nginx/nginx.conf', CONF);
    write('frontend/src/api/client.js', 'const API_BASE_URL = "/api";\nexport default axios.create({ baseURL: API_BASE_URL });\n');
    write('other/src/api.js', 'fetch("https://example.com/api/x")\n');
    expect((await readNginxRoutes(root)).length).toBe(2);
    expect(await callsRelativeApi(join(root, 'frontend'))).toBe(true);
    expect(await callsRelativeApi(join(root, 'other'))).toBe(false);
  });

  it('checks a path each route really sends', () => {
    expect(samplePath('/api')).toBe('/api/');
    expect(samplePath(/^\/(admin|api|ws)/)).toBe('/api/');
    expect(samplePath(/^\/graphql$/)).toBe('/graphql');
  });
});

describe('the gateway, on real sockets', () => {
  const servers: Server[] = [];
  const sockets: import('node:net').Socket[] = [];
  let gateway: Gateway | undefined;
  afterEach(async () => {
    await gateway?.close();
    gateway = undefined;
    for (const s of sockets.splice(0)) s.destroy();
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => { s.closeAllConnections(); s.close(r); })));
  });

  const serve = async (name: string): Promise<string> => {
    const s = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ from: name, method: req.method, path: req.url, body, host: req.headers.host, fwd: req.headers['x-forwarded-host'] }));
      });
    });
    s.on('upgrade', (req, socket) => {
      sockets.push(socket as import('node:net').Socket);
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
      socket.on('data', (d) => socket.write(`${name} echo: ${d}`));
    });
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    return `http://localhost:${(s.address() as AddressInfo).port}/`;
  };

  const call = (url: string, method = 'GET', body?: string) =>
    new Promise<Record<string, string>>((resolve, reject) => {
      const u = new URL(url);
      const req = request({ host: '127.0.0.1', port: u.port, path: u.pathname + u.search, method, agent: false, headers: { host: u.host } }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve(JSON.parse(d)));
      });
      req.on('error', reject);
      req.end(body);
    });

  it('sends the page\'s API calls to the backend — a POST with its body — and everything else to the frontend', async () => {
    const targets = { frontend: await serve('frontend'), backend: await serve('backend') };
    gateway = await startGateway({ routes: [{ match: /^\/(admin|api|ws)/, to: 'backend' }], fallback: 'frontend', targets });

    const post = await call(new URL('/api/create_post/', gateway.url).toString(), 'POST', '{"name":"Test"}');
    expect(post).toMatchObject({ from: 'backend', method: 'POST', path: '/api/create_post/', body: '{"name":"Test"}' });
    // Addressed as the service would be opened directly; the original kept, as nginx does.
    expect(post.host).toBe(new URL(targets.backend).host);
    expect(post.fwd).toBe(new URL(gateway.url).host);

    expect(await call(new URL('/static/js/bundle.js', gateway.url).toString())).toMatchObject({ from: 'frontend' });
  });

  it('passes a websocket through to the service its path goes to', async () => {
    const targets = { frontend: await serve('frontend'), backend: await serve('backend') };
    gateway = await startGateway({ routes: [{ match: '/api', to: 'backend' }], fallback: 'frontend', targets });
    const port = Number(new URL(gateway.url).port);
    const reply = await new Promise<string>((resolve, reject) => {
      const s = connect(port, '127.0.0.1', () => {
        s.write('GET /sockjs-node HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
      });
      let got = '';
      s.on('data', (d) => {
        got += d.toString();
        if (got.includes('101') && !got.includes('echo')) s.write('ping');
        if (got.includes('echo')) { s.destroy(); resolve(got); }
      });
      s.on('error', reject);
    });
    expect(reply).toContain('101 Switching Protocols');
    expect(reply).toContain('frontend echo: ping');
  });

  it('ends an open websocket when it stops, so a stopped run leaves nothing connected', async () => {
    const targets = { frontend: await serve('frontend'), backend: await serve('backend') };
    gateway = await startGateway({ routes: [], fallback: 'frontend', targets });
    const port = Number(new URL(gateway.url).port);
    const closed = await new Promise<boolean>((resolve) => {
      const s = connect(port, '127.0.0.1', () => s.write('GET /ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'));
      s.once('data', () => { void gateway!.close(); gateway = undefined; });
      s.on('close', () => resolve(true));
      setTimeout(() => resolve(false), 3000);
    });
    expect(closed).toBe(true);
  });

  it('says so, rather than hanging, when a service is not answering', async () => {
    gateway = await startGateway({ routes: [], fallback: 'frontend', targets: { frontend: 'http://localhost:1/' } });
    const status = await new Promise<number>((resolve) => {
      request({ host: '127.0.0.1', port: new URL(gateway!.url).port, path: '/' }, (res) => { res.resume(); resolve(res.statusCode ?? 0); }).end();
    });
    expect(status).toBe(502);
  });
});
