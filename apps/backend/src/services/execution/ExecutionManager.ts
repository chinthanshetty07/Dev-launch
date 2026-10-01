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
import { STATIC_SERVER_SCRIPT } from '../docker/staticServer.js';
import { CleanupManager } from '../cleanup/CleanupManager.js';
import { LogManager } from '../logs/LogManager.js';
import type { LogEntry } from '../logs/LogBuffer.js';
import { PortManager, type PortDiagnosis } from '../ports/PortManager.js';
import { ReadinessChecker, type ReadinessResult } from '../readiness/ReadinessChecker.js';
import { joinWorkspace } from '../security/PathValidator.js';
import { RunPlanValidator } from '../planning/RunPlanValidator.js';
import { FailureClassifier } from '../failures/FailureClassifier.js';
import { MemoryBudget, containerCapacityMb } from './MemoryPolicy.js';
import { detectOom, withMemoryEvidence } from '../failures/OomDetection.js';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { readCapped } from '../analysis/readCapped.js';
import { pyprojectRequirements } from '../analysis/ServiceDiscovery.js';

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
  /** Publish on this host port instead of letting Docker choose one. */
  hostPort?: number;
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
  /**
   * Memory ceiling for this container, overriding the configured default.
   *
   * Set by the one repair that changes no command: a run killed by the limit is retried
   * under a larger one, because the limit is DevLaunch's own number rather than
   * anything the repository did.
   */
  memoryMb?: number;
  /** A V8 heap size DevLaunch chose after a heap OOM; see `nodeHeapMbFor`. */
  nodeHeapMb?: number;
  /**
   * Which workspace this container belongs to, for keeping installs between containers.
   *
   * Containers launched under the same key share one workspace volume, and a launch
   * whose install would repeat one that already finished there skips it. A session's
   * single service has one key; a project's services each have their own, or one between
   * them when they install the same workspace. Absent, the workspace is anonymous and
   * goes with the container, as it always did. See `workspaceFor`.
   */
  workspaceKey?: string;
}

/** A workspace volume kept between the containers of one session. */
interface Workspace {
  volume: string;
  sessionId: string;
  /** The install that finished in it, as `installSignature` describes it. */
  installed?: string;
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
 * Derive the generated requirements file from the repository, when the plan installs it.
 *
 * From the repository and never from the plan: a plan — a model's included — can name the
 * path, and gets the file the repository's own pyproject.toml describes, validated line by
 * line; it cannot choose what is in it. Returns the lines written, or null when the plan
 * does not use the file.
 */
export async function derivedRequirements(sourceDir: string, workingDirectory: string): Promise<string[]> {
  const dir = resolve(sourceDir, workingDirectory);
  // The working directory was validated before this point; this keeps the read inside the
  // source directory even if that ever stops being true.
  if (dir !== resolve(sourceDir) && !dir.startsWith(resolve(sourceDir) + sep)) return [];
  const raw = await readCapped(join(dir, 'pyproject.toml'));
  return raw === null ? [] : pyprojectRequirements(raw);
}

/** The phase a container reached, from the sentinels it printed. */
function phaseFrom(sentinels: Set<string>): Phase {
  if (sentinels.has(Sentinel.START_BEGIN)) return 'start';
  if (sentinels.has(Sentinel.BUILD_BEGIN)) return 'build';
  if (sentinels.has(Sentinel.INSTALL_BEGIN)) return 'install';
  return 'none';
}

/**
 * A failure restated with the memory evidence: Docker's OOM flag first, the phase's own
 * log second. See `OomDetection`.
 */
function memoryVerdict(
  failure: FailureDetail,
  ctx: { oomKilled?: boolean; exitCode?: number; logs?: LogManager; phase: Phase; limitMb: number; coarse: FailureDetail },
): FailureDetail {
  const lines = ctx.logs ? phaseLog(ctx.logs, ctx.phase).map((e) => e.text) : [];
  const oom = detectOom({ oomKilled: ctx.oomKilled, exitCode: ctx.exitCode, lines });
  const withPhase = failure.phase || ctx.phase === 'none' ? failure : { ...failure, phase: ctx.phase };
  return withMemoryEvidence(withPhase, oom, { limitMb: ctx.limitMb, oomKilled: ctx.oomKilled, coarse: ctx.coarse });
}

/** A start command that ended with 0 where a server was expected, in one set of words. */
function finishedInsteadOfServing(plan: RunPlan): string {
  return `The start command finished successfully instead of serving; nothing ever listened on port ${plan.expectedPort}.`;
}

/**
 * The part of the log that can explain a failure in `phase`: from that phase's opening
 * sentinel on. An install prints hundreds of lines, and a signature matching any of them
 * explained a start that failed for a different reason — the one in the start's own
 * output. With no marker for the phase, the whole log, as before.
 */
export function phaseLog(logs: LogManager, phase: Phase): LogEntry[] {
  const marker =
    phase === 'start'
      ? Sentinel.START_BEGIN
      : phase === 'build'
        ? Sentinel.BUILD_BEGIN
        : phase === 'install'
          ? Sentinel.INSTALL_BEGIN
          : undefined;
  return marker ? logs.since(marker) : logs.buffer.all();
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
  /** The limit this container actually ran under, when a repair raised it. */
  memoryMb?: number,
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
          `${memoryMb ?? config.container.memoryMb} MB memory limit after it had become ready.`,
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

  /**
   * The memory every container this process runs has been promised, against the VM.
   * Read by escalation before it asks for more; see `MemoryBudget`.
   */
  readonly memory: MemoryBudget;
  private readonly workspaces = new Map<string, Workspace>();
  private workspaceSeq = 0;
  private capacityMb: number | null = null;
  private capacityRead = false;

  constructor(readonly docker: DockerManager) {
    this.ports = new PortManager(docker);
    this.memory = new MemoryBudget(() => this.capacityMb);
  }

  /** What a container is using now, in MB, or null when it cannot be sampled. */
  /**
   * What a container is using now, in MB; `'gone'` when Docker no longer has it, which is
   * different from a sample that could not be read and is treated differently: the
   * ledger releases a gone container's hold, and counts an unreadable one at its limit.
   */
  async usageMb(container: Dockerode.Container): Promise<number | null | 'gone'> {
    const stats = await this.docker.sampleStats?.(container);
    if (stats) return stats.memoryBytes / (1024 * 1024);
    try {
      await this.docker.inspect(container);
      return null;
    } catch (err) {
      return (err as { statusCode?: number }).statusCode === 404 ? 'gone' : null;
    }
  }

  /** The memory one container could be given, counting the others at what they use. */
  availableMb(exceptId?: string): Promise<number | null> {
    return this.memory.measuredFreeMb(exceptId);
  }

  /** The VM's size, read once, through the daemon the containers run on. */
  async vmMemoryBytes(): Promise<number | null> {
    const bytes = (await this.docker.hostMemoryBytes?.().catch(() => null)) ?? null;
    if (!this.capacityRead) {
      this.capacityMb = containerCapacityMb(bytes);
      this.capacityRead = true;
    }
    return bytes;
  }

  /**
   * Create, populate, and start a container, returning before it finishes.
   *
   * Servers never exit on their own, so the caller decides when to stop — Phase 3
   * will settle on readiness rather than on exit.
   */
  async launch(opts: LaunchOptions): Promise<LaunchHandle> {
    if (!this.capacityRead) await this.vmMemoryBytes();
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
    const workspace = await this.workspaceFor(opts);
    const signature = this.installSignature(opts);

    let container: Dockerode.Container;
    try {
      container = await this.docker.createContainer({
        image: opts.image,
        env: buildWrapperEnv(
          opts.plan,
          workdir,
          opts.plan.installDirectory
            ? joinWorkspace(config.container.workspacePath, opts.plan.installDirectory)
            : undefined,
          { ...(opts.nodeHeapMb ? { nodeHeapMb: opts.nodeHeapMb } : {}), installReused: workspace.reused },
        ),
        labels: buildLabels(opts.sessionId),
        hostConfig: buildHostConfig({
          sessionId: opts.sessionId,
          packageCacheVolume: opts.packageCacheVolume,
          networkName,
          ...(opts.memoryMb ? { memoryMb: opts.memoryMb } : {}),
        }),
        workingDir: workdir,
        exposePort: opts.plan.expectedPort,
        hostPort: opts.hostPort,
        // Only honoured on the user-defined network, which is also the only place the
        // egress policy applies — so a project that needs name resolution gets the
        // hardened network or neither.
        networkAliases: networkName ? opts.networkAliases : undefined,
        ...(workspace.volume ? { workspaceVolume: workspace.volume } : {}),
      });
    } catch (err) {
      await cleanup.cleanup();
      throw err;
    }
    cleanup.trackContainer(container);
    // The limit is held until this container is cleaned up, so an escalation elsewhere
    // cannot promise the VM more than it has.
    const limitMb = opts.memoryMb ?? config.container.memoryMb;
    this.memory.hold(container.id, limitMb, () => this.usageMb(container));

    try {
      // Repository first, wrapper second: both land inside the /workspace volume, and
      // copying the wrapper last guarantees a repository cannot shadow it.
      // A reused workspace already holds the repository; copying it again over a tree a
      // sibling may be serving from would only wake that sibling's file watchers.
      if (!workspace.reused) {
        await this.docker.copyDirInto(container, opts.sourceDir, config.container.workspacePath);
      }
      await this.docker.installWrapper(container, buildWrapperScript(), config.container.wrapperPath);
      const generated = await this.installGeneratedRequirements(container, opts);
      await this.installStaticServer(container, opts);

      const logs = opts.logs ?? new LogManager();
      if (generated !== null) {
        logs.write(
          'stdout',
          `Wrote ${config.container.generatedRequirementsPath} from pyproject.toml: ` +
            `${generated.length} requirements, with the version ranges it declares.`,
        );
      }
      const sentinels = new Set<string>();
      logs.on('sentinel', (marker: string) => sentinels.add(marker));
      // What this workspace now holds. Only for the volume this container mounted: a later
      // launch may have moved the key on to a fresh one.
      if (opts.workspaceKey && workspace.volume) {
        const key = opts.workspaceKey;
        const volume = workspace.volume;
        logs.on('sentinel', (marker: string) => {
          const ws = this.workspaces.get(key);
          if (!ws || ws.volume !== volume) return;
          if (marker === Sentinel.INSTALL_OK && signature !== null) ws.installed = signature;
          if (marker === Sentinel.INSTALL_FAIL) ws.installed = undefined;
        });
      }

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
          this.waitForReady(container, opts.plan, sentinels, timeoutMs, logs, limitMb),
        liveness: () => this.liveness(container),
        clearStartupBudget: () => startupBudget.abort(),
        stop: () => this.docker.stop(container),
        cleanup: async () => {
          try {
            return await cleanup.cleanup();
          } finally {
            this.memory.release(container.id);
          }
        },
      };
    } catch (err) {
      await cleanup.cleanup();
      this.memory.release(container.id);
      throw err;
    }
  }

  /**
   * What decides whether an install already done can stand in for this one: the image it
   * ran in, the command, and the directory it ran in. Null when there is no install.
   */
  private installSignature(opts: LaunchOptions): string | null {
    const { installCommand, installDirectory, workingDirectory } = opts.plan;
    if (!installCommand) return null;
    return JSON.stringify([opts.image, installCommand, installDirectory ?? workingDirectory]);
  }

  /**
   * The workspace volume for this launch, and whether its install can be skipped.
   *
   * Every container used to start from an empty workspace, so every restart installed
   * everything again: a repair that changed only a port reinstalled the whole tree, and
   * the second service of a workspace installed what the first had just installed.
   * Measured on `ejazahm3d/fullstack-turborepo-starter`: three installs of one tree,
   * 54 + 68 + 75 seconds, of a 222-second run.
   *
   * Reused only when an install with the same signature *finished* in that volume — an
   * install that was killed, failed or never ran leaves nothing to trust, and gets a
   * fresh volume, the previous one removed. Never across sessions: the key carries the
   * session, and teardown removes every volume the session made.
   */
  private async workspaceFor(opts: LaunchOptions): Promise<{ volume?: string; reused: boolean }> {
    if (!opts.workspaceKey || typeof this.docker.createWorkspaceVolume !== 'function') return { reused: false };
    const signature = this.installSignature(opts);
    const current = this.workspaces.get(opts.workspaceKey);
    if (current && signature !== null && current.installed === signature) {
      return { volume: current.volume, reused: true };
    }
    const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const volume = `${config.docker.workspaceVolumePrefix}${slug(opts.workspaceKey).slice(0, 48)}-${++this.workspaceSeq}`;
    await this.docker.createWorkspaceVolume(volume, opts.sessionId);
    if (current) {
      // Still mounted by a sibling, it stays until teardown, which removes it then.
      await this.docker.removeVolume(current.volume).catch(() => undefined);
    }
    this.workspaces.set(opts.workspaceKey, { volume, sessionId: opts.sessionId });
    return { volume, reused: false };
  }

  /** Remove every workspace volume a session made. Its containers must be gone first. */
  async releaseWorkspaces(sessionId: string): Promise<void> {
    for (const [key, ws] of [...this.workspaces]) if (ws.sessionId === sessionId) this.workspaces.delete(key);
    if (typeof this.docker.listWorkspaceVolumes !== 'function') return;
    const volumes = await this.docker.listWorkspaceVolumes({ sessionId }).catch(() => [] as string[]);
    for (const volume of volumes) await this.docker.removeVolume(volume).catch(() => undefined);
  }

  /**
   * The generated requirements file, when any step of the plan names it.
   *
   * Install only, at first, because the rule that writes the path puts it there. A model's
   * plan rewrite for `nsidnev/fastapi-realworld-example-app` installed a pinned asyncpg
   * first and moved `pip install -r` of this file into the build step — a reasonable plan,
   * which died on `Could not open requirements file` before reaching anything about the
   * repository. Which step names the path does not change what is in the file: that is
   * derived from the repository's own pyproject.toml, never from the plan.
   */
  private async installGeneratedRequirements(
    container: Dockerode.Container,
    opts: LaunchOptions,
  ): Promise<string[] | null> {
    const { installCommand, buildCommand, startCommand } = opts.plan;
    const named = [installCommand, buildCommand, startCommand].some((c) =>
      c?.includes(config.container.generatedRequirementsPath),
    );
    if (!named) return null;
    const lines = await derivedRequirements(opts.sourceDir, opts.plan.workingDirectory);
    await this.docker.installFile(
      container,
      basename(config.container.generatedRequirementsPath),
      lines.length ? `${lines.join('\n')}\n` : '',
      dirname(config.container.generatedRequirementsPath),
    );
    return lines;
  }

  /** DevLaunch's static server, when the plan starts it — and only then. */
  private async installStaticServer(container: Dockerode.Container, opts: LaunchOptions): Promise<void> {
    if (!opts.plan.startCommand.includes(config.container.staticServerPath)) return;
    await this.docker.installFile(
      container,
      basename(config.container.staticServerPath),
      STATIC_SERVER_SCRIPT,
      dirname(config.container.staticServerPath),
    );
  }

  /** Convenience for workloads that terminate on their own (fixtures, build steps). */
  async runToCompletion(opts: LaunchOptions): Promise<RunResult> {
    const handle = await this.launch(opts);
    try {
      const exit = await handle.exit;
      const { state, failure, phase } = classifyExit(exit, handle.sentinels);
      // Exit codes say which phase died; only the output says why — and Docker says
      // whether the kernel killed it for memory, which the output cannot.
      const inspected = failure ? await this.containerState(handle.container) : null;
      const refined = failure
        ? memoryVerdict(
            this.classifier.classify({ logs: phaseLog(handle.logs, phase), exitCode: exit.exitCode, phase, fallback: failure }),
            { oomKilled: inspected?.removed ? undefined : inspected?.oomKilled, exitCode: exit.exitCode, logs: handle.logs, phase, limitMb: opts.memoryMb ?? config.container.memoryMb, coarse: failure },
          )
        : undefined;

      return {
        state,
        exitCode: exit.exitCode,
        timedOut: exit.timedOut,
        phaseReached: phase,
        failure: refined,
        logs: handle.logs.buffer.all(),
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
    limitMb: number = config.container.memoryMb,
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
      // Ask *why* there is no mapping before describing its absence.
      //
      // A container that has already exited has no published port, so this reported
      // "Docker published no host mapping" — a symptom of the death rather than its
      // cause. For an OOM kill that is worse than unhelpful: the memory repair keys off
      // OUT_OF_MEMORY, so a wrong code meant the one repair that would have fixed the
      // run never fired. Seen against a real workspace repository, whose service was
      // killed at 1024 MB and reported as a missing port mapping.
      const died = await this.containerState(container);
      // `removed` is not a death. A container that 404s was swept by cleanup or stopped
      // by the user; it carries the -1 placeholder exit code, and the first version of
      // this branch duly reported "exited with code -1" for a run nobody's application
      // had anything to do with. The sibling path below (`state.removed`) already
      // refuses to attribute that, and so does this one.
      if (died?.running === false && died.removed !== true) {
        const oom = died.oomKilled === true;
        // -1 is this codebase's "inspect gave us no code", not a real exit status.
        const code = died.exitCode === -1 ? undefined : died.exitCode;
        // The phase it died in, from its own markers — not assumed to be the install.
        const phase = phaseFrom(sentinels);
        const exited: FailureDetail = oom
            ? {
                code: FailureCode.OUT_OF_MEMORY,
                message:
                  'The process was killed for exceeding the container memory limit, before ' +
                  'it opened a port.',
                ...(phase !== 'none' ? { phase } : {}),
                confidence: 'high',
              }
            : {
                code: FailureCode.APPLICATION_EXITED,
                // Exit 0 is its own story: the start command ran to completion instead
                // of staying up to serve. Reporting that as a crash sends the reader
                // looking for an error that was never printed, when the real answer is
                // that the plan is starting the wrong command.
                message:
                  code === 0
                    ? finishedInsteadOfServing(plan)
                    : code === undefined
                      ? `The container exited before opening port ${plan.expectedPort}, and Docker reported no exit code.`
                      : `The container exited with code ${code} before opening port ${plan.expectedPort}.`,
                ...(code !== undefined ? { exitCode: code } : {}),
                ...(phase !== 'none' ? { phase } : {}),
                confidence: 'high',
              };
        return {
          state: ExecutionState.FAILED,
          hostPort: null,
          readiness: { ready: false, attempts: 0, elapsedMs: 0 },
          failure: memoryVerdict(exited, { oomKilled: died.oomKilled, exitCode: code, logs, phase, limitMb, coarse: exited }),
        };
      }

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

    // Readiness measures the application, so its clock starts when the application
    // does — not when the container does.
    //
    // Install and build run inside the container before the start command is exec'd. A
    // heavy dependency tree can take many minutes, and counting that against a
    // sixty-second readiness budget reports "nothing is listening" about a project that
    // has not been asked to listen yet — then repairs a plan that was never wrong,
    // re-running the same install from scratch each time.
    const reached = await this.waitForStart(container, sentinels, logs);
    if (reached === 'timeout') {
      return {
        state: ExecutionState.FAILED,
        hostPort,
        readiness: { ready: false, attempts: 0, elapsedMs: 0 },
        failure: {
          code: FailureCode.PROCESS_TIMEOUT,
          message:
            'Installing dependencies did not finish within the time-to-ready budget, so ' +
            'the application was never started.',
          phase: sentinels.has(Sentinel.BUILD_BEGIN) ? 'build' : 'install',
          remedy:
            'Raise DEVLAUNCH_TIMEOUT_TIME_TO_READY_MS for a project with a large ' +
            'dependency tree. A pip resolver that reports backtracking is the usual cause.',
          confidence: 'high',
        },
      };
    }

    const readiness = await this.readiness.waitForReady({
      port: hostPort,
      healthCheck: plan.healthCheck,
      ...(plan.protocol ? { protocol: plan.protocol } : {}),
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
        url: `${plan.protocol ?? 'http'}://localhost:${hostPort}${plan.healthCheck.path}`,
        readiness,
      };
    }

    const explained = await this.explainNotReady(container, plan, sentinels, readiness, logs, limitMb);
    return { hostPort, readiness, ...explained };
  }

  private async explainNotReady(
    container: Dockerode.Container,
    plan: RunPlan,
    sentinels: Set<string>,
    readiness: ReadinessResult,
    logs?: LogManager,
    limitMb: number = config.container.memoryMb,
  ): Promise<{ state: ExecutionState; failure?: FailureDetail; diagnosis?: PortDiagnosis }> {
    // One inspect, not two. Calling isRunning() and then inspect() again left a window
    // in which the container could change state between them.
    const state = await this.containerState(container);

    if (state === null) {
      // Not knowing is its own answer. Reporting a phase failure here would be
      // inventing a diagnosis out of a Docker API hiccup.
      return {
        state: ExecutionState.FAILED,
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
        state: ExecutionState.FAILED,
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
      const { state: exitState, failure, phase } = classifyExit({ exitCode, timedOut: false }, sentinels);

      // A program that ran and exited 0 did its job. Not every repository is a server:
      // a CLI, a migration, a seeder, a scraper, a build script all finish and stop, and
      // reporting that as `UNKNOWN_RUNTIME_ERROR: container exited before becoming ready`
      // told a person their working program was broken, with no evidence and no remedy
      // — the exact shape of unhelpful failure this exists to prevent. `runToCompletion`
      // had always classified it correctly; only readiness, which is watching for a port
      // that is never going to open, did not.
      //
      // Unless DevLaunch itself planned a server. `hostBinding: 'forced'` means a framework
      // was recognised and told where to listen — a dev server, not a script — and a dev
      // server that stops with 0 before opening its port has stopped, not finished. Called
      // COMPLETED, "the expected shape for a script", it hid a CRA dev server closing on an
      // empty stdin, about a plan built minutes earlier to serve port 3000. The sibling
      // path above, for a container found dead before readiness began, already said so.
      if (exitState === ExecutionState.COMPLETED) {
        if (plan.hostBinding !== 'forced') return { state: ExecutionState.COMPLETED };
        return {
          state: ExecutionState.FAILED,
          failure: {
            code: FailureCode.APPLICATION_EXITED,
            message: finishedInsteadOfServing(plan),
            exitCode: 0,
            phase: 'start',
            evidence: lastOutputLine(logs),
            remedy:
              'DevLaunch started this as a server and it stopped by itself, reporting success. ' +
              'A dev server that exits cleanly has usually been told to: an ended stdin, a ' +
              'script that builds rather than serves, or a flag it read as "run once". The ' +
              'last lines of the log say which.',
            confidence: 'high',
          },
        };
      }

      const coarse = failure ?? {
        code: FailureCode.UNKNOWN_RUNTIME_ERROR,
        message: 'Container exited before becoming ready.',
      };
      return {
        state: ExecutionState.FAILED,
        failure: memoryVerdict(this.classifier.classify({
          // Read at classification time, not when readiness began: the session path
          // calls waitForReady immediately after launch, when nothing has been
          // logged yet, so a snapshot taken then is always empty.
          logs: logs ? phaseLog(logs, phase) : [],
          exitCode,
          phase,
          fallback: coarse,
        }), { oomKilled: state.oomKilled, exitCode, logs, phase, limitMb, coarse }),
      };
    }

    const diagnosis = await this.ports.diagnose(container, plan.expectedPort);

    // A process that is running but silent has usually said why. `tsx watch` and every
    // other watcher survive a crash in the code they are watching, so the container
    // stays up, nothing binds, and "nothing is listening" is the whole verdict unless
    // the application's own last words are carried with it.
    const lastError = lastErrorLine(logs);

    if (diagnosis.kind === 'loopback-only') {
      return {
        state: ExecutionState.FAILED,
        diagnosis,
        failure: {
          evidence: lastError,
          code: FailureCode.PORT_BOUND_TO_LOCALHOST,
          observedSocket: diagnosis.socket,
          message:
            `The application is listening on ${diagnosis.socket.address}:${diagnosis.socket.port}, ` +
            'which is reachable only from inside the container. Docker port mapping ' +
            'cannot forward to it. Bind 0.0.0.0 instead.',
          phase: 'start',
        },
      };
    }

    // Open, and on a port nobody expected. The kernel's answer, which beats both the
    // framework default the plan was built on and any log line claiming otherwise.
    if (diagnosis.kind === 'other-port') {
      const { address, port, loopbackOnly } = diagnosis.socket;
      return {
        state: ExecutionState.FAILED,
        diagnosis,
        failure: {
          code: loopbackOnly ? FailureCode.PORT_BOUND_TO_LOCALHOST : FailureCode.PORT_NOT_LISTENING,
          observedSocket: diagnosis.socket,
          message: loopbackOnly
            ? `The application is listening on ${address}:${port} — a different port from the ` +
              `expected ${plan.expectedPort}, and one reachable only from inside the container. ` +
              'Docker port mapping cannot forward to it.'
            : `Nothing is listening on port ${plan.expectedPort}, but the application has opened ` +
              `${address}:${port}. It is running; the plan is watching the wrong port.`,
          evidence: lastError,
          phase: 'start',
          confidence: 'high',
          remedy: loopbackOnly
            ? `Bind 0.0.0.0 rather than ${address}, and expose port ${port}.`
            : undefined,
        },
      };
    }

    if (diagnosis.kind === 'not-listening') {
      const seen = diagnosis.observed.map((o) => `${o.address}:${o.port}`).join(', ');

      // An application that never bound has usually not *errored* — it is simply still
      // doing something, or waiting on something that will never answer. Its last words
      // are the whole diagnosis, and an error-shaped filter throws them away: a server
      // stuck in its startup hook says `Waiting for application startup.` and nothing
      // further, which matches no error pattern and is the single most useful line in
      // the log. Reported without it, the failure reads `Nothing is listening on port
      // 8000. Sockets observed: 127.0.0.11:37497.` and tells a person nothing at all.
      const stalled = stalledStartup(logs);
      const lastSaid = lastError ?? lastOutputLine(logs);

      const portFailure: FailureDetail = {
        code: FailureCode.PORT_NOT_LISTENING,
        message:
          `Nothing is listening on port ${plan.expectedPort}.` +
          (seen ? ` Sockets observed: ${seen}.` : ' No listening sockets at all.'),
        phase: 'start',
        evidence: lastSaid,
        remedy: stalled
          ? 'The server started but never finished starting up, so it never opened its ' +
            'port. Something in its startup hook has not returned — most often a ' +
            'database or external service being waited on that never answers. Check ' +
            'what the application connects to at boot.'
          : lastError
            ? 'The application is running but never bound the port. Its last error is above.'
            : lastSaid
              ? 'The application is running but never bound the port. The line above is ' +
                'the last thing it printed before going quiet.'
              : undefined,
      };

      // "Nothing is listening" describes the symptom; the log often names the cause, and
      // a cause beats a symptom. Only this branch defers to the log — a loopback-only
      // bind is read from the container's own socket table and is not a guess a log line
      // should be allowed to overrule.
      return {
        state: ExecutionState.FAILED,
        diagnosis,
        failure: this.classifier.classify({
          logs: logs ? phaseLog(logs, 'start') : [],
          exitCode: 0,
          phase: 'start',
          fallback: portFailure,
        }),
      };
    }

    // Listening and reachable, but no HTTP response within the budget.
    return {
      state: ExecutionState.FAILED,
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
   * Wait until the application is actually started, or it becomes clear it never will be.
   *
   * The wrapper prints the START sentinel immediately before `exec`ing the start
   * command, which is the only signal that install and build are behind us. Bounded by
   * the time-to-ready budget, which is what stops the container anyway.
   */
  private async waitForStart(
    container: Dockerode.Container,
    sentinels: Set<string>,
    logs: LogManager | undefined,
    budgetMs = config.timeouts.timeToReadyMs,
  ): Promise<'started' | 'exited' | 'timeout'> {
    if (sentinels.has(Sentinel.START_BEGIN)) return 'started';
    if (!logs) return 'started';

    const deadline = Date.now() + budgetMs;

    return new Promise<'started' | 'exited' | 'timeout'>((resolve) => {
      let settled = false;
      const finish = (outcome: 'started' | 'exited' | 'timeout'): void => {
        if (settled) return;
        settled = true;
        logs.off('sentinel', onSentinel);
        clearInterval(poll);
        resolve(outcome);
      };

      function onSentinel(marker: string): void {
        if (marker.trim() === Sentinel.START_BEGIN) finish('started');
      }
      logs.on('sentinel', onSentinel);

      // A container that exits during install never prints the sentinel, and the caller
      // attributes that failure properly from its exit code.
      const poll = setInterval(() => {
        if (sentinels.has(Sentinel.START_BEGIN)) return finish('started');
        if (Date.now() > deadline) return finish('timeout');
        void this.containerState(container).then((state) => {
          if (state && !state.running) finish('exited');
        });
      }, 1000);
      poll.unref?.();
    });
  }

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

/**
 * What the application itself has printed: the log from the start marker on.
 *
 * These helpers describe a running application, and an install that finished before it
 * began is not the application talking. Read whole, the last "error-shaped" line of a
 * process that never listened was husky's install-time `git command not found`.
 */
function startLog(logs: LogManager | undefined): LogEntry[] {
  return logs?.since(Sentinel.START_BEGIN) ?? [];
}

/**
 * The application's last error line, for a failure that otherwise has none.
 *
 * Deliberately narrow: an arbitrary tail of a build log is noise, and a stack frame is
 * not the message. The first line of the most recent error is what a person reads.
 */
export function lastErrorLine(logs: LogManager | undefined): string | undefined {
  // "Written to stderr" is not the same as "says something". A crashing Node process
  // ends with its own version banner, and taking the last stderr line returns
  // `Node.js v20.20.2` — true, and no help at all. The line has to look like a message.
  const MESSAGE = /(^|\s)(\w*Error\b|error\b|exception\b)|\b(cannot|could not|failed|unable to|refused|not found|missing)\b/i;
  // Errno codes are matched separately *without* the case-insensitive flag. Folded into
  // the expression above they were a trap: `/i` makes `[A-Z]` match lowercase, so
  // `\bE[A-Z]{3,}\b` matched `extensions`, `elapsed`, `existing` — and pip's
  // "Successfully installed typing-extensions..." was reported as the error behind a
  // failure, in preference to the line that actually said what went wrong.
  const ERRNO = /\bE[A-Z]{3,}\b/;
  const NOISE = /^(node\.js v|npm (error )?a complete log|at\s)/i;

  const entries = startLog(logs);
  for (let i = entries.length - 1; i >= 0; i--) {
    const text = entries[i]!.text.trim();
    if (!text || NOISE.test(text) || /^\s*at /.test(text)) continue;
    if (MESSAGE.test(text) || ERRNO.test(text)) return text.slice(0, 300);
  }
  return undefined;
}

/**
 * The last thing the application said, error-shaped or not.
 *
 * `lastErrorLine` deliberately requires a line to look like a message, which is right
 * when an error exists and wrong when none does. A process that is alive and silent has
 * still told us where it stopped, and "the last line before it went quiet" is a fact
 * rather than a guess.
 */
export function lastOutputLine(logs: LogManager | undefined): string | undefined {
  const NOISE = /^(node\.js v|npm (error )?a complete log|at\s|__DEVLAUNCH:)/i;
  const entries = startLog(logs);
  for (let i = entries.length - 1; i >= 0; i--) {
    const text = entries[i]!.text.trim();
    if (!text || NOISE.test(text) || /^\s*at /.test(text)) continue;
    return text.slice(0, 300);
  }
  return undefined;
}

/**
 * A server that announced it was starting and never announced it had started.
 *
 * Worth separating from every other way of not listening, because the remedy is
 * different and specific: the port was never opened because startup never *finished*,
 * and the thing to look at is whatever the application connects to at boot. Uvicorn
 * opens its socket after the lifespan hook completes, so a hook awaiting a database that
 * is not there leaves exactly this shape — two INFO lines and silence.
 */
export function stalledStartup(logs: LogManager | undefined): boolean {
  const text = startLog(logs).map((e) => e.text).join('\n');
  const began = /Waiting for application startup|Starting (?:development )?server|Booting worker/i;
  const finished = /Application startup complete|Uvicorn running on|Running on http|Listening on|listening at/i;
  return began.test(text) && !finished.test(text);
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

