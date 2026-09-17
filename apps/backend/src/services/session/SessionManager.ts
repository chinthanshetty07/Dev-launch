import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import {
  ExecutionState,
  FailureCode,
  TERMINAL_STATES,
  type EnvExampleVar,
  type FailureDetail,
  type RepositoryMetadata,
  type ProjectPlan,
  type RunPlan,
  type WorkspacePackage,
} from '@devlaunch/shared';
import { config } from '../../config/index.js';
import { LogManager } from '../logs/LogManager.js';
import {
  classifyPostReadyExit,
  type ContainerLiveness,
  type ExecutionManager,
  type LaunchHandle,
} from '../execution/ExecutionManager.js';
import type { GitManager } from '../git/GitManager.js';
import type { RepositoryAnalyzer } from '../analysis/RepositoryAnalyzer.js';
import type { RuleBasedPlanner } from '../planning/RuleBasedPlanner.js';
import type { ProjectPlanner } from '../planning/ProjectPlanner.js';
import { ProjectExecutor, type ProjectRun } from '../execution/ProjectExecutor.js';
import { RunPlanValidator } from '../planning/RunPlanValidator.js';
import { imageForRuntime } from '../security/ImageAllowlist.js';
import type { AIPlanner } from '../ai/AIPlanner.js';
import type { AIRepair } from '../ai/AIRepair.js';
import { MAX_REPAIR_ATTEMPTS } from '../ai/AIProvider.js';

/**
 * Failures a different plan could plausibly fix.
 *
 * The rest are excluded on purpose. A missing database cannot be provisioned by v1, an
 * x86-only dependency cannot be rewritten, OUT_OF_MEMORY is a configuration change
 * rather than a plan change, and MISSING_ENV needs a person. Retrying those would spend
 * a model call to arrive at the same answer.
 */
const REPAIRABLE_FAILURES: readonly FailureCode[] = [
  FailureCode.START_COMMAND_FAILED,
  FailureCode.PORT_NOT_LISTENING,
  FailureCode.PORT_BOUND_TO_LOCALHOST,
  FailureCode.READINESS_TIMEOUT,
  FailureCode.DEPENDENCY_INSTALL_FAILED,
  FailureCode.BUILD_FAILED,
  FailureCode.WRONG_RUNTIME_VERSION,
];

/** What a session is blocked on while in AWAITING_INPUT. */
export interface PendingInput {
  /** Variables declared without a default in .env.example. */
  requiredEnv: EnvExampleVar[];
  /** Runnable packages, when a monorepo offers more than one. */
  choices?: WorkspacePackage[];
}

export interface Session {
  id: string;
  state: ExecutionState;
  createdAt: number;
  logs: LogManager;

  repoUrl?: string;
  sourceDir?: string;
  metadata?: RepositoryMetadata;
  /** Detector that matched, e.g. "vite". Null once the AI fallback exists and was used. */
  detected?: string | null;
  plan?: RunPlan;
  /** Set instead of `plan` when the repository needs several services running together. */
  project?: ProjectPlan;
  planWarnings?: string[];
  pending?: PendingInput;

  readyAt?: number;
  url?: string;
  failure?: FailureDetail;
  endedReason?: string;

  handle?: LaunchHandle;
  /** Set instead of `handle` for a multi-service run. */
  run?: ProjectRun;
  cleanupRepo?: () => Promise<void>;

  /** Plans already tried by the repair loop, so an attempt cannot repeat one. */
  repairAttempts?: RunPlan[];
  /** The model's own account of what it inferred. Displayed, never acted on. */
  aiNote?: string;
}

export interface LaunchRequest {
  /** Public GitHub URL. Triggers clone, analysis and deterministic planning. */
  repoUrl?: string;
  /** A directory already on disk. Analysed and planned unless `plan` is supplied. */
  sourceDir?: string;
  /** Skips analysis entirely. Used by tests and by a resumed session. */
  plan?: RunPlan;
  image?: string;
  readinessTimeoutMs?: number;
}

export interface ResolveInput {
  /** Values for the variables the session was waiting on. */
  env?: Record<string, string>;
  /** Chosen workspace package, when the session offered a choice. */
  workspaceDir?: string;
}

export class SessionConflict extends Error {}

export interface SessionManagerDeps {
  git?: GitManager;
  analyzer?: RepositoryAnalyzer;
  planner?: RuleBasedPlanner;
  /** Plans repositories made of several services. Absent means single-service only. */
  projectPlanner?: ProjectPlanner;
  /** Fallback planner. Absent in a no-AI deployment, which is the v1 default. */
  aiPlanner?: AIPlanner;
  /** Bounded repair. Absent in a no-AI deployment. */
  aiRepair?: AIRepair;
  /** Overridable so the unanswered-input timeout can be tested without waiting minutes. */
  awaitingInputMs?: number;
  /** Overridable so the liveness watch can be tested without waiting seconds. */
  livenessIntervalMs?: number;
}

/**
 * In-memory session registry, and the orchestrator of the whole pipeline:
 *
 *   clone → analyse → plan → validate → [ask the user] → run → verify
 *
 * Deliberately not backed by a database. This is a single-user local tool running one
 * session at a time, so sessions dying with the process is correct rather than a
 * limitation to work around.
 *
 * Owns the session lifetime clock, which is separate from the time-to-ready budget:
 * one ~10 minute budget covering both would kill a running application mid-use.
 */
export class SessionManager extends EventEmitter {
  private readonly sessions = new Map<string, Session>();
  private readonly timers = new Map<string, NodeJS.Timeout[]>();
  /** Current liveness watch per session, so a re-armed lifetime supersedes the old one. */
  private readonly watchGeneration = new Map<string, number>();
  private readonly validator = new RunPlanValidator();

  constructor(
    private readonly exec: ExecutionManager,
    private readonly deps: SessionManagerDeps = {},
  ) {
    super();
    // One listener per connected client; the default cap of 10 warns spuriously.
    this.setMaxListeners(64);
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  list(): Session[] {
    return [...this.sessions.values()];
  }

  private activeCount(): number {
    return this.list().filter((s) => !TERMINAL_STATES.includes(s.state)).length;
  }

  async launch(req: LaunchRequest): Promise<Session> {
    if (this.activeCount() >= config.concurrency.maxSessions) {
      throw new SessionConflict(
        `A session is already running. DevLaunch runs ${config.concurrency.maxSessions} ` +
          'at a time, because the Colima VM cannot safely host more.',
      );
    }

    const session: Session = {
      id: randomUUID(),
      state: ExecutionState.QUEUED,
      createdAt: Date.now(),
      // Created before the container exists so a client can attach immediately.
      logs: new LogManager(),
      repoUrl: req.repoUrl,
      sourceDir: req.sourceDir,
    };
    this.sessions.set(session.id, session);
    this.evictFinished();

    // Not awaited: the caller gets an id at once and follows progress over the stream.
    void this.run(session, req);
    return session;
  }

  /** Supply what a session in AWAITING_INPUT was blocked on, and continue. */
  async resolve(id: string, input: ResolveInput): Promise<Session | undefined> {
    const session = this.sessions.get(id);
    if (!session || session.state !== ExecutionState.AWAITING_INPUT) return session;

    this.clearTimers(id);
    void this.continueAfterInput(session, input);
    return session;
  }

  private async run(session: Session, req: LaunchRequest): Promise<void> {
    try {
      if (req.plan && req.sourceDir) {
        // Pre-planned: skip straight to execution.
        session.plan = req.plan;
        await this.startAndVerify(session, req.sourceDir, req);
        return;
      }

      const dir = req.repoUrl
        ? await this.cloneRepository(session, req.repoUrl)
        : req.sourceDir;

      if (!dir) {
        this.fail(session, {
          code: FailureCode.UNSUPPORTED_PROJECT,
          message: 'A repository URL or source directory is required.',
        });
        return;
      }

      session.sourceDir = dir;
      await this.analyseAndPlan(session, dir, req);
    } catch (err) {
      this.fail(session, {
        code: err instanceof Error && 'code' in err
          ? ((err as { code: FailureCode }).code)
          : FailureCode.UNKNOWN_RUNTIME_ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      await this.teardown(session);
    }
  }

  private async cloneRepository(session: Session, repoUrl: string): Promise<string> {
    if (!this.deps.git) throw new Error('Cloning requires a GitManager.');
    this.setState(session, ExecutionState.CLONING);
    const clone = await this.deps.git.clone(repoUrl);
    session.cleanupRepo = clone.cleanup;
    session.logs.buffer.push(
      'stdout',
      `Cloned ${clone.url} (${clone.fileCount} files, ${Math.round(clone.sizeBytes / 1024)} KB)`,
    );
    return clone.dir;
  }

  private async analyseAndPlan(
    session: Session,
    dir: string,
    req: LaunchRequest,
    subdir?: string,
  ): Promise<void> {
    const { analyzer, planner } = this.deps;
    if (!analyzer || !planner) throw new Error('Planning requires an analyzer and planner.');

    this.setState(session, ExecutionState.ANALYZING);
    session.metadata = await analyzer.analyze(dir, subdir ?? '.');

    this.setState(session, ExecutionState.PLANNING);

    // A repository with several services is planned as one project. Tried first because
    // the single-service planner would pick one of them and silently drop the rest —
    // which produces a page that loads and then fails every request it makes.
    if (!subdir && this.deps.projectPlanner && (session.metadata.services?.length ?? 0) > 1) {
      const project = await this.deps.projectPlanner.planProject(dir, session.metadata);
      for (const w of project.warnings) session.logs.buffer.push('stderr', `warning: ${w}`);

      if (project.plan) {
        session.project = project.plan;
        session.detected = `project:${project.plan.services.map((sv) => sv.role).join('+')}`;
        session.logs.buffer.push(
          'stdout',
          `Detected ${project.plan.services.length} services: ` +
            project.plan.services.map((sv) => `${sv.name} (${sv.role})`).join(', '),
        );
        for (const skip of project.skipped) {
          session.logs.buffer.push('stderr', `Skipping ${skip.name}: ${skip.reason}`);
        }
        await this.startProject(session, dir, req);
        return;
      }

      // Falling through is deliberate: a repository whose services could not all be
      // planned is still worth running as the one thing we do understand.
      session.logs.buffer.push(
        'stdout',
        `Multi-service planning declined (${project.reason ?? 'no reason given'}); ` +
          'continuing as a single service.',
      );
    }

    const outcome = subdir
      ? planner.plan(session.metadata, subdir)
      : await planner.planRepository(dir);

    session.detected = outcome.detected;
    session.planWarnings = outcome.warnings;
    for (const w of outcome.warnings) session.logs.buffer.push('stderr', `warning: ${w}`);

    // A monorepo with several runnable packages: a person picks, not a model.
    if (outcome.choices && outcome.choices.length > 1) {
      this.awaitInput(session, { requiredEnv: [], choices: outcome.choices });
      return;
    }

    if (!outcome.plan) {
      const reason = outcome.reason ?? 'No deterministic plan could be produced.';

      // The one place the fallback planner runs: the deterministic path declined.
      if (this.deps.aiPlanner) {
        session.logs.buffer.push(
          'stdout',
          `No known pattern matched (${reason}) — asking the fallback planner.`,
        );
        try {
          const ai = await this.deps.aiPlanner.plan(session.metadata, reason);
          session.plan = ai.plan;
          session.detected = 'ai-fallback';
          session.aiNote = ai.note;
          session.logs.buffer.push(
            'stdout',
            `Fallback plan accepted (plan source: ai-fallback)${ai.note ? ` — ${ai.note}` : ''}`,
          );
        } catch (err) {
          this.fail(session, {
            code: FailureCode.UNSUPPORTED_PROJECT,
            message: `${reason} The fallback planner could not help either.`,
            evidence: err instanceof Error ? err.message.slice(0, 400) : undefined,
            remedy: 'Supply the commands manually, or add a detector for this project type.',
            confidence: 'high',
          });
          await this.teardown(session);
          return;
        }
      } else {
        this.fail(session, {
          code: FailureCode.UNSUPPORTED_PROJECT,
          message: reason,
          remedy:
            'The rule-based planner recognised no known pattern, and no AI fallback is ' +
            'configured. Set GROQ_API_KEY to enable it.',
          confidence: 'high',
        });
        await this.teardown(session);
        return;
      }
    } else {
      session.plan = outcome.plan;
      session.logs.buffer.push('stdout', `Detected ${outcome.detected} (plan source: rule-based)`);
    }

    // Pre-flight gate: ask for configuration before building a container that would
    // only crash for want of it.
    const missing = (session.metadata.envExample ?? []).filter((v) => !v.hasDefault);
    if (missing.length > 0) {
      this.awaitInput(session, { requiredEnv: missing });
      return;
    }

    await this.startAndVerify(session, session.sourceDir ?? dir, req);
  }

  private async continueAfterInput(session: Session, input: ResolveInput): Promise<void> {
    try {
      if (input.workspaceDir && session.sourceDir) {
        // The user picked a package; plan that directory specifically.
        await this.analyseAndPlan(session, session.sourceDir, {}, input.workspaceDir);
        return;
      }

      if (!session.plan || !session.sourceDir) {
        this.fail(session, {
          code: FailureCode.UNKNOWN_RUNTIME_ERROR,
          message: 'Session has no plan to resume.',
        });
        return;
      }

      // Supplied values replace the placeholders the plan is carrying.
      if (input.env) {
        const supplied = new Map(Object.entries(input.env));
        session.plan = {
          ...session.plan,
          environmentVariables: [
            ...session.plan.environmentVariables.filter((v) => !supplied.has(v.key)),
            ...[...supplied].map(([key, value]) => ({ key, value, required: true })),
          ],
        };
      }

      session.pending = undefined;
      await this.startAndVerify(session, session.sourceDir, {});
    } catch (err) {
      this.fail(session, {
        code: FailureCode.UNKNOWN_RUNTIME_ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      await this.teardown(session);
    }
  }

  /**
   * Run every service in a project, and gate readiness on all of them.
   *
   * Kept beside `startAndVerify` rather than folded into it: the single-service path is
   * correct for the repositories it already handles, and a shared code path that has to
   * branch on "is this one service or several" at every step is how both get worse.
   */
  private async startProject(
    session: Session,
    sourceDir: string,
    req: LaunchRequest,
  ): Promise<void> {
    const project = session.project!;

    this.setState(session, ExecutionState.VALIDATING);
    // Every service passes the same gate a lone plan would.
    for (const plan of project.services) {
      this.validator.validate({
        plan,
        image: imageForRuntime(plan.runtime.language, plan.runtime.version),
      });
    }

    this.setState(session, ExecutionState.STARTING);
    const executor = new ProjectExecutor(this.exec);
    session.run = await executor.launch({
      sessionId: session.id,
      project,
      sourceDir,
      logs: session.logs,
      backing: session.metadata?.backing,
      repoName: session.metadata?.packageJson?.name ?? repoNameFromUrl(session.repoUrl),
    });

    this.setState(session, ExecutionState.WAITING_FOR_READY);
    const outcome = await executor.waitForReady(session.run, req.readinessTimeoutMs);

    if (outcome.state === ExecutionState.READY) {
      session.readyAt = Date.now();
      session.url = outcome.url;
      session.failure = undefined;
      for (const service of session.run.services) service.handle.clearStartupBudget?.();
      this.setState(session, ExecutionState.READY);
      this.armLifetime(session);
      return;
    }

    session.failure = outcome.failure;
    this.setState(session, ExecutionState.FAILED);
    await this.teardown(session);
  }

  private async startAndVerify(
    session: Session,
    sourceDir: string,
    req: LaunchRequest,
  ): Promise<void> {
    const plan = session.plan!;

    this.setState(session, ExecutionState.VALIDATING);
    const image = req.image ?? imageForRuntime(plan.runtime.language, plan.runtime.version);
    // One gate for every plan, whatever produced it.
    this.validator.validate({ plan, image });

    this.setState(session, ExecutionState.STARTING);
    const handle = await this.exec.launch({
      sessionId: session.id,
      plan,
      sourceDir,
      image,
      logs: session.logs,
    });
    session.handle = handle;

    this.setState(session, ExecutionState.WAITING_FOR_READY);
    const outcome = await handle.waitForReady(req.readinessTimeoutMs);

    if (outcome.state === ExecutionState.READY) {
      session.readyAt = Date.now();
      session.url = outcome.url;
      // A repaired session carries the diagnosis of the attempt that failed. Once it is
      // ready that diagnosis is history, and leaving it set would show an error against
      // a working application.
      session.failure = undefined;
      // The startup budget has done its job. Left in place it stops this container the
      // moment it elapses — a ten-minute ceiling on a session the lifetime clock
      // believes it has an hour to run.
      handle.clearStartupBudget?.();
      this.setState(session, ExecutionState.READY);
      this.armLifetime(session);
      return;
    }

    // Keep the first diagnosis. It describes the repository as the user wrote it; every
    // later one describes a plan the model invented. Overwriting it answers a question
    // nobody asked — and makes the reported cause depend on model output, which is why
    // an application that plainly binds loopback could be reported as failing to start.
    const original = (session.failure ??= outcome.failure);

    if (await this.tryRepair(session, outcome.failure, sourceDir, req)) return;

    if (session.repairAttempts?.length && outcome.failure?.code !== original?.code) {
      session.logs.buffer.push(
        'stderr',
        `Repair did not help. Reporting the original diagnosis (${original?.code}); the ` +
          `last attempt reported ${outcome.failure?.code ?? 'no failure'}.`,
      );
    }

    session.failure = original ?? outcome.failure;
    this.setState(session, ExecutionState.FAILED);
    await this.teardown(session);
  }

  /**
   * Attempt one bounded repair. Returns true when a retry was started.
   *
   * Capped at two attempts, each of which must differ from the last, and only for
   * failures a different plan could plausibly fix.
   */
  private async tryRepair(
    session: Session,
    failure: FailureDetail | undefined,
    sourceDir: string,
    req: LaunchRequest,
  ): Promise<boolean> {
    const repair = this.deps.aiRepair;
    if (!repair || !failure || !session.plan || !session.metadata) return false;
    if (!REPAIRABLE_FAILURES.includes(failure.code)) return false;

    const previous = session.repairAttempts ?? [];
    if (previous.length >= MAX_REPAIR_ATTEMPTS) {
      session.logs.buffer.push('stderr', `Repair limit of ${MAX_REPAIR_ATTEMPTS} reached.`);
      return false;
    }

    this.setState(session, ExecutionState.REPAIRING);
    session.logs.buffer.push(
      'stdout',
      `Attempting repair ${previous.length + 1}/${MAX_REPAIR_ATTEMPTS} for ${failure.code}...`,
    );

    // The previous container is released before a retry, so two never overlap.
    try {
      await session.handle?.cleanup();
      session.handle = undefined;
    } catch {
      /* teardown failures must not mask the repair attempt */
    }

    try {
      const result = await repair.repair({
        plan: session.plan,
        failure,
        logs: session.logs.buffer.all().map((l) => l.text).join('\n'),
        metadata: session.metadata,
        previousAttempts: previous,
      });

      session.repairAttempts = [...previous, session.plan];
      session.plan = result.plan;
      session.aiNote = result.note;
      session.logs.buffer.push(
        'stdout',
        `Repair ${result.attempt}: start=${result.plan.startCommand}` +
          (result.note ? ` — ${result.note}` : ''),
      );

      await this.startAndVerify(session, sourceDir, req);
      return true;
    } catch (err) {
      session.logs.buffer.push(
        'stderr',
        `Repair failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  private awaitInput(session: Session, pending: PendingInput): void {
    session.pending = pending;
    this.setState(session, ExecutionState.AWAITING_INPUT);

    // Concurrency is 1, so an unanswered question blocks every other session. Bounding
    // the wait means walking away never wedges the tool permanently.
    const timer = setTimeout(
      () => void this.cancelUnanswered(session.id),
      this.deps.awaitingInputMs ?? config.timeouts.awaitingInputMs,
    );
    timer.unref?.();
    this.timers.set(session.id, [timer]);
  }

  private async cancelUnanswered(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session || session.state !== ExecutionState.AWAITING_INPUT) return;
    session.failure = {
      code: FailureCode.PROCESS_TIMEOUT,
      message: 'No input was supplied, so the session was released.',
      remedy: 'Start it again and provide the requested values.',
      confidence: 'high',
    };
    this.setState(session, ExecutionState.CLEANING_UP);
    await this.teardown(session);
    this.setState(session, ExecutionState.CANCELLED, 'awaiting input timed out');
  }

  private fail(session: Session, failure: FailureDetail): void {
    session.failure = failure;
    this.setState(session, ExecutionState.FAILED);
  }

  /**
   * Start the session lifetime clock, which begins only once the app is READY.
   *
   * The hard cap bounds the session; the idle timer bounds neglect. Together they stop
   * a forgotten container running indefinitely without cutting short one in active use.
   */
  private armLifetime(session: Session): void {
    const timers: NodeJS.Timeout[] = [
      setTimeout(() => void this.stop(session.id, 'idle timeout'), config.timeouts.sessionIdleMs),
      setTimeout(
        () => void this.stop(session.id, 'maximum session lifetime'),
        config.timeouts.sessionHardCapMs,
      ),
    ];
    for (const t of timers) t.unref?.();
    this.timers.set(session.id, timers);
    this.watchLiveness(session);
  }

  /**
   * Keep checking that a READY session's container is still alive.
   *
   * Readiness was a measurement taken once. An application can serve a request and
   * then crash, get OOM-killed, or have its container removed from underneath it —
   * after which the session went on reporting READY, and handing out a URL that
   * answered nothing, until the idle clock expired half an hour later.
   *
   * Only a definite answer ends the session. "I could not inspect the container" is
   * not evidence that an application died, and treating it as such would turn every
   * Docker API hiccup into a spurious failure report.
   */
  private watchLiveness(session: Session): void {
    const handle = session.handle;
    if (typeof handle?.liveness !== 'function') return;
    const interval = this.deps.livenessIntervalMs ?? config.timeouts.livenessMs;
    let unknowns = 0;

    // `touch()` re-arms the lifetime on every session read, which starts a new watch.
    // Without a generation the old one survives its in-flight probe and re-schedules
    // itself into the new timer list, so an actively-polled session would accumulate
    // watchers.
    const generation = (this.watchGeneration.get(session.id) ?? 0) + 1;
    this.watchGeneration.set(session.id, generation);
    const current = (): boolean =>
      this.watchGeneration.get(session.id) === generation &&
      session.state === ExecutionState.READY;

    const schedule = (): void => {
      // A cleared timer list means the session was torn down. Not re-scheduling is how
      // this watch stops, so it cannot outlive the session it belongs to.
      const timers = this.timers.get(session.id);
      if (!timers || !current()) return;
      const timer = setTimeout(() => void tick(), interval);
      timer.unref?.();
      timers.push(timer);
    };

    const tick = async (): Promise<void> => {
      if (!current()) return;

      let liveness: ContainerLiveness;
      try {
        liveness = await handle.liveness();
      } catch (err) {
        liveness = { kind: 'unknown', error: err instanceof Error ? err.message : String(err) };
      }

      // Re-checked after the await: the session may have been torn down, or superseded
      // by a newer watch, while the probe was in flight. Reviving either would be worse
      // than missing one poll.
      if (!current()) return;

      if (liveness.kind === 'unknown') {
        // Reported once per run of consecutive failures rather than every poll, which
        // at a five-second interval would bury the application's own output.
        if (unknowns === 0) {
          session.logs.buffer.push(
            'stderr',
            `Liveness check could not read the container state${
              liveness.error ? `: ${liveness.error}` : ''
            }. The session is still treated as ready.`,
          );
        }
        unknowns++;
        schedule();
        return;
      }
      unknowns = 0;

      const verdict = classifyPostReadyExit(liveness, lastLogLine(session));
      if (!verdict) {
        schedule();
        return;
      }

      // The URL is dead the moment the container is. Continuing to advertise it is the
      // whole defect this watch exists to close.
      session.url = undefined;
      if (verdict.failure) {
        session.failure = verdict.failure;
        session.logs.buffer.push('stderr', verdict.failure.message);
      } else {
        session.logs.buffer.push('stdout', 'The application exited cleanly.');
      }

      this.setState(session, ExecutionState.CLEANING_UP);
      await this.teardown(session);
      this.setState(
        session,
        verdict.state,
        verdict.failure ? 'the application stopped running' : 'the application exited',
      );
    };

    schedule();
  }

  touch(id: string): void {
    const session = this.sessions.get(id);
    if (!session || session.state !== ExecutionState.READY) return;
    this.clearTimers(id);
    this.armLifetime(session);
  }

  async stop(id: string, reason = 'stopped'): Promise<void> {
    const session = this.sessions.get(id);
    if (!session || TERMINAL_STATES.includes(session.state)) return;
    this.setState(session, ExecutionState.CLEANING_UP);
    await this.teardown(session);
    this.setState(session, ExecutionState.COMPLETED, reason);
  }

  async cancel(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session || TERMINAL_STATES.includes(session.state)) return;
    this.setState(session, ExecutionState.CLEANING_UP);
    await this.teardown(session);
    this.setState(session, ExecutionState.CANCELLED, 'cancelled by request');
  }

  private async teardown(session: Session): Promise<void> {
    this.clearTimers(session.id);
    try {
      // cleanup() collects per-container failures and resolves successfully, so the
      // catch below never sees them. Ignoring the returned errors meant a container
      // that failed to stop left no trace at all until the next process start.
      const result = session.run ? await session.run.cleanup() : await session.handle?.cleanup();
      session.run = undefined;
      for (const err of result?.errors ?? []) {
        session.logs.buffer.push('stderr', `cleanup warning: ${err.message}`);
      }
    } catch (err) {
      // A thrown failure must not mask the transition that triggered teardown, but it
      // should still be visible.
      session.logs.buffer.push(
        'stderr',
        `cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    try {
      await session.cleanupRepo?.();
      session.cleanupRepo = undefined;
    } catch {
      /* the clone directory is in a temp root; a leak here is bounded */
    }
  }

  private clearTimers(id: string): void {
    for (const t of this.timers.get(id) ?? []) clearTimeout(t);
    this.timers.delete(id);
  }

  private setState(session: Session, state: ExecutionState, reason?: string): void {
    session.state = state;
    if (reason !== undefined) session.endedReason = reason;
    this.emit('state', session, reason);
    if (TERMINAL_STATES.includes(state)) this.evictFinished();
  }

  /**
   * Drop the oldest finished sessions beyond the retention cap.
   *
   * Finished sessions are kept so their logs can still be read, but each holds a buffer
   * of up to several megabytes. Without this the registry grows for as long as the
   * process lives. Active sessions are never evicted.
   */
  private evictFinished(): void {
    const finished = this.list()
      .filter((s) => TERMINAL_STATES.includes(s.state))
      .sort((a, b) => a.createdAt - b.createdAt);

    const excess = finished.length - config.concurrency.retainFinished;
    for (let i = 0; i < excess; i++) {
      const stale = finished[i]!;
      this.clearTimers(stale.id);
      this.watchGeneration.delete(stale.id);
      stale.logs.removeAllListeners();
      stale.logs.buffer.clear();
      this.sessions.delete(stale.id);
    }
  }

  async shutdown(): Promise<void> {
    await Promise.all(this.list().map((s) => this.cancel(s.id)));
    this.sessions.clear();
    this.watchGeneration.clear();
  }
}

/** The repository's own name, for naming its database after it rather than after nothing. */
function repoNameFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  return url.replace(/\.git$/, '').split('/').pop() || undefined;
}

/** The last line the application wrote, which is where a post-ready death explains itself. */
function lastLogLine(session: Session): string | undefined {
  const entries = session.logs.buffer.all();
  for (let i = entries.length - 1; i >= 0; i--) {
    const text = entries[i]!.text.trim();
    if (text) return text.slice(0, 500);
  }
  return undefined;
}
