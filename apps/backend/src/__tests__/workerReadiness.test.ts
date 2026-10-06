import { describe, it, expect } from 'vitest';
import { ExecutionState, FailureCode, Sentinel } from '@devlaunch/shared';
import { ProjectExecutor, workerOutcome, type ProjectRun, type ServiceRun } from '../services/execution/ProjectExecutor.js';
import type { ExecutionManager } from '../services/execution/ExecutionManager.js';
import type { ContainerLiveness, LaunchHandle } from '../services/execution/ExecutionManager.js';
import { LogManager } from '../services/logs/LogManager.js';

/**
 * Audit A-03: a project's worker was READY the moment it was launched, with nothing
 * asked of it. A worker whose install failed, or which crashed on boot, made the whole
 * project READY and showed "ready" beside a dead container.
 */
function worker(opts: { started: boolean; liveness: ContainerLiveness; exits?: boolean; lastLine?: string }): ServiceRun {
  const logs = new LogManager();
  if (opts.lastLine) logs.write('stderr', opts.lastLine);
  const sentinels = new Set<string>(opts.started ? [Sentinel.INSTALL_BEGIN, Sentinel.START_BEGIN] : [Sentinel.INSTALL_BEGIN]);
  const handle = {
    sentinels,
    exit: opts.exits ? Promise.resolve({ exitCode: 1 }) : new Promise(() => {}),
    liveness: async () => opts.liveness,
    phaseReached: () => (opts.started ? 'start' : 'install'),
  } as unknown as LaunchHandle;
  return { name: 'queue', role: 'worker', handle, logs, state: ExecutionState.STARTING } as unknown as ServiceRun;
}
const noWait = async () => undefined;

describe('a project worker', () => {
  it('counts as running once it has started and is still up a moment later', async () => {
    const out = await workerOutcome(worker({ started: true, liveness: { kind: 'running' } }), 1000, 5, noWait);
    expect(out).toEqual({ state: ExecutionState.READY });
  });

  it('fails the project when it crashes after starting, saying what it said', async () => {
    const out = await workerOutcome(
      worker({ started: true, exits: true, liveness: { kind: 'exited', exitCode: 1, oomKilled: false }, lastLine: 'Error: connect ECONNREFUSED 127.0.0.1:6379' }),
      1000, 5, noWait,
    );
    expect(out.state).toBe(ExecutionState.FAILED);
    expect(out.failure?.code).toBe(FailureCode.APPLICATION_EXITED);
    expect(out.failure?.phase).toBe('start');
  });

  it('fails when it dies during its install, in that phase', async () => {
    const out = await workerOutcome(
      worker({ started: false, exits: true, liveness: { kind: 'exited', exitCode: 1, oomKilled: false } }), 1000, 5, noWait,
    );
    expect(out.state).toBe(ExecutionState.FAILED);
    expect(out.failure?.phase).toBe('install');
    // Never "after it had become ready", nor "it started correctly": it did neither.
    expect(out.failure?.message).toMatch(/during its install/);
    expect(out.failure?.message).not.toMatch(/become ready/);
    expect(out.failure?.remedy).not.toMatch(/started correctly/);
  });

  it('names a memory kill as one', async () => {
    const out = await workerOutcome(
      worker({ started: true, exits: true, liveness: { kind: 'exited', exitCode: 137, oomKilled: true } }), 1000, 5, noWait,
    );
    expect(out.failure?.code).toBe(FailureCode.OUT_OF_MEMORY);
  });

  it('may finish: a one-off job that exits 0 is completed, not failed', async () => {
    const out = await workerOutcome(
      worker({ started: true, exits: true, liveness: { kind: 'exited', exitCode: 0, oomKilled: false } }), 1000, 5, noWait,
    );
    expect(out).toEqual({ state: ExecutionState.COMPLETED });
  });

  it('is not ready when it never got as far as starting', async () => {
    const out = await workerOutcome(worker({ started: false, liveness: { kind: 'running' } }), 0, 5, noWait);
    expect(out.state).toBe(ExecutionState.FAILED);
    expect(out.failure?.code).toBe(FailureCode.READINESS_TIMEOUT);
  });

  it('must still be up after the grace period, not only at the instant it started', async () => {
    let dead = false;
    const w = worker({ started: true, liveness: { kind: 'running' } });
    (w.handle as unknown as { liveness: () => Promise<ContainerLiveness> }).liveness = async () =>
      dead ? { kind: 'exited', exitCode: 1, oomKilled: false } : { kind: 'running' };
    // Crashes two seconds in: the grace period is what sees it.
    const out = await workerOutcome(w, 1000, 2000, async (ms) => { if (ms === 2000) dead = true; });
    expect(out.state).toBe(ExecutionState.FAILED);
  });

  it('is not called ready when its state cannot be read', async () => {
    const out = await workerOutcome(worker({ started: true, liveness: { kind: 'unknown', error: 'socket hang up' } }), 1000, 5, noWait);
    expect(out.state).toBe(ExecutionState.FAILED);
    expect(out.failure?.message).toMatch(/socket hang up/);
  });
});

describe('a project with a crashed worker', () => {
  it('is not READY, and names the worker', async () => {
    const web = {
      name: 'web', role: 'web', state: ExecutionState.STARTING, logs: new LogManager(),
      plan: { expectedPort: 5173 },
      handle: { waitForReady: async () => ({ state: ExecutionState.READY, url: 'http://localhost:5173/' }) },
    } as unknown as ServiceRun;
    const queue = worker({ started: true, exits: true, liveness: { kind: 'exited', exitCode: 1, oomKilled: false } });
    (queue as unknown as { plan: unknown }).plan = { expectedPort: null };
    const run = { services: [queue, web], backing: [], entry: () => web, cleanup: async () => ({ errors: [] }) } as unknown as ProjectRun;

    const out = await new ProjectExecutor({} as ExecutionManager).waitForReady(run, 1000);
    expect(out.state).toBe(ExecutionState.FAILED);
    expect(out.failure?.message).toMatch(/^queue: /);
  });
});

describe('a project whose one-off worker finished', () => {
  it('is READY: a job that exits 0 has done its work', async () => {
    const web = {
      name: 'web', role: 'web', state: ExecutionState.STARTING, logs: new LogManager(),
      plan: { expectedPort: 5173 },
      handle: { waitForReady: async () => ({ state: ExecutionState.READY, url: 'http://localhost:5173/' }) },
    } as unknown as ServiceRun;
    const job = worker({ started: true, exits: true, liveness: { kind: 'exited', exitCode: 0, oomKilled: false } });
    (job as unknown as { plan: unknown }).plan = { expectedPort: null };
    const run = { services: [job, web], backing: [], entry: () => web, cleanup: async () => ({ errors: [] }) } as unknown as ProjectRun;

    const out = await new ProjectExecutor({} as ExecutionManager).waitForReady(run, 1000);
    expect(out.state).toBe(ExecutionState.READY);
    expect(job.state).toBe(ExecutionState.COMPLETED);
  });
});
