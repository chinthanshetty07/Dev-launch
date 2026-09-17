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
import { assertImageApproved } from '../security/ImageAllowlist.js';
import {
  validateCommand,
  validateEnvVarKey,
  validateEnvVarValue,
  validateOptionalCommand,
} from '../security/CommandValidator.js';
import { assertSafeRelativePath, joinWorkspace } from '../security/PathValidator.js';

export type Phase = 'none' | 'install' | 'build' | 'start';

export interface LaunchOptions {
  sessionId: string;
  plan: RunPlan;
  /** Host directory whose contents become /workspace inside the container. */
  sourceDir: string;
  image: string;
  packageCacheVolume?: string;
  /** Overrides the time-to-ready budget. Exists so timeout behaviour is testable. */
  timeoutMs?: number;
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
  stop(): Promise<void>;
  cleanup(): Promise<{ errors: Error[] }>;
}

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

export class ExecutionManager {
  /** Network the most recent launch used; undefined means the egress policy is absent. */
  lastNetworkUsed: string | undefined;

  constructor(private readonly docker: DockerManager) {}

  /**
   * Create, populate, and start a container, returning before it finishes.
   *
   * Servers never exit on their own, so the caller decides when to stop — Phase 3
   * will settle on readiness rather than on exit.
   */
  async launch(opts: LaunchOptions): Promise<LaunchHandle> {
    const cleanup = new CleanupManager(this.docker);

    // Validate before anything is created. A rejected plan must never reach Docker.
    assertImageApproved(opts.image);
    validateCommand(opts.plan.startCommand, 'startCommand');
    validateOptionalCommand(opts.plan.installCommand, 'installCommand');
    validateOptionalCommand(opts.plan.buildCommand, 'buildCommand');
    assertSafeRelativePath(opts.plan.workingDirectory);
    for (const v of opts.plan.environmentVariables) {
      validateEnvVarKey(v.key);
      if (v.value !== null && v.value !== undefined) validateEnvVarValue(v.key, v.value);
    }

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

      const logs = new LogManager();
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

      const exit = this.docker
        .waitForExit(container, opts.timeoutMs ?? config.timeouts.timeToReadyMs)
        .then(async (r) => {
          await streaming.catch(() => undefined);
          return r;
        });

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
        hostPort: () => this.readHostPort(container, opts.plan.expectedPort),
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
      return {
        state,
        exitCode: exit.exitCode,
        timedOut: exit.timedOut,
        phaseReached: phase,
        failure,
        logs: handle.logs.buffer.all(),
      };
    } finally {
      await handle.cleanup();
    }
  }

  /** Read Docker's assigned host port. Never scans the host. */
  private async readHostPort(
    container: Dockerode.Container,
    internalPort: number | null,
  ): Promise<string | null> {
    if (!internalPort) return null;
    const info = await this.docker.inspect(container);
    const mapping = info.NetworkSettings?.Ports?.[`${internalPort}/tcp`];
    return mapping?.[0]?.HostPort ?? null;
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

