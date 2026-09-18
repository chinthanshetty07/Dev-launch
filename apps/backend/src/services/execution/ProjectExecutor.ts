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
import { cacheVolumeFor } from '../docker/ContainerSecurity.js';
import { BackingProvisioner, type BackingRun } from './BackingProvisioner.js';
import { preferredApiHostPort, wireService } from './CrossServiceWiring.js';
import { choosePort } from '../ports/HostPorts.js';
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
  /** Host port chosen before the container existed, so siblings could be told about it. */
  hostPort?: number;
  state: ExecutionState;
  failure?: FailureDetail;
  /**
   * Start this service again on the same port, with the same resolved plan.
   *
   * The port is what makes a restart safe to offer: it was chosen by DevLaunch and
   * written into the siblings' configuration, so a service can come back at the same
   * address and everything that referred to it still works. Re-deriving the plan would
   * throw away the injected database URL and API base along with it.
   */
  restart(): Promise<void>;
}

export type { BackingRun };

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
  /** Per service: absolute origins its source hardcodes, and the variables it declares. */
  discovery?: {
    callsOrigins: Record<string, string[]>;
    envKeys: Record<string, string[]>;
  };
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
    let injected: { key: string; value: string; required: boolean }[] = [];
    try {
      const provisioned = await new BackingProvisioner(this.exec).provision({
        sessionId: opts.sessionId,
        backing: opts.backing ?? [],
        repoName: opts.repoName,
        logs: opts.logs,
      });
      backing.push(...provisioned.runs);
      injected = provisioned.injected;
    } catch (err) {
      await run.cleanup();
      throw err;
    }

    // Host ports are chosen here rather than by Docker, because each service's URL has
    // to appear in its siblings' configuration and a port Docker has not assigned yet
    // cannot be written into anything. An API is published where the frontend already
    // looks, when the frontend hardcodes an address at all.
    const taken = new Set<number>();
    const urls: Record<string, string> = {};
    const hostPorts: Record<string, number> = {};

    // Another project may already be running a service of the same name. Docker
    // round-robins a duplicated alias rather than refusing it, so claiming it again
    // would send half of this project's traffic into that one.
    const networkName = config.docker.networkName;
    const claimed = (await this.exec.docker.networkExists(networkName))
      ? await this.exec.docker.claimedAliases(networkName)
      : new Set<string>();

    for (const plan of ordered) {
      if (plan.expectedPort === null) continue;
      const choice = await choosePort(
        [
          preferredApiHostPort(plan, ordered, opts.discovery?.callsOrigins ?? {}),
          plan.expectedPort,
        ],
        taken,
      );
      hostPorts[plan.name] = choice.port;
      urls[plan.name] = `http://localhost:${choice.port}/`;
      if (choice.substituted && choice.preferred) {
        opts.logs.write(
          'stderr',
          `Port ${choice.preferred} is in use on this machine, so ${plan.name} is published ` +
            `on ${choice.port} instead. A hardcoded reference to ${choice.preferred} will not reach it.`,
        );
      }
    }

    /**
     * The names this service answers to.
     *
     * The session-scoped one is always safe. The bare name is what a repository's own
     * configuration expects — `http://backend:5000` in a file written for
     * docker-compose — so it is claimed when it is free and declined when it is not,
     * because sharing it silently is worse than not having it.
     */
    const aliasesFor = (name: string): string[] => {
      const scoped = `${name}-${opts.sessionId.slice(0, 8)}`;
      if (!claimed.has(name)) return [name, scoped];
      opts.logs.write(
        'stderr',
        `Another running project already answers to "${name}", so this one is reachable ` +
          `only as "${scoped}". Stop the other project if a service here expects the ` +
          'plain name.',
      );
      return [scoped];
    };

    for (const base of ordered) {
      // A variable the repository already supplies wins: the user's own value for
      // MONGO_URI is a decision, and overwriting it would be DevLaunch overruling it.
      const declared = new Set(base.environmentVariables.filter((v) => v.value !== null).map((v) => v.key));
      const wired = wireService(base, ordered, {
        urls,
        envKeys: opts.discovery?.envKeys ?? {},
      });
      for (const v of wired) {
        opts.logs.write('stdout', `${base.name}: ${v.key}=${v.value} (${v.reason})`);
      }

      const plan: ServiceRunPlan = {
        ...base,
        environmentVariables: [
          ...base.environmentVariables,
          ...injected.filter((v) => !declared.has(v.key)),
          ...wired.map((v) => ({ key: v.key, value: v.value, required: false })),
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
          networkAliases: aliasesFor(plan.name),
          hostPort: hostPorts[plan.name],
          packageCacheVolume: cacheVolumeFor(opts.repoName ?? opts.sourceDir ?? opts.sessionId, plan.name),
        });
        const entry: ServiceRun = {
          name: plan.name,
          role: plan.role,
          plan,
          handle,
          logs,
          hostPort: hostPorts[plan.name],
          state: ExecutionState.STARTING,
          restart: async () => {
            opts.logs.write('stdout', `Restarting ${plan.name}...`);
            try {
              await entry.handle.cleanup();
            } catch {
              /* a container that will not release must not block the replacement */
            }
            entry.url = undefined;
            entry.failure = undefined;
            entry.state = ExecutionState.STARTING;
            entry.handle = await this.exec.launch({
              sessionId: opts.sessionId,
              plan,
              sourceDir: opts.sourceDir,
              image: imageForRuntime(plan.runtime.language, plan.runtime.version),
              logs,
              packageCacheVolume: cacheVolumeFor(opts.repoName ?? opts.sourceDir ?? opts.sessionId, plan.name),
              networkAliases: aliasesFor(plan.name),
              hostPort: hostPorts[plan.name],
            });
          },
        };
        services.push(entry);
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
