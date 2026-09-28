import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import {
  ExecutionState,
  FailureCode,
  SERVING_STATES,
  TERMINAL_STATES,
  type RequiredEnvVar,
  type FailureDetail,
  type ReadinessView,
  type RepairRecord,
  type RepositoryMetadata,
  type ProjectPlan,
  type RunPlan,
  type ServiceStats,
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
import {
  applyConfiguration,
  requiredConfiguration,
  requiredConfigurationForSingle,
} from '../planning/RequiredConfiguration.js';
import { cacheVolumeFor } from '../docker/ContainerSecurity.js';
import { lastErrorLine } from '../execution/ExecutionManager.js';
import { BackingProvisioner, type ProvisionResult } from '../execution/BackingProvisioner.js';
import { ProjectExecutor, type ProjectRun } from '../execution/ProjectExecutor.js';
import type { BrowserWiringProblem } from '../execution/CrossServiceWiring.js';
import { RunPlanValidator } from '../planning/RunPlanValidator.js';
import { imageForRuntime } from '../security/ImageAllowlist.js';
import type { AIPlanner } from '../ai/AIPlanner.js';
import type { AIRepair } from '../ai/AIRepair.js';
import { MAX_REPAIR_ATTEMPTS } from '../ai/AIProvider.js';
import { repairPolicyFor } from '../failures/RepairPolicy.js';
import { tryDeterministicRepair } from '../planning/DeterministicRepair.js';
import { impossibleCommand } from '../planning/Feasibility.js';
import {
  applySourceRewrites,
  databaseUrlRewrite,
  type SourceRewrite,
} from '../execution/SourceRewrite.js';

/**
 * Failures a different plan could plausibly fix.
 *
 * The rest are excluded on purpose. A missing database cannot be provisioned by v1, an
 * x86-only dependency cannot be rewritten, OUT_OF_MEMORY is a configuration change
 * rather than a plan change, and MISSING_ENV needs a person. Retrying those would spend
 * a model call to arrive at the same answer.
 */

/** What a session is blocked on while in AWAITING_INPUT. */
export interface PendingInput {
  /** Variables declared without a default in .env.example. */
  requiredEnv: RequiredEnvVar[];
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
  /**
   * Metadata of the directory the plan actually runs in, when that is not the root.
   *
   * `metadata` describes the repository: its compose file, its databases, the services
   * it contains. That is the right thing for provisioning and for the configuration
   * gate, and the wrong thing for repair — a plan running in `src/` is repaired against
   * `src/requirements.txt` and `src/package.json`, and reading the root's found neither.
   * One real repository's whole application lives in `src/`, and every rule that needed
   * a manifest silently had none.
   */
  planMetadata?: RepositoryMetadata;
  pending?: PendingInput;

  readyAt?: number;
  url?: string;
  failure?: FailureDetail;
  endedReason?: string;

  handle?: LaunchHandle;
  /** Set instead of `handle` for a multi-service run. */
  run?: ProjectRun;
  /**
   * Databases provisioned for a single-service run, which `run` would otherwise own.
   *
   * Kept on the session rather than the handle because it outlives one: a repair
   * replaces the application container, and the database it connects to must survive
   * that or every retry starts against an empty server.
   */
  backing?: ProvisionResult;
  cleanupRepo?: () => Promise<void>;
  /**
   * Whether `sourceDir` is a directory DevLaunch created and will delete.
   *
   * True only for a clone. A `sourceDir` launch runs against a directory that already
   * existed — a fixture in this repository, or a path someone gave us — and that is
   * somebody's working copy, not ours. Editing it is the exact thing every message about
   * rewriting promises does not happen, and a live run proved the promise was false: the
   * fixture's own `vite.config.js` came back from a test run rewritten and staged.
   */
  ownsSource?: boolean;
  /**
   * Set the moment somebody asks for this session to end, before any teardown.
   *
   * A pipeline step is not interruptible from outside: `cancel` removes the containers
   * and sets the state, and the `await` chain that was mid-install knows none of it. It
   * carried on, found its container gone and reported a crash — so pressing Stop during
   * a run answered `CANCELLED` and then, five seconds later, said the project had failed
   * with `UNKNOWN_RUNTIME_ERROR`. The state is protected by the terminal guard in
   * `setState`; this flag is what stops the *work*, so a stopped session does not go on
   * to spend four minutes installing, create a replacement container after teardown, or
   * spend a model call on a run nobody is waiting for.
   */
  stopped?: boolean;

  /** Plans already tried by the repair loop, so an attempt cannot repeat one. */
  repairAttempts?: RunPlan[];
  /** What each repair changed, why, and whether a rule or a model decided it. */
  repairs?: RepairRecord[];
  /** What the readiness check saw at the health path, once ready. */
  readiness?: ReadinessView;
  /**
   * Edits made to the clone, when `DEVLAUNCH_REWRITE_SOURCE` is set.
   *
   * Shown, always. A tool that changes code silently is one whose output cannot be
   * trusted, and the whole argument for allowing this at all is that the change is
   * small, named, and visible.
   */
  rewrites?: SourceRewrite[];
  /**
   * Why a READY project will still not work in a browser.
   *
   * Carried on the session rather than inside the failure, because it is not one: every
   * container is healthy and every URL is real. Two repositories reached READY in under
   * ten seconds, served a page, and had every request that page made refused — and
   * nothing anywhere said so. See `browserWiringProblems`.
   */
  browserProblems?: BrowserWiringProblem[];
  /**
   * Memory ceiling this session's containers run under, when a repair raised it.
   *
   * On the session rather than the plan, because it is not a plan: no command changes,
   * and a `RunPlan` describes what to run rather than what to run it in. It also has to
   * outlive a plan — a later repair replaces the plan wholesale, and a retry that
   * quietly went back to 1 GB would re-run the failure it had just fixed.
   */
  memoryMb?: number;
  /** Model calls spent on repair, against the per-failure budget. */
  aiRepairCalls?: number;
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

/**
 * A launch refused because another session holds the only slot.
 *
 * Carries the blocking session's id. Without it the message states a constraint and
 * offers no way to act on it — and a client that has lost track of that session, after
 * a page reload say, has no route back to it at all.
 */
export class SessionConflict extends Error {
  constructor(
    message: string,
    readonly activeSessionId?: string,
  ) {
    super(message);
    this.name = 'SessionConflict';
  }
}

/**
 * Thrown to unwind the pipeline of a session somebody stopped while it was running.
 *
 * Not a failure, and deliberately its own type rather than a sentinel return: every
 * step in the pipeline already propagates a throw to one of two catch blocks, and both
 * of them turn what they catch into a reported crash. A stop is neither a crash nor
 * something to report — the person who asked for it knows what happened.
 */
/**
 * The states a stop itself passes through, and the only ones it may still enter.
 *
 * COMPLETED as well as CANCELLED because `stop` and `cancel` differ only in what they
 * are called: an idle session reclaimed by the lifetime clock has completed, and one a
 * person ended was cancelled.
 */
const ENDING_STATES: readonly ExecutionState[] = [
  ExecutionState.CLEANING_UP,
  ExecutionState.CANCELLED,
  ExecutionState.COMPLETED,
];

class SessionStopped extends Error {
  constructor() {
    super('Session stopped.');
    this.name = 'SessionStopped';
  }
}

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
  /** Overridable so the never-became-ready backstop can be tested without waiting. */
  startupBoundMs?: number;
  /** Overridable so a database that never starts can be tested without waiting 90s. */
  backingReadyMs?: number;
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
  /** Backstop per session for one that never reaches READY. Cleared when it finishes. */
  private readonly startupBounds = new Map<string, NodeJS.Timeout>();
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

  /** Sessions that still hold resources, newest first. */
  active(): Session[] {
    return this.list()
      .filter((s) => !TERMINAL_STATES.includes(s.state))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async launch(req: LaunchRequest): Promise<Session> {
    if (this.activeCount() >= config.concurrency.maxSessions) {
      const blocking = this.active()[0];
      throw new SessionConflict(
        `A session is already running (${blocking?.repoUrl ?? 'started from a fixture'}, ` +
          `currently ${blocking?.state.toLowerCase().replace(/_/g, ' ')}). DevLaunch runs ` +
          `${config.concurrency.maxSessions} at a time, because the Colima VM cannot ` +
          'safely host more. Stop it and try again.',
        blocking?.id,
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
    this.armStartupBound(session);

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
      // A stop is not a failure, and the state it wants is already set.
      if (err instanceof SessionStopped) return;
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
    // Cloned, so this directory is ours to edit if the rewrite flag says so.
    session.ownsSource = true;
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
        // Carried, not only logged. The single-service path has always set this and the
        // dashboard has always rendered it, so a project was the one shape whose
        // warnings — which service is starting from where, and why — existed only as
        // two grey lines somewhere in several hundred lines of install output.
        session.planWarnings = [
          ...project.warnings,
          ...project.skipped.map((skip) => `Skipping ${skip.name}: ${skip.reason}`),
        ];
        session.logs.buffer.push(
          'stdout',
          `Detected ${project.plan.services.length} services: ` +
            project.plan.services.map((sv) => `${sv.name} (${sv.role})`).join(', '),
        );
        for (const skip of project.skipped) {
          session.logs.buffer.push('stderr', `Skipping ${skip.name}: ${skip.reason}`);
        }

        // Each service's configuration lives beside it, so the gate reads every service
        // rather than only the repository root — which is why a backend's API key was
        // never asked for and its container started without one.
        const missing = requiredConfiguration(
          project.plan,
          session.metadata.services ?? [],
          session.metadata.backing ?? [],
        );
        if (missing.length > 0) {
          this.awaitInput(session, { requiredEnv: missing });
          return;
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

      // The one place the fallback planner runs: the deterministic path declined *and*
      // could not say the repository is unrunnable. A library has no server to start, so
      // a model asked to find one invents a command and the run fails minutes later with
      // a diagnosis about the invention rather than about the repository.
      if (this.deps.aiPlanner && !outcome.unrunnable) {
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
          // Two different situations, and offering the wrong remedy for either one sends
          // a person after a problem they do not have. A repository that is not an
          // application is not waiting for a better planner.
          remedy: outcome.unrunnable
            ? 'Nothing here starts a server. If one of its packages does, point DevLaunch ' +
              'at that directory; otherwise this repository is not something to run.'
            : 'The rule-based planner recognised no known pattern, and no AI fallback is ' +
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

    // The plan may run somewhere other than the root — a workspace package, or the one
    // service a repository keeps in a subdirectory. Read that directory now, while the
    // analyzer is to hand, so repair does not have to guess which manifest is its own.
    const runsIn = session.plan?.workingDirectory ?? '.';
    session.planMetadata =
      runsIn === '.' ? undefined : await analyzer.analyze(session.sourceDir ?? dir, runsIn);

    // Pre-flight gate: ask for configuration before building a container that would
    // only crash for want of it.
    const missing = requiredConfigurationForSingle(session.metadata);
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

      // A gated project resumes into the project path, with each supplied value routed
      // to the services that declared it — one service's API key must not land in
      // another's environment.
      if (session.project && session.sourceDir) {
        if (input.env) {
          session.project = applyConfiguration(
            session.project,
            session.metadata?.services ?? [],
            input.env,
          );
        }
        session.pending = undefined;
        await this.startProject(session, session.sourceDir, {});
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
      if (err instanceof SessionStopped) return;
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
      const found = session.metadata?.services?.find((c) => c.dir === plan.workingDirectory);
      if (found && this.refuseImpossiblePlan(session, plan, found.scripts)) return;
    }

    this.setState(session, ExecutionState.STARTING);
    // The project path's own gate. The same rule as `startAndVerify`'s, and separate
    // because this is a different route to a different launcher.
    this.throwIfStopped(session);
    const executor = new ProjectExecutor(this.exec);
    session.run = await executor.launch({
      sessionId: session.id,
      project,
      sourceDir,
      logs: session.logs,
      backing: session.metadata?.backing,
      repoName: session.metadata?.packageJson?.name ?? repoNameFromUrl(session.repoUrl),
      discovery: discoveryByService(session, project),
      // Only a clone is ours to edit. See `Session.ownsSource`.
      mayRewriteSource: session.ownsSource === true,
    });

    if (session.run.rewrites?.length) session.rewrites = session.run.rewrites;
    if (session.run.browserProblems?.length) session.browserProblems = session.run.browserProblems;

    this.setState(session, ExecutionState.WAITING_FOR_READY);
    await this.verifyProject(session, executor, sourceDir, req);
  }

  /**
   * Wait for every service, repairing the one that fails, until it is ready or out of
   * attempts.
   *
   * Until this existed a project got no repair at all: `startProject` went from a
   * failed service straight to FAILED and teardown, so the entire repair architecture —
   * policy, evidence-backed rules, the bounded model call — served only repositories
   * that happened to contain one service. A frontend calling an API is the ordinary
   * shape of a web project and it was the one shape that got no second chance.
   *
   * One service is repaired and restarted at a time. The others are already serving
   * traffic; tearing them down to re-run a corrected plan for a sibling would throw away
   * working containers and several minutes of install to fix something unrelated to them.
   */
  private async verifyProject(
    session: Session,
    executor: ProjectExecutor,
    sourceDir: string,
    req: LaunchRequest,
  ): Promise<void> {
    const outcome = await executor.waitForReady(session.run!, req.readinessTimeoutMs);

    if (outcome.state === ExecutionState.READY) {
      session.readyAt = Date.now();
      session.url = outcome.url;
      session.failure = undefined;
      for (const service of session.run!.services) service.handle.clearStartupBudget?.();
      this.setState(session, ExecutionState.READY);
      this.armLifetime(session);
      return;
    }

    // Keep the first diagnosis, for the same reason the single-service path does: it
    // describes the repository as its author wrote it, and every later one describes a
    // plan that was rewritten in response.
    const failing = session.run?.services.find((sv) => sv.state !== ExecutionState.READY);
    const original = (session.failure ??= withBindRemedy(
      outcome.failure,
      failing ? await this.analyseService(sourceDir, failing) : undefined,
    ));

    if (await this.tryRepairService(session, executor, sourceDir, req)) return;

    const attempts = session.repairAttempts?.length ?? 0;
    const kept = original ?? outcome.failure;
    session.failure = kept && attempts > 0 ? { ...kept, repairAttemptsAfter: attempts } : kept;

    // What still works, keeps working.
    //
    // This was FAILED and teardown, unconditionally — so a repository whose server
    // lists a dependency that does not exist on PyPI had its frontend, which had been
    // serving for a minute, removed along with it. The reason had nothing to do with
    // the frontend, and a person who wanted to look at it was left with nothing.
    //
    // Any service serving traffic is enough. Which one hardly matters: a working
    // frontend is worth opening even when its API is down, and a working API is worth
    // curling even when its frontend is not built. The failure is still reported, and
    // reported first — the point is to stop destroying the answer, not to hide the
    // question.
    const serving = session.run?.services.filter((sv) => sv.state === ExecutionState.READY) ?? [];
    if (serving.length > 0) {
      // Those that made it keep their containers past the startup ceiling, as they
      // would have in a wholly successful run. Without this they are stopped ten
      // minutes later for failing to become ready, which they did.
      for (const sv of serving) sv.handle.clearStartupBudget?.();
      session.readyAt = Date.now();
      session.url = this.servingUrl(session, serving);
      this.setState(session, ExecutionState.PARTIALLY_READY);
      session.logs.buffer.push(
        'stdout',
        `${serving.length} of ${session.run!.services.length} services are running and ` +
          'will stay up. The diagnosis above is for the one that is not; fix it in the ' +
          'repository and restart that service, or stop the session when you are done.',
      );
      // The same clocks a READY session gets: this one owns containers too, and
      // something has to reclaim them.
      this.armLifetime(session);
      return;
    }

    this.setState(session, ExecutionState.FAILED);
    await this.teardown(session);
  }

  /**
   * The URL to hand a person for a partly-running project.
   *
   * The entry service when it is one of the survivors, because that is the page; the
   * first survivor otherwise, because an API's own URL is still something to open and
   * an empty result panel reads as nothing having worked.
   */
  private servingUrl(session: Session, serving: readonly ProjectRun['services'][number][]): string | undefined {
    const entry = session.run?.entry();
    if (entry && serving.includes(entry) && entry.url) return entry.url;
    return serving.find((sv) => sv.url)?.url;
  }

  /**
   * Repair the one service that is not ready, and start it again.
   *
   * The same policy, the same rules and the same ceiling as a lone plan gets — the only
   * thing that differs is which plan is rewritten and what has to be restarted. The
   * service's *own* log is what the rules read: a project's aggregated stream carries
   * four applications' output interleaved, and a rule looking for "the port this
   * application opened" would happily find a sibling's.
   */
  private async tryRepairService(
    session: Session,
    executor: ProjectExecutor,
    sourceDir: string,
    req: LaunchRequest,
  ): Promise<boolean> {
    // Nothing to repair for a session somebody ended: the containers are gone and a
    // rewritten plan would start a replacement one nobody asked for.
    if (session.stopped) return false;

    const service = session.run?.services.find((s) => s.state !== ExecutionState.READY);
    const failure = service?.failure;
    if (!service || !failure || !this.deps.analyzer) return false;

    const metadata = (await this.analyseService(sourceDir, service))!;
    if (this.refuseHardcodedBind(session, failure, metadata)) return false;

    const policy = repairPolicyFor(failure.code);
    if (policy.repairability === 'NON_REPAIRABLE') {
      session.logs.buffer.push(
        'stdout',
        `Not repairing ${service.name} (${failure.code}): ${policy.reason}.`,
      );
      return false;
    }

    const previous = session.repairAttempts ?? [];
    if (previous.length >= MAX_REPAIR_ATTEMPTS) {
      session.logs.buffer.push('stderr', `Repair limit of ${MAX_REPAIR_ATTEMPTS} reached.`);
      return false;
    }

    // *After* the attempt ceiling, as on the single-service path, and the ordering is
    // not cosmetic: the memory ceiling is the only other thing bounding this, and a
    // mutation that disabled it made the repair loop for ever rather than fail a test.
    // Two independent bounds, so neither is load-bearing alone.
    // A limit that is ours, before a plan that is theirs — as on the single-service
    // path, and reachable from here at last. The memory repair served only repositories
    // that happened to contain one service, which is the exact criticism this file
    // already makes of the repair architecture it replaced. A workspace is worse off
    // than a lone application rather than better: every service installs the whole
    // workspace, and they do it at the same time.
    //
    // This service only. Two containers at the raised ceiling exceed what the VM has,
    // and the one that was killed is the only one that has shown it needs more.
    if (failure.code === FailureCode.OUT_OF_MEMORY) {
      const current = service.memoryMb ?? config.container.memoryMb;
      const ceiling = config.container.memoryCeilingMb;
      if (current >= ceiling) {
        session.logs.buffer.push(
          'stdout',
          `Not raising ${service.name}'s memory again: ${current} MB is already the ` +
            'ceiling (DEVLAUNCH_CONTAINER_MEMORY_CEILING_MB). Give the VM more with ' +
            '`colima stop && colima start --cpu 4 --memory 8` and raise the ceiling.',
        );
        return false;
      }

      service.memoryMb = ceiling;
      session.repairAttempts = [...(session.repairAttempts ?? []), service.plan];
      session.repairs = [
        ...(session.repairs ?? []),
        {
          source: 'deterministic',
          type: 'MEMORY_LIMIT_RAISED',
          failureCode: FailureCode.OUT_OF_MEMORY,
          before: { memoryMb: current },
          after: { memoryMb: ceiling },
          evidence: [
            `${service.name} was killed at ${current} MB, which is DevLaunch's limit rather than the repository's`,
          ],
          confidence: 'high',
          service: service.name,
        },
      ];
      this.setState(session, ExecutionState.REPAIRING);
      session.logs.buffer.push(
        'stdout',
        `Raising ${service.name}'s memory limit from ${current} MB to ${ceiling} MB and ` +
          'starting it again. The limit is ours, not this repository\'s.',
      );

      try {
        await service.restart();
      } catch (err) {
        session.logs.buffer.push(
          'stderr',
          `Could not restart ${service.name}: ${err instanceof Error ? err.message : String(err)}`,
        );
        return false;
      }
      this.setState(session, ExecutionState.WAITING_FOR_READY);
      await this.verifyProject(session, executor, sourceDir, req);
      return true;
    }

    const logs = service.logs.buffer.all().map((l) => l.text).join('\n');

    const deterministic =
      policy.repairability === 'DETERMINISTIC'
        ? tryDeterministicRepair({
            plan: service.plan,
            failure,
            metadata,
            logs,
            previousAttempts: previous,
          })
        : null;

    if (!deterministic) {
      // No model call here, deliberately. A model rewriting one service's plan cannot
      // see what its siblings were told about it, and the addresses and ports they were
      // wired with are precisely what it would change. A rule cannot: every rule is
      // evidence-backed and none of them touches the service's name or published port.
      session.logs.buffer.push(
        'stdout',
        `No rule applies to ${service.name} (${failure.code}), and a project's services ` +
          'are not repaired by a model: its siblings were already told this one\'s ' +
          'address, and a rewritten plan would invalidate that.',
      );
      return false;
    }

    this.setState(session, ExecutionState.REPAIRING);
    session.logs.buffer.push(
      'stdout',
      `Attempting repair ${previous.length + 1}/${MAX_REPAIR_ATTEMPTS} for ${service.name} ` +
        `(${failure.code}) (rule: ${deterministic.record.type}): ` +
        deterministic.record.evidence.join('; '),
    );

    session.repairAttempts = [...previous, service.plan];
    session.repairs = [
      ...(session.repairs ?? []),
      { ...deterministic.record, service: service.name },
    ];
    // In place, so the service's own restart re-runs the corrected plan rather than the
    // one it was launched with.
    service.plan = { ...service.plan, ...deterministic.plan, name: service.name, role: service.role };

    try {
      await service.restart();
    } catch (err) {
      session.logs.buffer.push(
        'stderr',
        `Could not restart ${service.name}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }

    this.setState(session, ExecutionState.WAITING_FOR_READY);
    await this.verifyProject(session, executor, sourceDir, req);
    return true;
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
    const manifest = (session.planMetadata ?? session.metadata)?.packageJson?.scripts;
    if (this.refuseImpossiblePlan(session, plan, manifest && Object.keys(manifest))) return;

    // A single service needs its database as much as a project does. Until this ran
    // here, a lone API detected as needing Postgres was started with no server and no
    // connection string, and the repair loop filled the gap by inventing one —
    // `postgresql://user:pass@db:5432/dbname`, a host that does not exist — then spent
    // its remaining attempts installing drivers to satisfy a URL that could not connect.
    // Re-read: provisioning rewrites the plan to carry the connection string, and the
    // local `plan` above was captured before that happened.
    // Moved ahead of provisioning, which waits for a database to accept connections and
    // can take ninety seconds. Reported as VALIDATING, that wait told a person DevLaunch
    // was "checking the commands against the security allowlist" — a step that is
    // synchronous, took no time at all, and had already finished.
    this.setState(session, ExecutionState.STARTING);
    const resolved = await this.provisionBacking(session);
    await this.rewriteHardcodedHosts(session, sourceDir);
    // The one gate on the way into a container, and deliberately the only one.
    //
    // Everything before it — cloning, analysis, planning, and the provisioning wait
    // above, which is the long one and the likeliest moment for somebody to give up —
    // is cheap and leaves nothing behind, so a stop arriving during any of it is
    // honoured here by declining to start rather than by cleaning up afterwards.
    // Which is the only version that works: teardown has already run.
    //
    // Checks earlier in the pipeline were written first and then removed. Each was
    // individually redundant — no test could tell whether it was there — and a guard no
    // test can distinguish is a guard nobody can maintain.
    this.throwIfStopped(session);
    const handle = await this.exec.launch({
      sessionId: session.id,
      plan: resolved,
      // Downloads survive this container. A repair re-runs the same install seconds
      // later, and without a cache it fetches every package again from scratch — which
      // is most of what a live log is showing while it appears to have stalled.
      // A local directory is as stable an identity as a URL, and is what a fixture or a
      // `sourceDir` launch has instead of one. Falling back to the session id looks
      // harmless and is not: the key is never seen twice, so the cache is never warm and
      // every run leaves a volume behind for good.
      packageCacheVolume: cacheVolumeFor(session.repoUrl ?? session.sourceDir ?? session.id),
      sourceDir,
      image,
      logs: session.logs,
      ...(session.memoryMb ? { memoryMb: session.memoryMb } : {}),
    });
    session.handle = handle;

    this.setState(session, ExecutionState.WAITING_FOR_READY);
    const outcome = await handle.waitForReady(req.readinessTimeoutMs);

    if (outcome.state === ExecutionState.READY) {
      session.readyAt = Date.now();
      session.url = outcome.url;
      // What was seen at the health path travels with the URL. A 404 at `/` is not a
      // failure, but it is the fact a person needs before they open an API's root and
      // conclude the run is broken.
      // An error page says "Internal Server Error"; the traceback behind it says
      // `no such table: tasks`. The application wrote the second one to its own log a
      // moment ago, and it is the only one a person can act on.
      const said = outcome.readiness.healthHintOk === false ? lastErrorLine(session.logs) : undefined;
      session.readiness = {
        path: resolved.healthCheck.path,
        status: outcome.readiness.status,
        healthHintOk: outcome.readiness.healthHintOk,
        ...(outcome.readiness.body ? { body: outcome.readiness.body } : {}),
        ...(said ? { logError: said } : {}),
      };
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

    // It ran, and it finished. Nothing to browse and nothing to repair — repairing a
    // program that worked is how a session burns both attempts arriving back here.
    if (outcome.state === ExecutionState.COMPLETED) {
      session.failure = undefined;
      session.logs.buffer.push(
        'stdout',
        'The program ran to completion and exited 0. It never opened port ' +
          `${resolved.expectedPort ?? 'any'}, so there is nothing to open in a browser — ` +
          'which is the expected shape for a script, a migration or a CLI.',
      );
      this.setState(session, ExecutionState.COMPLETED, 'ran to completion');
      await this.teardown(session);
      return;
    }

    // Keep the first diagnosis. It describes the repository as the user wrote it; every
    // later one describes a plan the model invented. Overwriting it answers a question
    // nobody asked — and makes the reported cause depend on model output, which is why
    // an application that plainly binds loopback could be reported as failing to start.
    const original = (session.failure ??= withBindRemedy(
      outcome.failure,
      session.planMetadata ?? session.metadata,
    ));

    if (await this.tryRepair(session, outcome.failure, sourceDir, req)) return;

    if (session.repairAttempts?.length && outcome.failure?.code !== original?.code) {
      session.logs.buffer.push(
        'stderr',
        `Repair did not help. Reporting the original diagnosis (${original?.code}); the ` +
          `last attempt reported ${outcome.failure?.code ?? 'no failure'}.`,
      );
    }

    // Say which attempt this describes. Without it the dashboard pairs the repaired
    // plan with the original diagnosis and the two disagree on their face — a plan
    // starting `--port 8080` beside "Nothing is listening on port 8000" — which reads
    // as the tool contradicting itself rather than as a deliberate choice.
    const attempts = session.repairAttempts?.length ?? 0;
    const kept = original ?? outcome.failure;
    session.failure = kept && attempts > 0 ? { ...kept, repairAttemptsAfter: attempts } : kept;
    this.setState(session, ExecutionState.FAILED);
    await this.teardown(session);
  }

  /**
   * Give the container more memory, once, up to a ceiling.
   *
   * Once, and bounded: one session at a time on a 4 GB VM with a database possibly
   * beside it, so an unbounded retry trades a reported failure for a wedged machine.
   * Returns false when the ceiling is already reached, which puts the session back on
   * the honest report — `OUT_OF_MEMORY` naming a limit that was genuinely tried.
   *
   * `repairAttempts` is appended to with the unchanged plan, which is what keeps this
   * inside the same attempt ceiling as every other repair. It is not a plan change, but
   * it is an attempt, and an attempt that does not count is how a loop becomes infinite.
   */
  private raiseMemory(session: Session, previous: readonly RunPlan[]): boolean {
    const current = session.memoryMb ?? config.container.memoryMb;
    const ceiling = config.container.memoryCeilingMb;
    if (current >= ceiling) {
      session.logs.buffer.push(
        'stdout',
        `Not raising the memory limit again: ${current} MB is already the ceiling ` +
          `(DEVLAUNCH_CONTAINER_MEMORY_CEILING_MB). Give the VM more with ` +
          '`colima stop && colima start --cpu 4 --memory 8` and raise the ceiling.',
      );
      return false;
    }

    session.memoryMb = ceiling;
    session.repairAttempts = [...previous, session.plan!];
    session.repairs = [
      ...(session.repairs ?? []),
      {
        source: 'deterministic',
        type: 'MEMORY_LIMIT_RAISED',
        failureCode: FailureCode.OUT_OF_MEMORY,
        before: { memoryMb: current },
        after: { memoryMb: ceiling },
        evidence: [`the container was killed at ${current} MB, which is DevLaunch's limit rather than the repository's`],
        confidence: 'high',
      },
    ];
    session.logs.buffer.push(
      'stdout',
      `Raising the container memory limit from ${current} MB to ${ceiling} MB and ` +
        'starting again. The limit is ours, not this repository\'s.',
    );
    return true;
  }

  /**
   * Stop before building a container to run a command that cannot exist.
   *
   * The validator asks whether a plan is well-formed and whether it is safe, and never
   * asked whether it is *possible*. A model handed a repository whose own import was
   * broken answered `npm run serve` — a script in no package.json anywhere — and
   * DevLaunch built the container, installed the tree, and waited a minute to be told
   * `Missing script: "serve"`. Answering in a second, from a manifest already read, is
   * strictly better, and saying which scripts do exist is the part somebody can act on.
   *
   * Non-repairable either way, and for opposite reasons: a model that has produced an
   * unusable plan is not asked again, and a *rule* producing one is a bug here rather
   * than in the repository, so it should be loud rather than retried.
   */
  private refuseImpossiblePlan(
    session: Session,
    plan: RunPlan,
    declaredScripts: readonly string[] | undefined,
  ): boolean {
    const problem = impossibleCommand(plan, declaredScripts);
    if (!problem) return false;

    const fromModel = plan.planSource === 'ai-fallback';
    this.fail(session, {
      code: fromModel ? FailureCode.INVALID_AI_PLAN : FailureCode.UNSUPPORTED_PROJECT,
      message: problem,
      confidence: 'high',
      remedy: fromModel
        ? 'The fallback planner proposed a command this repository cannot run. Nothing ' +
          'was started. Add the script it named, or run the project by hand to find the ' +
          'command that works.'
        : 'This is a DevLaunch bug rather than a problem with the repository: a ' +
          'deterministic plan is built from the manifest and should never name a script ' +
          'the manifest does not have.',
    });
    return true;
  }

  /**
   * Point a loopback literal in the source at something the container can reach.
   *
   * Off unless `DEVLAUNCH_REWRITE_SOURCE` is set; see `SourceRewrite` for why the
   * default is off and why these two cases are the exception. Runs after provisioning,
   * because the replacement is the connection string of a server that has to exist
   * first, and before launch, because the clone is copied into the container there.
   *
   * Once per session. A repair re-enters `startAndVerify`, and the literal is already
   * gone by then — `applySourceRewrites` would find nothing and do nothing, but saying
   * so twice in the log reads like it happened twice.
   */
  private async rewriteHardcodedHosts(session: Session, sourceDir: string): Promise<void> {
    if (!config.rewriteSource || session.rewrites) return;
    if (!session.ownsSource) {
      session.logs.buffer.push(
        'stderr',
        'Not rewriting the source: this session runs from a directory that already ' +
          'existed rather than from a clone, and that is your working copy, not ours.',
      );
      return;
    }
    const url = (session.planMetadata ?? session.metadata)?.python?.hardcodedDatabaseUrl;
    const provisioned = session.backing?.injected?.[0]?.value;
    if (!url || !provisioned) return;

    const request = databaseUrlRewrite(
      joinRelative(session.plan?.workingDirectory, url.file),
      url.url,
      provisioned,
    );
    if (!request) return;

    const applied = await applySourceRewrites(sourceDir, [request]);
    session.rewrites = applied;
    for (const change of applied) {
      session.logs.buffer.push(
        'stdout',
        `Rewrote ${change.file}: ${redactUrl(change.from)} → ${redactUrl(change.to)} — ${change.reason}. ` +
          'Your own checkout is untouched; this edit is in the clone DevLaunch runs from.',
      );
    }
  }

  /**
   * Start the databases this repository expects, once per session.
   *
   * Once, because a repair replaces the application container and re-enters here: a
   * second provisioning would start a second Postgres, leave the first orphaned, and
   * hand the retry an empty database under the same alias.
   *
   * The injected variables overwrite whatever the plan carried. That is deliberate — an
   * AI-authored plan for this shape of repository reliably invents a placeholder
   * connection string, and a placeholder that silently wins over a real server is the
   * exact failure this closes.
   */
  private async provisionBacking(session: Session): Promise<RunPlan> {
    const needed = session.metadata?.backing ?? [];
    if (needed.length === 0 || !session.plan) return session.plan!;

    // Started once per session, but injected on every entry. A repair replaces the plan
    // wholesale with one the model wrote, and that plan does not carry the connection
    // string — so skipping this on a retry hands the new container a database it cannot
    // find, and the repair loop then diagnoses the absence it just caused.
    if (!session.backing && this.exec.docker) {
      try {
        session.backing = await new BackingProvisioner(this.exec).provision({
          sessionId: session.id,
          backing: needed,
          repoName: repoNameFromUrl(session.repoUrl ?? session.sourceDir),
          logs: { write: (stream, line) => session.logs.buffer.push(stream, line) },
          ...(this.deps.backingReadyMs ? { readyMs: this.deps.backingReadyMs } : {}),
        });
      } catch (err) {
        // A database that will not start is worth saying plainly, but it is not worth
        // refusing to run over: some applications degrade without one, and those that do
        // not will say so in their own logs with better detail than a guess here.
        session.logs.buffer.push(
          'stderr',
          `Could not provision a database: ${err instanceof Error ? err.message : String(err)}`,
        );
        return session.plan;
      }
    }

    const injected = session.backing?.injected ?? [];
    if (injected.length === 0) return session.plan;

    // The injected value wins over whatever the plan carried. Deliberate: an AI-authored
    // plan for this shape of repository reliably invents a placeholder connection string,
    // and a placeholder that silently outranks a running server is the failure this closes.
    session.plan = {
      ...session.plan,
      environmentVariables: [
        ...session.plan.environmentVariables.filter((v) => !injected.some((i) => i.key === v.key)),
        ...injected,
      ],
    };
    return session.plan;
  }

  /**
   * Attempt one bounded repair. Returns true when a retry was started.
   *
   * Progressive, in the sense the policy spells out: the failure class decides whether
   * repair is worth attempting at all; a rule with evidence gets the first attempt and
   * spends no model call; a model gets one call, after, with a budget per failure class.
   * The session-wide ceiling still bounds the whole sequence.
   */
  private async tryRepair(
    session: Session,
    failure: FailureDetail | undefined,
    sourceDir: string,
    req: LaunchRequest,
  ): Promise<boolean> {
    if (session.stopped) return false;
    if (!failure || !session.plan || !session.metadata) return false;

    // The plan's own directory, when it has one. Every rule here reads a manifest.
    const metadata = session.planMetadata ?? session.metadata;
    if (this.refuseHardcodedBind(session, failure, metadata)) return false;

    const policy = repairPolicyFor(failure.code);
    if (policy.repairability === 'NON_REPAIRABLE') {
      // Saying why is the whole point: a session that stops here stops with a reason a
      // person can act on, instead of two silent retries that arrive at the same place.
      session.logs.buffer.push('stdout', `Not repairing ${failure.code}: ${policy.reason}.`);
      return false;
    }

    const previous = session.repairAttempts ?? [];
    if (previous.length >= MAX_REPAIR_ATTEMPTS) {
      session.logs.buffer.push('stderr', `Repair limit of ${MAX_REPAIR_ATTEMPTS} reached.`);
      return false;
    }

    // Attempt: raise a limit that is ours, before touching a plan that is theirs.
    //
    // OUT_OF_MEMORY was non-repairable, with the reason "a container limit, changed by
    // configuration rather than by a plan" — true, and an odd thing to say about
    // configuration DevLaunch writes. A real Next.js repository is killed by the 1 GB
    // default every time, and was told its own project had failed.
    if (failure.code === FailureCode.OUT_OF_MEMORY && this.raiseMemory(session, previous)) {
      await this.startAndVerify(session, sourceDir, req);
      return true;
    }

    const logs = session.logs.buffer.all().map((l) => l.text).join('\n');

    // Attempt: a rule with evidence, first. It cannot invent, so it cannot make the
    // failure worse — and when it applies, the retry costs no model call at all.
    const deterministic =
      policy.repairability === 'DETERMINISTIC'
        ? tryDeterministicRepair({ plan: session.plan, failure, metadata, logs, previousAttempts: previous })
        : null;

    if (deterministic) {
      await this.beginRepair(session, previous.length, failure, `rule: ${deterministic.record.type}`);
      session.repairAttempts = [...previous, session.plan];
      session.repairs = [...(session.repairs ?? []), deterministic.record];
      session.plan = deterministic.plan;
      session.logs.buffer.push(
        'stdout',
        `Repair ${previous.length + 1} (${deterministic.record.type}): ` +
          deterministic.record.evidence.join('; '),
      );
      await this.startAndVerify(session, sourceDir, req);
      return true;
    }

    // Attempt: one model call, within this failure class's budget.
    const repair = this.deps.aiRepair;
    const used = session.aiRepairCalls ?? 0;
    if (!repair) return false;
    if (used >= policy.aiCalls) {
      session.logs.buffer.push('stdout', `Not asking the model again for ${failure.code}: its budget of ${policy.aiCalls} call(s) is spent.`);
      return false;
    }

    await this.beginRepair(session, previous.length, failure, 'model');
    session.aiRepairCalls = used + 1;

    try {
      const result = await repair.repair({
        plan: session.plan,
        failure,
        logs,
        metadata: session.metadata,
        previousAttempts: previous,
      });

      const before = session.plan;
      session.repairAttempts = [...previous, before];
      session.plan = result.plan;
      session.aiNote = result.note;
      session.repairs = [
        ...(session.repairs ?? []),
        {
          source: 'ai',
          type: 'PLAN_REWRITE',
          failureCode: failure.code,
          before: { installCommand: before.installCommand, startCommand: before.startCommand, expectedPort: before.expectedPort },
          after: { installCommand: result.plan.installCommand, startCommand: result.plan.startCommand, expectedPort: result.plan.expectedPort },
          evidence: [failure.evidence ?? failure.message].filter(Boolean),
          confidence: 'low',
          ...(result.note ? { note: result.note } : {}),
        },
      ];
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

  /**
   * The metadata of one service's own directory.
   *
   * The root metadata describes the repository, not the package in `frontend/`, and a
   * rule that corrects a start script by reading `scripts` would read the wrong manifest
   * entirely.
   */
  private async analyseService(
    sourceDir: string,
    service: { plan: { workingDirectory: string } },
  ): Promise<RepositoryMetadata | undefined> {
    if (!this.deps.analyzer) return undefined;
    return this.deps.analyzer.analyze(sourceDir, service.plan.workingDirectory);
  }

  /**
   * Stop before repairing a bind address that is a literal in the repository's source.
   *
   * `app.listen(port, 'localhost')` is not configuration. No variable, flag or rewritten
   * start command reaches it, so the repair loop can only spend its attempts proving
   * that — first a rule forcing `HOST=0.0.0.0` the application never reads, then a model
   * inventing a start command, each costing a full reinstall. Returning the diagnosis
   * with the line to change is the honest answer and it arrives minutes sooner.
   *
   * Returns true when repair should not be attempted.
   */
  private refuseHardcodedBind(
    session: Session,
    failure: FailureDetail,
    metadata: RepositoryMetadata | undefined,
  ): boolean {
    const bind = metadata?.hardcodedBind;
    if (!bind || failure.code !== FailureCode.PORT_BOUND_TO_LOCALHOST) return false;

    session.logs.buffer.push(
      'stdout',
      `Not repairing ${failure.code}: ${bind.file} hardcodes the bind address ` +
        `(${bind.line}). No plan can change a literal in the source.`,
    );
    return true;
  }

  /** Announce an attempt and release the previous container, so two never overlap. */
  private async beginRepair(session: Session, done: number, failure: FailureDetail, how: string): Promise<void> {
    this.setState(session, ExecutionState.REPAIRING);
    session.logs.buffer.push(
      'stdout',
      `Attempting repair ${done + 1}/${MAX_REPAIR_ATTEMPTS} for ${failure.code} (${how})...`,
    );
    try {
      await session.handle?.cleanup();
      session.handle = undefined;
    } catch {
      /* teardown failures must not mask the repair attempt */
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
   * Bound a session that never becomes ready.
   *
   * The lifetime clock starts at READY and the time-to-ready budget belongs to a
   * container, so a session that loses its containers before reaching READY — they were
   * removed from underneath it, or a step wedged — had nothing to end it. It kept the
   * only slot, and with no way to list sessions there was no way to find it: every
   * later launch failed with "a session is already running" and the only cure was
   * restarting the backend.
   *
   * Deliberately generous. This is a backstop for a session that is not progressing at
   * all, not a second opinion on how long a slow install may take.
   */
  private armStartupBound(session: Session): void {
    const budget = this.deps.startupBoundMs ?? config.timeouts.timeToReadyMs * 2;
    const timer = setTimeout(() => {
      // READY hands over to the lifetime clock; AWAITING_INPUT has its own bound and is
      // waiting on a person rather than stuck.
      // Both serving states hand over to the lifetime clock; AWAITING_INPUT has its own
      // bound and is waiting on a person rather than stuck.
      if (
        TERMINAL_STATES.includes(session.state) ||
        SERVING_STATES.includes(session.state) ||
        session.state === ExecutionState.AWAITING_INPUT
      ) {
        return;
      }
      void this.abandon(session.id, budget);
    }, budget);
    timer.unref?.();
    this.startupBounds.set(session.id, timer);
  }

  private async abandon(id: string, budget: number): Promise<void> {
    const session = this.sessions.get(id);
    if (!session || TERMINAL_STATES.includes(session.state)) return;

    session.failure = {
      code: FailureCode.PROCESS_TIMEOUT,
      message:
        `The session never became ready within ${Math.round(budget / 60_000)} minutes and ` +
        `was released, so it no longer holds the only run slot. It was ${session.state
          .toLowerCase()
          .replace(/_/g, ' ')} when it stopped making progress.`,
      remedy: 'Start it again; the logs above show how far it got.',
      confidence: 'medium',
    };
    this.setState(session, ExecutionState.CLEANING_UP);
    await this.teardown(session);
    this.setState(session, ExecutionState.FAILED, 'never became ready');
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

      const verdict = classifyPostReadyExit(liveness, lastLogLine(session), session.memoryMb);
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
    // A partly-running project is being used like any other: somebody watching its log
    // or polling its stats is reason not to reclaim it for idleness.
    if (!session || !SERVING_STATES.includes(session.state)) return;
    this.clearTimers(id);
    this.armLifetime(session);
  }

  /**
   * Start a service again — or the whole project — without losing the session.
   *
   * Restarting is the control a person reaches for when an application has wedged or
   * they have changed something it reads at boot, and re-cloning to get it is a heavy
   * answer to a light question. Ports and injected configuration are preserved, so
   * siblings that refer to the restarted service still reach it.
   *
   * A single-service session restarts its one container by the same route.
   */
  async restart(id: string, serviceName?: string): Promise<Session | undefined> {
    const session = this.sessions.get(id);
    if (!session || TERMINAL_STATES.includes(session.state)) return session;
    if (!session.run) {
      session.logs.buffer.push('stderr', 'Restart is only available for multi-service projects.');
      return session;
    }

    const targets = serviceName
      ? session.run.services.filter((sv) => sv.name === serviceName)
      : session.run.services;
    if (targets.length === 0) return session;

    // The lifetime clock and liveness watch both key off READY; leaving them armed while
    // containers are being replaced would have the watch declare the session dead.
    this.clearTimers(id);
    this.setState(session, ExecutionState.STARTING, `restarting ${serviceName ?? 'all services'}`);
    session.url = undefined;
    session.failure = undefined;

    try {
      for (const target of targets) await target.restart();
    } catch (err) {
      this.fail(session, {
        code: FailureCode.UNKNOWN_RUNTIME_ERROR,
        message: `Restart failed: ${err instanceof Error ? err.message : String(err)}`,
        remedy: 'Start a new session if the application cannot be brought back.',
      });
      await this.teardown(session);
      return session;
    }

    this.setState(session, ExecutionState.WAITING_FOR_READY);
    const executor = new ProjectExecutor(this.exec);
    const outcome = await executor.waitForReady(session.run);

    if (outcome.state === ExecutionState.READY) {
      session.readyAt = Date.now();
      session.url = outcome.url;
      for (const sv of session.run.services) sv.handle.clearStartupBudget?.();
      this.setState(session, ExecutionState.READY, 'restarted');
      this.armLifetime(session);
      return session;
    }

    session.failure = outcome.failure;
    // As in `verifyProject`: a restart that fixes nothing must not also take down the
    // siblings that were working before it was asked for.
    const serving = session.run.services.filter((sv) => sv.state === ExecutionState.READY);
    if (serving.length > 0) {
      for (const sv of serving) sv.handle.clearStartupBudget?.();
      session.url = this.servingUrl(session, serving);
      this.setState(session, ExecutionState.PARTIALLY_READY, 'restarted');
      this.armLifetime(session);
      return session;
    }

    this.setState(session, ExecutionState.FAILED);
    await this.teardown(session);
    return session;
  }

  /**
   * Sample what every container in this session is consuming.
   *
   * On request rather than on a stream: a dashboard polling every few seconds is the
   * whole requirement, and a stats stream per container costs the same whether or not
   * anyone is looking.
   */
  async stats(id: string): Promise<Record<string, ServiceStats>> {
    const session = this.sessions.get(id);
    if (!session) return {};

    const containers: [string, Parameters<ExecutionManager['docker']['sampleStats']>[0]][] = [];
    if (session.run) {
      for (const sv of session.run.services) containers.push([sv.name, sv.handle.container]);
      for (const db of session.run.backing) containers.push([db.kind, db.container]);
    } else if (session.handle?.container) {
      containers.push(['app', session.handle.container]);
    }
    for (const db of session.backing?.runs ?? []) containers.push([db.kind, db.container]);

    const sampled = await Promise.all(
      containers.map(async ([name, container]) => {
        // Sampling is a read for a dashboard, so nothing about it is worth failing a
        // request over: a container that has just exited, or a Docker client that is
        // not there at all, simply has no numbers to report.
        const stats = await this.exec.docker?.sampleStats(container).catch(() => null);
        return [name, stats ?? null] as const;
      }),
    );

    const out: Record<string, ServiceStats> = {};
    for (const [name, stats] of sampled) if (stats) out[name] = stats;
    return out;
  }

  async stop(id: string, reason = 'stopped'): Promise<void> {
    const session = this.sessions.get(id);
    if (!session || TERMINAL_STATES.includes(session.state)) return;
    // Before teardown, not after: teardown awaits Docker, and the pipeline step running
    // beside it reaches its next boundary during that wait.
    session.stopped = true;
    this.setState(session, ExecutionState.CLEANING_UP);
    await this.teardown(session);
    this.setState(session, ExecutionState.COMPLETED, reason);
  }

  async cancel(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session || TERMINAL_STATES.includes(session.state)) return;
    session.stopped = true;
    this.setState(session, ExecutionState.CLEANING_UP);
    await this.teardown(session);
    this.setState(session, ExecutionState.CANCELLED, 'cancelled by request');
  }

  /**
   * Stop advancing a session somebody ended.
   *
   * Called at each point where the pipeline is about to do something expensive or
   * irreversible — start a container, install for minutes, spend a model call. The
   * terminal guard in `setState` already makes the *state* safe; this is what makes the
   * work stop rather than run to completion against a session that no longer exists.
   */
  private throwIfStopped(session: Session): void {
    if (session.stopped) throw new SessionStopped();
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
      // After the application, so a container still shutting down does not lose its
      // connection mid-write and log an alarming error on the way out.
      for (const err of (await session.backing?.cleanup()) ?? []) {
        session.logs.buffer.push('stderr', `cleanup warning: ${err.message}`);
      }
      session.backing = undefined;
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

  /** Release the startup backstop; a finished session cannot be stuck starting. */
  private clearStartupBound(id: string): void {
    const timer = this.startupBounds.get(id);
    if (timer) clearTimeout(timer);
    this.startupBounds.delete(id);
  }

  private setState(session: Session, state: ExecutionState, reason?: string): void {
    // Once somebody has ended this session, only ending it may move it.
    //
    // Nothing in the pipeline is interruptible, so cancelling one mid-run left an
    // `await` chain still advancing a session that had already ended: it found its
    // container removed and called `fail`, which overwrote CANCELLED with FAILED and
    // `UNKNOWN_RUNTIME_ERROR`. Pressing Stop told you your project had crashed.
    //
    // The obvious guard — refuse to leave a terminal state — is not enough and gets it
    // exactly backwards. A stop passes through CLEANING_UP, which is not terminal, so
    // the resuming step still reached `fail`; FAILED arrived first, and *it* then became
    // the terminal state that blocked CANCELLED. The session ended as a crash because of
    // the guard meant to prevent one. What matters is not whether the session has
    // finished but whether somebody asked it to.
    if (session.stopped && !ENDING_STATES.includes(state)) return;

    session.state = state;
    if (reason !== undefined) session.endedReason = reason;
    this.emit('state', session, reason);
    if (TERMINAL_STATES.includes(state)) {
      this.clearStartupBound(session.id);
      this.evictFinished();
    }
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
      this.clearStartupBound(stale.id);
      this.watchGeneration.delete(stale.id);
      stale.logs.removeAllListeners();
      stale.logs.buffer.clear();
      this.sessions.delete(stale.id);
    }
  }

  async shutdown(): Promise<void> {
    await Promise.all(this.list().map((s) => this.cancel(s.id)));
    for (const id of [...this.startupBounds.keys()]) this.clearStartupBound(id);
    this.sessions.clear();
    this.watchGeneration.clear();
  }
}

/**
 * What discovery learned about each service, keyed by the name the plan gave it.
 *
 * Discovery works in directories and planning works in service names, so the two have to
 * be joined before either the hardcoded origins or the declared variables can be used.
 */
function discoveryByService(
  session: Session,
  project: ProjectPlan,
): {
  callsOrigins: Record<string, string[]>;
  acceptsOrigins: Record<string, { origin: string; file: string }[]>;
  envKeys: Record<string, string[]>;
  devProxies: Record<string, { file: string; target: string }>;
} {
  const callsOrigins: Record<string, string[]> = {};
  const acceptsOrigins: Record<string, { origin: string; file: string }[]> = {};
  const envKeys: Record<string, string[]> = {};
  const devProxies: Record<string, { file: string; target: string }> = {};

  for (const plan of project.services) {
    const found = session.metadata?.services?.find((c) => c.dir === plan.workingDirectory);
    if (!found) continue;
    if (found.callsOrigins) callsOrigins[plan.name] = found.callsOrigins;
    if (found.acceptsOrigins) acceptsOrigins[plan.name] = found.acceptsOrigins;
    if (found.envKeys) envKeys[plan.name] = found.envKeys;
    if (found.devProxy) devProxies[plan.name] = found.devProxy;
  }
  return { callsOrigins, acceptsOrigins, envKeys, devProxies };
}

/** The repository's own name, for naming its database after it rather than after nothing. */
export function repoNameFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  // Pasted URLs arrive with tracking baggage — `?utm_source=chatgpt.com` — and it was
  // ending up in the database name: `pgrag-utm_source-chatgpt-com`.
  return url.replace(/[?#].*$/, '').replace(/\/+$/, '').replace(/\.git$/, '').split('/').pop() || undefined;
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

/**
 * The diagnosis, with the line to change named when there is one.
 *
 * Attached where the diagnosis is taken rather than where repair declines, because the
 * two are answers to different questions and only the first survives: the reported
 * failure is deliberately the *first* one, so anything added later to a copy of it is
 * discarded when the original is restored.
 */
function withBindRemedy(
  failure: FailureDetail | undefined,
  metadata: RepositoryMetadata | undefined,
): FailureDetail | undefined {
  const bind = metadata?.hardcodedBind;
  if (!failure || !bind || failure.code !== FailureCode.PORT_BOUND_TO_LOCALHOST) return failure;
  return {
    ...failure,
    confidence: 'high',
    remedy:
      `${bind.file} binds a loopback address in its own source (\`${bind.line}\`), so no ` +
      'environment variable or command-line flag can change it. Edit that line to bind ' +
      '0.0.0.0 — inside a container it is the only address Docker can forward to.',
  };
}

/** A path inside the clone, given a plan that may run in a subdirectory of it. */
function joinRelative(workingDirectory: string | undefined, file: string): string {
  const dir = workingDirectory && workingDirectory !== '.' ? `${workingDirectory}/` : '';
  return `${dir}${file}`;
}

/**
 * A connection string with its password removed.
 *
 * The log is shown on screen and copied into bug reports. DevLaunch's own password is
 * not a secret, but the one in the repository's literal may be a real credential its
 * author pasted, and echoing it back is not this tool's decision to make.
 */
function redactUrl(url: string): string {
  return url.replace(/^([a-z0-9+.-]+:\/\/[^:/@]+):[^@]*@/i, '$1:***@');
}
