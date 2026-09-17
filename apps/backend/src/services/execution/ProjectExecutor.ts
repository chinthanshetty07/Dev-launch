import type Dockerode from 'dockerode';
import {
  ExecutionState,
  FailureCode,
  type BackingService,
  type FailureDetail,
  type ProjectPlan,
  type ServiceRole,
  type ServiceRunPlan,
} from '@devlaunch/shared';
import { config } from '../../config/index.js';
import { buildLabels } from '../docker/ContainerSecurity.js';
import { BACKING_SPECS, connectionEnv, databaseName } from './BackingServices.js';
import { imageForRuntime } from '../security/ImageAllowlist.js';
import { LogManager } from '../logs/LogManager.js';
import type { ExecutionManager, LaunchHandle, ReadyOutcome } from './ExecutionManager.js';

export interface ServiceRun {
  name: string;
  role: ServiceRole;
  plan: ServiceRunPlan;
  handle: LaunchHandle;
  /** This service's own output, kept separate so its sentinels stay its own. */
  logs: LogManager;
  url?: string;
  state: ExecutionState;
  failure?: FailureDetail;
}

export interface BackingRun {
  kind: BackingService['kind'];
  alias: string;
  container: Dockerode.Container;
  ready: boolean;
}

export interface ProjectRun {
  services: ServiceRun[];
  /** Databases provisioned for this project, in the order they were started. */
  backing: BackingRun[];
  /** The service a person is given the URL of: the web front door, or the only one. */
  entry(): ServiceRun | undefined;
  cleanup(): Promise<{ errors: Error[] }>;
}

export interface ProjectLaunchOptions {
  sessionId: string;
  project: ProjectPlan;
  /** Databases the repository expects. Provisioned and injected before anything starts. */
  backing?: BackingService[];
  /** Used to name the database, so it reads as the project's rather than as a default. */
  repoName?: string;
  /** The repository root; each service runs from its own subdirectory of it. */
  sourceDir: string;
  /** Aggregated, user-visible output. Each line arrives tagged with its service. */
  logs: LogManager;
  readinessTimeoutMs?: number;
}

/**
 * Run every service in a project, and decide whether the project as a whole is ready.
 *
 * Services reach each other by name on the shared network — the same network the egress
 * policy is bound to, so cross-service traffic costs nothing in isolation. A per-session
 * network would have been the obvious design and is the wrong one: the policy is keyed
 * to `devlaunch-net`'s subnet, so a fresh network would come up unfiltered.
 */
export class ProjectExecutor {
  constructor(private readonly exec: ExecutionManager) {}

  /**
   * Start every service, APIs first.
   *
   * Ordering is not synchronisation — nothing waits for an API to be ready before the
   * web service starts, because a dev server does not call its API at boot; the browser
   * does, later. Starting them first simply narrows the window in which it could.
   */
  async launch(opts: ProjectLaunchOptions): Promise<ProjectRun> {
    const ordered = [...opts.project.services].sort(
      (a, b) => startRank(a.role) - startRank(b.role),
    );
    const services: ServiceRun[] = [];
    const backing: BackingRun[] = [];

    const run: ProjectRun = {
      services,
      backing,
      entry: () => services.find((s) => s.role === 'web') ?? services[0],
      cleanup: async () => {
        const errors: Error[] = [];
        // Every container is released even if an earlier one refuses: a half-cleaned
        // project leaves containers running with nothing tracking them.
        for (const service of services) {
          try {
            const result = await service.handle.cleanup();
            errors.push(...result.errors);
          } catch (err) {
            errors.push(err instanceof Error ? err : new Error(String(err)));
          }
        }
        // Databases last, so an application still shutting down does not lose its
        // connection mid-write and log an alarming error on the way out.
        for (const db of backing) {
          try {
            await this.exec.docker.stop(db.container);
            await this.exec.docker.remove(db.container);
          } catch (err) {
            errors.push(err instanceof Error ? err : new Error(String(err)));
          }
        }
        return { errors };
      },
    };

    // Databases first, and waited for. Applications connect at boot — the real
    // repository that prompted this exits with "MongoDB connection error" rather than
    // retrying — so starting them in parallel would be a race the application loses.
    const database = databaseName(opts.repoName);
    try {
      for (const need of opts.backing ?? []) {
        const db = await this.startBacking(opts, need, database);
        if (db) backing.push(db);
      }
    } catch (err) {
      await run.cleanup();
      throw err;
    }

    const injected = connectionEnv(opts.backing ?? [], database);
    if (injected.length) {
      opts.logs.write(
        'stdout',
        `Provisioned ${backing.map((b) => b.kind).join(', ')}; ` +
          `injected ${injected.map((v) => v.key).join(', ')}.`,
      );
    }

    for (const base of ordered) {
      // A variable the repository already supplies wins: the user's own value for
      // MONGO_URI is a decision, and overwriting it would be DevLaunch overruling it.
      const declared = new Set(base.environmentVariables.filter((v) => v.value !== null).map((v) => v.key));
      const plan: ServiceRunPlan = {
        ...base,
        environmentVariables: [
          ...base.environmentVariables,
          ...injected.filter((v) => !declared.has(v.key)),
        ],
      };
      const logs = new LogManager();
      // Tagged as it arrives, so one stream stays readable with several services in it.
      logs.on('entry', (entry: { stream: 'stdout' | 'stderr'; text: string; ts: number }) => {
        opts.logs.write(entry.stream, `[${plan.name}] ${entry.text}`, entry.ts);
      });

      try {
        const handle = await this.exec.launch({
          sessionId: opts.sessionId,
          plan,
          sourceDir: opts.sourceDir,
          image: imageForRuntime(plan.runtime.language, plan.runtime.version),
          logs,
          // Both the bare name and a session-scoped one: the bare name is what a
          // repository's own configuration expects, and the scoped one stays unique if
          // more than one session is ever allowed to run at a time.
          networkAliases: [plan.name, `${plan.name}-${opts.sessionId.slice(0, 8)}`],
        });
        services.push({ name: plan.name, role: plan.role, plan, handle, logs, state: ExecutionState.STARTING });
      } catch (err) {
        // A service that cannot even be created sinks the project: releasing what is
        // already running is better than leaving a half-started one behind.
        await run.cleanup();
        throw err;
      }
    }

    return run;
  }

  /**
   * Start one database and wait until it actually answers.
   *
   * "Running" is not "accepting connections" — the same distinction readiness draws for
   * applications, and it matters more here because an application that connects at boot
   * gets exactly one chance.
   */
  private async startBacking(
    opts: ProjectLaunchOptions,
    need: BackingService,
    database: string,
  ): Promise<BackingRun | null> {
    const spec = BACKING_SPECS[need.kind];
    if (!spec) return null;

    const docker = this.exec.docker;
    opts.logs.write('stdout', `Starting ${need.kind} (${need.evidence}) as ${spec.alias}...`);
    await docker.ensureImage(spec.image);

    const networkName = (await docker.networkExists(config.docker.networkName))
      ? config.docker.networkName
      : undefined;

    const container = await docker.createBackingContainer({
      image: spec.image,
      alias: spec.alias,
      user: spec.user,
      env: spec.env,
      labels: buildLabels(opts.sessionId),
      dataPaths: spec.dataPaths,
      networkName,
    });

    await docker.start(container);
    const ready = await this.waitForBacking(docker, container, spec.readyCheck);

    if (!ready) {
      opts.logs.write('stderr', `${need.kind} did not become ready; the project will fail.`);
    } else {
      opts.logs.write('stdout', `${need.kind} is accepting connections at ${spec.url(database)}`);
    }
    return { kind: need.kind, alias: spec.alias, container, ready };
  }

  /** Poll the image's own health command until it succeeds, or the budget runs out. */
  private async waitForBacking(
    docker: ExecutionManager['docker'],
    container: Dockerode.Container,
    check: string[],
    timeoutMs = config.timeouts.backingReadyMs,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const out = await docker.execCapture(container, check);
        // Every one of these commands prints something recognisable on success and
        // fails or stays silent otherwise.
        if (/\b(1|PONG|accepting connections|mysqld is alive)\b/i.test(out)) return true;
      } catch {
        /* not up yet; the loop is the retry */
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }

  /**
   * Wait for every service that serves traffic, and report the project's readiness.
   *
   * A `worker` has no port and cannot be waited on; it is ready when it is running.
   * The project is ready only when all of them are — a frontend that answers while its
   * API is still starting is not something a person can use.
   */
  async waitForReady(
    run: ProjectRun,
    timeoutMs?: number,
  ): Promise<{ state: ExecutionState; url?: string; failure?: FailureDetail }> {
    const outcomes = await Promise.all(
      run.services.map(async (service): Promise<ReadyOutcome | null> => {
        if (service.role === 'worker' || service.plan.expectedPort === null) {
          service.state = ExecutionState.READY;
          return null;
        }
        const outcome = await service.handle.waitForReady(timeoutMs);
        service.state = outcome.state;
        service.url = outcome.url;
        service.failure = outcome.failure;
        return outcome;
      }),
    );

    const failed = run.services.find((s) => s.state !== ExecutionState.READY);
    if (failed) {
      return {
        state: ExecutionState.FAILED,
        // Named, because "the project failed" is useless when four things are running.
        failure: failed.failure
          ? { ...failed.failure, message: `${failed.name}: ${failed.failure.message}` }
          : {
              code: FailureCode.UNKNOWN_RUNTIME_ERROR,
              message: `${failed.name} did not become ready.`,
              confidence: 'low',
            },
      };
    }

    void outcomes;
    return { state: ExecutionState.READY, url: run.entry()?.url };
  }
}

/** APIs and workers first; the browser-facing service last. */
function startRank(role: ServiceRole): number {
  return role === 'web' ? 1 : 0;
}
