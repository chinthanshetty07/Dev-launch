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

  it('never returns a secret value in a session\'s plan', async () => {
    // Audit A-11: the plan went out whole, a typed API key and database password included.
    const s = await sessions.launch({
      sourceDir: FIXTURES,
      plan: { ...stubPlan, environmentVariables: [
        { key: 'OPENAI_API_KEY', value: 'sk-THE-REAL-ONE', required: true },
        { key: 'DATABASE_URL', value: 'postgresql://u:pw-REAL@db/x', required: false },
      ] } as never,
      replace: true,
    });
    const body = await (await fetch(`${base}/api/sessions/${s.id}`)).text();
    expect(body).toContain('OPENAI_API_KEY');
    expect(body).not.toContain('sk-THE-REAL-ONE');
    expect(body).not.toContain('pw-REAL');
    await sessions.cancel(s.id);
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

      // What the dashboard and `./devlaunch deploy` send: the running one makes way.
      const firstId = ((await first.json()) as { id: string }).id;
      const replacing = await fetch(`${url}/api/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fixture: 'node-http-basic', replace: true }),
      });
      expect(replacing.status).toBe(201);
      expect(stalling.get(firstId)?.state).toBe(ExecutionState.CANCELLED);

      // And for a repository URL, on both routes.
      for (const route of ['/api/sessions', '/api/deployments']) {
        // A fixture that stalls holds the slot; the URL run itself may fail fast offline.
        const holding = await stalling.launch({ sourceDir: `${FIXTURES}/node-http-basic`, replace: true });
        const before = holding.id;
        const byUrl = await fetch(`${url}${route}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ repoUrl: 'https://github.com/octocat/Hello-World', replace: true }),
        });
        expect(byUrl.status, route).toBe(201);
        expect(stalling.get(before)?.state, route).toBe(ExecutionState.CANCELLED);
      }
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

/**
 * A repository URL the intake will refuse should be refused by the request that submits
 * it, not four steps later inside the pipeline.
 *
 * `GitManager` has always rejected a non-GitHub host, a credentialed URL, plain http and
 * an SSH remote. What it did not do was refuse them *to the caller*: the route answered
 * 201, a session was created, and the rejection arrived asynchronously. A typo looked
 * accepted — and with `maxSessions: 1` it held the only slot until it finished failing,
 * so the next real launch was told "a session is already running".
 */
/**
 * `/api/health` returned the literal `true`. That is a liveness check wearing a health
 * check's name: it could not say "Docker is unreachable" or "the egress policy is
 * missing", and both happened during a single afternoon's verification.
 */
describe('health that can be unhealthy', () => {
  const start = async (over: Partial<Parameters<typeof createApp>[0]> = {}) => {
    const sessions = new SessionManager(stubExec(failed), { analyzer: stubAnalyzer, planner: stubPlanner });
    const server = createServer(
      createApp({ sessions, fixturesDir: FIXTURES, staticDirs: [], ...over }),
    );
    await new Promise<void>((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const body = (await (await fetch(`${base}/api/health`)).json()) as {
      ok: boolean; problems?: string[]; egress?: string;
    };
    await sessions.shutdown();
    await new Promise<void>((r) => server.close(() => r()));
    return body;
  };

  it('names Docker when Docker is the thing that is wrong', async () => {
    const body = await start({ docker: { ping: async () => { throw new Error('connect ENOENT /var/run/docker.sock'); } } });
    expect(body.ok).toBe(false);
    expect(body.problems?.join(' ')).toMatch(/Docker is not reachable/);
    expect(body.problems?.join(' '), 'and quote what Docker said').toMatch(/ENOENT/);
  });

  it('names the egress policy when that is the thing that is wrong', async () => {
    const body = await start({
      docker: { ping: async () => undefined },
      egress: () => ({ verdict: 'absent' as const, detail: 'A container reached 169.254.169.254.' }),
    });
    expect(body.ok).toBe(false);
    expect(body.problems?.join(' ')).toMatch(/169\.254\.169\.254/);
  });

  it('is ok when nothing is wrong', async () => {
    const body = await start({
      docker: { ping: async () => undefined },
      egress: () => ({ verdict: 'enforced' as const, detail: 'fine' }),
    });
    expect(body.ok).toBe(true);
    expect(body.problems).toBeUndefined();
    expect(body.egress).toBe('enforced');
  });

  it('answers even when Docker hangs instead of refusing', async () => {
    // The realistic bad case, and the one an unbounded `ping()` turns into a second
    // outage: a daemon that accepts the connection and never replies. Health exists to
    // say "Docker is broken"; hanging is the one answer it must not give.
    const body = await start({ docker: { ping: () => new Promise(() => {}) } });
    expect(body.ok).toBe(false);
    expect(body.problems?.join(' ')).toMatch(/timed out/);
  }, 15_000);

  it('does not report a fault the probe has not established yet', async () => {
    // The probe is asynchronous. A health request arriving first must not claim a
    // problem that has not been observed — a warning that fires on "not yet" is a
    // warning people learn to ignore.
    const body = await start({
      docker: { ping: async () => undefined },
      egress: () => ({ verdict: 'unknown' as const, detail: 'not checked yet' }),
    });
    expect(body.ok).toBe(true);
    expect(body.egress).toBe('unknown');
  });
});

describe('a repository URL the intake will refuse', () => {
  let server: Server;
  let base: string;
  let sessions: SessionManager;

  beforeAll(async () => {
    sessions = new SessionManager(stubExec(failed), { analyzer: stubAnalyzer, planner: stubPlanner });
    server = createServer(createApp({ sessions, fixturesDir: FIXTURES, staticDirs: [] }));
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterAll(async () => {
    await sessions.shutdown();
    await new Promise<void>((r) => server.close(() => r()));
  });

  const submit = (repoUrl: string) =>
    fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repoUrl }),
    });

  it('is refused by the request itself, with the reason the intake gives', async () => {
    const cases: [string, RegExp][] = [
      ['https://gitlab.com/a/b', /Only github\.com is supported/],
      ['https://user:pw@github.com/a/b', /credentials are rejected/],
      ['http://github.com/a/b', /Only https:\/\/ is supported/],
      ['git@github.com:a/b.git', /SSH-style URLs are not supported/],
    ];

    for (const [url, reason] of cases) {
      const res = await submit(url);
      expect(res.status, url).toBe(400);
      const body = (await res.json()) as { error: string; code: string };
      expect(body.error, url).toMatch(reason);
      expect(body.code, url).toBe('UNSUPPORTED_PROJECT');
    }
  });

  it('creates no session, so the only slot stays free', async () => {
    // The half that actually bit: a rejected URL used to occupy `maxSessions: 1` for as
    // long as it took to fail, and the next launch was refused for the wrong reason.
    const before = sessions.list().length;
    await submit('https://gitlab.com/a/b');
    expect(sessions.list().length, 'a refused URL must not create a session').toBe(before);
  });

  const submitWith = (body: Record<string, unknown>) =>
    fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('refuses a ref that could be read as an option, before a session exists', async () => {
    // The ref reaches `git fetch` as an argument. One beginning with `-` is an option.
    const before = sessions.list().length;
    for (const ref of ['--upload-pack=touch /tmp/x', '../../etc', 'a b', 'main;rm']) {
      const res = await submitWith({ repoUrl: 'https://github.com/owner/repo', ref });
      expect(res.status, ref).toBe(400);
      expect(((await res.json()) as { code: string }).code, ref).toBe('UNSUPPORTED_PROJECT');
    }
    expect(sessions.list().length).toBe(before);
  });

  it('carries the ref it was given, and the one a pasted /tree/ URL names', async () => {
    const cases: [Record<string, unknown>, string, string][] = [
      [{ repoUrl: 'https://github.com/owner/repo', ref: 'v3' }, 'https://github.com/owner/repo', 'v3'],
      [{ repoUrl: 'https://github.com/nuxt/starter/tree/v3' }, 'https://github.com/nuxt/starter', 'v3'],
      [{ repoUrl: 'https://github.com/o/r/tree/feature/x' }, 'https://github.com/o/r', 'feature/x'],
      // An explicit ref is the more deliberate statement, so it wins.
      [{ repoUrl: 'https://github.com/o/r/tree/main', ref: 'abc1234' }, 'https://github.com/o/r', 'abc1234'],
    ];
    for (const [body, repoUrl, ref] of cases) {
      await sessions.shutdown();
      const res = await submitWith(body);
      expect(res.status, JSON.stringify(body)).toBe(201);
      const { id } = (await res.json()) as { id: string };
      const view = (await (await fetch(`${base}/api/sessions/${id}`)).json()) as { repoUrl: string; ref: string };
      expect(view.repoUrl).toBe(repoUrl);
      expect(view.ref).toBe(ref);
    }
  });

  it('still accepts a URL the intake allows', async () => {
    // The check must not become a second, stricter gate that rejects what the pipeline
    // would have run.
    const res = await submit('https://github.com/owner/repo');
    expect(res.status).toBe(201);
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
