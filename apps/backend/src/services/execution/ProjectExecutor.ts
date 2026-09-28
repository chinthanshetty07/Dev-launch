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
import {
  browserWiringProblems,
  preferredApiHostPort,
  wireService,
  type BrowserWiringProblem,
} from './CrossServiceWiring.js';
import { choosePort } from '../ports/HostPorts.js';
import { imageForRuntime } from '../security/ImageAllowlist.js';
import { LogManager } from '../logs/LogManager.js';
import type { ExecutionManager, LaunchHandle, ReadyOutcome } from './ExecutionManager.js';
import {
  applySourceRewrites,
  repointHost,
  type RewriteRequest,
  type SourceRewrite,
} from './SourceRewrite.js';

export interface ServiceRun {
  name: string;
  role: ServiceRole;
  /**
   * The plan this service is running, fully resolved — the planner's, plus the database
   * URL and sibling addresses injected at launch.
   *
   * Mutable because repair replaces it. It must be the resolved plan that is rewritten
   * and re-run, not the planner's: re-deriving one would drop the injected connection
   * string and hand the retry a database it cannot find.
   */
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
   * Memory ceiling this service runs under, when a repair raised it.
   *
   * Per service and not per project, because the VM cannot afford otherwise: two
   * services at the raised ceiling exceed what Colima has, and only the one that was
   * killed has shown it needs more. Mutable for the same reason `plan` is — a restart
   * that went back to the default would re-run the failure it was fixing.
   */
  memoryMb?: number;
  /**
   * Plans already tried for *this* service, so an attempt cannot repeat one.
   *
   * Per service, because the budget is. A session-wide array meant one service could
   * spend the whole allowance and leave its siblings none: a real project had its API
   * use both attempts on a memory raise and a port correction, and its frontend — which
   * needed one rule to run — was refused with "repair limit reached" without a single
   * attempt of its own. That is the same shape of bug as a repair that served only
   * single-service repositories, one level down.
   */
  repairAttempts?: ServiceRunPlan[];
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
  /** Edits made to the clone, when DEVLAUNCH_REWRITE_SOURCE is set. Shown, always. */
  rewrites?: SourceRewrite[];
  /**
   * Why this project will not work in a browser, even if every service reaches READY.
   *
   * Not a failure: the containers are healthy and the URLs are real. It is the gap
   * between a repository written to run on one laptop's default ports and a run that
   * could not have them. See `browserWiringProblems`.
   */
  browserProblems?: BrowserWiringProblem[];
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
    /** Per API: the browser origins its own source will accept, and where they are. */
    acceptsOrigins?: Record<string, { origin: string; file: string }[]>;
    envKeys: Record<string, string[]>;
    /** Dev-server proxy targets pointing somewhere the container cannot reach. */
    devProxies?: Record<string, { file: string; target: string }>;
  };
  /** The repository root; each service runs from its own subdirectory of it. */
  sourceDir: string;
  /**
   * Whether `sourceDir` is a clone DevLaunch owns, rather than somebody's working copy.
   *
   * The rewrite flag is a decision about what DevLaunch may do to *its own* copy. A
   * `sourceDir` launch has no copy — it runs against the directory it was given — and a
   * live run proved what that means: this repository's own fixture came back rewritten.
   */
  mayRewriteSource?: boolean;
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
    // Memoised, because it is now asked the same question from four places — the
    // container's aliases, a restart's, the proxy rewrite's, and the sibling URLs below
    // — and it explains itself in the log when it has to decline a name. Recomputing
    // was harmless; saying it four times was not.
    const aliasCache = new Map<string, string[]>();
    const aliasesFor = (name: string): string[] => {
      const cached = aliasCache.get(name);
      if (cached) return cached;
      const scoped = `${name}-${opts.sessionId.slice(0, 8)}`;
      let aliases: string[];
      if (!claimed.has(name)) {
        aliases = [name, scoped];
      } else {
        opts.logs.write(
          'stderr',
          `Another running project already answers to "${name}", so this one is reachable ` +
            `only as "${scoped}". Stop the other project if a service here expects the ` +
            'plain name.',
        );
        aliases = [scoped];
      }
      aliasCache.set(name, aliases);
      return aliases;
    };

    // A dev server's proxy target is resolved by the dev server process, inside its own
    // container, so `localhost` there is the frontend itself. Rewritten here rather than
    // during planning because only now is it known what the API actually answers to:
    // `aliasesFor` declines the plain name when another project already holds it, and
    // pointing a config file at a name this project does not have would be worse than
    // leaving it alone. Off unless DEVLAUNCH_REWRITE_SOURCE is set.
    const rewrites =
      config.rewriteSource && opts.mayRewriteSource
        ? await this.repointProxies(ordered, opts, aliasesFor)
        : [];
    if (config.rewriteSource && !opts.mayRewriteSource) {
      opts.logs.write(
        'stderr',
        'Not rewriting the source: this session runs from a directory that already ' +
          'existed rather than from a clone, and that is your working copy, not ours.',
      );
    }
    for (const change of rewrites) {
      opts.logs.write(
        'stdout',
        `Rewrote ${change.file}: ${change.from} → ${change.to} — ${change.reason}. ` +
          'Your own checkout is untouched; this edit is in the clone DevLaunch runs from.',
      );
    }
    run.rewrites = rewrites;

    const wiredKeys: Record<string, string[]> = {};

    // Where each service answers on the container network, as opposed to on this
    // machine. `aliasesFor` puts the name a repository expects first when this project
    // holds it, so the value handed to a sibling is the one its own config already
    // names. A service with no port has nothing to be reached at.
    const internalUrls: Record<string, string> = {};
    for (const plan of ordered) {
      if (plan.expectedPort === null) continue;
      internalUrls[plan.name] = `http://${aliasesFor(plan.name)[0]}:${plan.expectedPort}`;
    }

    for (const base of ordered) {
      // A variable the repository already supplies wins: the user's own value for
      // MONGO_URI is a decision, and overwriting it would be DevLaunch overruling it.
      const declared = new Set(base.environmentVariables.filter((v) => v.value !== null).map((v) => v.key));
      const wired = wireService(base, ordered, {
        urls,
        internalUrls,
        envKeys: opts.discovery?.envKeys ?? {},
      });
      // Kept, because what was *not* wired is what decides whether a literal in the
      // source still matters. See `browserWiringProblems`.
      wiredKeys[base.name] = wired.map((v) => v.key);
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
            // `entry.plan`, not the captured `plan`: repair rewrites it in place, and
            // restarting the plan this closure was built with would silently undo the
            // repair and re-run the failure it just corrected.
            const current = entry.plan;
            entry.handle = await this.exec.launch({
              sessionId: opts.sessionId,
              plan: current,
              sourceDir: opts.sourceDir,
              image: imageForRuntime(current.runtime.language, current.runtime.version),
              logs,
              packageCacheVolume: cacheVolumeFor(opts.repoName ?? opts.sourceDir ?? opts.sessionId, plan.name),
              networkAliases: aliasesFor(plan.name),
              hostPort: hostPorts[plan.name],
              // Read off the entry rather than captured, for the same reason `plan` is:
              // a restart that went back to the default would re-run the OOM it fixed.
              ...(entry.memoryMb ? { memoryMb: entry.memoryMb } : {}),
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

    // Decidable only now: it compares what the source was written to expect against the
    // ports this run actually got, and neither is known before both exist. Recorded
    // rather than acted on — every one of these is a literal no plan can reach, so the
    // honest thing is to publish the project and say what will not work in the browser.
    run.browserProblems = browserWiringProblems({
      services: ordered,
      urls,
      acceptsOrigins: opts.discovery?.acceptsOrigins ?? {},
      callsOrigins: opts.discovery?.callsOrigins ?? {},
      wired: wiredKeys,
    });
    for (const problem of run.browserProblems) {
      opts.logs.write('stderr', `warning: ${problem.problem}`);
    }

    return run;
  }

  /**
   * Send each browser-facing service's proxy at the sibling it is really trying to reach.
   *
   * The API's own port is used, not its published host port: this request is made from
   * inside the frontend's container, over the container network, where the service is
   * listening on the port it was planned with. The host mapping is for the browser and
   * is a different number.
   */
  private async repointProxies(
    services: readonly ServiceRunPlan[],
    opts: ProjectLaunchOptions,
    aliasesFor: (name: string) => string[],
  ): Promise<SourceRewrite[]> {
    const api = services.find((s) => s.role === 'api' && s.expectedPort !== null);
    if (!api) return [];
    const alias = aliasesFor(api.name)[0];
    if (!alias) return [];

    const requests = proxyRewrites(services, opts.discovery?.devProxies ?? {}, api, alias);
    return applySourceRewrites(opts.sourceDir, requests);
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
        // A service that is already ready is left alone. This is re-entered after a
        // repair, which replaces one container; re-polling the three that are serving
        // traffic would spend the readiness budget proving what is already known.
        if (service.state === ExecutionState.READY) return null;
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

/**
 * The edits that would point each service's dev-server proxy at the API.
 *
 * Pure, and separate from applying them, so the decision can be checked without Docker:
 * which file, which literal, which replacement, and the sentence explaining it.
 */
export function proxyRewrites(
  services: readonly ServiceRunPlan[],
  devProxies: Record<string, { file: string; target: string }>,
  api: ServiceRunPlan,
  alias: string,
): RewriteRequest[] {
  const requests: RewriteRequest[] = [];
  for (const service of services) {
    const proxy = devProxies[service.name];
    if (!proxy) continue;
    const to = repointHost(proxy.target, alias, api.expectedPort ?? undefined);
    if (!to) continue;
    requests.push({
      file: joinService(service.workingDirectory, proxy.file),
      from: proxy.target,
      to,
      reason:
        `the dev server resolves this inside ${service.name}'s own container, where ` +
        `localhost is ${service.name}; ${api.name} answers to "${alias}" on port ` +
        `${api.expectedPort} of this network`,
    });
  }
  return requests;
}

/** A file inside the clone, given the service directory it belongs to. */
function joinService(workingDirectory: string, file: string): string {
  return workingDirectory && workingDirectory !== '.' ? `${workingDirectory}/${file}` : file;
}
