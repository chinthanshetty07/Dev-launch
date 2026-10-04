import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ExecutionState, FailureCode } from '@devlaunch/shared';
import { DockerManager } from '../../services/docker/DockerManager.js';
import { ExecutionManager } from '../../services/execution/ExecutionManager.js';
import { SessionManager } from '../../services/session/SessionManager.js';
import { GitManager } from '../../services/git/GitManager.js';
import { RepositoryAnalyzer } from '../../services/analysis/RepositoryAnalyzer.js';
import { RuleBasedPlanner } from '../../services/planning/RuleBasedPlanner.js';
import { CleanupManager } from '../../services/cleanup/CleanupManager.js';

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../fixtures');
const docker = new DockerManager();
const analyzer = new RepositoryAnalyzer();

/** Every manager a test creates, so afterAll can release all of them. */
const created: SessionManager[] = [];

function newManager(): SessionManager {
  const mgr = new SessionManager(new ExecutionManager(docker), {
    git: new GitManager(),
    analyzer,
    planner: new RuleBasedPlanner(analyzer),
  });
  created.push(mgr);
  return mgr;
}

/** Wait until a session reaches one of `states`, or throw with what it actually did. */
async function until(
  sessions: SessionManager,
  id: string,
  states: ExecutionState[],
  timeoutMs = 120_000,
): Promise<ExecutionState> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = sessions.get(id);
    if (s && states.includes(s.state)) return s.state;
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for ${states.join('/')}; session is ${s?.state} ` +
          `(${JSON.stringify(s?.failure)})`,
      );
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe('Full pipeline — analyse, plan, gate, run', () => {
  let sessions: SessionManager;

  beforeAll(async () => {
    await docker.ping();
    await docker.ensureImage('devlaunch/node:20');
    await docker.ensureImage('devlaunch/python:3.12');
  }, 300_000);

  afterAll(async () => {
    // `sessions` is reassigned per test, so shutting down only that one left earlier
    // managers holding containers and cloned repositories — which then broke an
    // unrelated suite's residue assertion.
    await Promise.all(created.map((m) => m.shutdown().catch(() => undefined)));
    await CleanupManager.sweepOrphans(docker);
  });

  it('plans and runs a fixture without being told the commands', async () => {
    // The API no longer supplies startCommand; the planner derives it from the manifest.
    sessions = newManager();
    const s = await sessions.launch({ sourceDir: `${FIXTURES}/node-http-basic` });
    await until(sessions, s.id, [ExecutionState.READY, ExecutionState.FAILED]);

    expect(s.state).toBe(ExecutionState.READY);
    expect(s.detected).toBe('node');
    expect(s.plan?.startCommand).toBe('npm run start');
    expect(s.plan?.planSource).toBe('rule-based');

    const res = await fetch(s.url!);
    expect(res.status).toBe(200);
    await sessions.cancel(s.id);
  }, 300_000);

  it('stops for configuration only a person can give, before any container exists', async () => {
    // Rewritten, not flipped. This used python-flask-basic, which asked for SECRET_KEY and
    // DATABASE_URL. Neither is a person's to give any more: SECRET_KEY only signs the app's
    // own sessions and is generated, and DATABASE_URL names a database DevLaunch starts and
    // injects — asking for it threw the answer away. node-missing-env needs REQUIRED_TOKEN,
    // which nothing can invent, so it is what the gate is tested with now.
    sessions = newManager();
    const s = await sessions.launch({ sourceDir: `${FIXTURES}/node-missing-env` });
    await until(sessions, s.id, [ExecutionState.AWAITING_INPUT, ExecutionState.FAILED]);
    expect(s.state, JSON.stringify(s.failure)).toBe(ExecutionState.AWAITING_INPUT);
    expect(s.pending?.requiredEnv.map((v) => [v.key, v.kind])).toEqual([['REQUIRED_TOKEN', 'REQUIRED_SECRET']]);
    // No container exists yet: the gate is genuinely pre-flight.
    expect(s.handle).toBeUndefined();
    await sessions.cancel(s.id);
  }, 600_000);

  it('runs without stopping when everything it needs can be provided (python-flask-basic)', async () => {
    // SECRET_KEY generated, DATABASE_URL injected from the Postgres DevLaunch starts.
    sessions = newManager();
    const s = await sessions.launch({ sourceDir: `${FIXTURES}/python-flask-basic` });
    await until(sessions, s.id, [ExecutionState.AWAITING_INPUT, ExecutionState.READY, ExecutionState.FAILED], 300_000);
    expect(s.state, JSON.stringify({ failure: s.failure, pending: s.pending })).toBe(ExecutionState.READY);
    const env = new Map(s.plan!.environmentVariables.map((v) => [v.key, v.value]));
    expect(env.get('SECRET_KEY')).toMatch(/^[0-9a-f]{64}$/);
    expect(env.get('DATABASE_URL')).toMatch(/^postgresql:\/\/.*@postgres:5432\//);
    await sessions.cancel(s.id);
  }, 600_000);

  it('runs a Flask application built by a factory in its package', async () => {
    // The Flask tutorial's layout: `flaskr/__init__.py` holds create_app and there is no
    // app.py. It went to a model on every run until the rule could see the factory.
    sessions = newManager();
    const s = await sessions.launch({ sourceDir: `${FIXTURES}/python-flask-factory` });
    await until(sessions, s.id, [ExecutionState.READY, ExecutionState.FAILED], 300_000);

    expect(s.state, JSON.stringify(s.failure)).toBe(ExecutionState.READY);
    expect(s.plan?.planSource).toBe('rule-based');
    const res = await fetch(s.url!);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('flask factory fixture');
    await sessions.cancel(s.id);
  }, 600_000);

  it('runs a TypeScript server that does not type-check, with type checking off (niksbanna/mern-boilerplate)', async () => {
    // ts-node refuses code with a type error before running any of it. The first try says
    // so plainly; the retry turns ts-node's check off and the same code serves.
    sessions = newManager();
    const s = await sessions.launch({ sourceDir: `${FIXTURES}/node-ts-type-error` });
    await until(sessions, s.id, [ExecutionState.READY, ExecutionState.FAILED], 300_000);

    const log = s.logs.buffer.all().map((l) => l.text).join('\n');
    expect(s.state, `${JSON.stringify(s.failure)}\n${log.slice(-2000)}`).toBe(ExecutionState.READY);
    // The first try's verdict, as the repair recorded it; the session itself is READY.
    expect(s.repairs?.[0]).toMatchObject({
      source: 'deterministic', failureCode: 'START_COMMAND_FAILED', after: { TS_NODE_TRANSPILE_ONLY: 'true' },
    });
    expect(s.repairs?.[0]?.evidence.join(' ')).toMatch(/server\.ts\(\d+,\d+\): error TS2322/);
    // And the log says, in words, what the retry did and that the type error remains.
    expect(log).toMatch(/Repair 1 \(START_COMMAND_CORRECTION\): ts-node: TSError: Unable to compile TypeScript; .*retrying with type checking off/);
    const res = await fetch(s.url!);
    expect(await res.text()).toBe('hello from a file that does not type-check');
    await sessions.cancel(s.id);
  }, 600_000);

  it('serves an application that refuses plain HTTP over its own certificate (nkwus/fastapi-starter)', async () => {
    // Its README runs uvicorn with --ssl-certfile/--ssl-keyfile; over HTTP every route is
    // a 403. A copy with a throwaway certificate, so no key is ever committed.
    const { mkdtemp, cp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { request } = await import('node:https');
    const { selfSignedCert } = await import('../helpers/selfSignedCert.js');
    const dir = await mkdtemp(join(tmpdir(), 'devlaunch-https-it-'));
    await cp(`${FIXTURES}/python-fastapi-https`, dir, { recursive: true });
    await selfSignedCert(join(dir, 'certs'));

    sessions = newManager();
    const s = await sessions.launch({ sourceDir: dir });
    await until(sessions, s.id, [ExecutionState.READY, ExecutionState.FAILED], 300_000);
    expect(s.state, JSON.stringify(s.failure)).toBe(ExecutionState.READY);
    expect(s.plan?.protocol).toBe('https');
    expect(s.url).toMatch(/^https:\/\/localhost:\d+\/api_health$/);

    const answer = await new Promise<{ status?: number; body: string }>((resolve, reject) => {
      const req = request(s.url!, { rejectUnauthorized: false }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      req.on('error', reject);
      req.end();
    });
    expect(answer).toEqual({ status: 200, body: '{"status":"ok"}' });
    await sessions.cancel(s.id);
  }, 600_000);

  it('stops waiting when nodemon says the app crashed, instead of polling for the whole budget', async () => {
    // The container stays up — nodemon waits for a file change — so readiness used to poll
    // until its budget ran out. Here the budget is five minutes; the first try must end in
    // well under one, and the type-check repair then brings the server up.
    sessions = newManager();
    const s = await sessions.launch({ sourceDir: `${FIXTURES}/node-nodemon-crash`, readinessTimeoutMs: 300_000 });
    await until(sessions, s.id, [ExecutionState.READY, ExecutionState.FAILED], 600_000);
    const log = s.logs.buffer.all().map((l) => l.text).join('\n');
    expect(s.state, `${JSON.stringify(s.failure)}\n${log.slice(-1500)}`).toBe(ExecutionState.READY);
    const first = s.launchAttempts?.[0];
    expect(first?.result).toBe('START_COMMAND_FAILED');
    expect(first?.durationMs).toBeLessThan(60_000);
    expect(log).toMatch(/\[nodemon\] app crashed/);
    await sessions.cancel(s.id);
  }, 700_000);

  it('asks which package to run rather than guessing, then runs the chosen one', async () => {
    sessions = newManager();
    const s = await sessions.launch({ sourceDir: `${FIXTURES}/node-monorepo-ambiguous` });
    await until(sessions, s.id, [ExecutionState.AWAITING_INPUT, ExecutionState.FAILED]);

    expect(s.state).toBe(ExecutionState.AWAITING_INPUT);
    expect(s.pending?.choices?.map((c) => c.dir).sort()).toEqual(['apps/admin', 'apps/web']);

    await sessions.resolve(s.id, { workspaceDir: 'apps/admin' });
    await until(sessions, s.id, [ExecutionState.READY, ExecutionState.FAILED], 300_000);

    expect(s.state, JSON.stringify(s.failure)).toBe(ExecutionState.READY);
    expect(s.plan?.workingDirectory).toBe('apps/admin');
    await expect((await fetch(s.url!)).text()).resolves.toBe('admin');
    await sessions.cancel(s.id);
  }, 600_000);

  it('clones a real repository and reports honestly when it cannot plan it', async () => {
    // Hello-World has no manifest of any kind. Declining is the correct deterministic
    // answer; an AI fallback is what would handle it, and that is not part of v1.
    sessions = newManager();
    const s = await sessions.launch({ repoUrl: 'https://github.com/octocat/Hello-World' });
    await until(sessions, s.id, [ExecutionState.FAILED, ExecutionState.READY], 180_000);

    expect(s.state).toBe(ExecutionState.FAILED);
    expect(s.failure?.code).toBe(FailureCode.UNSUPPORTED_PROJECT);
    expect(s.failure?.remedy).toMatch(/AI fallback/i);
    expect(s.logs.buffer.all().map((l) => l.text).join('\n')).toMatch(/Cloned https:\/\/github\.com/);
  }, 300_000);

  it('rejects a disallowed repository URL', async () => {
    sessions = newManager();
    const s = await sessions.launch({ repoUrl: 'https://gitlab.com/owner/repo' });
    await until(sessions, s.id, [ExecutionState.FAILED], 60_000);
    expect(s.failure?.message).toMatch(/github\.com/);
  }, 120_000);
});
