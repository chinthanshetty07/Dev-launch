import { describe, it, expect } from 'vitest';
import { ExecutionState, FailureCode, RunPlanSchema, type RunPlan } from '@devlaunch/shared';
import { ExecutionManager } from '../services/execution/ExecutionManager.js';
import type { DockerManager } from '../services/docker/DockerManager.js';
import { LogManager } from '../services/logs/LogManager.js';

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
  state: string;
  failure: { code: string; confidence?: string; message: string; evidence?: string; remedy?: string };
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

  it('calls a container that exited 0 completed, not an unknown error', async () => {
    // Readiness is watching for a port. A repository that never opens one — a CLI, a
    // migration, a seeder — exits 0 having done its job, and this reported
    // `UNKNOWN_RUNTIME_ERROR: container exited before becoming ready`: a working program
    // described as broken, with no evidence and no remedy. runToCompletion had always
    // classified exit 0 correctly; only this path, which cannot tell "finished" from
    // "died" by watching a socket, did not.
    const exec = new ExecutionManager(
      stubDocker(async () => ({ State: { Running: false, ExitCode: 0 } })),
    );
    const sentinels = new Set(['__DEVLAUNCH:PHASE:START:BEGIN__']);
    const out = await explain(exec, [container, plan, sentinels, readiness, undefined]);
    expect(out.state).toBe('COMPLETED');
    expect(out.failure).toBeUndefined();
  });

  it('calls a planned server that exited 0 a failure, naming the port it never opened', async () => {
    // `hostBinding: 'forced'`: a framework DevLaunch recognised and told where to listen.
    // Stopping with 0 is not finishing — a CRA dev server closing on an empty stdin was
    // reported COMPLETED, "the expected shape for a script".
    const exec = new ExecutionManager(
      stubDocker(async () => ({ State: { Running: false, ExitCode: 0 } })),
    );
    const sentinels = new Set(['__DEVLAUNCH:PHASE:START:BEGIN__']);
    const server = { ...plan, hostBinding: 'forced' as const };
    const out = await explain(exec, [container, server, sentinels, readiness, undefined]);
    expect(out.state).toBe('FAILED');
    expect(out.failure.code).toBe(FailureCode.APPLICATION_EXITED);
    expect(out.failure.message).toBe(
      'The start command finished successfully instead of serving; nothing ever listened on port 3000.',
    );
  });

  it('calls an install killed by the kernel OUT_OF_MEMORY from Docker\'s flag, though the wrapper exited 110', async () => {
    // Measured: yarn killed inside the container leaves the wrapper exiting 110 — the
    // install-failed code — and sets OOMKilled, because the cgroup is shared.
    const exec = new ExecutionManager(
      stubDocker(async () => ({ State: { Running: false, ExitCode: 110, OOMKilled: true } })),
    );
    const sentinels = new Set(['__DEVLAUNCH:PHASE:INSTALL:BEGIN__', '__DEVLAUNCH:PHASE:INSTALL:FAIL__']);
    const out = await explain(exec, [container, plan, sentinels, readiness, undefined, 1024]);
    expect(out.state).toBe('FAILED');
    expect(out.failure.code).toBe(FailureCode.OUT_OF_MEMORY);
    expect(out.failure.message).toBe('Dependency installation was killed for exceeding the 1024 MB container memory limit.');
    expect((out.failure as { memory?: { detectedBy: string[] } }).memory?.detectedBy).toEqual(['docker: OOMKilled']);
  });

  it('does not call an install failure memory when Docker says it was not', async () => {
    const exec = new ExecutionManager(
      stubDocker(async () => ({ State: { Running: false, ExitCode: 110, OOMKilled: false } })),
    );
    const sentinels = new Set(['__DEVLAUNCH:PHASE:INSTALL:BEGIN__', '__DEVLAUNCH:PHASE:INSTALL:FAIL__']);
    const out = await explain(exec, [container, plan, sentinels, readiness, undefined, 1024]);
    expect(out.failure.code).toBe(FailureCode.DEPENDENCY_INSTALL_FAILED);
  });

  it('still attributes a genuinely exited container to its phase', async () => {
    const exec = new ExecutionManager(
      stubDocker(async () => ({ State: { Running: false, ExitCode: 1 } })),
    );

    const sentinels = new Set(['__DEVLAUNCH:PHASE:START:BEGIN__']);
    const out = await explain(exec, [container, plan, sentinels, readiness, undefined]);
    expect(out.state).toBe('FAILED');
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

describe('a running process that never bound its port', () => {
  const readiness = { ready: false, attempts: 3, elapsedMs: 5000 };
  const container = {} as never;

  it('carries the application\'s own error into the verdict', async () => {
    // `tsx watch` and every other watcher survive a crash in the code they watch, so the
    // container stays up and nothing binds. "Nothing is listening" was the entire
    // verdict, while the reason sat in the log two lines above it.
    // Deliberately an error no signature recognises, so this stays a test about
    // evidence rather than about classification.
    const logs = new LogManager();
    logs.buffer.push('stdout', '> tsx watch src/server.ts');
    logs.buffer.push('stderr', 'Error: config.yml is malformed at line 4');
    logs.buffer.push('stderr', '    at loadConfig (/workspace/src/config.ts:23:11)');
    // A crashing Node process signs off with its own version, which is true and useless.
    logs.buffer.push('stderr', 'Node.js v20.20.2');

    const exec = new ExecutionManager(
      stubDocker(async () => ({ State: { Running: true, ExitCode: 0 } })),
    );
    const out = await explain(exec, [container, plan, new Set(), readiness, logs]);

    expect(out.failure.code).toBe(FailureCode.PORT_NOT_LISTENING);
    expect(out.failure.evidence).toBe('Error: config.yml is malformed at line 4');
  });

  it('names the cause when the log gives one, instead of the symptom', async () => {
    // "Nothing is listening" is what DevLaunch observed; the log says why. A project
    // that drives Docker cannot run in a sandbox that withholds the socket, and no
    // amount of retrying or configuring changes that — so saying so is the whole value.
    const logs = new LogManager();
    logs.buffer.push('stderr', 'Error: No Docker socket found. Tried:');
    logs.buffer.push('stderr', '  /var/run/docker.sock');

    const exec = new ExecutionManager(
      stubDocker(async () => ({ State: { Running: true, ExitCode: 0 } })),
    );
    const out = await explain(exec, [container, plan, new Set(), readiness, logs]);

    expect(out.failure.code).toBe(FailureCode.DOCKER_SOCKET_REQUIRED);
    expect(out.failure.message).toMatch(/docker daemon/i);
  });

  it('keeps the port verdict when the log explains nothing', async () => {
    const logs = new LogManager();
    logs.buffer.push('stdout', 'compiling...');

    const exec = new ExecutionManager(
      stubDocker(async () => ({ State: { Running: true, ExitCode: 0 } })),
    );
    const out = await explain(exec, [container, plan, new Set(), readiness, logs]);
    expect(out.failure.code).toBe(FailureCode.PORT_NOT_LISTENING);
  });

  it('quotes the last line as a last line, never as an error', async () => {
    // This once offered no evidence at all rather than a line that might not be the
    // cause. The caution was right and the conclusion was wrong: with nothing quoted,
    // the report reads `Nothing is listening on port 3000.` and a person has nowhere to
    // go — which is exactly how it was reported from a real run. A process that never
    // bound has usually not errored, so demanding an error-shaped line means saying
    // nothing precisely when there is nothing else to say.
    //
    // What the original caution protects is still protected here: the line is offered as
    // the last thing printed, not as the cause.
    const logs = new LogManager();
    logs.buffer.push('stdout', 'listening soon, honest');

    const exec = new ExecutionManager(
      stubDocker(async () => ({ State: { Running: true, ExitCode: 0 } })),
    );
    const out = await explain(exec, [container, plan, new Set(), readiness, logs]);

    expect(out.failure.evidence).toBe('listening soon, honest');
    expect(out.failure.remedy).toMatch(/last thing it printed/i);
    // And it must not be described as the application's error, because it is not one.
    expect(out.failure.remedy).not.toMatch(/its last error/i);
  });
});
