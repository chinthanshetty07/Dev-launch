import { describe, it, expect, beforeEach } from 'vitest';
import { ExecutionState, FailureCode, RunPlanSchema, type RunPlan } from '@devlaunch/shared';
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

    expect(repairs, 'the repair loop must actually have run').toBe(2);
    expect(s.failure?.code).toBe(FailureCode.PORT_BOUND_TO_LOCALHOST);
    expect(s.failure?.message).toMatch(/Bind 0\.0\.0\.0 instead/);
    // What the attempts produced is still visible, just not presented as the cause.
    const trail = s.logs.buffer.all().map((l) => l.text).join('\n');
    expect(trail).toMatch(/Reporting the original diagnosis/);
    expect(trail).toMatch(/START_COMMAND_FAILED/);
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
