import type Dockerode from 'dockerode';
import {
  ExecutionState,
  FailureCode,
  Sentinel,
  WrapperExit,
  type FailureDetail,
  type RunPlan,
} from '@devlaunch/shared';
import { config } from '../../config/index.js';
import { DockerManager, type ExitResult } from '../docker/DockerManager.js';
import { buildHostConfig, buildLabels } from '../docker/ContainerSecurity.js';
import { buildWrapperEnv, buildWrapperScript } from '../docker/wrapper.js';
import { CleanupManager } from '../cleanup/CleanupManager.js';
import { LogManager } from '../logs/LogManager.js';
import type { LogEntry } from '../logs/LogBuffer.js';
import { PortManager, type PortDiagnosis } from '../ports/PortManager.js';
import { ReadinessChecker, type ReadinessResult } from '../readiness/ReadinessChecker.js';
import { joinWorkspace } from '../security/PathValidator.js';
import { RunPlanValidator } from '../planning/RunPlanValidator.js';
import { FailureClassifier } from '../failures/FailureClassifier.js';

export type Phase = 'none' | 'install' | 'build' | 'start';

export interface LaunchOptions {
  sessionId: string;
  plan: RunPlan;
  /**
   * Names other services reach this container by, on the shared network.
   *
   * Absent for a single-service run, which has nothing to talk to.
   */
  networkAliases?: string[];
  /** Host directory whose contents become /workspace inside the container. */
  sourceDir: string;
  image: string;
  packageCacheVolume?: string;
  /** Overrides the time-to-ready budget. Exists so timeout behaviour is testable. */
  timeoutMs?: number;
  /**
   * Reuse an existing log manager instead of creating one.
   *
   * Lets a caller own the buffer before the container exists, so a client can attach
   * to a session's log stream while it is still queued and miss nothing.
   */
  logs?: LogManager;
}

export interface ReadyOutcome {
  state: ExecutionState;
  readiness: ReadinessResult;
  hostPort: string | null;
  /** Reachable URL, present only when the application actually answered. */
  url?: string;
  failure?: FailureDetail;
  /** Why the port was unreachable. Absent when the app became ready. */
  diagnosis?: PortDiagnosis;
}

export interface LaunchHandle {
  sessionId: string;
  container: Dockerode.Container;
  logs: LogManager;
  /** Sentinels observed so far, which is how a failure is attributed to a phase. */
  sentinels: Set<string>;
  phaseReached(): Phase;
  exit: Promise<ExitResult>;
  waitForLog(predicate: (e: LogEntry) => boolean, timeoutMs: number): Promise<LogEntry | null>;
  hostPort(): Promise<string | null>;
  /** Poll until the application answers, then explain the result either way. */
  waitForReady(timeoutMs?: number): Promise<ReadyOutcome>;
  /** Is the container still alive? Answers "I do not know" rather than guessing. */
  liveness(): Promise<ContainerLiveness>;
  /**
   * Stop applying the time-to-ready budget to this container.
   *
   * Called once the application is ready. The budget exists to bound *startup*; left
   * running it stops a perfectly healthy container the moment it elapses, which is a
   * ten-minute ceiling on every session regardless of the lifetime clock.
   */
  clearStartupBudget(): void;
  stop(): Promise<void>;
  cleanup(): Promise<{ errors: Error[] }>;
}

/**
 * What a liveness probe found.
 *
 * `unknown` is a first-class answer, not an error to be smoothed over: a Docker API
 * hiccup must never be reported to the user as their application having died.
 */
export type ContainerLiveness =
  | { kind: 'running' }
  | { kind: 'exited'; exitCode: number; oomKilled: boolean }
  | { kind: 'removed' }
  | { kind: 'unknown'; error?: string };

export interface RunResult {
  state: ExecutionState;
  exitCode: number;
  timedOut: boolean;
  phaseReached: Phase;
  failure?: FailureDetail;
  logs: LogEntry[];
}

/**
 * Map a wrapper exit code plus observed sentinels onto a failure class.
 *
 * Neither input is sufficient alone: the wrapper `exec`s the start command, so a
 * failing application returns *its own* exit code with no indication of which phase it
 * died in. The sentinels supply that missing half.
 *
 * Pure and exported so it can be unit-tested without Docker.
 */
export function classifyExit(
  exit: ExitResult,
  sentinels: Set<string>,
): { state: ExecutionState; failure?: FailureDetail; phase: Phase } {
  const phase: Phase = sentinels.has(Sentinel.START_BEGIN)
    ? 'start'
    : sentinels.has(Sentinel.BUILD_BEGIN)
      ? 'build'
      : sentinels.has(Sentinel.INSTALL_BEGIN)
        ? 'install'
        : 'none';

  if (exit.timedOut) {
    return {
      state: ExecutionState.FAILED,
      phase,
      failure: {
        code: FailureCode.PROCESS_TIMEOUT,
        message: `Execution exceeded its budget during the ${phase} phase.`,
        phase: phase === 'none' ? undefined : phase,
      },
    };
  }

  if (exit.exitCode === 0) {
    return { state: ExecutionState.COMPLETED, phase };
  }

  // Wrapper exit codes are authoritative only while the wrapper still owns the
  // process. Once the start command is exec'd the wrapper is gone, and the exit code
  // belongs to the application — an app exiting 110 of its own accord must not be
  // reported as a dependency install failure.
  if (!sentinels.has(Sentinel.START_BEGIN)) {
    if (exit.exitCode === WrapperExit.INSTALL_FAILED || sentinels.has(Sentinel.INSTALL_FAIL)) {
      return {
        state: ExecutionState.FAILED,
        phase: 'install',
        failure: {
          code: FailureCode.DEPENDENCY_INSTALL_FAILED,
          message: 'Dependency installation failed.',
          exitCode: exit.exitCode,
          phase: 'install',
        },
      };
    }

    if (exit.exitCode === WrapperExit.BUILD_FAILED || sentinels.has(Sentinel.BUILD_FAIL)) {
      return {
        state: ExecutionState.FAILED,
        phase: 'build',
        failure: {
          code: FailureCode.BUILD_FAILED,
          message: 'Build step failed.',
          exitCode: exit.exitCode,
          phase: 'build',
        },
      };
    }

    if (exit.exitCode === WrapperExit.WORKDIR_MISSING || sentinels.has(Sentinel.FATAL)) {
      return {
        state: ExecutionState.FAILED,
        phase,
        failure: {
          code: FailureCode.CONTAINER_CREATE_FAILED,
          message: 'Working directory was not present inside the container.',
          exitCode: exit.exitCode,
        },
      };
    }
  }

  if (phase === 'start') {
    return {
      state: ExecutionState.FAILED,
      phase,
      failure: {
        code: FailureCode.START_COMMAND_FAILED,
        message: `Start command exited with code ${exit.exitCode}.`,
        exitCode: exit.exitCode,
        phase: 'start',
      },
    };
  }

  return {
    state: ExecutionState.FAILED,
    phase,
    failure: {
      code: FailureCode.UNKNOWN_RUNTIME_ERROR,
      message: `Container exited with code ${exit.exitCode} before any phase began.`,
      exitCode: exit.exitCode,
    },
  };
}

/**
 * Decide what a liveness probe means for a session that had already become ready.
 *
 * Separate from `classifyExit` because the two answer different questions. That one
 * asks "which phase did this die in", and leans on sentinels to work it out. By the
 * time an application is ready every phase has already succeeded, so the phase is
 * known and the only open questions are whether it died and why.
 *
 * Returns null when the session should be left alone — which covers "still running"
 * and, importantly, "I could not tell". Reporting a Docker API hiccup as a dead
 * application would be inventing a failure out of a failure to observe one.
 *
 * Pure and exported so every branch can be tested without Docker.
 */
export function classifyPostReadyExit(
  liveness: ContainerLiveness,
  evidence?: string,
): { state: ExecutionState; failure?: FailureDetail } | null {
  if (liveness.kind === 'running' || liveness.kind === 'unknown') return null;

  if (liveness.kind === 'removed') {
    return {
      state: ExecutionState.FAILED,
      failure: {
        code: FailureCode.APPLICATION_EXITED,
        message: 'The container disappeared while the application was running.',
        phase: 'start',
        remedy:
          'Something outside DevLaunch removed it — check for a stray `docker rm` or a ' +
          'system prune, then start the session again.',
        confidence: 'medium',
      },
    };
  }

  const { exitCode, oomKilled } = liveness;

  if (oomKilled) {
    return {
      state: ExecutionState.FAILED,
      failure: {
        code: FailureCode.OUT_OF_MEMORY,
        message:
          `The application was killed for exceeding the container's ` +
          `${config.container.memoryMb} MB memory limit after it had become ready.`,
        exitCode,
        phase: 'start',
        remedy:
          'Raise DEVLAUNCH_CONTAINER_MEMORY_MB, or run the production build instead of ' +
          'a dev server — watch mode holds the whole module graph in memory.',
        confidence: 'high',
      },
    };
  }

  // A server that returns 0 shut itself down rather than crashed. Calling that a
  // failure would be wrong; the session is simply over.
  if (exitCode === 0) {
    return { state: ExecutionState.COMPLETED };
  }

  // Exit codes above 128 encode the signal that killed the process. Naming it turns an
  // opaque "137" into something the user can act on.
  const signal = exitCode > 128 && exitCode < 256 ? SIGNALS[exitCode - 128] : undefined;

  return {
    state: ExecutionState.FAILED,
    failure: {
      code: FailureCode.APPLICATION_EXITED,
      message: signal
        ? `The application was terminated by ${signal} after it had become ready.`
        : `The application exited with code ${exitCode} after it had become ready.`,
      exitCode,
      phase: 'start',
      evidence,
      remedy:
        'It started correctly, so the plan is not the problem. The end of the log is ' +
        'where the cause will be.',
      confidence: 'high',
    },
  };
}

/** Signal names for the exit codes that encode them, for the ones a container sees. */
const SIGNALS: Readonly<Record<number, string>> = {
  1: 'SIGHUP',
  2: 'SIGINT',
  3: 'SIGQUIT',
  6: 'SIGABRT',
  9: 'SIGKILL',
  11: 'SIGSEGV',
  15: 'SIGTERM',
};

export class ExecutionManager {
  /** Network the most recent launch used; undefined means the egress policy is absent. */
  lastNetworkUsed: string | undefined;

  private readonly ports: PortManager;
  private readonly readiness = new ReadinessChecker();
  private readonly validator = new RunPlanValidator();
  private readonly classifier = new FailureClassifier();
  /** Why the last inspect failed, so an unattributable failure can say what went wrong. */
  private lastInspectError: string | undefined;

  constructor(readonly docker: DockerManager) {
    this.ports = new PortManager(docker);
  }

  /**
   * Create, populate, and start a container, returning before it finishes.
   *
   * Servers never exit on their own, so the caller decides when to stop — Phase 3
   * will settle on readiness rather than on exit.
   */
  async launch(opts: LaunchOptions): Promise<LaunchHandle> {
    const cleanup = new CleanupManager(this.docker);

    // One gate for every plan, whatever produced it. A rejected plan never reaches Docker.
    this.validator.validate({ plan: opts.plan, image: opts.image });

    await this.docker.ensureImage(opts.image);
    if (opts.packageCacheVolume) await this.docker.ensureVolume(opts.packageCacheVolume);

    // The egress policy lives on a user-defined network. Without it the run still
    // works, but with weaker isolation, so the degradation is explicit rather than silent.
    const networkName = (await this.docker.networkExists(config.docker.networkName))
      ? config.docker.networkName
      : undefined;
    this.lastNetworkUsed = networkName;

    const workdir = joinWorkspace(config.container.workspacePath, opts.plan.workingDirectory);

    let container: Dockerode.Container;
    try {
      container = await this.docker.createContainer({
        image: opts.image,
        env: buildWrapperEnv(opts.plan, workdir),
        labels: buildLabels(opts.sessionId),
        hostConfig: buildHostConfig({
          sessionId: opts.sessionId,
          packageCacheVolume: opts.packageCacheVolume,
          networkName,
        }),
        workingDir: workdir,
        exposePort: opts.plan.expectedPort,
        // Only honoured on the user-defined network, which is also the only place the
        // egress policy applies — so a project that needs name resolution gets the
        // hardened network or neither.
        networkAliases: networkName ? opts.networkAliases : undefined,
      });
    } catch (err) {
      await cleanup.cleanup();
      throw err;
    }
    cleanup.trackContainer(container);

    try {
      // Repository first, wrapper second: both land inside the /workspace volume, and
      // copying the wrapper last guarantees a repository cannot shadow it.
      await this.docker.copyDirInto(container, opts.sourceDir, config.container.workspacePath);
      await this.docker.installWrapper(container, buildWrapperScript(), config.container.wrapperPath);

      const logs = opts.logs ?? new LogManager();
      const sentinels = new Set<string>();
      logs.on('sentinel', (marker: string) => sentinels.add(marker));

      // Start first, then attach.
      //
      // Attaching before start looks safer but is wrong: Docker's log stream on a
      // created-but-not-started container ends immediately, so every line is lost.
      // Attaching after start loses nothing either, because the logs endpoint replays
      // the container's full history (tail defaults to "all") before it begins
      // following — even if the container has already exited.
      await this.docker.start(container);

      const stream = await this.docker.followLogs(container);
      const streaming = logs.attach(container, stream);

      // The time-to-ready budget stops the container when it elapses. That is right
      // for a container that never became ready and wrong for one that did, so the
      // deadline is made liftable and the session releases it on READY.
      const startupBudget = new AbortController();

      const exit = this.docker
        .waitForExit(
          container,
          opts.timeoutMs ?? config.timeouts.timeToReadyMs,
          startupBudget.signal,
        )
        .then(async (r) => {
          await streaming.catch(() => undefined);
          return r;
        });

      // Once the budget is lifted this promise outlives readiness, and in the session
      // path nobody awaits it. Absorbing the rejection on a *derived* promise keeps a
      // container removed mid-wait from taking the process down, while an awaiting
      // caller (runToCompletion) still sees the error.
      exit.catch(() => undefined);

      return {
        sessionId: opts.sessionId,
        container,
        logs,
        sentinels,
        phaseReached: () =>
          sentinels.has(Sentinel.START_BEGIN)
            ? 'start'
            : sentinels.has(Sentinel.BUILD_BEGIN)
              ? 'build'
              : sentinels.has(Sentinel.INSTALL_BEGIN)
                ? 'install'
                : 'none',
        exit,
        waitForLog: (predicate, timeoutMs) => waitForLog(logs, predicate, timeoutMs),
        hostPort: () => this.ports.hostPortFor(container, opts.plan.expectedPort),
        waitForReady: (timeoutMs) =>
          this.waitForReady(container, opts.plan, sentinels, timeoutMs, logs),
        liveness: () => this.liveness(container),
        clearStartupBudget: () => startupBudget.abort(),
        stop: () => this.docker.stop(container),
        cleanup: () => cleanup.cleanup(),
      };
    } catch (err) {
      await cleanup.cleanup();
      throw err;
    }
  }

  /** Convenience for workloads that terminate on their own (fixtures, build steps). */
  async runToCompletion(opts: LaunchOptions): Promise<RunResult> {
    const handle = await this.launch(opts);
    try {
      const exit = await handle.exit;
      const { state, failure, phase } = classifyExit(exit, handle.sentinels);
      const logs = handle.logs.buffer.all();

      // Exit codes say which phase died; only the output says why.
      const refined = failure
        ? this.classifier.classify({ logs, exitCode: exit.exitCode, phase, fallback: failure })
        : undefined;

      return {
        state,
        exitCode: exit.exitCode,
        timedOut: exit.timedOut,
        phaseReached: phase,
        failure: refined,
        logs,
      };
    } finally {
      await handle.cleanup();
    }
  }

  /**
   * Wait for the application to answer, and explain the outcome either way.
   *
   * "Process started" and "application ready" are different facts, and separating them
   * is the entire point of this phase. When readiness is not reached, the container's
   * own listening sockets say *why* — a port bound to 127.0.0.1 is a completely
   * different problem from a port that never opened.
   */
  private async waitForReady(
    container: Dockerode.Container,
    plan: RunPlan,
    sentinels: Set<string>,
    timeoutMs?: number,
    logs?: LogManager,
  ): Promise<ReadyOutcome> {
    const budget = timeoutMs ?? config.timeouts.readinessMs;

    if (plan.expectedPort === null) {
      return {
        state: ExecutionState.FAILED,
        hostPort: null,
        readiness: { ready: false, attempts: 0, elapsedMs: 0 },
        failure: {
          code: FailureCode.PORT_NOT_LISTENING,
          message: 'Readiness cannot be checked: the plan declares no expected port.',
        },
      };
    }

    const hostPort = await this.ports.hostPortFor(container, plan.expectedPort);
    if (hostPort === null) {
      return {
        state: ExecutionState.FAILED,
        hostPort: null,
        readiness: { ready: false, attempts: 0, elapsedMs: 0 },
        failure: {
          code: FailureCode.PORT_NOT_LISTENING,
          message: `Docker published no host mapping for port ${plan.expectedPort}.`,
        },
      };
    }

    const readiness = await this.readiness.waitForReady({
      port: hostPort,
      healthCheck: plan.healthCheck,
      timeoutMs: budget,
      // Polling a container that has already died just burns the whole budget — but
      // only abort when we *know* it is gone. An inspect failure means unknown, and
      // aborting on unknown would cut readiness short for a healthy application.
      abortIf: async () => (await this.containerState(container))?.running === false,
    });

    if (readiness.ready) {
      return {
        state: ExecutionState.READY,
        hostPort,
        url: `http://localhost:${hostPort}${plan.healthCheck.path}`,
        readiness,
      };
    }

    return {
      state: ExecutionState.FAILED,
      hostPort,
      readiness,
      ...(await this.explainNotReady(container, plan, sentinels, readiness, logs)),
    };
  }

  private async explainNotReady(
    container: Dockerode.Container,
    plan: RunPlan,
    sentinels: Set<string>,
    readiness: ReadinessResult,
    logs?: LogManager,
  ): Promise<{ failure: FailureDetail; diagnosis?: PortDiagnosis }> {
    // One inspect, not two. Calling isRunning() and then inspect() again left a window
    // in which the container could change state between them.
    const state = await this.containerState(container);

    if (state === null) {
      // Not knowing is its own answer. Reporting a phase failure here would be
      // inventing a diagnosis out of a Docker API hiccup.
      return {
        failure: {
          code: FailureCode.UNKNOWN_RUNTIME_ERROR,
          message: 'The container could not be inspected, so the failure cannot be attributed.',
          evidence: this.lastInspectError,
          remedy: 'Check that the Docker daemon is responsive and retry.',
          confidence: 'low',
        },
      };
    }

    // A container that no longer exists was removed by cleanup, not by the application
    // failing. Attributing a phase failure to it would invent a cause.
    if (state.removed) {
      return {
        failure: {
          code: FailureCode.UNKNOWN_RUNTIME_ERROR,
          message: 'The container was removed before readiness completed.',
          confidence: 'low',
        },
      };
    }

    // A container that has exited cannot be introspected, and its exit code is the
    // more informative answer anyway.
    if (!state.running) {
      const exitCode = state.exitCode;
      const { failure, phase } = classifyExit({ exitCode, timedOut: false }, sentinels);
      const coarse = failure ?? {
        code: FailureCode.UNKNOWN_RUNTIME_ERROR,
        message: 'Container exited before becoming ready.',
      };
      return {
        failure: this.classifier.classify({
          // Read at classification time, not when readiness began: the session path
          // calls waitForReady immediately after launch, when nothing has been
          // logged yet, so a snapshot taken then is always empty.
          logs: logs?.buffer.all() ?? [],
          exitCode,
          phase,
          fallback: coarse,
        }),
      };
    }

    const diagnosis = await this.ports.diagnose(container, plan.expectedPort);

    if (diagnosis.kind === 'loopback-only') {
      return {
        diagnosis,
        failure: {
          code: FailureCode.PORT_BOUND_TO_LOCALHOST,
          message:
            `The application is listening on ${diagnosis.socket.address}:${diagnosis.socket.port}, ` +
            'which is reachable only from inside the container. Docker port mapping ' +
            'cannot forward to it. Bind 0.0.0.0 instead.',
          phase: 'start',
        },
      };
    }

    if (diagnosis.kind === 'not-listening') {
      const seen = diagnosis.observed.map((o) => `${o.address}:${o.port}`).join(', ');
      return {
        diagnosis,
        failure: {
          code: FailureCode.PORT_NOT_LISTENING,
          message:
            `Nothing is listening on port ${plan.expectedPort}.` +
            (seen ? ` Sockets observed: ${seen}.` : ' No listening sockets at all.'),
          phase: 'start',
        },
      };
    }

    // Listening and reachable, but no HTTP response within the budget.
    return {
      diagnosis,
      failure: {
        code: FailureCode.READINESS_TIMEOUT,
        message:
          `Port ${plan.expectedPort} is open but returned no HTTP response within the ` +
          `budget after ${readiness.attempts} attempts. Last error: ${readiness.lastError ?? 'none'}.`,
        phase: 'start',
      },
    };
  }

  /**
   * Container state as three outcomes, not two.
   *
   * The previous version swallowed every inspect error and returned false, which turned
   * "I could not determine the state" into "it has exited" — and the caller then built a
   * diagnosis from an exit code belonging to a container that was very likely still
   * running. Under load a transient Docker API error is entirely normal, so that
   * conflation produced confident, wrong failure attribution.
   *
   * Returning null for "unknown" forces the caller to decide what to do about not
   * knowing, rather than being handed a fabricated certainty.
   */
  /**
   * One inspect, reported as a liveness answer rather than as a diagnosis.
   *
   * Deliberately thin: the decision about what a dead container *means* belongs to
   * `classifyPostReadyExit`, which is pure and therefore testable without Docker.
   */
  private async liveness(container: Dockerode.Container): Promise<ContainerLiveness> {
    const state = await this.containerState(container);
    if (state === null) return { kind: 'unknown', error: this.lastInspectError };
    if (state.removed) return { kind: 'removed' };
    if (state.running) return { kind: 'running' };
    return { kind: 'exited', exitCode: state.exitCode, oomKilled: state.oomKilled === true };
  }

  private async containerState(
    container: Dockerode.Container,
    attempts = 3,
  ): Promise<{
    running: boolean;
    exitCode: number;
    removed?: boolean;
    oomKilled?: boolean;
  } | null> {
    let lastError: unknown;

    // Inspect is an idempotent read, so a transient failure is worth retrying rather
    // than escalating. Measured under full-suite load, the Docker API intermittently
    // refuses a request while many containers are churning; a single attempt turned
    // that hiccup into an unattributable failure for a healthy application.
    for (let i = 0; i < attempts; i++) {
      try {
        const info = await this.docker.inspect(container);
        this.lastInspectError = undefined;
        return {
          running: info.State.Running === true,
          exitCode: info.State.ExitCode ?? -1,
          // The kernel's OOM killer sends SIGKILL, so the process writes nothing on its
          // way out. This flag is the only evidence that survives, which makes it the
          // only way to tell an out-of-memory death from an ordinary crash.
          oomKilled: info.State.OOMKilled === true,
        };
      } catch (err) {
        // 404 is an answer, not a failure to get one: the container has been removed,
        // so it is definitively not running. Retrying cannot change that, and reporting
        // it as "unknown" discards information we actually have.
        if ((err as { statusCode?: number }).statusCode === 404) {
          this.lastInspectError = undefined;
          return { running: false, exitCode: -1, removed: true, oomKilled: false };
        }
        lastError = err;
        if (i < attempts - 1) await new Promise((r) => setTimeout(r, 150 * 2 ** i));
      }
    }

    // Kept so the failure can name *why* it could not be attributed. An unexplained
    // "unknown" is only marginally better than a wrong answer.
    this.lastInspectError = lastError instanceof Error ? lastError.message : String(lastError);
    return null;
  }
}

function waitForLog(
  logs: LogManager,
  predicate: (e: LogEntry) => boolean,
  timeoutMs: number,
): Promise<LogEntry | null> {
  const existing = logs.buffer.all().find(predicate);
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      logs.off('entry', onEntry);
      resolve(null);
    }, timeoutMs);

    function onEntry(entry: LogEntry) {
      if (!predicate(entry)) return;
      clearTimeout(timer);
      logs.off('entry', onEntry);
      resolve(entry);
    }

    logs.on('entry', onEntry);
  });
}

