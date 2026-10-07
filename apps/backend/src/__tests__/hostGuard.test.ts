import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { createApp } from '../api/app.js';
import { SessionManager } from '../services/session/SessionManager.js';
import type { ExecutionManager } from '../services/execution/ExecutionManager.js';
import { LogSocketServer } from '../websocket/LogSocketServer.js';
import { configuredHosts } from '../services/security/HostGuard.js';

/**
 * Audit A-10. Loopback keeps the network out but not a browser: a page whose DNS answer
 * flips to 127.0.0.1 is same-origin with `http://evil.example:3939`, and DevLaunch has no
 * login. Every request must be addressed to this machine, and come from a page it served.
 */
let server: Server;
let port: number;
let sessions: SessionManager;

beforeAll(async () => {
  sessions = new SessionManager({} as ExecutionManager);
  server = createServer(createApp({ sessions, fixturesDir: '/nonexistent', staticDirs: [], allowedHosts: [] }));
  new LogSocketServer(sessions, []).attach(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  await sessions.shutdown();
  await new Promise<void>((r) => server.close(() => r()));
});

function call(method: string, path: string, headers: Record<string, string>, body?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end(body);
  });
}

describe('who may use the API', () => {
  it('answers this machine by any of its names', async () => {
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, 'localhost']) {
      expect(await call('GET', '/api/sessions', { host }), host).toBe(200);
    }
  });

  it('refuses a request addressed to another name, which is what a rebound page sends', async () => {
    expect(await call('GET', '/api/sessions', { host: `evil.example:${port}` })).toBe(421);
    expect(await call('POST', '/api/sessions', { host: `evil.example:${port}`, 'content-type': 'application/json' }, '{"repoUrl":"https://github.com/a/b"}')).toBe(421);
  });

  it('refuses a page from another site, and allows its own pages and tools that send no Origin', async () => {
    expect(await call('POST', '/api/sessions', { host: `127.0.0.1:${port}`, origin: 'https://evil.example', 'content-type': 'application/json' }, '{}')).toBe(403);
    expect(await call('GET', '/api/sessions', { host: `127.0.0.1:${port}`, origin: 'http://localhost:5173' })).toBe(200);
    expect(await call('GET', '/api/sessions', { host: `127.0.0.1:${port}` })).toBe(200);
    expect(await call('GET', '/api/sessions', { host: `127.0.0.1:${port}`, origin: 'null' })).toBe(403);
  });

  it('lets the website open the dashboard with a link, and nothing else from another site', async () => {
    // What the DevLaunch website's "Run on my computer" button causes: a page visit.
    const visit = { host: `127.0.0.1:${port}`, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' };
    expect(await call('GET', '/?repo=https://github.com/a/b', visit)).not.toBe(403);
    // A background request from any other site — even one that sends no Origin, as a
    // no-cors GET or an <img> does — is refused.
    for (const mode of ['no-cors', 'cors', 'same-origin']) {
      expect(await call('GET', '/api/sessions', { host: `127.0.0.1:${port}`, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': mode }), mode).toBe(403);
    }
    expect(await call('GET', '/api/sessions', { host: `127.0.0.1:${port}`, 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'no-cors' })).toBe(403);
    // A form posted at DevLaunch from another site is a navigation too, and still refused.
    expect(await call('POST', '/api/sessions', { ...visit, 'content-type': 'application/x-www-form-urlencoded' }, 'repoUrl=https://github.com/a/b')).toBe(403);
    // The website itself is just another site.
    expect(await call('POST', '/api/sessions', { host: `127.0.0.1:${port}`, origin: 'https://chinthanshetty07.github.io', 'content-type': 'application/json' }, '{}')).toBe(403);
    // The dashboard's own requests, and tools that send none of this.
    expect(await call('GET', '/api/sessions', { host: `127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' })).toBe(200);
    expect(await call('GET', '/api/sessions', { host: `127.0.0.1:${port}`, 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate' })).toBe(200);
  });

  it('refuses the log socket to a rebound page', async () => {
    const opened = (headers: Record<string, string>) =>
      new Promise<boolean>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/sessions/none/logs`, { headers });
        ws.on('open', () => { ws.close(); resolve(true); });
        ws.on('unexpected-response', (_req, res) => resolve(res.statusCode === 404 ? true : false));
        ws.on('error', () => resolve(false));
      });
    // 404 means it got past the guard to the session lookup.
    expect(await opened({ host: `127.0.0.1:${port}` })).toBe(true);
    expect(await opened({ host: `evil.example:${port}` })).toBe(false);
    expect(await opened({ host: `127.0.0.1:${port}`, origin: 'https://evil.example' })).toBe(false);
  });

  it('can be widened on purpose, never by accident', () => {
    expect(configuredHosts({ DEVLAUNCH_ALLOWED_HOSTS: 'devbox.local, my.vm' })).toEqual(['devbox.local', 'my.vm']);
    expect(configuredHosts({ DEVLAUNCH_HOST: '0.0.0.0' })).toEqual([]);
    expect(configuredHosts({})).toEqual([]);
  });
});
