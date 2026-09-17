import { describe, it, expect, beforeEach } from 'vitest';
import { ExecutionState, RunPlanSchema, type RunPlan } from '@devlaunch/shared';
import { config } from '../config/index.js';
import { SessionManager, SessionConflict } from '../services/session/SessionManager.js';
import type { ExecutionManager, LaunchHandle, ReadyOutcome } from '../services/execution/ExecutionManager.js';
import { LogManager } from '../services/logs/LogManager.js';

const plan = (): RunPlan =>
  RunPlanSchema.parse({
    runtime: { language: 'node', version: '20' },
    packageManager: 'npm',
    installCommand: null,
    buildCommand: null,
    startCommand: 'node server.js',
    workingDirectory: '.',
    expectedPort: 3000,
    planSource: 'rule-based',
  });

/** Stands in for the real launcher so session bookkeeping can be tested without Docker. */
function fakeExec(outcome: () => ReadyOutcome): ExecutionManager {
  return {
    async launch(opts: { logs?: LogManager }) {
      const logs = opts.logs ?? new LogManager();
      logs.buffer.push('stdout', 'fake output');
      return {
        logs,
        waitForReady: async () => outcome(),
        cleanup: async () => ({ errors: [] }),
      } as unknown as LaunchHandle;
    },
  } as unknown as ExecutionManager;
}

const failed = (): ReadyOutcome => ({
  state: ExecutionState.FAILED,
  hostPort: null,
  readiness: { ready: false, attempts: 1, elapsedMs: 1 },
  failure: { code: 'PORT_NOT_LISTENING', message: 'nope' } as ReadyOutcome['failure'],
});

async function settle(): Promise<void> {
  // The launch pipeline is intentionally not awaited by launch(); let it finish.
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

describe('SessionManager', () => {
  let sessions: SessionManager;
  beforeEach(() => { sessions = new SessionManager(fakeExec(failed)); });

  it('refuses a second concurrent session', async () => {
    const exec = fakeExec(() => ({
      state: ExecutionState.READY,
      hostPort: '1234',
      url: 'http://localhost:1234/',
      readiness: { ready: true, attempts: 1, elapsedMs: 1, status: 200 },
    }));
    const mgr = new SessionManager(exec);
    await mgr.launch({ plan: plan(), sourceDir: '/tmp', image: 'devlaunch/node:20' });
    await settle();
    await expect(
      mgr.launch({ plan: plan(), sourceDir: '/tmp', image: 'devlaunch/node:20' }),
    ).rejects.toBeInstanceOf(SessionConflict);
    await mgr.shutdown();
  });

  it('evicts the oldest finished sessions beyond the retention cap', async () => {
    // Each retained session holds a log buffer of up to several megabytes, so an
    // unbounded registry is a memory leak for any long-running backend.
    const cap = config.concurrency.retainFinished;
    const created: string[] = [];

    for (let i = 0; i < cap + 5; i++) {
      const s = await sessions.launch({ plan: plan(), sourceDir: '/tmp', image: 'devlaunch/node:20' });
      created.push(s.id);
      await settle();
    }

    expect(sessions.list().length).toBe(cap);
    // The survivors must be the most recent ones.
    for (const id of created.slice(0, 5)) expect(sessions.get(id)).toBeUndefined();
    for (const id of created.slice(-cap)) expect(sessions.get(id)).toBeDefined();
  });

  it('releases the log buffer of an evicted session', async () => {
    const first = await sessions.launch({ plan: plan(), sourceDir: '/tmp', image: 'devlaunch/node:20' });
    await settle();
    const buffer = first.logs.buffer;
    expect(buffer.all().length).toBeGreaterThan(0);

    for (let i = 0; i < config.concurrency.retainFinished + 1; i++) {
      await sessions.launch({ plan: plan(), sourceDir: '/tmp', image: 'devlaunch/node:20' });
      await settle();
    }

    expect(sessions.get(first.id)).toBeUndefined();
    expect(buffer.all().length, 'evicted buffers must be released').toBe(0);
  });

  it('records why a session ended, so an idle stop is distinguishable', async () => {
    const exec = fakeExec(() => ({
      state: ExecutionState.READY,
      hostPort: '1234',
      url: 'http://localhost:1234/',
      readiness: { ready: true, attempts: 1, elapsedMs: 1, status: 200 },
    }));
    const mgr = new SessionManager(exec);
    const s = await mgr.launch({ plan: plan(), sourceDir: '/tmp', image: 'devlaunch/node:20' });
    await settle();
    expect(s.state).toBe(ExecutionState.READY);

    await mgr.stop(s.id, 'idle timeout');
    expect(s.state).toBe(ExecutionState.COMPLETED);
    expect(s.endedReason).toBe('idle timeout');
  });

  it('releases a session nobody answers, so concurrency 1 cannot wedge the tool', async () => {
    // A session parked in AWAITING_INPUT holds the only slot. Without a bound, walking
    // away leaves DevLaunch unusable until the process restarts.
    const analyzer = {
      analyze: async () => ({ envExample: [{ key: 'X', hasDefault: false }], warnings: [] }),
    };
    const planner = {
      planRepository: async () => ({
        plan: { environmentVariables: [], runtime: { language: 'node', version: '20' } },
        detected: 'node',
        warnings: [],
      }),
    };
    const mgr = new SessionManager(fakeExec(failed), {
      analyzer: analyzer as never,
      planner: planner as never,
      awaitingInputMs: 60,
    });

    // Let the real pipeline open the gate, rather than forcing it and racing the
    // background run that is still in flight.
    const s = await mgr.launch({ sourceDir: '/tmp' });
    await settle();
    expect(s.state).toBe(ExecutionState.AWAITING_INPUT);
    expect(s.pending?.requiredEnv.map((v) => v.key)).toEqual(['X']);

    await new Promise((r) => setTimeout(r, 250));
    expect(s.state).toBe(ExecutionState.CANCELLED);
    expect(s.endedReason).toBe('awaiting input timed out');
    await mgr.shutdown();
  });

  it('keeps an active session even when finished ones pile up', async () => {
    const stalled = new SessionManager(
      fakeExec(() => new Promise<ReadyOutcome>(() => {}) as unknown as ReadyOutcome),
    );
    const active = await stalled.launch({ plan: plan(), sourceDir: '/tmp', image: 'devlaunch/node:20' });
    await settle();
    expect(stalled.get(active.id)).toBeDefined();
    await stalled.shutdown();
  });
});
