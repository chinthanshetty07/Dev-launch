import { describe, it, expect } from 'vitest';
import { ExecutionState, RunPlanSchema } from '@devlaunch/shared';
import { SessionManager } from '../services/session/SessionManager.js';
import type { ExecutionManager, ReadyOutcome } from '../services/execution/ExecutionManager.js';
import { LogManager } from '../services/logs/LogManager.js';

/**
 * A stop that arrives while a database is still starting.
 *
 * Seen live: `testdrivenio/fastapi-crud-sync` was stopped from the dashboard 13 seconds in,
 * while its database was starting. The stop's teardown found no database to remove — the
 * session records one only once it is ready — and the database, ready moments later, was
 * left running with no session for 28 minutes, holding its memory.
 */
function setup(opts: { holdLaunch?: Promise<void>; project?: boolean; needsInput?: boolean } = {}) {
  const created: string[] = [];
  const removed: string[] = [];
  let dbReady = false;
  const launched: string[] = [];
  const ready: ReadyOutcome = {
    state: ExecutionState.READY, hostPort: '1', url: 'http://localhost:1',
    readiness: { ready: true, attempts: 1, elapsedMs: 1 } as ReadyOutcome['readiness'],
  };
  const exec = {
    docker: {
      ensureImage: async () => undefined,
      networkExists: async () => true,
      claimedAliases: async () => new Set<string>(),
      createBackingContainer: async (o: { image: string }) => { created.push(o.image); return { id: `db-${created.length}` } as never; },
      start: async () => undefined,
      stop: async () => undefined,
      remove: async (c: { id: string }) => { removed.push(c.id); },
      inspect: async () => ({ State: { Running: true } }),
      logTail: async () => '',
      // Not ready until the test says so: the stop lands while it is starting.
      execCapture: async () => (dbReady ? 'accepting connections' : ''),
    },
    async launch(o: { logs?: LogManager; plan?: { name?: string } }) {
      const name = o.plan?.name ?? 'app';
      launched.push(name);
      await opts.holdLaunch;
      const logs = o.logs ?? new LogManager();
      return {
        container: { id: name }, logs, waitForReady: async () => ready, liveness: async () => ({ kind: 'running' }),
        clearStartupBudget: () => undefined, cleanup: async () => { removed.push(name); return { errors: [] }; },
      };
    },
  } as unknown as ExecutionManager;
  const plan = (name?: string, port = 8000) => ({
    ...RunPlanSchema.parse({
      runtime: { language: 'python', version: '3.12' }, packageManager: 'pip', installCommand: null,
      buildCommand: null, startCommand: `uvicorn main:app --host 0.0.0.0 --port ${port}`,
      workingDirectory: name ?? '.', expectedPort: port, planSource: 'rule-based',
    }),
    ...(name ? { name, role: name } : {}),
  });
  const m = new SessionManager(exec, {
    analyzer: {
      analyze: async () => ({
        warnings: [], lockfiles: [], frameworkConfigs: [],
        envExample: opts.needsInput ? [{ key: 'SECRET_KEY', hasDefault: false }] : [],
        backing: [{ kind: 'postgres' as const, evidence: 'depends on psycopg2', urlEnvKeys: ['DATABASE_URL'], neededBy: [] }],
        ...(opts.project
          ? { services: [
              { name: 'api', dir: 'api', role: 'api', language: 'python', scripts: [], evidence: 'x' },
              { name: 'web', dir: 'web', role: 'web', language: 'python', scripts: [], evidence: 'x' },
            ] }
          : {}),
      }),
    } as never,
    ...(opts.project
      ? {
          projectPlanner: {
            planProject: async () => ({
              plan: { services: [plan('api', 8000), plan('web', 8001)], planSource: 'rule-based' },
              skipped: [], warnings: [],
            }),
          } as never,
        }
      : {}),
    planner: {
      planRepository: async () => ({
        plan: opts.needsInput
          ? { ...plan(), environmentVariables: [{ key: 'SECRET_KEY', value: null, required: true }] }
          : plan(),
        detected: 'fastapi', warnings: [],
      }),
    } as never,
    backingReadyMs: 10_000,
  });
  return { m, created, removed, launched, makeDbReady: () => { dbReady = true; } };
}

const until = async (cond: () => boolean, ms = 5000) => {
  for (let t = 0; t < ms && !cond(); t += 20) await new Promise((r) => setTimeout(r, 20));
};

describe('a stop while the database is still starting', () => {
  it('removes the database once it has finished starting, and starts nothing else', async () => {
    const { m, created, removed, launched, makeDbReady } = setup();
    const s = await m.launch({ sourceDir: '/tmp/repo', image: 'devlaunch/python:3.12' });
    await until(() => created.length === 1);

    await m.cancel(s.id);
    expect(s.state).toBe(ExecutionState.CANCELLED);
    expect(removed).toEqual([]); // nothing to remove yet: it is still starting

    makeDbReady();
    await until(() => removed.includes('db-1'));
    expect(removed).toContain('db-1');
    expect(launched).toEqual([]);
    expect(s.state).toBe(ExecutionState.CANCELLED);
    await m.shutdown();
  });
});

describe('a stop while the application container is being created', () => {
  it('removes the container once it exists, and never reports it ready', async () => {
    let release!: () => void;
    const holdLaunch = new Promise<void>((r) => { release = r; });
    const { m, removed, launched, makeDbReady } = setup({ holdLaunch });
    makeDbReady();
    const s = await m.launch({ sourceDir: '/tmp/repo', image: 'devlaunch/python:3.12' });
    await until(() => launched.length === 1);

    await m.cancel(s.id);
    expect(removed).not.toContain('app'); // still being created: nothing to remove yet

    release();
    await until(() => removed.includes('app'));
    expect(removed).toContain('app');
    expect(removed).toContain('db-1');
    expect(s.state).toBe(ExecutionState.CANCELLED);
    await m.shutdown();
  });
});

describe('a stop while a project is starting its services', () => {
  it('removes every service once they exist', async () => {
    let release!: () => void;
    const holdLaunch = new Promise<void>((r) => { release = r; });
    const { m, removed, launched, makeDbReady } = setup({ holdLaunch, project: true });
    makeDbReady();
    const s = await m.launch({ sourceDir: '/tmp/repo' });
    await until(() => launched.length >= 1);

    await m.cancel(s.id);
    release();
    await until(() => launched.every((n) => removed.includes(n)) && removed.includes('db-1'));
    for (const name of launched) expect(removed).toContain(name);
    expect(s.state, JSON.stringify({ f: s.failure, log: s.logs.buffer.all().map((l) => l.text).slice(-12), launched, removed })).toBe(ExecutionState.CANCELLED);
    await m.shutdown();
  });
});

describe('a stop after the run asked for input and was resumed', () => {
  it('removes the container once it exists', async () => {
    let release!: () => void;
    const holdLaunch = new Promise<void>((r) => { release = r; });
    const { m, removed, launched, makeDbReady } = setup({ holdLaunch, needsInput: true });
    makeDbReady();
    const s = await m.launch({ sourceDir: '/tmp/repo', image: 'devlaunch/python:3.12' });
    await until(() => s.state === ExecutionState.AWAITING_INPUT);
    await m.resolve(s.id, { env: { SECRET_KEY: 'x' } });
    await until(() => launched.length === 1);

    await m.cancel(s.id);
    release();
    await until(() => removed.includes('app'));
    expect(removed).toContain('app');
    expect(s.state).toBe(ExecutionState.CANCELLED);
    await m.shutdown();
  });
});
