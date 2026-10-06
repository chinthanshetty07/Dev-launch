import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ExecutionState,
  FailureCode,
  RunPlanSchema,
  TERMINAL_STATES,
  type RunPlan,
} from '@devlaunch/shared';
import { config } from '../config/index.js';
import { SessionManager, SessionConflict, progressedPast } from '../services/session/SessionManager.js';
import type {
  ContainerLiveness,
  ExecutionManager,
  LaunchHandle,
  ReadyOutcome,
} from '../services/execution/ExecutionManager.js';
import { LogManager } from '../services/logs/LogManager.js';

/**
 * A clone holding the files a model's plan names.
 *
 * A model plan's entry file is checked against the clone before anything starts (see
 * `missingEntryFile`), and `/tmp/repo` holds nothing — so a test whose model plan runs
 * `node server.js` has to have a server.js, or it is refused before reaching what the
 * test is about.
 */
function cloneWith(...files: string[]): string {
  // Named `repo`, as `/tmp/repo` was: the database DevLaunch provisions is named after it.
  const dir = join(mkdtempSync(join(tmpdir(), 'devlaunch-sm-')), 'repo');
  mkdirSync(dir);
  for (const f of files) writeFileSync(join(dir, f), '');
  return dir;
}

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
  // It used to return quietly here, so a test waiting for a state that never came went
  // on to assert something else and passed. Two tests did exactly that.
  throw new Error(`until: condition not met within ${ms} ms`);
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

  it('stops the running deployment when a new one asks to replace it', async () => {
    // Local use: look at one repository, then paste the next. Being refused, and having to
    // stop the first by hand, was a step with only one answer.
    const mgr = new SessionManager(fakeExec(ready));
    const first = await mgr.launch({ plan: plan(), sourceDir: '/tmp', image: 'devlaunch/node:20', repoUrl: 'https://github.com/a/one' });
    await until(() => first.state === ExecutionState.READY);

    const second = await mgr.launch({ plan: plan(), sourceDir: '/tmp', image: 'devlaunch/node:20', repoUrl: 'https://github.com/a/two', replace: true });
    expect(first.state).toBe(ExecutionState.CANCELLED);
    expect(first.endedReason).toBe('replaced by https://github.com/a/two');
    await until(() => second.state === ExecutionState.READY);
    expect(mgr.active().map((s) => s.id)).toEqual([second.id]);
    await mgr.shutdown();
  });

  it('makes room by stopping the oldest, keeping the newer ones', async () => {
    const mgr = new SessionManager(fakeExec(ready), { maxConcurrent: 2 });
    const req = { plan: plan(), sourceDir: '/tmp', image: 'devlaunch/node:20' };
    const a = await mgr.launch(req);
    await new Promise((r) => setTimeout(r, 5));
    const b = await mgr.launch(req);
    await settle();
    const c = await mgr.launch({ ...req, replace: true });
    expect(a.state).toBe(ExecutionState.CANCELLED);
    expect(mgr.active().map((s) => s.id).sort()).toEqual([b.id, c.id].sort());
    await mgr.shutdown();
  });

  it('never runs more than the limit when several replace at once', async () => {
    const mgr = new SessionManager(fakeExec(ready));
    const req = { plan: plan(), sourceDir: '/tmp', image: 'devlaunch/node:20', replace: true };
    await mgr.launch(req);
    const started = await Promise.all([mgr.launch(req), mgr.launch(req), mgr.launch(req)]);
    await settle();
    expect(mgr.active().map((s) => s.id)).toEqual([started[2]!.id]);
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
  it('reports the new failure when the repair installed the package the first one lacked', async () => {
    // `Saaalil/ShipRocket-Audio-VAD`: gradio is in an optional extra, the repair installed
    // it, and the app then failed on its own `spaces/` folder shadowing a package. The
    // run was reported as "No module named 'gradio'" — about a package by then installed.
    const failed = (evidence: string): ReadyOutcome => ({
      state: ExecutionState.FAILED,
      hostPort: null,
      readiness: { ready: false, attempts: 1, elapsedMs: 1 },
      failure: { code: FailureCode.START_COMMAND_FAILED, message: evidence, evidence, phase: 'start' },
    });
    const outcomes = [
      failed("ModuleNotFoundError: No module named 'gradio'"),
      failed("AttributeError: module 'spaces' has no attribute 'GPU'"),
    ];
    let attempt = 0;
    const exec = fakeExec(() => outcomes[Math.min(attempt++, outcomes.length - 1)]!);
    const mgr = new SessionManager(exec, {
      analyzer: { analyze: async () => ({ envExample: [], warnings: [] }) } as never,
      planner: {
        planRepository: async () => ({ plan: { ...plan(), environmentVariables: [] }, detected: 'gradio', warnings: [] }),
      } as never,
      aiRepair: {
        repair: async () => ({ plan: { ...plan(), installCommand: 'npm install gradio' }, attempt: 1, note: 'install it' }),
      } as never,
    });

    const s = await mgr.launch({ sourceDir: '/tmp', image: 'devlaunch/node:20' });
    await until(() => s.state === ExecutionState.FAILED, 3000);

    expect(s.repairAttempts?.length, 'the repair ran').toBeGreaterThan(0);
    expect(s.failure?.evidence).toBe("AttributeError: module 'spaces' has no attribute 'GPU'");
    await mgr.shutdown();
  });

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

describe('a stop during the clone (A-19)', () => {
  it('removes the clone when it lands, and asks no model about a stopped run', async () => {
    let finishClone!: () => void;
    const cloned = new Promise<void>((r) => { finishClone = r; });
    let removedClone = false;
    let modelAsked = false;
    const mgr = new SessionManager(fakeExec(ready), {
      git: {
        clone: async () => {
          await cloned;
          return { dir: '/tmp/repo', url: 'https://github.com/a/b', commit: 'abc', sizeBytes: 1, fileCount: 1, cleanup: async () => { removedClone = true; } };
        },
      } as never,
      analyzer: { analyze: async () => ({ envExample: [], warnings: [] }) } as never,
      planner: { planRepository: async () => ({ plan: null, detected: null, warnings: [] }) } as never,
      aiPlanner: { plan: async () => { modelAsked = true; throw new Error('no'); } } as never,
    });
    const s = await mgr.launch({ repoUrl: 'https://github.com/a/b' });
    await until(() => s.state === ExecutionState.CLONING);
    await mgr.cancel(s.id);
    finishClone();
    await until(() => removedClone);
    expect(modelAsked).toBe(false);
    expect(s.state).toBe(ExecutionState.CANCELLED);
    await mgr.shutdown();
  });

  it('removes the clone of a repository that would have asked for a setting', async () => {
    // The path the audit traced: it asks, `awaitInput` returns normally, nothing throws,
    // and the clone stayed on disk.
    let finishClone!: () => void;
    const cloned = new Promise<void>((r) => { finishClone = r; });
    let removedClone = false;
    const mgr = new SessionManager(fakeExec(ready), {
      git: {
        clone: async () => {
          await cloned;
          return { dir: '/tmp/repo', url: 'https://github.com/a/b', commit: 'abc', sizeBytes: 1, fileCount: 1, cleanup: async () => { removedClone = true; } };
        },
      } as never,
      analyzer: { analyze: async () => ({ envExample: [{ key: 'PAYMENT_API_KEY', hasDefault: false }], warnings: [] }) } as never,
      planner: { planRepository: async () => ({ plan: plan(), detected: 'node', warnings: [] }) } as never,
    });
    const s = await mgr.launch({ repoUrl: 'https://github.com/a/b' });
    await until(() => s.state === ExecutionState.CLONING);
    await mgr.cancel(s.id);
    finishClone();
    await until(() => removedClone);
    expect(s.state).toBe(ExecutionState.CANCELLED);
    await mgr.shutdown();
  });
});

describe('choosing a package', () => {
  it('accepts only one the run offered (A-13)', async () => {
    const analyzed: string[] = [];
    const mgr = new SessionManager(fakeExec(ready), {
      analyzer: { analyze: async (_dir: string, sub?: string) => { analyzed.push(sub ?? '.'); return { envExample: [], warnings: [] }; } } as never,
      planner: {
        planRepository: async () => ({
          plan: null, detected: null, warnings: [],
          choices: [{ name: 'web', dir: 'apps/web', scripts: ['dev'] }, { name: 'api', dir: 'apps/api', scripts: ['dev'] }],
        }),
      } as never,
    });
    const s = await mgr.launch({ sourceDir: '/tmp/repo' });
    await until(() => s.state === ExecutionState.AWAITING_INPUT);

    await mgr.resolve(s.id, { workspaceDir: '../../../../Users/someone/project' });
    expect(s.state).toBe(ExecutionState.AWAITING_INPUT);
    expect(analyzed).not.toContain('../../../../Users/someone/project');
    expect(s.logs.buffer.all().map((l) => l.text).join('\n')).toMatch(/not one of those this run offered/);

    await mgr.resolve(s.id, { workspaceDir: 'apps/web' });
    await until(() => analyzed.includes('apps/web'));
    await mgr.shutdown();
  });
});

describe('the maximum session lifetime', () => {
  it('is reached by a session somebody keeps looking at', async () => {
    // Audit A-16: every read re-armed the hard cap with the idle clock, and the dashboard
    // reads every few seconds — so a watched session never reached its maximum lifetime.
    const mgr = new SessionManager(fakeExec(ready));
    const s = await mgr.launch({ plan: plan(), sourceDir: '/tmp', image: 'devlaunch/node:20' });
    await until(() => s.state === ExecutionState.READY);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const capMs = config.timeouts.sessionHardCapMs;
      const step = Math.min(config.timeouts.sessionIdleMs / 2, capMs / 4);
      for (let t = 0; t < capMs + step && s.state === ExecutionState.READY; t += step) {
        mgr.touch(s.id);
        await vi.advanceTimersByTimeAsync(step);
      }
    } finally {
      vi.useRealTimers();
    }
    await until(() => s.state === ExecutionState.COMPLETED);
    expect(s.endedReason).toBe('maximum session lifetime');
    await mgr.shutdown();
  });
});

describe('the databases of two runs at once', () => {
  it('get their own passwords, and the second its own name when the first holds the plain one', async () => {
    // Audit A-08: every run's Postgres answered to `postgres` with password `devlaunch`.
    // Two at once shared one name, and an application could connect to the other's.
    const { BackingProvisioner } = await import('../services/execution/BackingProvisioner.js');
    const holders = new Set<string>();
    const created: { alias: string; env: string[] }[] = [];
    const docker = {
      networkExists: async () => true,
      claimedAliases: async () => new Set(holders),
      ensureImage: async () => undefined,
      createBackingContainer: async (o: { alias: string; env: string[] }) => {
        created.push(o);
        holders.add(o.alias);
        return { id: o.alias } as never;
      },
      start: async () => undefined,
      execCapture: async () => 'accepting connections',
    };
    const p = new BackingProvisioner({ docker } as never);
    const need = [{ kind: 'postgres' as const, evidence: 'pg', urlEnvKeys: ['DATABASE_URL'], neededBy: [] }];
    const logs = { write: () => undefined };
    const a = await p.provision({ sessionId: 'aaaaaaaa-1', backing: need, logs });
    const b = await p.provision({ sessionId: 'bbbbbbbb-2', backing: need, logs });

    expect(created.map((c) => c.alias)).toEqual(['postgres', 'postgres-bbbbbbbb']);
    expect(a.injected[0]!.value).toMatch(/@postgres:5432\//);
    expect(b.injected[0]!.value).toMatch(/@postgres-bbbbbbbb:5432\//);
    const pw = (v: string) => /postgres:([^@]+)@/.exec(v)![1];
    expect(pw(a.injected[0]!.value)).not.toBe(pw(b.injected[0]!.value));
    // The container is started with the password its URL carries.
    expect(created[1]!.env).toContain(`POSTGRES_PASSWORD=${pw(b.injected[0]!.value)}`);
  });
});

describe('a repair that proposes a plan that cannot run', () => {
  it('keeps the repository\'s own diagnosis and releases what the run holds', async () => {
    // A model repair naming a file that is not there is refused before it runs. It used
    // to end the run as INVALID_AI_PLAN — replacing the diagnosis of the repository with
    // one about the model's invention — and to leave the database it had started running.
    const created: string[] = [];
    const removed: string[] = [];
    const exec = fakeExec(failed) as ExecutionManager & { docker: unknown };
    exec.docker = { ...fakeDocker(created), remove: async () => { removed.push('db'); } } as never;
    const mgr = new SessionManager(exec, {
      analyzer: {
        analyze: async () => ({
          backing: [{ kind: 'postgres' as const, evidence: 'pg', driver: 'pg', urlEnvKeys: ['DATABASE_URL'], neededBy: [] }],
        }),
      } as never,
      planner: { planRepository: async () => ({ plan: plan(), detected: 'x', warnings: [] }) } as never,
      aiRepair: {
        repair: async () => ({
          plan: RunPlanSchema.parse({ ...plan(), startCommand: 'node invented.js', planSource: 'ai-fallback' }),
          attempt: 1,
        }),
      } as never,
    });
    const s = await mgr.launch({ sourceDir: cloneWith('server.js'), image: 'devlaunch/node:20' });
    await until(() => s.state === ExecutionState.FAILED);

    expect(s.failure?.code).not.toBe(FailureCode.INVALID_AI_PLAN);
    expect(s.failure?.repairAttemptsAfter).toBe(1);
    expect(s.logs.buffer.all().map((l) => l.text).join('\n')).toMatch(/proposed a plan that cannot run here/);
    expect(created, 'a database was started').toEqual(['postgres:16']);
    expect(removed, 'and released').toContain('db');
    await mgr.shutdown();
  });
});

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
    // The password is the run's own since audit A-08 (it was `devlaunch` for every run).
    const injected = launchedWith.find((v) => v.key === 'DATABASE_URL');
    expect(injected?.value).toMatch(/^postgresql\+asyncpg:\/\/postgres:[0-9a-f]{24}@postgres:5432\/repo$/);
    expect(injected?.required).toBe(false);
    expect(session.state).toBe(ExecutionState.READY);
    // The URL above carries the password; the log, which is shown and streamed, must not.
    const password = /postgres:([0-9a-f]{24})@/.exec(injected!.value!)![1]!;
    const log = session.logs.buffer.all().map((l) => l.text).join('\n');
    expect(log).toMatch(/accepting connections at postgresql/);
    expect(log).not.toContain(password);
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
    await mgr.launch({ sourceDir: cloneWith('server.js'), image: 'devlaunch/python:3.12' });
    await settle();

    // One URL — the provisioned one, with this run's own password — not the invented one.
    const urls = launchedWith.filter((v) => v.key === 'DATABASE_URL');
    expect(urls).toHaveLength(1);
    expect(urls[0]!.value).toMatch(/^postgresql\+asyncpg:\/\/postgres:[0-9a-f]{24}@postgres:5432\/repo$/);
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
    const session = await mgr.launch({
      sourceDir: cloneWith('server.js', 'retry-0.js', 'retry-1.js', 'retry-2.js', 'retry-3.js'),
      image: 'devlaunch/python:3.12',
    });
    await until(() => session.state === ExecutionState.FAILED);

    expect(session.repairAttempts?.length, 'the repair loop ran').toBeGreaterThan(0);
    expect(created, 'one database, however many attempts').toEqual(['postgres:16']);
    // Every attempt, including the repaired ones, knows where the database is.
    expect(launches.length).toBeGreaterThan(1);
    // The same URL every time — one database, one password, across every attempt.
    expect(new Set(launches).size).toBe(1);
    expect(launches[0]).toMatch(/^postgresql\+asyncpg:\/\/postgres:[0-9a-f]{24}@postgres:5432\/repo$/);
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
    // PARTIALLY_READY, not FAILED: the web service runs and stays up while api is
    // explained. This waited for FAILED, which never came; it passed only because
    // `until` used to return quietly when its time ran out (it now fails).
    await until(() => session.state === ExecutionState.PARTIALLY_READY, 8000);

    expect(calls).toEqual([]);
    expect(session.logs.buffer.all().map((l) => l.text).join('\n')).toMatch(/are not repaired by a model/);
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

  it('falls back as soon as the named image has exited, not after the whole budget (testdrivenio/fastapi-crud-sync)', async () => {
    // `postgres:15.1-alpine` exits under the sandbox within two seconds; its health
    // command was retried against the dead container for all 90 seconds. With a budget of
    // 30 seconds here, only a wait that notices the exit finishes in time.
    const created: string[] = [];
    const exec = fakeExec(ready) as ExecutionManager & { docker: unknown };
    exec.docker = {
      ...pickyDocker(created, 'postgres:16'),
      inspect: async (c: { id: string }) => ({ State: { Running: c.id === 'postgres:16' } }),
    } as never;

    const mgr = new SessionManager(exec, {
      analyzer: analyzed('postgres:15.1-alpine') as never,
      planner: planned as never,
      backingReadyMs: 30_000,
    });
    const started = Date.now();
    const session = await mgr.launch({ sourceDir: '/tmp/repo', image: 'devlaunch/python:3.12' });
    await until(() => session.state === ExecutionState.READY, 5000);

    expect(created).toEqual(['postgres:15.1-alpine', 'postgres:16']);
    expect(Date.now() - started).toBeLessThan(5000);
    await mgr.shutdown();
  }, 60_000);

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
/**
 * A workspace is worse off than a lone application, not better: every service installs
 * the whole workspace, and they do it at the same time. `horusyeung/nextjs-nestjs-
 * fullstack-starter` got past Yarn 1's refusal, resolved with the Yarn 4 it pins, and
 * then had both of its services killed mid-fetch — `web` pegged at 1024/1024 MB.
 *
 * The memory repair could not help, because it served only repositories that happened to
 * contain one service. Which is the exact criticism this file already makes of the repair
 * architecture that preceded it.
 */
/**
 * Two services, each needing a repair of its own.
 *
 * The budget was session-wide, so the first service to be repaired could spend it all.
 * `horusyeung/nextjs-nestjs-fullstack-starter` did exactly that: its API used both
 * attempts — a memory raise and a port correction — and its frontend was refused with
 * "repair limit reached" without a single attempt of its own, then reported as the
 * reason the project failed.
 */
describe('a project where more than one service needs repairing', () => {
  const projectMeta = {
    warnings: [], envExample: [], lockfiles: [], frameworkConfigs: [],
    services: [
      { name: 'api', dir: 'api', role: 'api', language: 'node', scripts: ['dev'], evidence: 'x' },
      { name: 'web', dir: 'web', role: 'web', language: 'node', scripts: ['dev'], evidence: 'x' },
    ],
  };
  const svc = (name: string, role: string, port: number) =>
    ({ ...RunPlanSchema.parse({
      runtime: { language: 'node', version: '20' },
      packageManager: 'npm', installCommand: null, buildCommand: null,
      startCommand: 'npm run dev', workingDirectory: name,
      expectedPort: port, planSource: 'rule-based',
    }), name, role }) as never;

  /**
   * `api` needs two repairs and `web` needs one — the real sequence, exactly. Under a
   * session-wide budget of two, `api` consumes both and `web` is refused without ever
   * being attempted.
   */
  function exec() {
    const attempts: string[] = [];
    let apiStarts = 0;
    return {
      attempts,
      manager: {
        docker: { networkExists: async () => false, claimedAliases: async () => new Set<string>() },
        async launch(o: { plan: { name?: string; expectedPort: number | null }; logs?: LogManager; memoryMb?: number }) {
          const name = o.plan.name ?? 'single';
          attempts.push(name);
          const logs = o.logs ?? new LogManager();

          if (name === 'api') {
            apiStarts++;
            // First: killed by the memory limit. Second: alive, but on the wrong port.
            // Third: correct.
            if (apiStarts === 1) {
              return handle(logs, {
                state: ExecutionState.FAILED, hostPort: null,
                readiness: { ready: false, attempts: 1, elapsedMs: 1 },
                failure: { code: FailureCode.OUT_OF_MEMORY, message: 'api: killed for exceeding the container memory limit.' },
              });
            }
            if (o.plan.expectedPort !== 9000) {
              logs.buffer.push('stderr', 'Listening on http://0.0.0.0:9000');
              return handle(logs, {
                state: ExecutionState.FAILED, hostPort: '1',
                readiness: { ready: false, attempts: 1, elapsedMs: 1 },
                failure: {
                  code: FailureCode.PORT_NOT_LISTENING,
                  message: `Nothing is listening on port ${o.plan.expectedPort}.`,
                  observedSocket: { address: '0.0.0.0', port: 9000, loopbackOnly: false },
                },
              });
            }
            return handle(logs, {
              state: ExecutionState.READY, hostPort: '1', url: 'http://localhost/api',
              readiness: { ready: true, attempts: 1, elapsedMs: 1 },
            });
          }

          // `web` needs exactly one correction, and only gets it if a budget is left.
          if (o.plan.expectedPort !== 9100) {
            logs.buffer.push('stderr', 'Listening on http://0.0.0.0:9100');
            return handle(logs, {
              state: ExecutionState.FAILED, hostPort: '1',
              readiness: { ready: false, attempts: 1, elapsedMs: 1 },
              failure: {
                code: FailureCode.PORT_NOT_LISTENING,
                message: `Nothing is listening on port ${o.plan.expectedPort}.`,
                observedSocket: { address: '0.0.0.0', port: 9100, loopbackOnly: false },
              },
            });
          }
          return handle(logs, {
            state: ExecutionState.READY, hostPort: '1', url: 'http://localhost/web',
            readiness: { ready: true, attempts: 1, elapsedMs: 1 },
          });
        },
      } as unknown as ExecutionManager,
    };
  }

  const handle = (logs: LogManager, outcome: ReadyOutcome) =>
    ({
      logs,
      waitForReady: async () => outcome,
      clearStartupBudget: () => undefined,
      cleanup: async () => ({ errors: [] }),
    }) as unknown as LaunchHandle;

  it('gives every service its own attempts, so one cannot starve the others', async () => {
    const e = exec();
    const m = new SessionManager(e.manager, {
      analyzer: { analyze: async () => projectMeta } as never,
      planner: { planRepository: async () => ({ plan: null, detected: null, warnings: [] }) } as never,
      projectPlanner: {
        planProject: async () => ({
          plan: { services: [svc('api', 'api', 3000), svc('web', 'web', 3001)], planSource: 'rule-based' },
          skipped: [], warnings: [],
        }),
      } as never,
    });
    const s = await m.launch({ sourceDir: '/tmp/repo' });
    await until(
      () => s.state === ExecutionState.READY || s.state === ExecutionState.FAILED
        || s.state === ExecutionState.PARTIALLY_READY,
      8000,
    );

    // `api` took two repairs — the whole session-wide allowance — and `web` still got
    // the one it needed. Under the old budget this ended PARTIALLY_READY with `web`
    // refused for a limit another service had spent.
    expect(s.state).toBe(ExecutionState.READY);
    expect(e.attempts.filter((n) => n === 'api')).toHaveLength(3);
    expect(e.attempts.filter((n) => n === 'web')).toHaveLength(2);
    expect((s.repairs ?? []).map((r) => `${r.service}:${r.type}`)).toEqual([
      'api:MEMORY_LIMIT_RAISED',
      'api:PORT_CORRECTION',
      'web:PORT_CORRECTION',
    ]);
    // Every container each service got, in order, with how it ended — the memory raise
    // and the plan repair alike. A repair that restarted a service without a record left
    // the summary describing a container that no longer existed.
    const history = (name: string) => (s.launchAttempts ?? []).filter((a) => a.service === name).map((a) => a.result);
    expect(history('api')).toEqual([FailureCode.OUT_OF_MEMORY, FailureCode.PORT_NOT_LISTENING, 'ok']);
    expect(history('web')).toEqual([FailureCode.PORT_NOT_LISTENING, 'ok']);
    await m.shutdown();
  });

  it('holds each service to its own ceiling, counting only its own attempts', async () => {
    // A service that would need three distinct repairs gets two, because that is the
    // ceiling — and the count is of *its* attempts, not the session's. Without recording
    // per service, `previous` is always empty and the ceiling never arrives, which turns
    // a bounded retry into one stopped only by a rule running out of ideas.
    const attempts: string[] = [];
    let starts = 0;
    const manager = {
      docker: { networkExists: async () => false, claimedAliases: async () => new Set<string>() },
      async launch(o: { plan: { name?: string; expectedPort: number | null }; logs?: LogManager }) {
        const name = o.plan.name ?? 'single';
        attempts.push(name);
        const logs = o.logs ?? new LogManager();
        if (name === 'web') {
          return handle(logs, {
            state: ExecutionState.READY, hostPort: '1', url: 'http://localhost/web',
            readiness: { ready: true, attempts: 1, elapsedMs: 1 },
          });
        }
        starts++;
        if (starts === 1) {
          return handle(logs, {
            state: ExecutionState.FAILED, hostPort: null,
            readiness: { ready: false, attempts: 1, elapsedMs: 1 },
            failure: { code: FailureCode.OUT_OF_MEMORY, message: 'api: killed for exceeding the container memory limit.' },
          });
        }
        // A different port every time, so each correction is a *new* plan and the
        // progress check never refuses one. Only the ceiling can stop this.
        const opened = 9000 + starts;
        logs.buffer.push('stderr', `Listening on http://0.0.0.0:${opened}`);
        return handle(logs, {
          state: ExecutionState.FAILED, hostPort: '1',
          readiness: { ready: false, attempts: 1, elapsedMs: 1 },
          failure: {
            code: FailureCode.PORT_NOT_LISTENING,
            message: `Nothing is listening on port ${o.plan.expectedPort}.`,
            observedSocket: { address: '0.0.0.0', port: opened, loopbackOnly: false },
          },
        });
      },
    } as unknown as ExecutionManager;

    const m = new SessionManager(manager, {
      analyzer: { analyze: async () => projectMeta } as never,
      planner: { planRepository: async () => ({ plan: null, detected: null, warnings: [] }) } as never,
      projectPlanner: {
        planProject: async () => ({
          plan: { services: [svc('api', 'api', 3000), svc('web', 'web', 3001)], planSource: 'rule-based' },
          skipped: [], warnings: [],
        }),
      } as never,
    });
    const s = await m.launch({ sourceDir: '/tmp/repo' });
    await until(
      () => s.state === ExecutionState.PARTIALLY_READY || s.state === ExecutionState.FAILED,
      8000,
    );

    expect(s.state).toBe(ExecutionState.PARTIALLY_READY);
    // One start, one memory raise, then exactly its own allowance of plan repairs.
    //
    // Rewritten, not flipped: the memory raise used to count against the same two-attempt
    // allowance, so this was 1 + 2. A memory ladder of two raises would then leave no plan
    // repair at all for a run that needed one once it had memory enough, so raises have
    // their own limit (the memory policy's) and the plan repairs keep theirs. The intent —
    // this service's plan repairs stop at the ceiling, counted per service — is unchanged.
    expect(attempts.filter((n) => n === 'api')).toHaveLength(2 + config.ai.maxRepairAttempts);
    expect(s.logs.buffer.all().map((l) => l.text).join('\n')).toMatch(
      new RegExp(`Repair limit of ${config.ai.maxRepairAttempts} reached for api`),
    );
    await m.shutdown();
  });

  it('still stops a service that keeps failing, without touching its siblings\' budget', async () => {
    // The ceiling is per service now, which must not mean unbounded. `api` can never be
    // corrected here, so it spends its own attempts and stops; `web` is unaffected.
    const attempts: string[] = [];
    const manager = {
      docker: { networkExists: async () => false, claimedAliases: async () => new Set<string>() },
      async launch(o: { plan: { name?: string; expectedPort: number | null }; logs?: LogManager }) {
        const name = o.plan.name ?? 'single';
        attempts.push(name);
        const logs = o.logs ?? new LogManager();
        if (name === 'api') logs.buffer.push('stderr', 'Listening on http://0.0.0.0:9000');
        return {
          logs,
          waitForReady: async (): Promise<ReadyOutcome> =>
            name === 'web'
              ? { state: ExecutionState.READY, hostPort: '1', url: 'http://localhost/web', readiness: { ready: true, attempts: 1, elapsedMs: 1 } }
              : { state: ExecutionState.FAILED, hostPort: '1', readiness: { ready: false, attempts: 1, elapsedMs: 1 },
                  failure: {
                    code: FailureCode.PORT_NOT_LISTENING,
                    message: 'Nothing is listening.',
                    observedSocket: { address: '0.0.0.0', port: 9000, loopbackOnly: false },
                  } },
          clearStartupBudget: () => undefined,
          cleanup: async () => ({ errors: [] }),
        } as unknown as LaunchHandle;
      },
    } as unknown as ExecutionManager;

    const m = new SessionManager(manager, {
      analyzer: { analyze: async () => projectMeta } as never,
      planner: { planRepository: async () => ({ plan: null, detected: null, warnings: [] }) } as never,
      projectPlanner: {
        planProject: async () => ({
          plan: { services: [svc('api', 'api', 3000), svc('web', 'web', 3001)], planSource: 'rule-based' },
          skipped: [], warnings: [],
        }),
      } as never,
    });
    const s = await m.launch({ sourceDir: '/tmp/repo' });
    await until(
      () => s.state === ExecutionState.PARTIALLY_READY || s.state === ExecutionState.FAILED,
      8000,
    );

    expect(s.state).toBe(ExecutionState.PARTIALLY_READY);
    // One start plus its own attempts, and no more.
    expect(attempts.filter((n) => n === 'api').length).toBeLessThanOrEqual(1 + config.ai.maxRepairAttempts);
    expect(attempts.filter((n) => n === 'web')).toHaveLength(1);
    // It stops with a reason naming the service, and which reason depends on how it
    // fails: here the rule proposes the same correction twice and the progress check
    // refuses it before the budget runs out. Both are stopping for a stated cause, which
    // is what this asserts — the *bound* is asserted by the attempt count above.
    expect(s.logs.buffer.all().map((l) => l.text).join('\n')).toMatch(
      /(Repair limit of \d+ reached for api|No rule applies to api)/,
    );
    await m.shutdown();
  });
});

describe('a project service killed by our own memory limit', () => {
  const projectMeta = {
    warnings: [], envExample: [], lockfiles: [], frameworkConfigs: [],
    services: [
      { name: 'web', dir: 'apps/web', role: 'web', language: 'node', scripts: ['dev'], evidence: 'x' },
      { name: 'api', dir: 'packages/api', role: 'api', language: 'node', scripts: ['start:dev'], evidence: 'x' },
    ],
  };
  const svc = (name: string, role: string, port: number) =>
    ({ ...RunPlanSchema.parse({
      runtime: { language: 'node', version: '20' },
      packageManager: 'yarn', installCommand: 'yarn install', buildCommand: null,
      startCommand: `npm run dev --port ${port}`, workingDirectory: name,
      expectedPort: port, planSource: 'rule-based',
    }), name, role }) as never;

  /** `api` is OOM-killed until it is given more than the default. */
  function exec() {
    const limits: { name: string; memoryMb?: number }[] = [];
    return {
      limits,
      manager: {
        docker: { networkExists: async () => false, claimedAliases: async () => new Set<string>() },
        async launch(o: { plan: { name?: string }; logs?: LogManager; memoryMb?: number }) {
          const name = o.plan.name ?? 'single';
          limits.push({ name, memoryMb: o.memoryMb });
          // The first container is launched at the policy's initial limit (1024 here); only
          // a raise takes it past that.
          const raised = (o.memoryMb ?? 1024) > 1024;
          return {
            logs: o.logs ?? new LogManager(),
            waitForReady: async (): Promise<ReadyOutcome> =>
              name !== 'api' || raised
                ? { state: ExecutionState.READY, hostPort: '1', url: `http://localhost/${name}`, readiness: { ready: true, attempts: 1, elapsedMs: 1 } }
                : { state: ExecutionState.FAILED, hostPort: null, readiness: { ready: false, attempts: 1, elapsedMs: 1 },
                    failure: { code: FailureCode.OUT_OF_MEMORY, message: 'api: killed for exceeding the container memory limit.' } },
            clearStartupBudget: () => undefined,
            cleanup: async () => ({ errors: [] }),
          } as unknown as LaunchHandle;
        },
      } as unknown as ExecutionManager,
    };
  }

  const mgr = (e: ExecutionManager) =>
    new SessionManager(e, {
      analyzer: { analyze: async () => projectMeta } as never,
      planner: { planRepository: async () => ({ plan: null, detected: null, warnings: [] }) } as never,
      projectPlanner: {
        planProject: async () => ({
          plan: { services: [svc('api', 'api', 3000), svc('web', 'web', 3001)], planSource: 'rule-based' },
          skipped: [], warnings: [],
        }),
      } as never,
      aiRepair: { repair: async () => { throw new Error('a model cannot change a HostConfig'); } } as never,
    });

  it('raises the limit for the service that died and reaches READY', async () => {
    const e = exec();
    const m = mgr(e.manager);
    const s = await m.launch({ sourceDir: '/tmp/repo' });
    await until(() => s.state === ExecutionState.READY || s.state === ExecutionState.FAILED, 8000);

    expect(s.state).toBe(ExecutionState.READY);
    expect(s.repairs?.[0]).toMatchObject({
      source: 'deterministic', type: 'MEMORY_LIMIT_RAISED', service: 'api',
    });
    // Rewritten, not flipped: the restart used to jump straight to the ceiling from an
    // implicit default. It now starts at the policy's initial limit and takes the next
    // step of the ladder — here, with no VM size to read, 1024 → 2048.
    expect(e.limits.filter((l) => l.name === 'api').map((l) => l.memoryMb)).toEqual([1024, 2048]);
    await m.shutdown();
  });

  it('raises it for that service only, because the VM cannot afford both', async () => {
    // Two containers at the ceiling exceed what Colima has, and only the one that was
    // killed has shown it needs more. Raising the project would trade a reported failure
    // for a wedged machine — which is the thing the ceiling exists to prevent.
    const e = exec();
    const m = mgr(e.manager);
    const s = await m.launch({ sourceDir: '/tmp/repo' });
    await until(() => s.state === ExecutionState.READY || s.state === ExecutionState.FAILED, 8000);

    // Rewritten, not flipped: "unraised" used to be `undefined`; the initial limit is now
    // explicit, so unraised is the initial limit itself.
    expect(e.limits.filter((l) => l.name === 'web').map((l) => l.memoryMb)).toEqual([1024]);
    // And not merely unlaunched at the ceiling — unraised. A sibling carrying a raised
    // limit would take it on its next restart, which is the same mistake arriving late.
    expect(s.run?.services.find((sv) => sv.name === 'web')?.memoryMb).toBe(1024);
    expect(s.run?.services.find((sv) => sv.name === 'api')?.memoryMb).toBeGreaterThan(1024);
    await m.shutdown();
  });

  it('stops at the ceiling rather than restarting for ever', async () => {
    // A service that is still killed with everything the VM can spare is a service this
    // machine cannot run. Saying so beats a loop — and the survivors stay up, so the
    // session is partly running rather than a total loss.
    const limits: { name: string; memoryMb?: number }[] = [];
    const alwaysOom = {
      docker: { networkExists: async () => false, claimedAliases: async () => new Set<string>() },
      async launch(o: { plan: { name?: string }; logs?: LogManager; memoryMb?: number }) {
        const name = o.plan.name ?? 'single';
        limits.push({ name, memoryMb: o.memoryMb });
        return {
          logs: o.logs ?? new LogManager(),
          waitForReady: async (): Promise<ReadyOutcome> =>
            name !== 'api'
              ? { state: ExecutionState.READY, hostPort: '1', url: `http://localhost/${name}`, readiness: { ready: true, attempts: 1, elapsedMs: 1 } }
              : { state: ExecutionState.FAILED, hostPort: null, readiness: { ready: false, attempts: 1, elapsedMs: 1 },
                  failure: { code: FailureCode.OUT_OF_MEMORY, message: 'api: killed for exceeding the container memory limit.' } },
          clearStartupBudget: () => undefined,
          cleanup: async () => ({ errors: [] }),
        } as unknown as LaunchHandle;
      },
    } as unknown as ExecutionManager;

    const m = mgr(alwaysOom);
    const s = await m.launch({ sourceDir: '/tmp/repo' });
    await until(
      () => s.state === ExecutionState.PARTIALLY_READY || s.state === ExecutionState.FAILED,
      8000,
    );

    // Started once, raised once — to the 2048 MB ceiling this fake VM allows — and then no
    // more. Rewritten, not flipped: the message it looks for is the final one now.
    expect(limits.filter((l) => l.name === 'api')).toHaveLength(2);
    expect(s.state).toBe(ExecutionState.PARTIALLY_READY);
    expect(s.logs.buffer.all().map((l) => l.text).join('\n')).toMatch(/still exceeded the maximum available memory \(2048 MB/);
    expect(s.failure?.memory).toMatchObject({ limitMb: 2048, maximumMb: 2048, attempts: 2, retryable: false });
    await m.shutdown();
  });
});

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
    // `broken` is an api. A worker used to be ready as soon as it ran, so it could not
    // fail here; since audit A-03 it is checked too (see workerOutcome's tests).
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

/**
 * Audit A-04: a project had no watch after READY. A backend that died ten minutes in left
 * the project READY, its URL advertised, until the idle clock reclaimed it.
 */
describe('a project whose service dies after it is ready', () => {
  const projectMeta = {
    warnings: [], envExample: [], lockfiles: [], frameworkConfigs: [],
    services: [
      { name: 'web', dir: 'web', role: 'web', language: 'node', scripts: ['dev'], evidence: 'x' },
      { name: 'api', dir: 'api', role: 'api', language: 'node', scripts: ['dev'], evidence: 'x' },
    ],
  };
  const svc = (name: string, role: string, port: number) =>
    ({ ...RunPlanSchema.parse({
      runtime: { language: 'node', version: '20' },
      packageManager: 'npm', installCommand: null, buildCommand: null,
      startCommand: `npm run dev --port ${port}`, workingDirectory: name,
      expectedPort: port, planSource: 'rule-based',
    }), name, role }) as never;

  function setup(hold?: { next?: Promise<void> }) {
    const alive: Record<string, ContainerLiveness> = {};
    const cleanups: string[] = [];
    let launches = 0;
    const exec = {
      docker: { networkExists: async () => false, claimedAliases: async () => new Set<string>() },
      async launch(o: { plan: { name?: string }; logs?: LogManager }) {
        const name = o.plan.name ?? 'single';
        launches++;
        if (launches > 2 && hold?.next) await hold.next;
        alive[name] = { kind: 'running' };
        return {
          logs: o.logs ?? new LogManager(),
          waitForReady: async (): Promise<ReadyOutcome> =>
            ({ state: ExecutionState.READY, hostPort: '1', url: `http://localhost/${name}`, readiness: { ready: true, attempts: 1, elapsedMs: 1 } }),
          liveness: async () => alive[name]!,
          clearStartupBudget: () => undefined,
          cleanup: async () => (cleanups.push(name), { errors: [] }),
        } as unknown as LaunchHandle;
      },
    } as unknown as ExecutionManager;
    const mgr = new SessionManager(exec, {
      livenessIntervalMs: 10,
      analyzer: { analyze: async () => projectMeta } as never,
      planner: { planRepository: async () => ({ plan: null, detected: null, warnings: [] }) } as never,
      projectPlanner: {
        planProject: async () => ({
          plan: { services: [svc('api', 'api', 4000), svc('web', 'web', 5173)], planSource: 'rule-based' },
          skipped: [], warnings: [],
        }),
      } as never,
    });
    return { mgr, alive, cleanups };
  }

  it('becomes partly running, names the service, and stops offering its URL', async () => {
    const { mgr, alive } = setup();
    const s = await mgr.launch({ sourceDir: '/tmp/repo' });
    await until(() => s.state === ExecutionState.READY, 4000);

    alive.api = { kind: 'exited', exitCode: 1, oomKilled: false };
    await until(() => s.state === ExecutionState.PARTIALLY_READY, 4000);
    expect(s.failure?.message).toMatch(/^api: /);
    expect(s.url).toBe('http://localhost/web');
    const api = s.run!.services.find((sv) => sv.name === 'api')!;
    expect(api.state).toBe(ExecutionState.FAILED);
    expect(api.url).toBeUndefined();
    await mgr.shutdown();
  });

  it('stops offering the front door when that is what died', async () => {
    const { mgr, alive } = setup();
    const s = await mgr.launch({ sourceDir: '/tmp/repo' });
    await until(() => s.state === ExecutionState.READY, 4000);
    alive.web = { kind: 'exited', exitCode: 1, oomKilled: false };
    await until(() => s.state === ExecutionState.PARTIALLY_READY, 4000);
    expect(s.url).toBe('http://localhost/api');
    await mgr.shutdown();
  });

  it('ends, and releases everything, when the last service stops', async () => {
    const { mgr, alive, cleanups } = setup();
    const s = await mgr.launch({ sourceDir: '/tmp/repo' });
    await until(() => s.state === ExecutionState.READY, 4000);

    alive.api = { kind: 'exited', exitCode: 1, oomKilled: false };
    await until(() => s.state === ExecutionState.PARTIALLY_READY, 4000);
    alive.web = { kind: 'exited', exitCode: 137, oomKilled: true };
    await until(() => s.state === ExecutionState.FAILED, 4000);
    expect(s.url).toBeUndefined();
    expect(cleanups.sort()).toEqual(['api', 'web']);
    await mgr.shutdown();
  });

  it('gives unrelated repositories with the same package name separate package caches', async () => {
    // Audit A-09: the cache was keyed by package.json "name", so every repository called
    // "monorepo" shared one writable cache — Corepack's package-manager binaries included.
    const caches: string[] = [];
    const run = async (dir: string) => {
      const { mgr } = setup();
      const exec = (mgr as unknown as { exec: { launch: (o: { packageCacheVolume?: string }) => unknown } }).exec;
      const launch = exec.launch.bind(exec);
      exec.launch = (o) => {
        if (o.packageCacheVolume) caches.push(o.packageCacheVolume);
        return launch(o);
      };
      const s = await mgr.launch({ sourceDir: dir });
      await until(() => s.state === ExecutionState.READY, 4000);
      await mgr.shutdown();
    };
    (projectMeta as unknown as { packageJson: unknown }).packageJson = { name: 'monorepo', scripts: {}, dependencies: {} };
    await run('/tmp/owner-a/repo');
    await run('/tmp/owner-b/repo');
    expect(caches).toHaveLength(4);
    expect(new Set(caches).size, JSON.stringify(caches)).toBe(4);
  });

  it('refuses a restart while starting, and a second while one runs (A-07)', async () => {
    let release!: () => void;
    const hold = { next: new Promise<void>((r) => { release = r; }) };
    const { mgr } = setup(hold);
    const s = await mgr.launch({ sourceDir: '/tmp/repo' });
    expect(mgr.restartRefusal(s)).toMatch(/restart once it is running/);
    // And restart() itself honours it, whoever calls it.
    await mgr.restart(s.id, 'api');
    expect(s.logs.buffer.all().map((l) => l.text).join('\n')).toMatch(/Not restarting: It is still/);
    await until(() => s.state === ExecutionState.READY, 4000);
    expect(mgr.restartRefusal(s)).toBeNull();

    const first = mgr.restart(s.id, 'api');
    expect(mgr.restartRefusal(s)).toMatch(/already in progress/);
    release();
    await first;
    await until(() => s.state === ExecutionState.READY, 4000);
    expect(mgr.restartRefusal(s)).toBeNull();
    await mgr.shutdown();
  });

  it('releases a container a restart creates after a stop arrived (A-06)', async () => {
    let release!: () => void;
    const hold = { next: new Promise<void>((r) => { release = r; }) };
    const { mgr, cleanups } = setup(hold);
    const s = await mgr.launch({ sourceDir: '/tmp/repo' });
    await until(() => s.state === ExecutionState.READY, 4000);

    const restarting = mgr.restart(s.id, 'api');
    await until(() => cleanups.includes('api'), 4000); // the old api container is gone
    await mgr.cancel(s.id);
    const before = cleanups.length;
    release(); // the replacement is created only now, after the stop
    await restarting;
    expect(cleanups.length, 'the replacement was released too').toBe(before + 1);
    expect(cleanups.at(-1)).toBe('api');
    expect(s.state).toBe(ExecutionState.CANCELLED);
    await mgr.shutdown();
  });

  it('keeps a service that cannot be inspected for a moment', async () => {
    const { mgr, alive } = setup();
    const s = await mgr.launch({ sourceDir: '/tmp/repo' });
    await until(() => s.state === ExecutionState.READY, 4000);
    alive.api = { kind: 'unknown', error: 'socket hang up' };
    await new Promise((r) => setTimeout(r, 100));
    expect(s.state).toBe(ExecutionState.READY);
    await mgr.shutdown();
  });
});

/**
 * A limit DevLaunch chose, reported as the repository's failure.
 *
 * `cerbos/nextjs-prisma-cerbos` is killed by the 1 GB container default every time a
 * Next.js dev build runs, and the verdict was OUT_OF_MEMORY, non-repairable, on the
 * reasoning that a container limit is "changed by configuration rather than by a plan".
 * Every word true, and an odd thing to say about configuration DevLaunch writes.
 */
describe('running out of memory under our own ceiling', () => {
  const GB = 1024 * 1024 * 1024;
  /** A container killed by the kernel for its limit, as the executor now reports it. */
  const oom = (phase: 'install' | 'build' | 'start' = 'install'): ReadyOutcome => ({
    state: ExecutionState.FAILED,
    hostPort: null,
    readiness: { ready: false, attempts: 1, elapsedMs: 1 },
    failure: {
      code: FailureCode.OUT_OF_MEMORY,
      message: 'Dependency installation was killed for exceeding the container memory limit.',
      phase,
      memory: { kind: 'container', limitMb: 0, detectedBy: ['docker: OOMKilled'] },
    } as ReadyOutcome['failure'],
  });
  const ok = (): ReadyOutcome => ready();

  /**
   * Records the memory limit each container was created with, and how many of its
   * predecessors had been cleaned up by then — a retry must not overlap the container it
   * replaces.
   */
  function limitSpy(outcome: (limitMb: number, n: number) => ReadyOutcome, vmBytes?: number, budget?: { capacityMb: number; heldMb: number }) {
    const limits: (number | undefined)[] = [];
    const heaps: (number | undefined)[] = [];
    const cleanedBeforeLaunch: number[] = [];
    let cleaned = 0;
    return {
      limits,
      heaps,
      cleanedBeforeLaunch,
      cleaned: () => cleaned,
      exec: {
        // Present only when a test says how big the VM is. Its *absence* is the
        // pre-existing case — a Docker client that cannot answer — and the reason those
        // tests see the fallback ceiling of 2048.
        ...(vmBytes === undefined ? {} : { docker: { hostMemoryBytes: async () => vmBytes } }),
        ...(budget ? { memory: { freeMb: () => budget.capacityMb - budget.heldMb, holders: () => [{ id: 'db', mb: budget.heldMb }] } } : {}),
        async launch(o: { logs?: LogManager; memoryMb?: number; nodeHeapMb?: number }) {
          cleanedBeforeLaunch.push(cleaned);
          limits.push(o.memoryMb);
          heaps.push(o.nodeHeapMb);
          const n = limits.length;
          return {
            container: { id: `c${n}` },
            logs: o.logs ?? new LogManager(),
            waitForReady: async () => outcome(o.memoryMb ?? 0, n),
            clearStartupBudget: () => undefined,
            cleanup: async () => {
              cleaned++;
              return { errors: [] };
            },
          } as unknown as LaunchHandle;
        },
      } as unknown as ExecutionManager,
    };
  }

  const deps = (exec: ExecutionManager) => ({
    analyzer: { analyze: async () => ({ warnings: [], envExample: [], lockfiles: [], frameworkConfigs: [] }) } as never,
    planner: { planRepository: async () => ({ plan: plan(), detected: 'next', warnings: [] }) } as never,
    aiRepair: { repair: async () => { throw new Error('a model cannot change a HostConfig'); } } as never,
  });

  async function run(spy: ReturnType<typeof limitSpy>) {
    const mgr = new SessionManager(spy.exec, deps(spy.exec));
    const s = await mgr.launch({ sourceDir: '/tmp/repo', image: 'devlaunch/node:20' });
    await until(() => ([ExecutionState.READY, ExecutionState.FAILED] as ExecutionState[]).includes(s.state), 6000);
    // Taken before shutdown, which cancels a READY session.
    const snapshot = { ...s, state: s.state, launchAttempts: [...(s.launchAttempts ?? [])] };
    await mgr.shutdown();
    return snapshot;
  }
  const text = (s: { logs: LogManager }) => s.logs.buffer.all().map((l) => l.text).join('\n');
  const vm5910 = 5910 * 1024 * 1024;

  it('does not retry an install that succeeds at the initial limit (test 6)', async () => {
    const spy = limitSpy(() => ok(), vm5910);
    const s = await run(spy);
    expect(s.state).toBe(ExecutionState.READY);
    expect(spy.limits).toEqual([1024]);
    expect(s.launchAttempts).toMatchObject([{ attempt: 1, memoryMb: 1024, result: 'ok' }]);
  });

  it('retries exactly once when the second limit is enough (test 7)', async () => {
    const spy = limitSpy((mb) => (mb < 2048 ? oom() : ok()), vm5910);
    const s = await run(spy);
    expect(s.state).toBe(ExecutionState.READY);
    expect(spy.limits).toEqual([1024, 2048]);
    expect(s.repairs?.[0]).toMatchObject({ source: 'deterministic', type: 'MEMORY_LIMIT_RAISED', before: { memoryMb: 1024 }, after: { memoryMb: 2048 } });
    expect(s.launchAttempts?.map((a) => [a.memoryMb, a.result])).toEqual([[1024, FailureCode.OUT_OF_MEMORY], [2048, 'ok']]);
  });

  it('climbs 1024 → 2048 → 4096 on a 5910 MB VM, and stops when it fits (test 8)', async () => {
    // The ceiling is derived — the VM less its reserve, capped at 4096 — not a constant.
    const spy = limitSpy((mb) => (mb < 4096 ? oom() : ok()), vm5910);
    const s = await run(spy);
    expect(s.state).toBe(ExecutionState.READY);
    expect(spy.limits).toEqual([1024, 2048, 4096]);
    const log = text(s);
    // This fake plan has no install step, and the log says so rather than inventing one.
    expect(log).toMatch(/\[install\] Attempt 1\/3 · memory limit 1024 MB · running: \(no install step\)/);
    expect(log).toMatch(/\[install\] Increasing memory: 1024 MB → 2048 MB/);
    expect(log).toMatch(/\[install\] Attempt 3\/3 · memory limit 4096 MB/);
  });

  it('gives a final, structured OUT_OF_MEMORY when every limit is exceeded (test 9)', async () => {
    const spy = limitSpy(() => oom(), vm5910);
    const s = await run(spy);
    expect(s.state).toBe(ExecutionState.FAILED);
    expect(spy.limits).toEqual([1024, 2048, 4096]);
    expect(s.failure).toMatchObject({
      code: FailureCode.OUT_OF_MEMORY,
      phase: 'install',
      memory: { limitMb: 4096, maximumMb: 4096, attempts: 3, retryable: false, kind: 'container' },
    });
    expect(s.failure?.message).toBe(
      'Dependency installation exceeded the container memory limit. DevLaunch retried with progressively ' +
        'larger memory limits (1024 → 2048 → 4096 MB) but it still exceeded the maximum available memory ' +
        '(4096 MB, the 4096 MB DevLaunch gives any one container).',
    );
    // The machine is the limit; nothing says the repository is broken.
    expect(s.failure?.remedy).toMatch(/Give the Docker VM more memory/);
  });

  it('never asks for more than the VM allows, when the next step would exceed it (test 13)', async () => {
    // A 3000 MB VM: the ceiling is 2488 (all but the reserve), below the next doubling.
    const spy = limitSpy(() => oom(), 3000 * 1024 * 1024);
    const s = await run(spy);
    expect(spy.limits).toEqual([1024, 2048, 2488]);
    expect(s.failure?.memory).toMatchObject({ maximumMb: 2488, retryable: false });
    expect(s.failure?.message).toMatch(/2488 MB, all this 3000 MB Docker VM can give one container, less its 512 MB reserve/);
  });

  it('will not hand a small VM its entire memory, and says when there is nothing larger', async () => {
    // Rewritten, not flipped: a 2 GB VM used to get no raise at all (half of it was the
    // initial limit). By the user's decision it now gets all but its 512 MB reserve — never
    // the whole machine — and then says the machine is the limit.
    const spy = limitSpy(() => oom(), 2 * GB);
    const s = await run(spy);
    expect(spy.limits).toEqual([1024, 1536]);
    expect(s.failure?.memory).toMatchObject({ maximumMb: 1536, retryable: false });
    // A VM whose ceiling is the initial limit itself still retries nothing, and says so.
    process.env.DEVLAUNCH_MEMORY_RESERVE_MB = '1024';
    try {
      const tiny = limitSpy(() => oom(), 2 * GB);
      const t = await run(tiny);
      expect(tiny.limits).toEqual([1024]);
      expect(t.failure?.message).toMatch(/already the maximum available memory .* so there was nothing larger to retry with/);
    } finally {
      delete process.env.DEVLAUNCH_MEMORY_RESERVE_MB;
    }
  });

  it('does not over-allocate beside other containers: it takes only what is free (test 14)', async () => {
    // A database already holds 3000 of a 4886 MB capacity. The next step for this
    // container is then what is free, not the doubling — and past that, it stops and
    // names the holder instead of promising the VM memory it does not have.
    const spy = limitSpy(() => oom(), 8 * GB, { capacityMb: 4886, heldMb: 3000 });
    const s = await run(spy);
    expect(spy.limits).toEqual([1024, 1886]);
    expect(s.failure?.message).toMatch(/the VM has no more to give: 1886 MB is free after the 1 other container/);
  });

  it('releases each failed container before creating the next', async () => {
    const spy = limitSpy(() => oom(), vm5910);
    await run(spy);
    // Before launch n, n-1 containers have been cleaned up: no two ever overlap.
    expect(spy.cleanedBeforeLaunch).toEqual([0, 1, 2]);
  });

  it('does not add memory for a failure that is not memory (test 10)', async () => {
    const spy = limitSpy(() => failed(), vm5910);
    const s = await run(spy);
    expect(spy.limits.every((mb) => mb === 1024)).toBe(true);
    expect((s.repairs ?? []).some((r) => r.type === 'MEMORY_LIMIT_RAISED')).toBe(false);
  });

  it('reports the failure that stopped the run once an earlier one was got past', async () => {
    // ahfarmer/calculator: a strict install refused a stale lockfile, a rule relaxed it, the
    // install succeeded, and webpack 4 then failed on OpenSSL 3. Keeping the first diagnosis
    // reported the lockfile — which had been solved — and hid the real error. The same with
    // memory: killed at install, raised, then stopped at start by something else.
    const tooNew = (): ReadyOutcome => ({
      state: ExecutionState.FAILED, hostPort: null, readiness: { ready: false, attempts: 0, elapsedMs: 0 },
      failure: { code: FailureCode.WRONG_RUNTIME_VERSION, message: 'OpenSSL 3', phase: 'start', runtimeDirection: 'older' } as ReadyOutcome['failure'],
    });
    let n = 0;
    const spy = limitSpy(() => (++n === 1 ? oom() : tooNew()), vm5910);
    const s = await run(spy);
    expect(s.state).toBe(ExecutionState.FAILED);
    expect(s.failure?.code).toBe(FailureCode.WRONG_RUNTIME_VERSION);
  });

  it('does not retry the install for a build failure, or add memory for it (test 11)', async () => {
    const buildFailed = (): ReadyOutcome => ({
      state: ExecutionState.FAILED, hostPort: null, readiness: { ready: false, attempts: 1, elapsedMs: 1 },
      failure: { code: FailureCode.BUILD_FAILED, message: 'Build failed.', phase: 'build' },
    });
    const spy = limitSpy(() => buildFailed(), vm5910);
    const s = await run(spy);
    expect(spy.limits.every((mb) => mb === 1024)).toBe(true);
    expect((s.repairs ?? []).some((r) => r.type === 'MEMORY_LIMIT_RAISED')).toBe(false);
    expect(s.failure?.code).toBe(FailureCode.BUILD_FAILED);
  });

  it('reports a port that never opens as that, not as memory (test 12)', async () => {
    const neverListens = (): ReadyOutcome => ({
      state: ExecutionState.FAILED, hostPort: '1', readiness: { ready: false, attempts: 5, elapsedMs: 60000 },
      failure: { code: FailureCode.PORT_NOT_LISTENING, message: 'Nothing is listening on port 3000.', phase: 'start' },
    });
    const spy = limitSpy(() => neverListens(), vm5910);
    const s = await run(spy);
    expect(s.failure?.code).toBe(FailureCode.PORT_NOT_LISTENING);
    expect(spy.limits.every((mb) => mb === 1024)).toBe(true);
  });

  it('answers a Node heap OOM with a larger heap first, inside the same container', async () => {
    let n = 0;
    const spy = limitSpy(() => {
      n++;
      return n === 1
        ? ({ ...oom(), failure: { ...oom().failure!, memory: { kind: 'node-heap', limitMb: 1024, detectedBy: ['log: JavaScript heap limit'] } } } as ReadyOutcome)
        : ok();
    }, vm5910);
    const s = await run(spy);
    expect(s.state).toBe(ExecutionState.READY);
    // Same container size, a heap of three quarters of it — never all of it.
    expect(spy.limits).toEqual([1024, 1024]);
    expect(spy.heaps).toEqual([undefined, 768]);
    expect(s.repairs?.[0]).toMatchObject({ type: 'NODE_HEAP_RAISED', after: { nodeHeapMb: 768 } });
  });

  it('still raises memory after the plan repairs are spent — the two budgets are separate', async () => {
    // Two port corrections spend the plan-repair allowance; the third run is then killed
    // for memory. Counted in one budget, that kill would be reported as final at 1024 MB.
    const portMoved = (port: number): ReadyOutcome => ({
      state: ExecutionState.FAILED, hostPort: '1', readiness: { ready: false, attempts: 1, elapsedMs: 1 },
      failure: {
        code: FailureCode.PORT_NOT_LISTENING, message: 'Nothing is listening on port 3000.', phase: 'start',
        observedSocket: { address: '0.0.0.0', port, loopbackOnly: false },
      } as ReadyOutcome['failure'],
    });
    const spy = limitSpy((mb, n) => (n === 1 ? portMoved(9101) : n === 2 ? portMoved(9102) : mb < 2048 ? oom() : ok()), vm5910);
    const s = await run(spy);
    expect(s.state).toBe(ExecutionState.READY);
    expect(spy.limits).toEqual([1024, 1024, 1024, 2048]);
    expect((s.repairs ?? []).map((r) => r.type)).toEqual(['PORT_CORRECTION', 'PORT_CORRECTION', 'MEMORY_LIMIT_RAISED']);
  });

  it('stops after the configured number of raises, even with room to grow', async () => {
    process.env.DEVLAUNCH_MEMORY_RETRY_LIMIT = '1';
    try {
      const spy = limitSpy(() => oom(), 16 * GB);
      const s = await run(spy);
      expect(spy.limits).toEqual([1024, 2048]);
      expect(s.failure?.memory).toMatchObject({ attempts: 2, retryable: false });
    } finally {
      delete process.env.DEVLAUNCH_MEMORY_RETRY_LIMIT;
    }
  });

  it('turns escalation off when told to, and says so', async () => {
    process.env.DEVLAUNCH_MEMORY_RETRY_ENABLED = 'false';
    try {
      const spy = limitSpy(() => oom(), vm5910);
      const s = await run(spy);
      expect(spy.limits).toEqual([1024]);
      expect(s.failure?.message).toMatch(/memory retries are off/);
    } finally {
      delete process.env.DEVLAUNCH_MEMORY_RETRY_ENABLED;
    }
  });

  it('keeps the raised limit across a later repair', async () => {
    // The limit lives on the session rather than the plan, and a later repair replaces
    // the plan wholesale. A retry that quietly went back to the default would re-run
    // the failure it had just fixed.
    const spy = limitSpy((_mb, n) => (n === 1 ? oom() : failed()));
    await run(spy);
    expect(spy.limits.length).toBeGreaterThanOrEqual(2);
    for (const limit of spy.limits.slice(1)) expect(limit).toBe(2048);
  });
});

/**
 * Refusing a plan that names a command this repository cannot run.
 *
 * `Preeti-Dalawai6/dataforge` imports a file of its own that is not there, so the rule
 * plan failed honestly. The model then got its one call and answered `npm run serve` —
 * a script in no package.json anywhere. DevLaunch built the container, installed the
 * dependency tree and waited to be told `Missing script: "serve"`.
 */
describe('a plan naming a script the manifest does not have', () => {
  const metadata = (scripts: Record<string, string>) => ({
    warnings: [], envExample: [], lockfiles: [], frameworkConfigs: [],
    packageJson: { scripts, dependencies: {}, devDependencies: {} },
  });

  function spyExec() {
    const launches: string[] = [];
    return {
      launches,
      exec: {
        async launch(o: { plan: { startCommand: string }; logs?: LogManager }) {
          launches.push(o.plan.startCommand);
          return {
            logs: o.logs ?? new LogManager(),
            waitForReady: async () => ready(),
            clearStartupBudget: () => undefined,
            cleanup: async () => ({ errors: [] }),
          } as unknown as LaunchHandle;
        },
      } as unknown as ExecutionManager,
    };
  }

  it('starts nothing, and says which scripts do exist', async () => {
    const { exec, launches } = spyExec();
    const mgr = new SessionManager(exec, {
      analyzer: { analyze: async () => metadata({ start: 'node server.js', dev: 'nodemon server.js' }) } as never,
      planner: {
        planRepository: async () => ({
          plan: RunPlanSchema.parse({ ...plan(), startCommand: 'npm run serve', planSource: 'ai-fallback' }),
          detected: 'express',
          warnings: [],
        }),
      } as never,
    });
    const s = await mgr.launch({ sourceDir: '/tmp/repo', image: 'devlaunch/node:20' });
    await until(() => s.state === ExecutionState.FAILED, 4000);

    expect(launches, 'nothing should be built to run a command that cannot exist').toEqual([]);
    expect(s.failure?.message).toMatch(/no such script/);
    // The actionable half: not just that `serve` is wrong, but what is right.
    expect(s.failure?.message).toMatch(/dev, start/);
    await mgr.shutdown();
  });

  it('blames the model when a model wrote it, and DevLaunch when a rule did', async () => {
    // Opposite conclusions from the same evidence. A model that has produced an
    // unusable plan is not asked again; a *rule* producing one is a bug here rather
    // than in the repository, and should say so rather than look like the project's
    // fault.
    const forSource = async (planSource: string) => {
      const { exec } = spyExec();
      const mgr = new SessionManager(exec, {
        analyzer: { analyze: async () => metadata({ start: 'node server.js' }) } as never,
        planner: {
          planRepository: async () => ({
            plan: RunPlanSchema.parse({ ...plan(), startCommand: 'npm run serve', planSource }),
            detected: 'express',
            warnings: [],
          }),
        } as never,
      });
      const s = await mgr.launch({ sourceDir: '/tmp/repo', image: 'devlaunch/node:20' });
      await until(() => s.state === ExecutionState.FAILED, 4000);
      await mgr.shutdown();
      return s;
    };

    expect((await forSource('ai-fallback')).failure?.code).toBe(FailureCode.INVALID_AI_PLAN);
    const ruled = await forSource('rule-based');
    expect(ruled.failure?.code).toBe(FailureCode.UNSUPPORTED_PROJECT);
    expect(ruled.failure?.remedy).toMatch(/DevLaunch bug/);
  });

  it('starts nothing when a model plan runs a file the clone does not have', async () => {
    // `techiescamp/kubernetes-ai-projects`: `node index.js`, no index.js anywhere, reported
    // a minute later as a missing dependency.
    const { exec, launches } = spyExec();
    const mgr = new SessionManager(exec, {
      analyzer: { analyze: async () => metadata({}) } as never,
      planner: {
        planRepository: async () => ({
          plan: RunPlanSchema.parse({ ...plan(), startCommand: 'node index.js', planSource: 'ai-fallback' }),
          detected: null,
          warnings: [],
        }),
      } as never,
    });
    const released: string[] = [];
    (exec as unknown as { releaseWorkspaces: (id: string) => Promise<void> }).releaseWorkspaces = async (id) => {
      released.push(id);
    };
    const s = await mgr.launch({ sourceDir: cloneWith('README.md'), image: 'devlaunch/node:20' });
    await until(() => s.state === ExecutionState.FAILED, 4000);

    expect(launches).toEqual([]);
    // Refused runs release what they hold, like every other refusal.
    await until(() => released.includes(s.id), 4000);
    expect(s.failure?.code).toBe(FailureCode.INVALID_AI_PLAN);
    expect(s.failure?.message).toBe('The start command runs `index.js`, and the repository has no such file.');
    await mgr.shutdown();
  });

  it('hands the application the values its example file ships', async () => {
    // `os.environ["AWS_REGION"]` at import, `AWS_REGION=us-east-1` in .env.example, and
    // nothing set it: a backend that could only crash.
    let launchedWith: RunPlan['environmentVariables'] = [];
    const { exec } = spyExec();
    const launch = exec.launch.bind(exec);
    exec.launch = (async (o: { plan: RunPlan }) => {
      launchedWith = o.plan.environmentVariables;
      return launch(o as never);
    }) as never;
    const mgr = new SessionManager(exec, {
      analyzer: {
        analyze: async () => ({
          ...metadata({ dev: 'vite' }),
          envExample: [{ key: 'AWS_REGION', hasDefault: true, value: 'us-east-1' }],
        }),
      } as never,
      planner: {
        planRepository: async () => ({
          plan: RunPlanSchema.parse({ ...plan(), startCommand: 'npm run dev' }),
          detected: 'vite',
          warnings: [],
        }),
      } as never,
    });
    const clone = cloneWith();
    writeFileSync(join(clone, 'main.py'), 'REGION = os.environ["AWS_REGION"]\n');
    const s = await mgr.launch({ sourceDir: clone, image: 'devlaunch/node:20' });
    await until(() => s.state === ExecutionState.READY, 4000);

    expect(launchedWith).toContainEqual({ key: 'AWS_REGION', value: 'us-east-1', required: false });
    await mgr.shutdown();
  });

  it('lets through a plan whose script is really there', async () => {
    const { exec, launches } = spyExec();
    const mgr = new SessionManager(exec, {
      analyzer: { analyze: async () => metadata({ dev: 'vite' }) } as never,
      planner: {
        planRepository: async () => ({
          plan: RunPlanSchema.parse({ ...plan(), startCommand: 'npm run dev' }),
          detected: 'vite',
          warnings: [],
        }),
      } as never,
    });
    const s = await mgr.launch({ sourceDir: '/tmp/repo', image: 'devlaunch/node:20' });
    await until(() => s.state === ExecutionState.READY, 4000);

    expect(launches).toEqual(['npm run dev']);
    await mgr.shutdown();
  });
});

describe('whether a later attempt got past the first failure', () => {
  const f = (evidence: string | undefined, phase: 'install' | 'build' | 'start' = 'start') => ({
    code: FailureCode.START_COMMAND_FAILED, message: 'x', phase, ...(evidence ? { evidence } : {}),
  });

  it('counts a missing package that is missing no longer', () => {
    expect(progressedPast(f("ModuleNotFoundError: No module named 'gradio'"), f('AttributeError: no GPU'))).toBe(true);
    expect(progressedPast(f("Error: Cannot find module 'express'"), f('TypeError: x is not a function'))).toBe(true);
  });

  it('does not count the same package still missing, or any other pair in one phase', () => {
    expect(progressedPast(f("No module named 'gradio'"), f("No module named 'gradio.themes'"))).toBe(false);
    expect(progressedPast(f('Bind 0.0.0.0 instead'), f('the model broke it'))).toBe(false);
    // A relative import is the repository's own file, not a package anything installs.
    expect(progressedPast(f("Cannot find module './routes'"), f('TypeError: x'))).toBe(false);
    // Nothing to compare against is not proof.
    expect(progressedPast(f("No module named 'gradio'"), f(undefined))).toBe(false);
    expect(progressedPast(f("No module named 'gradio'", 'build'), f('TypeError: x', 'build'))).toBe(true);
    expect(progressedPast(f("No module named 'gradio'", 'start'), f('TypeError: x', 'build'))).toBe(false);
  });
});
