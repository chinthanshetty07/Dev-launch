import { describe, it, expect } from 'vitest';
import { ExecutionState, FailureCode, RunPlanSchema, type RunPlan } from '@devlaunch/shared';
import { ExecutionManager } from '../services/execution/ExecutionManager.js';
import type { DockerManager } from '../services/docker/DockerManager.js';

const plan: RunPlan = RunPlanSchema.parse({
  runtime: { language: 'node', version: '20' },
  packageManager: 'npm',
  installCommand: null,
  buildCommand: null,
  startCommand: 'node server.js',
  workingDirectory: '.',
  expectedPort: 3000,
  planSource: 'rule-based',
});

/** Minimal DockerManager whose inspect behaviour a test controls. */
function stubDocker(inspect: () => Promise<unknown>): DockerManager {
  return {
    inspect,
    hostPortFor: async () => '12345',
    execCapture: async () => '',
  } as unknown as DockerManager;
}

interface Explained {
  failure: { code: string; confidence?: string; message: string; evidence?: string };
}

/** Reach the private attribution path directly; it is the branch under test. */
type Internals = {
  explainNotReady(...args: unknown[]): Promise<Explained>;
  containerState(
    container: unknown,
  ): Promise<{ running: boolean; exitCode: number; oomKilled?: boolean } | null>;
};

const internals = (exec: ExecutionManager) => exec as unknown as Internals;

function explain(exec: ExecutionManager, args: unknown[]): Promise<Explained> {
  return internals(exec).explainNotReady(...args);
}

describe('container state attribution', () => {
  const readiness = { ready: false, attempts: 3, elapsedMs: 5000 };
  const container = {} as never;

  it('reports an un-inspectable container as unknown, not as a phase failure', async () => {
    // Regression: inspect errors used to be swallowed into "not running", after which
    // the caller built a diagnosis from an exit code belonging to a container that was
    // very likely still alive. Under load a transient Docker API error is normal, so
    // that produced confident, wrong attribution.
    const exec = new ExecutionManager(
      stubDocker(async () => {
        throw new Error('EAI_AGAIN: docker socket busy');
      }),
    );

    const out = await explain(exec, [container, plan, new Set(), readiness, undefined]);
    expect(out.failure.code).toBe(FailureCode.UNKNOWN_RUNTIME_ERROR);
    // Saying "I do not know" is the honest answer, and it must be labelled as such.
    expect(out.failure.confidence).toBe('low');
    expect(out.failure.message).toMatch(/could not be inspected/i);
  });

  it('still attributes a genuinely exited container to its phase', async () => {
    const exec = new ExecutionManager(
      stubDocker(async () => ({ State: { Running: false, ExitCode: 1 } })),
    );

    const sentinels = new Set(['__DEVLAUNCH:PHASE:START:BEGIN__']);
    const out = await explain(exec, [container, plan, sentinels, readiness, undefined]);
    expect(out.failure.code).toBe(FailureCode.START_COMMAND_FAILED);
  });

  it('inspects once on success, so the state cannot change mid-check', async () => {
    let calls = 0;
    const exec = new ExecutionManager(
      stubDocker(async () => {
        calls++;
        return { State: { Running: false, ExitCode: 1 } };
      }),
    );

    await explain(exec, [container, plan, new Set(), readiness, undefined]);
    // A successful read is used as-is. Re-inspecting would reopen the race this closed.
    expect(calls).toBe(1);
  });

  it('retries a transient inspect failure before giving up', async () => {
    // Measured under load: the Docker API intermittently refuses a request while many
    // containers churn. Escalating the first refusal made a healthy app unattributable.
    let calls = 0;
    const exec = new ExecutionManager(
      stubDocker(async () => {
        calls++;
        if (calls < 3) throw new Error('socket hang up');
        return { State: { Running: true, ExitCode: 0 } };
      }),
    );

    const state = await internals(exec).containerState({});
    // Exact shape, not a subset: a field silently going missing is the kind of change
    // this assertion exists to catch.
    expect(state).toEqual({ running: true, exitCode: 0, oomKilled: false });
    expect(calls).toBe(3);
  });

  it('names why attribution failed when inspect never succeeds', async () => {
    const exec = new ExecutionManager(
      stubDocker(async () => {
        throw new Error('socket hang up');
      }),
    );
    const out = await explain(exec, [container, plan, new Set(), readiness, undefined]);
    // An unexplained "unknown" is only marginally better than a wrong answer.
    expect(out.failure.evidence).toContain('socket hang up');
  });
});

describe('readiness abort', () => {
  it('does not abort polling when the container state is unknown', async () => {
    // Aborting on "unknown" would cut readiness short for a perfectly healthy app
    // whenever the Docker API hiccuped.
    const exec = new ExecutionManager(
      stubDocker(async () => {
        throw new Error('socket busy');
      }),
    );
    await expect(internals(exec).containerState({})).resolves.toBeNull();

    // null?.running === false is false, so polling continues — which is the point.
    const aborted = (await internals(exec).containerState({}))?.running === false;
    expect(aborted).toBe(false);
  });
});
