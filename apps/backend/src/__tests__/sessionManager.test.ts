import { describe, it, expect, beforeEach } from 'vitest';
import {
  ExecutionState,
  FailureCode,
  RunPlanSchema,
  TERMINAL_STATES,
  type RunPlan,
} from '@devlaunch/shared';
import { config } from '../config/index.js';
import { SessionManager, SessionConflict } from '../services/session/SessionManager.js';
import type {
  ContainerLiveness,
  ExecutionManager,
  LaunchHandle,
  ReadyOutcome,
} from '../services/execution/ExecutionManager.js';
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

/** Records what a fake handle was asked to do, so the session's side of the contract is checkable. */
interface HandleSpy {
  budgetCleared: number;
  cleanups: number;
  livenessCalls: number;
  /** Probes in flight, for diagnosis. Transient overlap across a re-arm is expected. */
  inFlight: number;
  maxInFlight: number;
}

/** Stands in for the real launcher so session bookkeeping can be tested without Docker. */
function fakeExec(
  outcome: () => ReadyOutcome,
  opts: { liveness?: () => Promise<ContainerLiveness>; spy?: HandleSpy } = {},
): ExecutionManager {
  return {
    async launch(launchOpts: { logs?: LogManager }) {
      const logs = launchOpts.logs ?? new LogManager();
      logs.buffer.push('stdout', 'fake output');
      return {
        logs,
        waitForReady: async () => outcome(),
        // Omitted entirely unless a test asks for it, so the liveness watch has to cope
        // with a handle that cannot answer.
        ...(opts.liveness
          ? {
              liveness: async () => {
                const spy = opts.spy;
                if (spy) {
                  spy.livenessCalls++;
                  spy.inFlight++;
                  spy.maxInFlight = Math.max(spy.maxInFlight, spy.inFlight);
                }
                try {
                  return await opts.liveness!();
                } finally {
                  if (spy) spy.inFlight--;
                }
              },
            }
          : {}),
        clearStartupBudget: () => {
          if (opts.spy) opts.spy.budgetCleared++;
        },
        cleanup: async () => {
          if (opts.spy) opts.spy.cleanups++;
          return { errors: [] };
        },
      } as unknown as LaunchHandle;
    },
  } as unknown as ExecutionManager;
}

const ready = (): ReadyOutcome => ({
  state: ExecutionState.READY,
  hostPort: '1234',
  url: 'http://localhost:1234/',
  readiness: { ready: true, attempts: 1, elapsedMs: 1, status: 200 },
});

const spy = (): HandleSpy =>
  ({ budgetCleared: 0, cleanups: 0, livenessCalls: 0, inFlight: 0, maxInFlight: 0 });

/** Wait for a condition the liveness watch will bring about, without a fixed sleep. */
async function until(predicate: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
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
    // The name claims an interaction between eviction pressure and a live session, so
    // the test has to create that pressure. Previously it only proved a lone session
    // survived in isolation, which eviction never threatened.
    const stalled = new SessionManager(
      fakeExec(() => new Promise<ReadyOutcome>(() => {}) as unknown as ReadyOutcome),
    );
    const active = await stalled.launch({ plan: plan(), sourceDir: '/tmp', image: 'devlaunch/node:20' });
    await settle();

    // Force finished sessions past the retention cap alongside the active one.
    const finished = new SessionManager(fakeExec(failed));
    for (let i = 0; i < config.concurrency.retainFinished + 3; i++) {
      await finished.launch({ plan: plan(), sourceDir: '/tmp', image: 'devlaunch/node:20' });
      await settle();
    }
    (stalled as unknown as { evictFinished(): void }).evictFinished();

    expect(stalled.get(active.id), 'an active session must never be evicted').toBeDefined();
    await stalled.shutdown();
    await finished.shutdown();
  });
});

describe('READY liveness', () => {
  it('ends a session whose container died after it became ready', async () => {
    // Readiness is a measurement taken once, not a promise. Before this watch existed a
    // session went on reporting READY — and handing out a URL that answered nothing —
    // until the idle clock expired half an hour later.
    let alive = true;
    const s1 = spy();
    const mgr = new SessionManager(fakeExec(ready, {
      spy: s1,
      liveness: async () =>
        alive ? { kind: 'running' } : { kind: 'exited', exitCode: 1, oomKilled: false },
    }), { livenessIntervalMs: 10 });

    const s = await mgr.launch({ plan: plan(), sourceDir: '/tmp', image: 'devlaunch/node:20' });
    await settle();
    expect(s.state).toBe(ExecutionState.READY);
    expect(s.url).toBe('http://localhost:1234/');

    alive = false;
    await until(() => s.state !== ExecutionState.READY);

    expect(s.state).toBe(ExecutionState.FAILED);
    expect(s.failure?.code).toBe(FailureCode.APPLICATION_EXITED);
    // A dead URL must not still be advertised; that is the whole point.
    expect(s.url).toBeUndefined();
    // And the container has to be released, or the watch has merely relabelled a leak.
    expect(s1.cleanups).toBeGreaterThan(0);
    await mgr.shutdown();
  });

  it('keeps a session READY while the Docker API is unreadable', async () => {
    // The failure mode this guards against is worse than the one it detects: flipping a
    // healthy session to FAILED on a transient socket error would make the tool lie
    // about the user's application every time the daemon was busy.
    const s1 = spy();
    const mgr = new SessionManager(
      fakeExec(ready, { spy: s1, liveness: async () => ({ kind: 'unknown', error: 'socket hang up' }) }),
      { livenessIntervalMs: 5 },
    );
    const s = await mgr.launch({ plan: plan(), sourceDir: '/tmp', image: 'devlaunch/node:20' });
    await settle();

    await until(() => s1.livenessCalls >= 4);
    expect(s.state).toBe(ExecutionState.READY);
    expect(s.url).toBe('http://localhost:1234/');

    // Reported once per run of failures, not once per poll: at the real five-second
    // interval a line every tick would bury the application's own output.
    const complaints = s.logs.buffer.all().filter((l) => /could not read the container state/.test(l.text));
    expect(complaints.length).toBe(1);
    await mgr.shutdown();
  });

  it('calls a clean exit completion rather than failure', async () => {
    let alive = true;
    const mgr = new SessionManager(fakeExec(ready, {
      liveness: async () =>
        alive ? { kind: 'running' } : { kind: 'exited', exitCode: 0, oomKilled: false },
    }), { livenessIntervalMs: 10 });
    const s = await mgr.launch({ plan: plan(), sourceDir: '/tmp', image: 'devlaunch/node:20' });
    await settle();

    alive = false;
    await until(() => s.state !== ExecutionState.READY);
    expect(s.state).toBe(ExecutionState.COMPLETED);
    expect(s.failure).toBeUndefined();
    await mgr.shutdown();
  });

  it('releases the time-to-ready budget once the application is ready', async () => {
    // The budget stops the container when it elapses. Correct for a container that
    // never became ready; for one that did it is a ten-minute ceiling on a session the
    // lifetime clock believes it has an hour to run.
    const s1 = spy();
    const mgr = new SessionManager(fakeExec(ready, { spy: s1 }), { livenessIntervalMs: 10 });
    await mgr.launch({ plan: plan(), sourceDir: '/tmp', image: 'devlaunch/node:20' });
    await settle();
    expect(s1.budgetCleared).toBe(1);
    await mgr.shutdown();
  });

  it('does not accumulate watchers when the session is polled', async () => {
    // touch() re-arms the lifetime on every GET /api/sessions/:id, and each re-arm
    // starts a watch. The old watch's probe is already in flight, so it survives the
    // timer sweep and re-schedules itself into the new list — an actively-polled session
    // gains a watcher for every touch that lands mid-probe.
    //
    // A probe that takes real time is what makes that window exist, so this fake takes
    // 15 ms against a 5 ms interval. Concurrency is the sharp assertion: a single watch
    // schedules its next probe only after the last one returns, so probes never overlap.
    const s1 = spy();
    const mgr = new SessionManager(
      fakeExec(ready, {
        spy: s1,
        liveness: async () => {
          await new Promise((r) => setTimeout(r, 15));
          return { kind: 'running' };
        },
      }),
      { livenessIntervalMs: 5 },
    );
    const s = await mgr.launch({ plan: plan(), sourceDir: '/tmp', image: 'devlaunch/node:20' });
    await settle();

    for (let i = 0; i < 30; i++) {
      mgr.touch(s.id);
      await new Promise((r) => setTimeout(r, 6));
    }
    // Let every watch that was mid-probe when the polling stopped finish and decide
    // whether it re-schedules. Transient overlap during the polling is expected; what
    // must not survive it is more than one watch still running.
    await new Promise((r) => setTimeout(r, 100));

    const before = s1.livenessCalls;
    await new Promise((r) => setTimeout(r, 200));
    const probes = s1.livenessCalls - before;

    // One watch probes at roughly (15 ms probe + 5 ms interval), so ~10 times in 200 ms.
    // Measured without the generation guard: 39, from four surviving watches.
    expect(probes, `probes in 200 ms after polling stopped: ${probes}`).toBeLessThan(16);
    expect(s.state).toBe(ExecutionState.READY);
    await mgr.shutdown();
  });

  it('stops polling once the session is torn down', async () => {
    // An unref'd timer that reschedules itself forever would keep a finished session's
    // log buffer alive, which is the leak eviction exists to prevent.
    const s1 = spy();
    const mgr = new SessionManager(
      fakeExec(ready, { spy: s1, liveness: async () => ({ kind: 'running' }) }),
      { livenessIntervalMs: 5 },
    );
    const s = await mgr.launch({ plan: plan(), sourceDir: '/tmp', image: 'devlaunch/node:20' });
    await settle();
    await until(() => s1.livenessCalls >= 2);

    await mgr.stop(s.id, 'stopped');
    const after = s1.livenessCalls;
    await new Promise((r) => setTimeout(r, 60));
    expect(s1.livenessCalls).toBe(after);
    await mgr.shutdown();
  });
});

describe('repair and the reported diagnosis', () => {
  it('reports the original diagnosis when repair does not help', async () => {
    // Measured against the real pipeline: two live repairs of a fixture that hardcodes
    // 127.0.0.1 landed on a different start command each run, so the failure the user
    // finally saw was a diagnosis of whatever the model had last invented. The
    // repository's actual problem — a loopback bind no plan can change — was discarded.
    const outcomes: ReadyOutcome[] = [
      {
        state: ExecutionState.FAILED,
        hostPort: null,
        readiness: { ready: false, attempts: 1, elapsedMs: 1 },
        failure: { code: FailureCode.PORT_BOUND_TO_LOCALHOST, message: 'Bind 0.0.0.0 instead.' },
      },
      {
        state: ExecutionState.FAILED,
        hostPort: null,
        readiness: { ready: false, attempts: 1, elapsedMs: 1 },
        failure: { code: FailureCode.START_COMMAND_FAILED, message: 'the model broke it' },
      },
    ];
    let attempt = 0;
    const exec = fakeExec(() => outcomes[Math.min(attempt++, outcomes.length - 1)]!);

    let repairs = 0;
    // Repair needs the repository metadata it reasons about, so the session has to come
    // through the analyse-and-plan path rather than being handed a plan directly.
    const mgr = new SessionManager(exec, {
      analyzer: { analyze: async () => ({ envExample: [], warnings: [] }) } as never,
      planner: {
        planRepository: async () => ({
          plan: { ...plan(), environmentVariables: [] },
          detected: 'node',
          warnings: [],
        }),
      } as never,
      aiRepair: {
        repair: async () => ({
          plan: { ...plan(), startCommand: `node other-${++repairs}.js` },
          attempt: repairs,
          note: 'guessing',
        }),
      } as never,
    });

    const s = await mgr.launch({ sourceDir: '/tmp', image: 'devlaunch/node:20' });
    await until(() => s.state === ExecutionState.FAILED, 3000);

    // Two attempts ran: a rule first (the loopback bind has a known fix and needs no
    // model), then one model call. This once demanded two model calls, which is the
    // "two retries for every failure" shape the repair policy replaced.
    expect(s.repairAttempts?.length, 'the repair loop must actually have run').toBe(2);
    expect(s.repairs?.map((r) => r.source)).toEqual(['deterministic', 'ai']);
    expect(repairs, 'the model is asked once').toBe(1);
    expect(s.failure?.code).toBe(FailureCode.PORT_BOUND_TO_LOCALHOST);
    expect(s.failure?.message).toMatch(/Bind 0\.0\.0\.0 instead/);
    // What the attempts produced is still visible, just not presented as the cause.
    const trail = s.logs.buffer.all().map((l) => l.text).join('\n');
    expect(trail).toMatch(/Reporting the original diagnosis/);
    expect(trail).toMatch(/START_COMMAND_FAILED/);
    // The hard ceiling: a rule and a model make two attempts, and a third failure stops
    // at the cap rather than starting another of either.
    expect(trail).toMatch(/Repair limit of 2 reached/);
    await mgr.shutdown();
  });

  it('does not show an error against an application repair fixed', async () => {
    // The first failure is now retained so repair cannot bury it. That retention must
    // end at READY: a working application showing the diagnosis of an attempt that was
    // subsequently fixed would be worse than the problem it solves.
    const outcomes: ReadyOutcome[] = [
      {
        state: ExecutionState.FAILED,
        hostPort: null,
        readiness: { ready: false, attempts: 1, elapsedMs: 1 },
        failure: { code: FailureCode.PORT_BOUND_TO_LOCALHOST, message: 'loopback' },
      },
      ready(),
    ];
    let attempt = 0;
    const mgr = new SessionManager(
      fakeExec(() => outcomes[Math.min(attempt++, outcomes.length - 1)]!),
      {
        analyzer: { analyze: async () => ({ envExample: [], warnings: [] }) } as never,
        planner: {
          planRepository: async () => ({
            plan: { ...plan(), environmentVariables: [] },
            detected: 'node',
            warnings: [],
          }),
        } as never,
        aiRepair: {
          repair: async () => ({ plan: { ...plan(), startCommand: 'node fixed.js' }, attempt: 1 }),
        } as never,
      },
    );

    const s = await mgr.launch({ sourceDir: '/tmp', image: 'devlaunch/node:20' });
    await until(() => s.state === ExecutionState.READY, 3000);
    expect(s.state).toBe(ExecutionState.READY);
    expect(s.failure, 'a ready session must not carry a failure').toBeUndefined();
    await mgr.shutdown();
  });

  it('reports the only diagnosis there is when no repair ran', async () => {
    const mgr = new SessionManager(fakeExec(failed));
    const s = await mgr.launch({ plan: plan(), sourceDir: '/tmp', image: 'devlaunch/node:20' });
    await settle();
    expect(s.state).toBe(ExecutionState.FAILED);
    expect(s.failure?.code).toBe('PORT_NOT_LISTENING');
    await mgr.shutdown();
  });
});

describe('a session that never becomes ready', () => {
  it('releases the only run slot instead of holding it forever', async () => {
    // What the error "a session is already running" was really reporting: a session
    // whose containers were gone sat non-terminal with nothing to end it. The lifetime
    // clock starts at READY and the time-to-ready budget belongs to a container, so
    // nothing bounded the session itself — and with no way to list sessions, the only
    // cure was restarting the backend.
    const mgr = new SessionManager(
      fakeExec(() => new Promise<ReadyOutcome>(() => {}) as unknown as ReadyOutcome),
      { startupBoundMs: 80 },
    );
    const s = await mgr.launch({ plan: plan(), sourceDir: '/tmp', image: 'devlaunch/node:20' });
    await settle();
    expect(s.state).not.toBe(ExecutionState.FAILED);

    await until(() => s.state === ExecutionState.FAILED, 3000);
    expect(s.failure?.code).toBe(FailureCode.PROCESS_TIMEOUT);
    expect(s.failure?.message).toMatch(/never became ready/i);

    // The point of the backstop: another launch can now proceed.
    const next = await mgr.launch({ plan: plan(), sourceDir: '/tmp', image: 'devlaunch/node:20' });
    expect(next.id).not.toBe(s.id);
    await mgr.shutdown();
  });

  it('does not cut short a session that is ready', async () => {
    const mgr = new SessionManager(fakeExec(ready, { liveness: async () => ({ kind: 'running' }) }), {
      startupBoundMs: 60,
      livenessIntervalMs: 20,
    });
    const s = await mgr.launch({ plan: plan(), sourceDir: '/tmp', image: 'devlaunch/node:20' });
    await settle();
    expect(s.state).toBe(ExecutionState.READY);

    await new Promise((r) => setTimeout(r, 200));
    expect(s.state, 'READY hands over to the lifetime clock').toBe(ExecutionState.READY);
    await mgr.shutdown();
  });

  it('does not cut short a session waiting on a person', async () => {
    // AWAITING_INPUT has its own bound and is blocked on an answer, not stuck.
    const analyzer = {
      analyze: async () => ({ envExample: [{ key: 'X', hasDefault: false }], warnings: [] }),
    };
    const planner = {
      planRepository: async () => ({
        plan: { ...plan(), environmentVariables: [] },
        detected: 'node',
        warnings: [],
      }),
    };
    const mgr = new SessionManager(fakeExec(failed), {
      analyzer: analyzer as never,
      planner: planner as never,
      startupBoundMs: 60,
      awaitingInputMs: 60_000,
    });
    const s = await mgr.launch({ sourceDir: '/tmp' });
    await settle();
    expect(s.state).toBe(ExecutionState.AWAITING_INPUT);

    await new Promise((r) => setTimeout(r, 200));
    expect(s.state).toBe(ExecutionState.AWAITING_INPUT);
    await mgr.shutdown();
  });

  it('names the session standing in the way of a launch', async () => {
    // A message that states a constraint and offers no way to act on it is what made
    // this unrecoverable from the UI.
    const mgr = new SessionManager(
      fakeExec(() => new Promise<ReadyOutcome>(() => {}) as unknown as ReadyOutcome),
    );
    const first = await mgr.launch({ plan: plan(), sourceDir: '/tmp', image: 'devlaunch/node:20' });
    await settle();

    await expect(
      mgr.launch({ plan: plan(), sourceDir: '/tmp', image: 'devlaunch/node:20' }),
    ).rejects.toMatchObject({ activeSessionId: first.id });

    expect(mgr.active().map((x) => x.id)).toEqual([first.id]);
    await mgr.shutdown();
  });
});

/** A Docker stub that records what was asked of it, so provisioning is observable. */
function fakeDocker(created: string[]) {
  return {
    ensureImage: async () => undefined,
    networkExists: async () => false,
    createBackingContainer: async (o: { image: string }) => {
      created.push(o.image);
      return { id: 'db' } as never;
    },
    start: async () => undefined,
    stop: async () => undefined,
    remove: async () => undefined,
    // The readiness poll: "1" is what mongosh and pg_isready print on success.
    execCapture: async () => '1',
  };
}

describe('a failure that outlived its plan', () => {
  it('says how many times the plan was rewritten after the diagnosis was taken', async () => {
    // The first diagnosis is kept on purpose: it describes the repository, where every
    // later one describes a plan the model invented. The cost is that the plan on screen
    // is no longer the plan the failure came from — a real dashboard showed
    // `uvicorn --port 8080` beside "Nothing is listening on port 8000" with nothing to
    // connect them. Two numbers that cannot both be right is how a tool teaches someone
    // to stop reading it and just retry.
    const mgr = new SessionManager(fakeExec(failed), {
      aiRepair: {
        repair: async ({ previousAttempts }: { previousAttempts: RunPlan[] }) => ({
          plan: RunPlanSchema.parse({ ...plan(), startCommand: `node retry-${previousAttempts.length}.js` }),
          attempt: previousAttempts.length + 1,
          note: 'test',
        }),
      } as never,
      analyzer: { analyze: async () => ({}) } as never,
      planner: { planRepository: async () => ({ plan: plan(), detected: 'x', warnings: [] }) } as never,
    });

    const session = await mgr.launch({ sourceDir: '/tmp/repo', image: 'devlaunch/node:20' });
    await until(() => session.state === ExecutionState.FAILED);

    // One rewrite, not two: a model is asked at most once per failure class. The second
    // attempt used to be a second model guess, and the guesses did not converge.
    expect(session.repairAttempts?.length).toBe(1);
    expect(session.failure?.repairAttemptsAfter).toBe(1);
    // And the diagnosis itself is still the original one, not a repaired plan's.
    expect(session.failure?.code).toBe('PORT_NOT_LISTENING');
    await mgr.shutdown();
  });

  it('says nothing about repairs when there were none', async () => {
    const mgr = new SessionManager(fakeExec(failed));
    const session = await mgr.launch({ plan: plan(), sourceDir: '/tmp', image: 'devlaunch/node:20' });
    await settle();
    expect(session.failure?.repairAttemptsAfter).toBeUndefined();
    await mgr.shutdown();
  });
});

describe('a single service that needs a database', () => {
  /** Metadata as the analyzer reports it for a lone Python API depending on asyncpg. */
  const analyzed = {
    analyze: async () => ({
      backing: [
        {
          kind: 'postgres' as const,
          evidence: 'depends on asyncpg',
          driver: 'asyncpg',
          urlEnvKeys: ['DATABASE_URL'],
          neededBy: [],
        },
      ],
    }),
  };
  const planned = {
    planRepository: async () => ({ plan: plan(), detected: 'fastapi', warnings: [] }),
  };

  it('starts one, and tells the application where it is', async () => {
    // The gap this closes: provisioning lived in the multi-service path only, so a lone
    // API detected as needing Postgres started with no server and no connection string.
    // Nothing reported a problem — the application simply crashed on its own first query,
    // and the repair loop then invented `postgresql://user:pass@db:5432/dbname` to fill
    // the silence, which no amount of retrying could have made reachable.
    const created: string[] = [];
    let launchedWith: RunPlan['environmentVariables'] = [];

    const exec = fakeExec(ready) as ExecutionManager & { docker: unknown };
    exec.docker = fakeDocker(created) as never;
    const launch = exec.launch.bind(exec);
    exec.launch = async (opts: { plan: RunPlan; logs?: LogManager }) => {
      launchedWith = opts.plan.environmentVariables;
      return launch(opts as never);
    };

    const mgr = new SessionManager(exec, {
      analyzer: analyzed as never,
      planner: planned as never,
    });
    const session = await mgr.launch({ sourceDir: '/tmp/repo', image: 'devlaunch/python:3.12' });
    await settle();

    expect(created, 'a postgres container was started').toEqual(['postgres:16']);
    // Async driver, because the repository named one. `postgresql://` reaches psycopg2
    // and dies with "the asyncio extension requires an async driver" against a database
    // that is running and correct.
    expect(launchedWith).toContainEqual({
      key: 'DATABASE_URL',
      value: 'postgresql+asyncpg://postgres:devlaunch@postgres:5432/repo',
      required: false,
    });
    expect(session.state).toBe(ExecutionState.READY);
    await mgr.shutdown();
  });

  it('does not report a ninety-second database wait as checking commands', async () => {
    // Validation is synchronous and had already finished. Provisioning waits for a
    // database to accept connections, which on a cold MySQL is most of a minute — and
    // the dashboard said "Checking the commands against the security allowlist" for all
    // of it, which is a state lying about what it is doing.
    const created: string[] = [];
    const seen: ExecutionState[] = [];

    const exec = fakeExec(ready) as ExecutionManager & { docker: unknown };
    const docker = fakeDocker(created);
    let stateWhenProvisioning: ExecutionState | undefined;
    exec.docker = {
      ...docker,
      createBackingContainer: async (o: { image: string }) => {
        stateWhenProvisioning = seen[seen.length - 1];
        return docker.createBackingContainer(o);
      },
    } as never;

    const mgr = new SessionManager(exec, { analyzer: analyzed as never, planner: planned as never });
    mgr.on('state', (updated: { state: ExecutionState }) => seen.push(updated.state));
    const session = await mgr.launch({ sourceDir: '/tmp/repo', image: 'devlaunch/python:3.12' });
    await settle();

    expect(session.state).toBe(ExecutionState.READY);
    expect(stateWhenProvisioning).toBe(ExecutionState.STARTING);
    await mgr.shutdown();
  });

  it('overrules a connection string the plan invented', async () => {
    // Taken from a real run. The AI fallback planned a lone FastAPI service and filled in
    // `DATABASE_URL=postgresql://user:pass@db:5432/dbname` — a host that does not exist,
    // credentials that were never real. Left to win, it produced three start attempts and
    // three different tracebacks: the field missing, then psycopg2 missing, then psycopg2
    // being the wrong driver. None of them were the problem, and none could be repaired.
    const created: string[] = [];
    let launchedWith: RunPlan['environmentVariables'] = [];

    const exec = fakeExec(ready) as ExecutionManager & { docker: unknown };
    exec.docker = fakeDocker(created) as never;
    const launch = exec.launch.bind(exec);
    exec.launch = async (opts: { plan: RunPlan; logs?: LogManager }) => {
      launchedWith = opts.plan.environmentVariables;
      return launch(opts as never);
    };

    const invented = {
      planRepository: async () => ({
        plan: RunPlanSchema.parse({
          ...plan(),
          planSource: 'ai-fallback',
          environmentVariables: [
            { key: 'DATABASE_URL', value: 'postgresql://user:pass@db:5432/dbname', required: true },
          ],
        }),
        detected: null,
        warnings: [],
      }),
    };

    const mgr = new SessionManager(exec, {
      analyzer: analyzed as never,
      planner: invented as never,
    });
    await mgr.launch({ sourceDir: '/tmp/repo', image: 'devlaunch/python:3.12' });
    await settle();

    expect(launchedWith.filter((v) => v.key === 'DATABASE_URL')).toEqual([
      {
        key: 'DATABASE_URL',
        value: 'postgresql+asyncpg://postgres:devlaunch@postgres:5432/repo',
        required: false,
      },
    ]);
    await mgr.shutdown();
  });

  it('keeps the same database across a repair, and re-injects its URL', async () => {
    // Two failures in one. A repair replaces the application container and re-enters the
    // start path: provisioning again would orphan the first Postgres and hand the retry
    // an empty one under the same alias. But the repair also replaces the *plan* with one
    // the model wrote, which carries no connection string — so the injection has to run
    // again, or the retry is handed a database it cannot find and the loop then diagnoses
    // the absence it just caused.
    const created: string[] = [];
    const launches: string[] = [];

    const exec = fakeExec(failed) as ExecutionManager & { docker: unknown };
    exec.docker = fakeDocker(created) as never;
    const launch = exec.launch.bind(exec);
    exec.launch = async (opts: { plan: RunPlan; logs?: LogManager }) => {
      launches.push(
        opts.plan.environmentVariables.find((v) => v.key === 'DATABASE_URL')?.value ?? 'absent',
      );
      return launch(opts as never);
    };

    const mgr = new SessionManager(exec, {
      analyzer: analyzed as never,
      planner: planned as never,
      aiRepair: {
        // A model rewriting the plan from scratch, which is what repair actually does.
        repair: async ({ previousAttempts }: { previousAttempts: RunPlan[] }) => ({
          plan: RunPlanSchema.parse({
            ...plan(),
            startCommand: `node retry-${previousAttempts.length}.js`,
            planSource: 'ai-fallback',
          }),
          attempt: previousAttempts.length + 1,
          note: 'test',
        }),
      } as never,
    });
    const session = await mgr.launch({ sourceDir: '/tmp/repo', image: 'devlaunch/python:3.12' });
    await until(() => session.state === ExecutionState.FAILED);

    expect(session.repairAttempts?.length, 'the repair loop ran').toBeGreaterThan(0);
    expect(created, 'one database, however many attempts').toEqual(['postgres:16']);
    // Every attempt, including the repaired ones, knows where the database is.
    expect(launches.length).toBeGreaterThan(1);
    expect(new Set(launches)).toEqual(
      new Set(['postgresql+asyncpg://postgres:devlaunch@postgres:5432/repo']),
    );
    await mgr.shutdown();
  });
});

describe('how a failure is repaired', () => {
  const analyzed = { analyze: async () => ({ warnings: [], envExample: [], lockfiles: [], frameworkConfigs: [] }) };
  const planned = { planRepository: async () => ({ plan: plan(), detected: 'x', warnings: [] }) };
  const aiSpy = () => {
    const calls: number[] = [];
    return {
      calls,
      repair: {
        repair: async ({ previousAttempts }: { previousAttempts: RunPlan[] }) => {
          calls.push(previousAttempts.length);
          return {
            plan: RunPlanSchema.parse({ ...plan(), startCommand: `node ai-${previousAttempts.length}.js` }),
            attempt: previousAttempts.length + 1,
          };
        },
      } as never,
    };
  };

  it('never asks the model about a failure a person has to fix', async () => {
    const missing = (): ReadyOutcome => ({
      state: ExecutionState.FAILED, hostPort: null,
      readiness: { ready: false, attempts: 1, elapsedMs: 1 },
      failure: { code: 'MISSING_ENV', message: 'A required environment variable is not set: GROQ_API_KEY' } as ReadyOutcome['failure'],
    });
    const ai = aiSpy();
    const mgr = new SessionManager(fakeExec(missing), { analyzer: analyzed as never, planner: planned as never, aiRepair: ai.repair });
    const session = await mgr.launch({ sourceDir: '/tmp/repo', image: 'devlaunch/node:20' });
    await until(() => session.state === ExecutionState.FAILED);

    expect(ai.calls).toEqual([]);
    expect(session.repairAttempts ?? []).toEqual([]);
    expect(session.logs.buffer.all().map((l) => l.text).join('\n')).toMatch(/Not repairing MISSING_ENV: a secret has to come from a person/);
    await mgr.shutdown();
  });

  it('lets a rule with evidence go first, and spends no model call on it', async () => {
    // The log says which port opened. A rule reads it; a model would have guessed.
    const exec = fakeExec(failed);
    const launch = exec.launch.bind(exec);
    const ports: (number | null)[] = [];
    exec.launch = async (opts: { plan: RunPlan; logs?: LogManager }) => {
      ports.push(opts.plan.expectedPort);
      const h = await launch(opts as never);
      opts.logs?.buffer.push('stderr', 'INFO:     Uvicorn running on http://0.0.0.0:8080 (Press CTRL+C to quit)');
      return h;
    };
    const ai = aiSpy();
    const mgr = new SessionManager(exec, { analyzer: analyzed as never, planner: planned as never, aiRepair: ai.repair });
    const session = await mgr.launch({ sourceDir: '/tmp/repo', image: 'devlaunch/node:20' });
    await until(() => session.state === ExecutionState.FAILED);

    expect(ports[0]).toBe(3000);
    expect(ports[1], 'the retry watched the port the log named').toBe(8080);
    expect(session.repairs?.[0]).toMatchObject({ source: 'deterministic', type: 'PORT_CORRECTION' });
    // The rule's retry also failed, so the model got its one call — after, not instead.
    expect(ai.calls).toEqual([1]);
    expect(session.repairs?.[1]?.source).toBe('ai');
    await mgr.shutdown();
  });

  it('asks the model once per failure class, not once per attempt', async () => {
    const ai = aiSpy();
    const mgr = new SessionManager(fakeExec(failed), { analyzer: analyzed as never, planner: planned as never, aiRepair: ai.repair });
    const session = await mgr.launch({ sourceDir: '/tmp/repo', image: 'devlaunch/node:20' });
    await until(() => session.state === ExecutionState.FAILED);

    expect(ai.calls).toEqual([0]);
    expect(session.logs.buffer.all().map((l) => l.text).join('\n')).toMatch(/budget of 1 call\(s\) is spent/);
    await mgr.shutdown();
  });
});

describe('a program that is not a server', () => {
  const completed = (): ReadyOutcome => ({
    state: ExecutionState.COMPLETED,
    hostPort: null,
    readiness: { ready: false, attempts: 1, elapsedMs: 1 },
  });

  it('reports it as completed, with no failure and no repair', async () => {
    // Not every repository is a server. A CLI, a migration, a seeder, a scraper all run
    // and stop, and readiness — watching for a port that is never going to open — called
    // that `UNKNOWN_RUNTIME_ERROR: container exited before becoming ready`: a working
    // program reported as broken, with no evidence and no remedy. runToCompletion had
    // always classified exit 0 correctly; only this path did not.
    let repaired = 0;
    const mgr = new SessionManager(fakeExec(completed), {
      analyzer: { analyze: async () => ({ warnings: [], envExample: [] }) } as never,
      planner: { planRepository: async () => ({ plan: plan(), detected: 'node', warnings: [] }) } as never,
      aiRepair: { repair: async () => { repaired++; return { plan: plan(), attempt: 1 }; } } as never,
    });
    const session = await mgr.launch({ sourceDir: '/tmp/repo', image: 'devlaunch/node:20' });
    await until(() => session.state === ExecutionState.COMPLETED);

    expect(session.state).toBe(ExecutionState.COMPLETED);
    expect(session.failure).toBeUndefined();
    expect(repaired, 'a program that worked is not repaired').toBe(0);
    expect(session.logs.buffer.all().map((l) => l.text).join('\n')).toMatch(/ran to completion and exited 0/);
    await mgr.shutdown();
  });
});

describe('repairing a project, not only a lone service', () => {
  /**
   * Until this existed a project got no repair at all: a failed service went straight to
   * FAILED and teardown, so the whole repair architecture served only repositories that
   * happened to contain one service. A frontend calling an API is the ordinary shape of
   * a web project, and it was the one shape with no second chance.
   */
  const service = (name: string, role: 'web' | 'api', port: number) => ({
    ...plan(),
    name,
    role,
    expectedPort: port,
  });

  const projectMeta = {
    warnings: [],
    envExample: [],
    lockfiles: [],
    frameworkConfigs: [],
    services: [
      { name: 'web', dir: 'frontend', role: 'web', language: 'node', scripts: ['dev'], evidence: 'x' },
      { name: 'api', dir: 'backend', role: 'api', language: 'node', scripts: ['dev'], evidence: 'x' },
    ],
  };

  /**
   * An ExecutionManager whose `api` service opens 9001 rather than the 4000 it was
   * planned on, and whose `web` service is fine.
   */
  function projectExec(opts: { apiRecovers: boolean }) {
    const launches: { name: string; port: number | null }[] = [];
    const waits: string[] = [];
    const cleanups: string[] = [];
    const budgetsCleared: string[] = [];
    let apiAttempt = 0;

    const exec = {
      docker: {
        networkExists: async () => false,
        claimedAliases: async () => new Set<string>(),
      },
      async launch(o: { plan: { name?: string; expectedPort: number | null }; logs?: LogManager }) {
        const name = o.plan.name ?? 'single';
        launches.push({ name, port: o.plan.expectedPort });
        const isApi = name === 'api';
        if (isApi) apiAttempt++;
        const fixed = isApi && opts.apiRecovers && o.plan.expectedPort === 9001;
        return {
          logs: o.logs ?? new LogManager(),
          waitForReady: async (): Promise<ReadyOutcome> => (
            waits.push(name),
            !isApi || fixed
              ? { state: ExecutionState.READY, hostPort: '1234', url: 'http://localhost:1234/', readiness: { ready: true, attempts: 1, elapsedMs: 1 } }
              : {
                  state: ExecutionState.FAILED,
                  hostPort: '1234',
                  readiness: { ready: false, attempts: 1, elapsedMs: 1 },
                  failure: {
                    code: FailureCode.PORT_NOT_LISTENING,
                    message: 'Nothing is listening on port 4000.',
                    observedSocket: { address: '0.0.0.0', port: 9001, loopbackOnly: false },
                  },
                }),
          clearStartupBudget: () => { budgetsCleared.push(name); },
          cleanup: async () => (cleanups.push(name), { errors: [] }),
        } as unknown as LaunchHandle;
      },
    } as unknown as ExecutionManager;

    return { exec, launches, waits, cleanups, budgetsCleared, apiAttempts: () => apiAttempt };
  }

  const deps = (exec: ExecutionManager) =>
    new SessionManager(exec, {
      analyzer: { analyze: async () => projectMeta } as never,
      planner: { planRepository: async () => ({ plan: null, detected: null, warnings: [] }) } as never,
      projectPlanner: {
        planProject: async () => ({
          plan: { services: [service('api', 'api', 4000), service('web', 'web', 5173)], planSource: 'rule-based' },
          skipped: [],
          warnings: [],
        }),
      } as never,
    });

  it('repairs the one service that failed and leaves its siblings running', async () => {
    const { exec, launches, waits } = projectExec({ apiRecovers: true });
    const mgr = deps(exec);
    const session = await mgr.launch({ sourceDir: '/tmp/repo' });
    await until(() => session.state === ExecutionState.READY || session.state === ExecutionState.FAILED);

    expect(session.state).toBe(ExecutionState.READY);
    expect(session.repairs?.[0]).toMatchObject({ source: 'deterministic', type: 'PORT_CORRECTION', service: 'api' });
    // The web service was started once. Repairing a sibling must not cost it its
    // container and several minutes of install.
    expect(launches.filter((l) => l.name === 'web')).toHaveLength(1);
    expect(launches.filter((l) => l.name === 'api').map((l) => l.port)).toEqual([4000, 9001]);
    // Nor is it waited on again: re-polling a service that is already serving traffic
    // spends the readiness budget proving what is already known.
    expect(waits.filter((n) => n === 'web')).toHaveLength(1);
    await mgr.shutdown();
  });

  it('still stops at the repair ceiling when the rule does not help', async () => {
    // The subject here is the ceiling: the loop must stop rather than thrash. It used
    // to end in FAILED, and that was how "stopped" was expressed rather than what was
    // being tested — stopping now leaves the web service up, because tearing down a
    // container that works to announce that a sibling does not is not a way of
    // stopping, it is a second failure. The diagnosis is still the api's, and it is
    // still the first one taken.
    const { exec, apiAttempts } = projectExec({ apiRecovers: false });
    const mgr = deps(exec);
    const session = await mgr.launch({ sourceDir: '/tmp/repo' });
    await until(
      () => session.state === ExecutionState.PARTIALLY_READY || session.state === ExecutionState.FAILED,
      8000,
    );

    expect(session.state).toBe(ExecutionState.PARTIALLY_READY);
    // One repair, then the same proposal again — which the progress check refuses.
    expect(apiAttempts()).toBeLessThanOrEqual(1 + config.ai.maxRepairAttempts);
    expect(session.failure?.message).toMatch(/api/);
    await mgr.shutdown();
  });

  it('does not ask a model to rewrite one service of a project', async () => {
    // Its siblings were already told this service's address, and a model rewriting the
    // plan is exactly what would invalidate that.
    const { exec } = projectExec({ apiRecovers: false });
    const calls: number[] = [];
    const mgr = new SessionManager(exec, {
      analyzer: { analyze: async () => projectMeta } as never,
      planner: { planRepository: async () => ({ plan: null, detected: null, warnings: [] }) } as never,
      projectPlanner: {
        planProject: async () => ({
          plan: { services: [service('api', 'api', 4000), service('web', 'web', 5173)], planSource: 'rule-based' },
          skipped: [],
          warnings: [],
        }),
      } as never,
      aiRepair: { repair: async () => { calls.push(1); throw new Error('should not be called'); } } as never,
    });
    const session = await mgr.launch({ sourceDir: '/tmp/repo' });
    await until(() => session.state === ExecutionState.FAILED, 8000);

    expect(calls).toEqual([]);
    await mgr.shutdown();
  });
});

describe('a bind address written into the source', () => {
  it('refuses to repair it, and says which line to change', async () => {
    // `app.listen(port, 'localhost')` is not configuration. No variable, flag or
    // rewritten start command reaches it, so repair can only spend its attempts proving
    // that — at a full reinstall each.
    const loopback = (): ReadyOutcome => ({
      state: ExecutionState.FAILED,
      hostPort: '1234',
      readiness: { ready: false, attempts: 1, elapsedMs: 1 },
      failure: {
        code: FailureCode.PORT_BOUND_TO_LOCALHOST,
        message: 'The application is listening on ::1:8017.',
      } as ReadyOutcome['failure'],
    });
    const calls: number[] = [];
    const mgr = new SessionManager(fakeExec(loopback), {
      analyzer: {
        analyze: async () => ({
          warnings: [], envExample: [], lockfiles: [], frameworkConfigs: [],
          hardcodedBind: { file: 'src/server.js', line: "const hostname = 'localhost'" },
        }),
      } as never,
      planner: { planRepository: async () => ({ plan: plan(), detected: 'express', warnings: [] }) } as never,
      aiRepair: { repair: async () => { calls.push(1); throw new Error('should not be called'); } } as never,
    });
    const session = await mgr.launch({ sourceDir: '/tmp/repo', image: 'devlaunch/node:20' });
    await until(() => session.state === ExecutionState.FAILED);

    expect(calls).toEqual([]);
    expect(session.repairAttempts ?? []).toEqual([]);
    expect(session.failure?.remedy).toMatch(/src\/server\.js/);
    expect(session.logs.buffer.all().map((l) => l.text).join('\n')).toMatch(/hardcodes the bind address/);
    await mgr.shutdown();
  });

  it('still repairs a loopback bind that is not a literal', async () => {
    // `--host 127.0.0.1` in a start command is configuration, and configuration is
    // exactly what a rule can change. Refusing here would stop a repair that works.
    const loopback = (): ReadyOutcome => ({
      state: ExecutionState.FAILED,
      hostPort: '1234',
      readiness: { ready: false, attempts: 1, elapsedMs: 1 },
      failure: {
        code: FailureCode.PORT_BOUND_TO_LOCALHOST,
        message: 'The application is listening on 127.0.0.1:3000.',
      } as ReadyOutcome['failure'],
    });
    const mgr = new SessionManager(fakeExec(loopback), {
      analyzer: { analyze: async () => ({ warnings: [], envExample: [], lockfiles: [], frameworkConfigs: [] }) } as never,
      planner: {
        planRepository: async () => ({
          plan: RunPlanSchema.parse({ ...plan(), startCommand: 'npm run dev -- --host 127.0.0.1' }),
          detected: 'vite',
          warnings: [],
        }),
      } as never,
    });
    const session = await mgr.launch({ sourceDir: '/tmp/repo', image: 'devlaunch/node:20' });
    await until(() => session.state === ExecutionState.FAILED);

    expect(session.repairs?.[0]).toMatchObject({ type: 'HOST_BINDING_CORRECTION' });
    await mgr.shutdown();
  });
});

describe('a database image the repository names', () => {
  /**
   * The approval check reads the repository name and adopts whatever tag follows, which
   * is how one compose file's `postgres:15.1-alpine` was started under the hardening
   * profile — non-root, read-only rootfs, every capability dropped — where its entrypoint
   * chmods the data directory and exits 1. The application then started, was handed a
   * connection string, and failed with `could not translate host name "postgres"`,
   * because the alias belonged to a container that no longer existed.
   */
  const analyzed = (image: string) => ({
    analyze: async () => ({
      backing: [
        { kind: 'postgres' as const, evidence: 'docker-compose declares db', image, urlEnvKeys: ['DATABASE_URL'], neededBy: [] },
      ],
    }),
  });
  const planned = { planRepository: async () => ({ plan: plan(), detected: 'fastapi', warnings: [] }) };

  /** A Docker whose named image never becomes ready, and whose own image does. */
  function pickyDocker(created: string[], workingImage: string) {
    let current = '';
    return {
      ensureImage: async () => undefined,
      networkExists: async () => true,
      createBackingContainer: async (o: { image: string }) => {
        created.push(o.image);
        current = o.image;
        return { id: o.image } as never;
      },
      start: async () => undefined,
      stop: async () => undefined,
      remove: async () => undefined,
      logTail: async () => 'chmod: /var/lib/postgresql/data: Operation not permitted',
      execCapture: async () => (current === workingImage ? 'accepting connections' : ''),
    };
  }

  it('falls back to the image DevLaunch verifies when the named one will not start', async () => {
    const created: string[] = [];
    const exec = fakeExec(ready) as ExecutionManager & { docker: unknown };
    exec.docker = pickyDocker(created, 'postgres:16') as never;

    const mgr = new SessionManager(exec, {
      analyzer: analyzed('postgres:15.1-alpine') as never,
      planner: planned as never,
      backingReadyMs: 60,
    });
    const session = await mgr.launch({ sourceDir: '/tmp/repo', image: 'devlaunch/python:3.12' });
    await until(() => session.state === ExecutionState.READY, 5000);

    expect(created).toEqual(['postgres:15.1-alpine', 'postgres:16']);
    expect(session.state).toBe(ExecutionState.READY);
    await mgr.shutdown();
  }, 120_000);

  it('says why, rather than quietly running something else', async () => {
    // A repository asking for pgvector and quietly getting plain Postgres fails later on
    // its first `CREATE EXTENSION`, and deserves to know which it got.
    const created: string[] = [];
    const exec = fakeExec(ready) as ExecutionManager & { docker: unknown };
    exec.docker = pickyDocker(created, 'postgres:16') as never;

    const mgr = new SessionManager(exec, {
      analyzer: analyzed('postgres:15.1-alpine') as never,
      planner: planned as never,
      backingReadyMs: 60,
    });
    const session = await mgr.launch({ sourceDir: '/tmp/repo', image: 'devlaunch/python:3.12' });
    await until(() => session.state === ExecutionState.READY, 5000);

    const log = session.logs.buffer.all().map((l) => l.text).join('\n');
    expect(log).toMatch(/did not start under the sandbox profile/);
    expect(log).toMatch(/Operation not permitted/);
    expect(log).toMatch(/Falling back to postgres:16/);
    await mgr.shutdown();
  }, 120_000);

  it('does not restart its own image when that is the one that failed', async () => {
    // The fallback exists because a *named* tag is unverified. Re-running the verified
    // one after it has already failed starts a second container to watch it fail again.
    const created: string[] = [];
    const exec = fakeExec(ready) as ExecutionManager & { docker: unknown };
    exec.docker = pickyDocker(created, 'nothing-works') as never;

    const mgr = new SessionManager(exec, {
      analyzer: { analyze: async () => ({ backing: [
        { kind: 'postgres' as const, evidence: 'depends on psycopg2', urlEnvKeys: ['DATABASE_URL'], neededBy: [] },
      ] }) } as never,
      planner: planned as never,
      backingReadyMs: 60,
    });
    const session = await mgr.launch({ sourceDir: '/tmp/repo', image: 'devlaunch/python:3.12' });
    await until(() => session.state === ExecutionState.READY, 5000);

    expect(created).toEqual(['postgres:16']);
    await mgr.shutdown();
  }, 120_000);

  it('does not start a second container when the named image works', async () => {
    const created: string[] = [];
    const exec = fakeExec(ready) as ExecutionManager & { docker: unknown };
    exec.docker = pickyDocker(created, 'pgvector/pgvector:pg16') as never;

    const mgr = new SessionManager(exec, {
      analyzer: analyzed('pgvector/pgvector:pg16') as never,
      planner: planned as never,
      backingReadyMs: 60,
    });
    const session = await mgr.launch({ sourceDir: '/tmp/repo', image: 'devlaunch/python:3.12' });
    await until(() => session.state === ExecutionState.READY, 5000);

    expect(created).toEqual(['pgvector/pgvector:pg16']);
    await mgr.shutdown();
  }, 120_000);
});

describe('rewriting a hardcoded database URL, behind the flag', () => {
  /**
   * Off by default: "run this project" and "change this project" are different promises.
   * With `DEVLAUNCH_REWRITE_SOURCE` set, the one literal analysis identified is pointed
   * at the database DevLaunch actually started.
   */
  const withFlag = async <T>(value: boolean, run: () => Promise<T>): Promise<T> => {
    const { config } = await import('../config/index.js');
    const original = config.rewriteSource;
    Object.defineProperty(config, 'rewriteSource', { value, configurable: true, writable: true });
    try {
      return await run();
    } finally {
      Object.defineProperty(config, 'rewriteSource', { value: original, configurable: true, writable: true });
    }
  };

  async function repoWithHardcodedUrl(): Promise<string> {
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'devlaunch-hard-'));
    await writeFile(
      join(dir, 'database.py'),
      'SQLALCHEMY_DATABASE_URL = "postgresql://postgres:test1234@localhost/TodoDb"\n',
    );
    return dir;
  }

  const analyzed = (root: string) => ({
    analyze: async () => ({
      warnings: [], envExample: [], lockfiles: [], frameworkConfigs: [], root,
      python: {
        requirements: [], hasPyproject: false, hasPipfile: false, hasManagePy: false,
        entryCandidates: [],
        hardcodedDatabaseUrl: {
          file: 'database.py',
          url: 'postgresql://postgres:test1234@localhost/TodoDb',
        },
      },
      backing: [
        { kind: 'postgres' as const, evidence: 'the source hardcodes a postgres URL', urlEnvKeys: [], neededBy: [] },
      ],
    }),
  });
  const planned = { planRepository: async () => ({ plan: plan(), detected: 'fastapi', warnings: [] }) };

  it('points the literal at the database it started', async () => {
    const root = await repoWithHardcodedUrl();
    const created: string[] = [];
    const exec = fakeExec(ready) as ExecutionManager & { docker: unknown };
    exec.docker = fakeDocker(created) as never;

    const session = await withFlag(true, async () => {
      const mgr = new SessionManager(exec, { analyzer: analyzed(root) as never, planner: planned as never });
      const s = await mgr.launch({ sourceDir: root, image: 'devlaunch/python:3.12' });
      // Stands in for having cloned it: only a clone is DevLaunch's to edit.
      s.ownsSource = true;
      await until(() => s.state === ExecutionState.READY, 5000);
      await mgr.shutdown();
      return s;
    });

    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const after = await readFile(join(root, 'database.py'), 'utf8');
    expect(after).toContain('@postgres:5432/');
    expect(after).not.toContain('@localhost/');
    expect(session.rewrites?.[0]?.file).toBe('database.py');
  });

  it('never redacts nothing: the log shows the change without the password', async () => {
    // The log is copied into bug reports, and the password in the literal may be a real
    // credential its author pasted.
    const root = await repoWithHardcodedUrl();
    const created: string[] = [];
    const exec = fakeExec(ready) as ExecutionManager & { docker: unknown };
    exec.docker = fakeDocker(created) as never;

    const session = await withFlag(true, async () => {
      const mgr = new SessionManager(exec, { analyzer: analyzed(root) as never, planner: planned as never });
      const s = await mgr.launch({ sourceDir: root, image: 'devlaunch/python:3.12' });
      s.ownsSource = true;
      await until(() => s.state === ExecutionState.READY, 5000);
      await mgr.shutdown();
      return s;
    });

    const log = session.logs.buffer.all().map((l) => l.text).join('\n');
    expect(log).toMatch(/Rewrote database\.py/);
    expect(log).toMatch(/your own checkout is untouched/i);
    expect(log).not.toContain('test1234');
  });

  it('refuses to touch a directory it did not clone, flag or no flag', async () => {
    // The promise every rewrite message makes is "your own checkout is untouched". A
    // `sourceDir` launch runs against a directory that already existed, so there is no
    // clone and that promise would be false. A live run proved it: this repository's own
    // fixture came back from a test rewritten and staged in git.
    const root = await repoWithHardcodedUrl();
    const created: string[] = [];
    const exec = fakeExec(ready) as ExecutionManager & { docker: unknown };
    exec.docker = fakeDocker(created) as never;

    const session = await withFlag(true, async () => {
      const mgr = new SessionManager(exec, { analyzer: analyzed(root) as never, planner: planned as never });
      // `launch({ sourceDir })` never sets ownsSource; only cloning does.
      const s = await mgr.launch({ sourceDir: root, image: 'devlaunch/python:3.12' });
      await until(() => s.state === ExecutionState.READY, 5000);
      await mgr.shutdown();
      return s;
    });

    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    expect(await readFile(join(root, 'database.py'), 'utf8')).toContain('@localhost/TodoDb');
    expect(session.rewrites).toBeUndefined();
    expect(session.logs.buffer.all().map((l) => l.text).join('\n')).toMatch(
      /your working copy, not ours/,
    );
  });

  it('marks a cloned directory as its own to edit', async () => {
    // The two tests above set this by hand; without something asserting that cloning
    // sets it, the flag could be on, the clone ours, and nothing would ever be rewritten.
    const root = await repoWithHardcodedUrl();
    const created: string[] = [];
    const exec = fakeExec(ready) as ExecutionManager & { docker: unknown };
    exec.docker = fakeDocker(created) as never;

    const session = await withFlag(true, async () => {
      const mgr = new SessionManager(exec, {
        analyzer: analyzed(root) as never,
        planner: planned as never,
        git: {
          clone: async () => ({ dir: root, url: 'https://github.com/x/y', fileCount: 1, sizeBytes: 1, cleanup: async () => undefined }),
        } as never,
      });
      const s = await mgr.launch({ repoUrl: 'https://github.com/x/y', image: 'devlaunch/python:3.12' });
      await until(() => s.state === ExecutionState.READY, 5000);
      await mgr.shutdown();
      return s;
    });

    expect(session.ownsSource).toBe(true);
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    expect(await readFile(join(root, 'database.py'), 'utf8')).toContain('@postgres:5432/');
  });

  it('changes nothing at all with the flag off', async () => {
    const root = await repoWithHardcodedUrl();
    const created: string[] = [];
    const exec = fakeExec(ready) as ExecutionManager & { docker: unknown };
    exec.docker = fakeDocker(created) as never;

    const session = await withFlag(false, async () => {
      const mgr = new SessionManager(exec, { analyzer: analyzed(root) as never, planner: planned as never });
      const s = await mgr.launch({ sourceDir: root, image: 'devlaunch/python:3.12' });
      await until(() => s.state === ExecutionState.READY, 5000);
      await mgr.shutdown();
      return s;
    });

    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    expect(await readFile(join(root, 'database.py'), 'utf8')).toContain('@localhost/TodoDb');
    expect(session.rewrites).toBeUndefined();
  });
});

/**
 * Stopping a run, from the outside, while it is still going.
 *
 * Nothing in the pipeline is interruptible: `cancel` removes the containers and sets the
 * state, and the `await` chain that was mid-install knows none of it. It carried on,
 * found its container gone and reported a crash — so a live run cancelled at
 * WAITING_FOR_READY answered `{"state":"CANCELLED"}` and then, five seconds later, said
 * the project had failed with UNKNOWN_RUNTIME_ERROR. The person who pressed Stop was
 * told their project had crashed.
 */
describe('stopping a session that is still running', () => {
  /** A launcher whose readiness wait blocks until the test releases it. */
  function gatedExec(
    outcome: () => ReadyOutcome,
    gate: Promise<void>,
    counters: { launches: number },
  ): ExecutionManager {
    return {
      async launch(launchOpts: { logs?: LogManager }) {
        counters.launches++;
        const logs = launchOpts.logs ?? new LogManager();
        return {
          logs,
          waitForReady: async () => {
            await gate;
            return outcome();
          },
          clearStartupBudget: () => undefined,
          cleanup: async () => ({ errors: [] }),
        } as unknown as LaunchHandle;
      },
    } as unknown as ExecutionManager;
  }

  it('stays CANCELLED when the pipeline finishes after the stop', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const counters = { launches: 0 };
    const mgr = new SessionManager(gatedExec(failed, gate, counters));

    const s = await mgr.launch({ plan: plan(), sourceDir: '/tmp', image: 'devlaunch/node:20' });
    await until(() => s.state === ExecutionState.WAITING_FOR_READY);
    expect(s.state).toBe(ExecutionState.WAITING_FOR_READY);

    await mgr.cancel(s.id);
    expect(s.state).toBe(ExecutionState.CANCELLED);

    // The step that was in flight now completes, and reports a failure nobody asked for.
    release();
    await settle();

    expect(s.state, 'a stopped session must not be re-stated by the run it was stopping').toBe(
      ExecutionState.CANCELLED,
    );
    expect(s.endedReason).toBe('cancelled by request');
    // Not merely the right state with the wrong story attached: a person who pressed
    // Stop should not find a diagnosis of their project sitting underneath it.
    expect(s.failure?.code).not.toBe(FailureCode.UNKNOWN_RUNTIME_ERROR);
    await mgr.shutdown();
  });

  it('does not start a replacement container for a session that was stopped', async () => {
    // The race this closes is not hypothetical: `teardown` awaits Docker, and the
    // pipeline step that was in flight reaches its next boundary during that wait. So
    // the gate is released from inside cleanup — the step resumes while the stop is
    // still happening, which is exactly when it used to relaunch.
    //
    // PORT_NOT_LISTENING is repairable by rule, and this session is analysed and
    // planned rather than handed a plan, so `tryRepair` has the metadata it needs and
    // genuinely would rewrite the plan and launch again. The second container would be
    // an orphan: nobody is watching it and nothing left will clean it up.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let launches = 0;

    const exec = {
      async launch(launchOpts: { logs?: LogManager }) {
        launches++;
        const logs = launchOpts.logs ?? new LogManager();
        return {
          logs,
          waitForReady: async () => { await gate; return failed(); },
          clearStartupBudget: () => undefined,
          cleanup: async () => { release(); return { errors: [] }; },
        } as unknown as LaunchHandle;
      },
    } as unknown as ExecutionManager;

    const mgr = new SessionManager(exec, {
      analyzer: { analyze: async () => ({ warnings: [], envExample: [], lockfiles: [], frameworkConfigs: [] }) } as never,
      planner: { planRepository: async () => ({ plan: plan(), detected: 'express', warnings: [] }) } as never,
    });

    const s = await mgr.launch({ sourceDir: '/tmp/repo', image: 'devlaunch/node:20' });
    await until(() => s.state === ExecutionState.WAITING_FOR_READY);
    await mgr.cancel(s.id);
    await settle();

    expect(launches, 'a stopped session must not be repaired into a new container').toBe(1);
    // Not merely that no container appeared: no repair was *attempted*. The rewritten
    // plan is the work, and a session nobody is waiting for should not cost one — nor,
    // where the policy allows it, a model call to produce one.
    expect(s.repairAttempts ?? [], 'a stopped session must not be repaired at all').toEqual([]);
    expect(s.state).toBe(ExecutionState.CANCELLED);
    await mgr.shutdown();
  });

  it('starts nothing at all when the stop lands before the run does', async () => {
    // Stopping during analysis or planning should cost nothing. There is no container
    // yet, so honouring the stop means declining to make one — which is cheaper and
    // safer than making it and cleaning up after, and is the only version that works
    // when teardown has already run.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let launches = 0;
    const exec = {
      async launch() {
        launches++;
        return {
          logs: new LogManager(),
          waitForReady: async () => ready(),
          clearStartupBudget: () => undefined,
          cleanup: async () => ({ errors: [] }),
        } as unknown as LaunchHandle;
      },
    } as unknown as ExecutionManager;

    const mgr = new SessionManager(exec, {
      analyzer: { analyze: async () => { await gate; return { warnings: [], envExample: [], lockfiles: [], frameworkConfigs: [] }; } } as never,
      planner: { planRepository: async () => ({ plan: plan(), detected: 'express', warnings: [] }) } as never,
    });

    const s = await mgr.launch({ sourceDir: '/tmp/repo', image: 'devlaunch/node:20' });
    await until(() => s.state === ExecutionState.ANALYZING);
    await mgr.cancel(s.id);
    release();
    await settle();

    expect(launches, 'nothing should be started for a session stopped before it ran').toBe(0);
    expect(s.state).toBe(ExecutionState.CANCELLED);
    await mgr.shutdown();
  });

  it('spends no model call on a session that was stopped', async () => {
    // What the launch gate cannot catch. Repair asks the model *before* it re-enters
    // the run, so a stopped session would still pay for a rewritten plan it will never
    // use — money and thirty seconds, for an answer nobody is waiting for.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const calls: number[] = [];
    const exec = {
      async launch(launchOpts: { logs?: LogManager }) {
        const logs = launchOpts.logs ?? new LogManager();
        return {
          logs,
          waitForReady: async () => { await gate; return failed(); },
          clearStartupBudget: () => undefined,
          cleanup: async () => { release(); return { errors: [] }; },
        } as unknown as LaunchHandle;
      },
    } as unknown as ExecutionManager;

    const mgr = new SessionManager(exec, {
      analyzer: { analyze: async () => ({ warnings: [], envExample: [], lockfiles: [], frameworkConfigs: [] }) } as never,
      planner: { planRepository: async () => ({ plan: plan(), detected: 'express', warnings: [] }) } as never,
      aiRepair: {
        repair: async ({ previousAttempts }: { previousAttempts: RunPlan[] }) => {
          calls.push(previousAttempts.length);
          return { plan: RunPlanSchema.parse({ ...plan(), startCommand: 'node ai.js' }), attempt: 1 };
        },
      } as never,
    });

    const s = await mgr.launch({ sourceDir: '/tmp/repo', image: 'devlaunch/node:20' });
    await until(() => s.state === ExecutionState.WAITING_FOR_READY);
    await mgr.cancel(s.id);
    await settle();

    expect(calls, 'a stopped session must not be diagnosed by a model').toEqual([]);
    expect(s.state).toBe(ExecutionState.CANCELLED);
    await mgr.shutdown();
  });

  it('frees the slot when a READY session is stopped', async () => {
    // What the Stop button on a running application is for. Until it existed the only
    // route was to launch something else, be refused, and stop it from the error.
    const spied = spy();
    const mgr = new SessionManager(fakeExec(ready, { spy: spied }));
    const s = await mgr.launch({ plan: plan(), sourceDir: '/tmp', image: 'devlaunch/node:20' });
    await until(() => s.state === ExecutionState.READY);

    await mgr.cancel(s.id);

    expect(s.state).toBe(ExecutionState.CANCELLED);
    expect(spied.cleanups, 'the container must be removed, not merely forgotten').toBeGreaterThan(0);
    // The slot is the point: a second launch was refused until this one ended.
    const next = await mgr.launch({ plan: plan(), sourceDir: '/tmp', image: 'devlaunch/node:20' });
    expect(next.id).not.toBe(s.id);
    await mgr.shutdown();
  });
});

/**
 * A project where one service will not start, and the rest are fine.
 *
 * Which is the ordinary shape of a real failure, not an edge case. Of the repositories
 * this was measured against, two failed exactly here: `school-management-system`, whose
 * requirements.txt lists a package that does not exist on PyPI, and
 * `sern-compose-template`, whose backend exits 1. Both had a frontend that had been
 * serving for a minute, and both had it removed — for a reason that had nothing to do
 * with it, leaving a person who wanted to look at it with nothing to look at.
 */
describe('a project that is partly running', () => {
  const projectMeta = {
    warnings: [], envExample: [], lockfiles: [], frameworkConfigs: [],
    services: [
      { name: 'web', dir: 'frontend', role: 'web', language: 'node', scripts: ['dev'], evidence: 'x' },
      { name: 'api', dir: 'backend', role: 'api', language: 'node', scripts: ['dev'], evidence: 'x' },
    ],
  };

  const svc = (name: string, role: string, port: number) =>
    ({ ...RunPlanSchema.parse({
      runtime: { language: 'node', version: '20' },
      packageManager: 'npm', installCommand: null, buildCommand: null,
      startCommand: `npm run dev --port ${port}`, workingDirectory: name,
      expectedPort: port, planSource: 'rule-based',
    }), name, role }) as never;

  /** `api` never starts however it is planned; `web` is always fine. */
  function exec() {
    const cleanups: string[] = [];
    const budgets: string[] = [];
    return {
      cleanups,
      budgets,
      manager: {
        docker: { networkExists: async () => false, claimedAliases: async () => new Set<string>() },
        async launch(o: { plan: { name?: string; expectedPort: number | null }; logs?: LogManager }) {
          const name = o.plan.name ?? 'single';
          const ok = name !== 'api';
          return {
            logs: o.logs ?? new LogManager(),
            waitForReady: async (): Promise<ReadyOutcome> =>
              ok
                ? { state: ExecutionState.READY, hostPort: '5173', url: `http://localhost:5173/`, readiness: { ready: true, attempts: 1, elapsedMs: 1 } }
                : {
                    state: ExecutionState.FAILED, hostPort: '4000',
                    readiness: { ready: false, attempts: 1, elapsedMs: 1 },
                    failure: { code: FailureCode.START_COMMAND_FAILED, message: 'api: Start command exited with code 1.' },
                  },
            clearStartupBudget: () => { budgets.push(name); },
            cleanup: async () => (cleanups.push(name), { errors: [] }),
          } as unknown as LaunchHandle;
        },
      } as unknown as ExecutionManager,
    };
  }

  const manager = (e: ExecutionManager, warnings: string[] = []) =>
    new SessionManager(e, {
      analyzer: { analyze: async () => projectMeta } as never,
      planner: { planRepository: async () => ({ plan: null, detected: null, warnings: [] }) } as never,
      projectPlanner: {
        planProject: async () => ({
          plan: { services: [svc('api', 'api', 4000), svc('web', 'web', 5173)], planSource: 'rule-based' },
          skipped: [{ name: 'worker', reason: 'no plan could be produced' }],
          warnings,
        }),
      } as never,
    });

  async function run(warnings: string[] = []) {
    const e = exec();
    const mgr = manager(e.manager, warnings);
    const session = await mgr.launch({ sourceDir: '/tmp/repo' });
    await until(
      () => session.state === ExecutionState.PARTIALLY_READY || session.state === ExecutionState.FAILED,
      8000,
    );
    return { session, mgr, ...e };
  }

  it('keeps the services that work, and says which one does not', async () => {
    const { session, cleanups, mgr } = await run();

    expect(session.state).toBe(ExecutionState.PARTIALLY_READY);
    // The whole point: nothing was torn down. A working container and the minutes of
    // install behind it are not a reasonable price for announcing a sibling's failure.
    expect(cleanups).toEqual([]);
    expect(session.url).toBe('http://localhost:5173/');
    // And the failure is still reported. Keeping what works is not the same as
    // pretending the run succeeded.
    expect(session.failure?.message).toMatch(/api/);
    await mgr.shutdown();
  });

  it('is not terminal, so it can still be stopped and still holds the slot', async () => {
    // It owns containers. A state that reads as finished while holding a port and the
    // only session slot is how a session becomes unreachable.
    const { session, mgr, cleanups } = await run();
    expect(TERMINAL_STATES.includes(session.state)).toBe(false);

    await mgr.cancel(session.id);
    expect(session.state).toBe(ExecutionState.CANCELLED);
    expect(cleanups.length).toBeGreaterThan(0);
    await mgr.shutdown();
  });

  it('spares the survivors the startup ceiling they did meet', async () => {
    // The budget stops a container that never became ready. These did, so leaving it
    // armed stops them ten minutes later for a thing they are not guilty of.
    const { session, budgets, mgr } = await run();
    expect(budgets).toContain('web');
    expect(session.readyAt).toBeGreaterThan(0);
    await mgr.shutdown();
  });

  it('is not abandoned by the backstop for a readiness it did reach', async () => {
    // The startup bound exists for a session that is not progressing at all. A partly
    // running one has progressed as far as it is going to and owns live containers, so
    // it hands over to the lifetime clock exactly as a wholly ready one does. Left in
    // the bound's care it is torn down minutes later for a failure already reported.
    const e = exec();
    const mgr = new SessionManager(e.manager, {
      analyzer: { analyze: async () => projectMeta } as never,
      planner: { planRepository: async () => ({ plan: null, detected: null, warnings: [] }) } as never,
      projectPlanner: {
        planProject: async () => ({
          plan: { services: [svc('api', 'api', 4000), svc('web', 'web', 5173)], planSource: 'rule-based' },
          skipped: [],
          warnings: [],
        }),
      } as never,
      startupBoundMs: 40,
    });
    const session = await mgr.launch({ sourceDir: '/tmp/repo' });
    await until(() => session.state === ExecutionState.PARTIALLY_READY, 8000);

    // Well past the bound, which would have fired several times over.
    await new Promise((r) => setTimeout(r, 250));
    expect(session.state).toBe(ExecutionState.PARTIALLY_READY);
    expect(e.cleanups).toEqual([]);
    await mgr.shutdown();
  });

  it('stays alive while somebody is watching it', async () => {
    // Every read of a session touches it, which is what keeps a dashboard someone is
    // looking at from being reclaimed for idleness. A partly running project is being
    // looked at for exactly the same reason as a ready one — more, probably, since
    // something on it is broken.
    const { config } = await import('../config/index.js');
    const original = config.timeouts.sessionIdleMs;
    Object.defineProperty(config.timeouts, 'sessionIdleMs', { value: 120, configurable: true, writable: true });
    try {
      const { session, mgr } = await run();
      expect(session.state).toBe(ExecutionState.PARTIALLY_READY);

      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 40));
        mgr.touch(session.id);
      }
      expect(session.state, 'a watched session must not be reclaimed for idleness').toBe(
        ExecutionState.PARTIALLY_READY,
      );

      // And left alone, it is: the clock is real, not disabled.
      await until(() => session.state === ExecutionState.COMPLETED, 2000);
      expect(session.state).toBe(ExecutionState.COMPLETED);
      await mgr.shutdown();
    } finally {
      Object.defineProperty(config.timeouts, 'sessionIdleMs', { value: original, configurable: true, writable: true });
    }
  });

  it('is reclaimed when nobody is watching, like anything else holding containers', async () => {
    // The counterpart to the test above, and the one that matters more: a state that
    // owns a port, a container and the only session slot and has no clock on it is a
    // leak. Nothing touches this one, so only the lifetime armed at the transition can
    // end it.
    const { config } = await import('../config/index.js');
    const original = config.timeouts.sessionIdleMs;
    Object.defineProperty(config.timeouts, 'sessionIdleMs', { value: 80, configurable: true, writable: true });
    try {
      const { session, mgr, cleanups } = await run();
      expect(session.state).toBe(ExecutionState.PARTIALLY_READY);

      await until(() => session.state === ExecutionState.COMPLETED, 3000);
      expect(session.state).toBe(ExecutionState.COMPLETED);
      expect(cleanups.length, 'and its containers go with it').toBeGreaterThan(0);
      await mgr.shutdown();
    } finally {
      Object.defineProperty(config.timeouts, 'sessionIdleMs', { value: original, configurable: true, writable: true });
    }
  });

  it('hands over the page\'s URL, not whichever service happened to survive first', async () => {
    // A project can lose a service and still have several running. The one worth
    // opening is the browser front door; an API\'s own URL is a fallback for when that
    // is the thing that died, not a first choice ahead of it.
    const cleanups: string[] = [];
    const manager = {
      docker: { networkExists: async () => false, claimedAliases: async () => new Set<string>() },
      async launch(o: { plan: { name?: string }; logs?: LogManager }) {
        const name = o.plan.name ?? 'single';
        const ok = name !== 'broken';
        return {
          logs: o.logs ?? new LogManager(),
          waitForReady: async (): Promise<ReadyOutcome> =>
            ok
              ? { state: ExecutionState.READY, hostPort: '1', url: `http://localhost/${name}`, readiness: { ready: true, attempts: 1, elapsedMs: 1 } }
              : { state: ExecutionState.FAILED, hostPort: null, readiness: { ready: false, attempts: 1, elapsedMs: 1 },
                  failure: { code: FailureCode.START_COMMAND_FAILED, message: 'broken: exited 1' } },
          clearStartupBudget: () => undefined,
          cleanup: async () => (cleanups.push(name), { errors: [] }),
        } as unknown as LaunchHandle;
      },
    } as unknown as ExecutionManager;

    // `healthy-api` is planned first and survives; `web` is the entry and also survives.
    // `broken` is an api rather than a worker: a worker has no port to wait on and is
    // ready as soon as it runs, so it could not fail here even if it wanted to.
    const mgr = new SessionManager(manager, {
      analyzer: { analyze: async () => projectMeta } as never,
      planner: { planRepository: async () => ({ plan: null, detected: null, warnings: [] }) } as never,
      projectPlanner: {
        planProject: async () => ({
          plan: {
            services: [svc('healthy-api', 'api', 4000), svc('web', 'web', 5173), svc('broken', 'api', 7000)],
            planSource: 'rule-based',
          },
          skipped: [], warnings: [],
        }),
      } as never,
    });
    const session = await mgr.launch({ sourceDir: '/tmp/repo' });
    await until(
      () => session.state === ExecutionState.PARTIALLY_READY || session.state === ExecutionState.FAILED,
      8000,
    );

    expect(session.state).toBe(ExecutionState.PARTIALLY_READY);
    expect(session.url).toBe('http://localhost/web');
    await mgr.shutdown();
  });

  it('carries the project planner\'s warnings, which only ever reached the log', async () => {
    // `session.plan` is the single-service field, so a project left `planWarnings`
    // empty and the dashboard's warning list with nothing in it — while the reasons a
    // service starts from an odd directory scrolled past in the install output.
    const { session, mgr } = await run(['api: starting from backend/, where its imports resolve']);

    expect(session.planWarnings).toContain('api: starting from backend/, where its imports resolve');
    // Including what was dropped: a service nobody planned is a thing to be told about,
    // not a silent absence from a list.
    expect(session.planWarnings).toContain('Skipping worker: no plan could be produced');
    await mgr.shutdown();
  });
});
