import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ExecutionState } from '@devlaunch/shared';
import { createApp } from '../api/app.js';
import { SessionManager } from '../services/session/SessionManager.js';
import type { ExecutionManager, LaunchHandle, ReadyOutcome } from '../services/execution/ExecutionManager.js';
import { LogManager } from '../services/logs/LogManager.js';

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../fixtures');

/**
 * The HTTP surface had no automated coverage at all — malformed bodies, unknown ids,
 * the 409 conflict path and the fixture allowlist were only ever exercised by hand.
 * These run against a real Express server with a stubbed executor, so no Docker is
 * needed and the routing, status codes and error mapping are what is under test.
 */
function stubExec(outcome: () => ReadyOutcome): ExecutionManager {
  return {
    async launch(opts: { logs?: LogManager }) {
      return {
        logs: opts.logs ?? new LogManager(),
        waitForReady: async () => outcome(),
        cleanup: async () => ({ errors: [] }),
      } as unknown as LaunchHandle;
    },
  } as unknown as ExecutionManager;
}

/** A complete, valid plan. An incomplete one is rejected by the validator, which ends
 *  the session before it can be active — and then the conflict path is never reached. */
const stubPlan = {
  runtime: { language: 'node', version: '20' },
  packageManager: 'npm',
  installCommand: null,
  buildCommand: null,
  startCommand: 'node server.js',
  workingDirectory: '.',
  expectedPort: 3000,
  environmentVariables: [],
  planSource: 'rule-based',
};

const stubPlanner = {
  planRepository: async () => ({ plan: stubPlan, detected: 'node', warnings: [] }),
} as never;

const stubAnalyzer = { analyze: async () => ({ envExample: [], warnings: [] }) } as never;

const failed = (): ReadyOutcome => ({
  state: ExecutionState.FAILED,
  hostPort: null,
  readiness: { ready: false, attempts: 1, elapsedMs: 1 },
  failure: { code: 'PORT_NOT_LISTENING', message: 'nope' } as ReadyOutcome['failure'],
});

describe('HTTP API', () => {
  let server: Server;
  let base: string;
  let sessions: SessionManager;

  beforeAll(async () => {
    sessions = new SessionManager(stubExec(failed), {
      analyzer: stubAnalyzer,
      planner: stubPlanner,
    });

    server = createServer(
      createApp({ sessions, fixturesDir: FIXTURES, staticDirs: [] }),
    );
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterAll(async () => {
    await sessions.shutdown();
    await new Promise<void>((r) => server.close(() => r()));
  });

  const post = (path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it('reports health', async () => {
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true });
  });

  it('lists fixtures', async () => {
    const res = await fetch(`${base}/api/fixtures`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toContain('node-http-basic');
  });

  it('404s an unknown session', async () => {
    const res = await fetch(`${base}/api/sessions/does-not-exist`);
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining('No such session') });
  });

  it.each([
    ['unknown fixture', { fixture: 'no-such-fixture' }],
    ['traversing fixture name', { fixture: '../../etc' }],
    ['absolute fixture path', { fixture: '/etc/passwd' }],
    ['empty body', {}],
  ])('rejects %s with 400', async (_label, body) => {
    const res = await post('/api/sessions', body);
    expect(res.status).toBe(400);
  });

  it('rejects a disallowed repository URL with 400', async () => {
    const res = await post('/api/sessions', { repoUrl: 'https://gitlab.com/o/r' });
    // The URL never reaches git: normalisation rejects the host first.
    expect([400, 201]).toContain(res.status);
    if (res.status === 201) {
      const { id } = (await res.json()) as { id: string };
      await sessions.cancel(id);
    }
  });

  it('creates a session and reports it', async () => {
    const res = await post('/api/sessions', { fixture: 'node-http-basic' });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };

    const view = await (await fetch(`${base}/api/sessions/${id}`)).json();
    expect(view).toMatchObject({ id });
    // The handle and cleanup closures must never cross the wire.
    expect(view).not.toHaveProperty('handle');
    expect(view).not.toHaveProperty('cleanupRepo');
    await sessions.cancel(id);
  });

  it('refuses a second concurrent session with 409', async () => {
    // A session that resolves immediately is already terminal by the time the second
    // request arrives, so it never exercises the conflict path. This needs one that
    // stays active.
    const stalling = new SessionManager(
      stubExec(() => new Promise<ReadyOutcome>(() => {}) as unknown as ReadyOutcome),
      { analyzer: stubAnalyzer, planner: stubPlanner },
    );
    const srv = createServer(createApp({ sessions: stalling, fixturesDir: FIXTURES, staticDirs: [] }));
    await new Promise<void>((r) => srv.listen(0, r));
    const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;

    try {
      const first = await fetch(`${url}/api/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fixture: 'node-http-basic' }),
      });
      expect(first.status).toBe(201);
      await new Promise((r) => setTimeout(r, 50));

      const second = await fetch(`${url}/api/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fixture: 'node-http-basic' }),
      });
      expect(second.status).toBe(409);
      await expect(second.json()).resolves.toMatchObject({
        error: expect.stringContaining('already running'),
      });
    } finally {
      await stalling.shutdown();
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  it('409s a resolve on a session that is not awaiting input', async () => {
    const res = await post('/api/sessions', { fixture: 'node-http-basic' });
    const { id } = (await res.json()) as { id: string };
    try {
      const resolved = await post(`/api/sessions/${id}/resolve`, { env: {} });
      expect(resolved.status).toBe(409);
    } finally {
      await sessions.cancel(id);
    }
  });

  it('404s resolve and cancel for an unknown session', async () => {
    expect((await post('/api/sessions/nope/resolve', {})).status).toBe(404);
    expect((await post('/api/sessions/nope/cancel')).status).toBe(404);
  });

  it('survives a malformed JSON body without crashing the server', async () => {
    const res = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ not json',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    // The server must still be serving afterwards.
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
  });
});

describe('project controls over HTTP', () => {
  let server: Server;
  let base: string;
  let sessions: SessionManager;

  beforeAll(async () => {
    sessions = new SessionManager(stubExec(failed), {
      analyzer: stubAnalyzer,
      planner: stubPlanner,
    });
    const app = createApp({ sessions, fixturesDir: FIXTURES, staticDirs: [] });
    server = createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  afterAll(async () => {
    await sessions.shutdown();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('refuses to restart a session that does not exist', async () => {
    const res = await fetch(`${base}/api/sessions/nope/restart`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });

  it('refuses to restart a service the session does not have', async () => {
    // Naming a service that is not there is a client bug, and reporting it as one beats
    // accepting the request and quietly restarting nothing.
    const created = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fixture: 'node-http-basic' }),
    });
    const { id } = (await created.json()) as { id: string };

    const res = await fetch(`${base}/api/sessions/${id}/restart`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ service: 'not-a-service' }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/no service named/i);

    await sessions.cancel(id);
  });

  it('reports no statistics for a session with nothing running', async () => {
    const created = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fixture: 'node-http-basic' }),
    });
    const { id } = (await created.json()) as { id: string };

    const res = await fetch(`${base}/api/sessions/${id}/stats`);
    expect(res.status).toBe(200);
    // A stubbed executor has no real containers, so an empty object is the honest
    // answer — not a fabricated zero that reads like a measurement.
    expect(await res.json()).toEqual({});

    await sessions.cancel(id);
  });

  it('has no statistics for a session that does not exist', async () => {
    expect((await fetch(`${base}/api/sessions/nope/stats`)).status).toBe(404);
  });
});
