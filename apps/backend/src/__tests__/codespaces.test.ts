import { describe, it, expect, afterEach } from 'vitest';
import { createServer } from 'node:http';
import { codespace, dashboardHost, toLocal, toPublic } from '../config/Codespaces.js';

/**
 * DevLaunch inside a GitHub Codespace: the person's browser is on their own computer, so a
 * `http://localhost:3000` link would open nothing. Every address shown, or handed to a page,
 * becomes the forwarded one; DevLaunch still checks the local one itself.
 */
const CS = { CODESPACES: 'true', CODESPACE_NAME: 'cool-name-x7', GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: 'app.github.dev' };

describe('addresses in a codespace', () => {
  const cs = codespace(CS)!;

  it('knows it is in one only from the variables GitHub sets', () => {
    expect(cs).toEqual({ name: 'cool-name-x7', domain: 'app.github.dev' });
    expect(codespace({})).toBeNull();
    expect(codespace({ ...CS, CODESPACE_NAME: 'evil/../x' })).toBeNull();
  });

  it('gives every local address as the forwarded one, and nothing else changes', () => {
    expect(toPublic('open http://localhost:3000/ or http://127.0.0.1:8000/api', cs)).toBe(
      'open https://cool-name-x7-3000.app.github.dev/ or https://cool-name-x7-8000.app.github.dev/api',
    );
    expect(toPublic('http://example.com:3000/ and postgres://postgres:5432', cs)).toBe('http://example.com:3000/ and postgres://postgres:5432');
    expect(toPublic('http://localhost:3000/', null)).toBe('http://localhost:3000/');
  });

  it('turns a forwarded address back into the local one, to check it from here', () => {
    expect(toLocal('https://cool-name-x7-8000.app.github.dev/api/', cs)).toBe('http://localhost:8000/api/');
    expect(toLocal('https://other-8000.app.github.dev/', cs)).toBe('https://other-8000.app.github.dev/');
    expect(toLocal(toPublic('http://localhost:5173/x', cs), cs)).toBe('http://localhost:5173/x');
  });

  it('names the dashboard\'s own address, and none outside a codespace', () => {
    expect(dashboardHost(3939, cs)).toBe('cool-name-x7-3939.app.github.dev');
    expect(dashboardHost(3939, null)).toBeNull();
  });
});

describe('the dashboard in a codespace', () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of Object.keys(CS)) delete process.env[k];
    Object.assign(process.env, saved);
  });

  it('answers at its codespace address with forwarded links, and still refuses other sites', async () => {
    Object.assign(process.env, CS);
    const { createApp } = await import('../api/app.js');
    const sessions = { list: () => [{ id: 'a', state: 'READY', repoUrl: 'https://github.com/a/b', url: 'http://localhost:3000/', createdAt: 1 }] } as never;
    const server = createServer(createApp({ sessions, fixturesDir: '/nonexistent', staticDirs: [] }));
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    const call = (host: string, origin?: string) =>
      new Promise<{ status: number; body: string }>((resolve) => {
        const req = require('node:http').request(
          { host: '127.0.0.1', port, path: '/api/sessions', headers: { host, ...(origin ? { origin } : {}) } },
          (res: import('node:http').IncomingMessage) => {
            let b = '';
            res.on('data', (c) => (b += c));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
          },
        );
        req.end();
      });
    const mine = await call('cool-name-x7-3939.app.github.dev', 'https://cool-name-x7-3939.app.github.dev');
    expect(mine.status).toBe(200);
    expect(mine.body).toContain('https://cool-name-x7-3000.app.github.dev/');
    expect(mine.body).not.toContain('localhost:3000');
    expect((await call('evil.example')).status).toBe(421);
    expect((await call('cool-name-x7-3939.app.github.dev', 'https://evil.example')).status).toBe(403);
    await new Promise<void>((r) => server.close(() => r()));
  });
});
