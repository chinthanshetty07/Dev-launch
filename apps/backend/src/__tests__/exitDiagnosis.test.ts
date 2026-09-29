import { describe, it, expect } from 'vitest';
import { ExecutionState, FailureCode, RunPlanSchema, Sentinel, type RunPlan } from '@devlaunch/shared';
import { ExecutionManager } from '../services/execution/ExecutionManager.js';
import type { DockerManager } from '../services/docker/DockerManager.js';

/**
 * Why a container has no published port.
 *
 * Every assertion here is derived from the requirement — "a failure names the cause,
 * not the symptom" — rather than from the branch that implements it. The branch existed
 * before these tests and all four of its outcomes survived deletion, which is the only
 * reason this file is here.
 */

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

interface Failure {
  code: string;
  message: string;
  exitCode?: number;
  phase?: string;
  confidence?: string;
  memory?: { kind: string; detectedBy: string[] };
}

/**
 * Docker whose first inspect is the port lookup and whose second is the diagnosis.
 *
 * PortManager resolves the mapping through `inspect` too, so a single stub cannot
 * distinguish the two questions. The first answer here is always "alive, no mapping
 * published" — the state that sends the code into this branch in the first place — and
 * only the second is the test's. That ordering is not a convenience: it is the real
 * sequence, and the removal case genuinely is a container that goes away between them.
 */
function noPortDocker(then: () => Promise<unknown>): DockerManager {
  let first = true;
  return {
    inspect: async () => {
      if (first) {
        first = false;
        return { State: { Running: true, ExitCode: 0, OOMKilled: false }, NetworkSettings: { Ports: {} } };
      }
      return then();
    },
    execCapture: async () => '',
  } as unknown as DockerManager;
}

async function diagnose(inspect: () => Promise<unknown>, sentinels: string[] = []): Promise<{
  state: string;
  failure?: Failure;
}> {
  const exec = new ExecutionManager(noPortDocker(inspect));
  const internals = exec as unknown as {
    waitForReady(c: unknown, p: RunPlan, s: Set<string>, t?: number): Promise<{
      state: string;
      failure?: Failure;
    }>;
  };
  return internals.waitForReady({} as never, plan, new Set(sentinels), 500);
}

/** A Docker inspect result for a container that has stopped. */
const exited = (code: number, oom = false) => async () => ({
  State: { Running: false, ExitCode: code, OOMKilled: oom },
});

describe('why there is no published port', () => {
  it('names the OOM kill, because that is what the memory repair keys off', async () => {
    // The decisive case. A workspace service killed at 1024 MB reported "Docker
    // published no host mapping" — true, and a symptom. Because the memory repair
    // triggers on OUT_OF_MEMORY, the wrong code meant the one repair that would have
    // fixed the run never fired at all.
    //
    // Rewritten, not flipped: the phase used to be `install` whatever the container had
    // printed, and this test passed no markers at all. It is now read from the markers the
    // container did print, so the test gives it the evidence the real case had — an install
    // that began — and a sibling below holds the case the hardcoding got wrong.
    const out = await diagnose(exited(137, true), [Sentinel.INSTALL_BEGIN]);
    expect(out.state).toBe(ExecutionState.FAILED);
    expect(out.failure?.code).toBe(FailureCode.OUT_OF_MEMORY);
    expect(out.failure?.message).toMatch(/memory limit/i);
    expect(out.failure?.phase).toBe('install');
  });

  it('says a container killed after it started was killed in the start phase', async () => {
    const out = await diagnose(exited(137, true), [Sentinel.INSTALL_BEGIN, Sentinel.INSTALL_OK, Sentinel.START_BEGIN]);
    expect(out.failure?.code).toBe(FailureCode.OUT_OF_MEMORY);
    expect(out.failure?.phase).toBe('start');
    expect(out.failure?.memory?.kind).toBe('container');
    expect(out.failure?.memory?.detectedBy[0]).toBe('docker: OOMKilled');
  });

  it('reports an ordinary crash with the code the process actually exited on', async () => {
    const out = await diagnose(exited(1));
    expect(out.failure?.code).toBe(FailureCode.APPLICATION_EXITED);
    expect(out.failure?.exitCode).toBe(1);
    expect(out.failure?.message).toContain('exited with code 1');
  });

  it('does not describe a clean exit as a crash', async () => {
    // Exit 0 before listening is a real failure, but not the one a reader would go
    // looking for: nothing crashed and no error was printed. The start command ran to
    // completion, which means the plan is starting the wrong thing.
    const out = await diagnose(exited(0));
    expect(out.failure?.code).toBe(FailureCode.APPLICATION_EXITED);
    expect(out.failure?.exitCode).toBe(0);
    expect(out.failure?.message).toMatch(/finished successfully instead of serving/i);
    expect(out.failure?.message).not.toMatch(/exited with code/i);
  });

  it('does not invent an exit code for a container that was removed', async () => {
    // A 404 means cleanup swept it or the user stopped it. containerState returns the
    // -1 placeholder for that, and the first version of this branch dutifully reported
    // "the container exited with code -1" about a run the application never lost.
    const out = await diagnose(async () => {
      throw Object.assign(new Error('no such container'), { statusCode: 404 });
    });
    expect(out.failure?.message).not.toContain('-1');
    expect(out.failure?.code).not.toBe(FailureCode.APPLICATION_EXITED);
    expect(out.failure?.code).not.toBe(FailureCode.OUT_OF_MEMORY);
  });

  it('says so when Docker stopped the container without reporting a code', async () => {
    // The second source of the -1 placeholder, and the one the removal guard does not
    // cover: inspect succeeds, the container is down, and State.ExitCode is absent.
    // Printing the placeholder would report a code the daemon never gave us.
    const out = await diagnose(async () => ({
      State: { Running: false, OOMKilled: false },
    }));
    expect(out.failure?.code).toBe(FailureCode.APPLICATION_EXITED);
    expect(out.failure?.message).toMatch(/no exit code/i);
    expect(out.failure?.message).not.toContain('-1');
    expect(out.failure?.exitCode).toBeUndefined();
  });

  it('still reports the missing mapping when the container is alive', async () => {
    // The pre-existing behaviour, which this branch must not have swallowed: a running
    // container with no mapping really is a port problem.
    const out = await diagnose(async () => ({
      State: { Running: true, ExitCode: 0, OOMKilled: false },
    }));
    expect(out.failure?.code).toBe(FailureCode.PORT_NOT_LISTENING);
  });

  it('does not attribute a phase failure when inspect itself fails', async () => {
    const out = await diagnose(async () => {
      throw new Error('EAI_AGAIN: docker socket busy');
    });
    expect(out.failure?.code).not.toBe(FailureCode.APPLICATION_EXITED);
    expect(out.failure?.code).not.toBe(FailureCode.OUT_OF_MEMORY);
  });
});
