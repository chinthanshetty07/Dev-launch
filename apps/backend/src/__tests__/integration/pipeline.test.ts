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

  it('stops for required configuration instead of launching something that will crash', async () => {
    // python-flask-basic declares SECRET_KEY and DATABASE_URL with no default.
    sessions = newManager();
    const s = await sessions.launch({ sourceDir: `${FIXTURES}/python-flask-basic` });
    await until(sessions, s.id, [ExecutionState.AWAITING_INPUT, ExecutionState.FAILED]);

    expect(s.state).toBe(ExecutionState.AWAITING_INPUT);
    expect(s.detected).toBe('flask');
    expect(s.pending?.requiredEnv.map((v) => v.key)).toEqual(['SECRET_KEY', 'DATABASE_URL']);
    // No container exists yet: the gate is genuinely pre-flight.
    expect(s.handle).toBeUndefined();

    await sessions.resolve(s.id, { env: { SECRET_KEY: 'x', DATABASE_URL: 'sqlite://' } });
    await until(sessions, s.id, [ExecutionState.READY, ExecutionState.FAILED], 300_000);

    expect(s.state, JSON.stringify(s.failure)).toBe(ExecutionState.READY);
    const supplied = s.plan!.environmentVariables.find((v) => v.key === 'SECRET_KEY');
    expect(supplied?.value).toBe('x');
    await sessions.cancel(s.id);
  }, 600_000);

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
