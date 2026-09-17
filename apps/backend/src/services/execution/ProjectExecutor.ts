import {
  ExecutionState,
  FailureCode,
  type FailureDetail,
  type ProjectPlan,
  type ServiceRole,
  type ServiceRunPlan,
} from '@devlaunch/shared';
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

export interface ProjectRun {
  services: ServiceRun[];
  /** The service a person is given the URL of: the web front door, or the only one. */
  entry(): ServiceRun | undefined;
  cleanup(): Promise<{ errors: Error[] }>;
}

export interface ProjectLaunchOptions {
  sessionId: string;
  project: ProjectPlan;
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

    const run: ProjectRun = {
      services,
      entry: () => services.find((s) => s.role === 'web') ?? services[0],
      cleanup: async () => {
        const errors: Error[] = [];
        // Every service is released even if an earlier one refuses: a half-cleaned
        // project leaves containers running with nothing tracking them.
        for (const service of services) {
          try {
            const result = await service.handle.cleanup();
            errors.push(...result.errors);
          } catch (err) {
            errors.push(err instanceof Error ? err : new Error(String(err)));
          }
        }
        return { errors };
      },
    };

    for (const plan of ordered) {
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
