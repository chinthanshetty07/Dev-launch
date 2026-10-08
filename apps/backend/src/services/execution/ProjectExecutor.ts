import { join } from 'node:path';
import { toPublic } from '../../config/Codespaces.js';
import type Dockerode from 'dockerode';
import {
  ExecutionState,
  FailureCode,
  Sentinel,
  type BackingService,
  type FailureDetail,
  type ProjectPlan,
  type ServiceRole,
  type ServiceRunPlan,
} from '@devlaunch/shared';
import { config } from '../../config/index.js';
import { cacheVolumeFor } from '../docker/ContainerSecurity.js';
import { BackingProvisioner, type BackingRun } from './BackingProvisioner.js';
import { sessionNetwork } from './RunNetworks.js';
import { planGateway, readNginxRoutes, startGateway, type Gateway } from './Gateway.js';
import { callsRelativeApi } from '../analysis/ServiceDiscovery.js';
import {
  browserWiringProblems,
  preferredApiHostPort,
  wireService,
  type BrowserWiringProblem,
} from './CrossServiceWiring.js';
import { choosePort } from '../ports/HostPorts.js';
import { imageForRuntime } from '../security/ImageAllowlist.js';
import { LogManager } from '../logs/LogManager.js';
import type { ContainerLiveness, ExecutionManager, LaunchHandle, ReadyOutcome } from './ExecutionManager.js';
import { classifyPostReadyExit, lastErrorLine } from './ExecutionManager.js';
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
  /** Memory raises spent by this service, against the policy's limit. */
  memoryRaises?: number;
  /** The V8 heap DevLaunch set for this service after a heap OOM. */
  nodeHeapMb?: number;
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
  /**
   * One address for the frontend and the API paths behind it, standing in for the
   * project's own reverse proxy (`Gateway`). When present, it is the address a person is
   * given.
   */
  gateway?: Gateway;
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
  /**
   * What the package cache belongs to: the repository URL. Not `repoName`, which is the
   * repository's own `package.json` "name" — "monorepo", "frontend", "app" — and shared by
   * unrelated repositories, which then shared a writable cache, Corepack's package-manager
   * binaries included (audit A-09).
   */
  cacheKey?: string;
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
  /**
   * The memory policy's hooks, supplied by the session so the decision stays in one place.
   *
   * `initialMb` is what a service starts with. `onLaunch` records every container a
   * service gets. `onInstallDied` is asked when a service's container dies during a
   * shared workspace install, before the next service may start: `restarted` means it was
   * given more memory and is installing again, `exhausted` that no more memory can be
   * given, `not-oom` that it died of something else.
   */
  /**
   * Handed the run the moment it exists, before anything is started, so a stop that
   * arrives mid-launch can release what has been created so far (audit A-05).
   */
  onRun?(run: ProjectRun): void;
  /** Asked between steps; true ends the launch, releasing everything it made. */
  stopped?(): boolean;
  memory?: {
    initialMb: number;
    /** Where one service starts instead, when its repository needed more last time. */
    initialFor?(service: string): number | undefined;
    onLaunch?(service: ServiceRun): Promise<void>;
    onInstallDied?(service: ServiceRun, died: ContainerLiveness | undefined): Promise<'restarted' | 'exhausted' | 'not-oom'>;
  };
}

/**
 * Run every service in a project, and decide whether the project as a whole is ready.
 *
 * Services reach each other by name on the shared network — the same network the egress
 * policy is bound to, so cross-service traffic costs nothing in isolation. A per-session
 * network would have been the obvious design and is the wrong one: the policy is keyed
 * to `devlaunch-net`'s subnet, so a fresh network would come up unfiltered.
 */
/**
 * The workspace a service's containers keep between them (`LaunchOptions.workspaceKey`).
 *
 * Services that install one shared workspace share one: they install the same tree from
 * the same root, one at a time, and the second used to install it all over again. Others
 * each keep their own.
 */
/** A launch ended because its session was stopped, after releasing what it made. */
export class LaunchStopped extends Error {
  constructor() {
    super('The launch was stopped.');
    this.name = 'LaunchStopped';
  }
}

function workspaceKeyFor(opts: { sessionId: string; project: { sharedInstall?: boolean } }, service: string): string {
  return opts.project.sharedInstall ? `${opts.sessionId}:shared` : `${opts.sessionId}:${service}`;
}

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
        await run.gateway?.close().catch(() => undefined);
        run.gateway = undefined;
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
    opts.onRun?.(run);
    // Between every step. Without it a stop mid-launch released nothing — the containers
    // existed only in this function — and the launch went on starting services and
    // waiting on installs for minutes beside the run that replaced it.
    const halt = async (): Promise<void> => {
      if (!opts.stopped?.()) return;
      await run.cleanup();
      throw new LaunchStopped();
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
    await halt();

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
    // On this run's own network that is only ever this run's own services; on the
    // shared one (see RunNetworks) it can be another run's.
    const networkName = await sessionNetwork(this.exec, opts.sessionId);
    const claimed = networkName
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
      urls[plan.name] = `${plan.protocol ?? 'http'}://localhost:${choice.port}/`;
      if (choice.substituted && choice.preferred) {
        opts.logs.write(
          'stderr',
          `Port ${choice.preferred} is in use on this machine, so ${plan.name} is published ` +
            `on ${choice.port} instead. A hardcoded reference to ${choice.preferred} will not reach it.`,
        );
      }
    }

    // The project's own reverse proxy, done by DevLaunch: a frontend that calls `/api` on
    // its own address, as it would behind the project's nginx (`Gateway`). Not when the
    // frontend's dev server already proxies those paths itself.
    const web = ordered.find((p) => p.role === 'web');
    if (web && urls[web.name] && !opts.discovery?.devProxies?.[web.name]) {
      const routing = planGateway({
        services: ordered.map((p) => ({ name: p.name, role: p.role, port: p.expectedPort, dir: p.workingDirectory })),
        nginx: await readNginxRoutes(opts.sourceDir).catch(() => []),
        callsRelativeApi: await callsRelativeApi(join(opts.sourceDir, web.workingDirectory ?? '.')).catch(() => false),
      });
      if (routing) {
        run.gateway = await startGateway({ routes: routing.routes, fallback: routing.web, targets: urls });
        const described = routing.routes
          .map((r) => `${typeof r.match === 'string' ? r.match : r.match.source} → ${r.to}`)
          .join(', ');
        opts.logs.write(
          'stdout',
          `${web.name} calls its API through its own address, as it would behind the project's ` +
            `own reverse proxy. Serving both at ${run.gateway.url} (${described}; everything else → ${web.name}).`,
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
      internalUrls[plan.name] = `${plan.protocol ?? 'http'}://${aliasesFor(plan.name)[0]}:${plan.expectedPort}`;
    }

    // A shared install's learned memory, and the service whose install could not be given
    // enough; see the install gate below.
    const shared: { memoryMb?: number; nodeHeapMb?: number } = {};
    let blocked: ServiceRun | undefined;
    for (const [position, base] of ordered.entries()) {
      // A variable the repository already supplies wins: the user's own value for
      // MONGO_URI is a decision, and overwriting it would be DevLaunch overruling it.
      const declared = new Set(base.environmentVariables.filter((v) => v.value !== null).map((v) => v.key));
      const wired = wireService(base, ordered, {
        // What a page's browser reads: in a codespace, the forwarded addresses.
        urls: Object.fromEntries(Object.entries(urls).map(([name, url]) => [name, toPublic(url)])),
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

      // What a shared workspace needed to install is what the next service installing it
      // needs — same tree, same packages — so it starts there rather than rediscovering the
      // limit by being killed at the default. Never more than the VM has free.
      const startMb = await startingMemory(opts, shared, this.exec, plan.name);
      await halt();
      try {
        const handle = await this.exec.launch({
          sessionId: opts.sessionId,
          plan,
          sourceDir: opts.sourceDir,
          image: imageForRuntime(plan.runtime.language, plan.runtime.version),
          logs,
          networkAliases: aliasesFor(plan.name),
          hostPort: hostPorts[plan.name],
          packageCacheVolume: cacheVolumeFor(opts.cacheKey ?? opts.sourceDir ?? opts.sessionId, plan.name),
          workspaceKey: workspaceKeyFor(opts, plan.name),
          ...(startMb !== undefined ? { memoryMb: startMb } : {}),
          ...(shared.nodeHeapMb ? { nodeHeapMb: shared.nodeHeapMb } : {}),
        });
        const entry: ServiceRun = {
          name: plan.name,
          role: plan.role,
          plan,
          handle,
          logs,
          hostPort: hostPorts[plan.name],
          state: ExecutionState.STARTING,
          ...(startMb !== undefined ? { memoryMb: startMb } : {}),
          ...(shared.nodeHeapMb ? { nodeHeapMb: shared.nodeHeapMb } : {}),
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
              packageCacheVolume: cacheVolumeFor(opts.cacheKey ?? opts.sourceDir ?? opts.sessionId, plan.name),
              workspaceKey: workspaceKeyFor(opts, plan.name),
              networkAliases: aliasesFor(plan.name),
              hostPort: hostPorts[plan.name],
              // Read off the entry rather than captured, for the same reason `plan` is:
              // a restart that went back to the default would re-run the OOM it fixed.
              ...(entry.memoryMb ? { memoryMb: entry.memoryMb } : {}),
              ...(entry.nodeHeapMb ? { nodeHeapMb: entry.nodeHeapMb } : {}),
            });
            // A stop that arrived while this was being created has already released the
            // run — including the old container, not this one, which nothing would then
            // track (audit A-06). It is released here instead.
            if (opts.stopped?.()) {
              await entry.handle.cleanup().catch(() => undefined);
              throw new LaunchStopped();
            }
          },
        };
        services.push(entry);
        await halt();
        await opts.memory?.onLaunch?.(entry);

        // One workspace install at a time.
        //
        // The loop was already sequential, but `exec.launch` returns once the container
        // has *started* — the installs then ran side by side inside them. For a shared
        // workspace that is the same dependency tree fetched twice at once, and a NestJS
        // plus Next.js monorepo needed more memory than the VM had: both containers were
        // killed mid-fetch. Waiting costs wall-clock on a cold cache and bounds peak
        // memory to one install, which is the thing that was failing.
        //
        // Only for a shared workspace (`sharedInstall`). Independent services install
        // different things and gain nothing from queueing behind each other.
        // The loop's own index, not `indexOf`: a scan by value is a scan, and it
        // answers "where is an element equal to this" when the question is "how far
        // through am I". The last service waits for nobody — there is nothing behind it.
        if (opts.project.sharedInstall && position < ordered.length - 1) {
          opts.logs.write('stdout', `Waiting for ${plan.name} to finish installing before starting the next service...`);
          // A container that dies mid-install is asked about before anything else starts.
          // Releasing the next service after an out-of-memory kill ran the same tree at the
          // same limit, and it died the same way — every time, and a minute later.
          let outcome: Awaited<ReturnType<typeof waitForInstall>>;
          for (;;) {
          outcome = await waitForInstall(logs, {
            timeoutMs: config.timeouts.timeToReadyMs,
            cancelled: opts.stopped,
            // Docker's answer, not ours: our own state is not written until readiness,
            // which runs after this loop.
            hasExited: async () => {
              const live = await entry.handle.liveness?.().catch(() => undefined);
              return live !== undefined && live.kind !== 'running' && live.kind !== 'unknown';
            },
          });
          // Both endings of a killed install. When yarn is OOM-killed the wrapper survives,
          // prints its install-failed marker, and exits 110 a moment later — `failed`, not
          // `exited` — with Docker's OOMKilled set. Asking only on `exited` let the live run
          // release the next service into the same kill.
          if (outcome === 'cancelled') await halt();
          if ((outcome !== 'exited' && outcome !== 'failed') || !opts.memory?.onInstallDied) break;
          const died = await settledLiveness(entry.handle);
          const verdict = await opts.memory.onInstallDied(entry, died);
          if (verdict === 'restarted') continue;
          if (verdict === 'exhausted') blocked = entry;
          break;
          }
          if (outcome === 'ok' && entry.memoryMb !== undefined) {
            shared.memoryMb = entry.memoryMb;
            if (entry.nodeHeapMb !== undefined) shared.nodeHeapMb = entry.nodeHeapMb;
          }
          if (blocked) {
            // The same tree, at a limit already shown to be too small, can only fail the
            // same way. Starting the rest would report their deaths as if they were news.
            for (const rest of ordered.slice(position + 1)) {
              opts.logs.write(
                'stderr',
                `Not starting ${rest.name}: it installs the same workspace ${blocked.name} could ` +
                  `not install within ${blocked.memoryMb ?? opts.memory?.initialMb ?? config.container.memoryMb} MB.`,
              );
            }
            break;
          }
          if (outcome === 'timeout') {
            // Proceed rather than hang. A stuck install must not stop the project; it
            // will be diagnosed by readiness like any other failure.
            opts.logs.write(
              'stderr',
              `${plan.name} is still installing after ${Math.round(config.timeouts.timeToReadyMs / 1000)}s; ` +
                'starting the next service anyway.',
            );
          }
        }
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
  private async waitForWorker(service: ServiceRun, timeoutMs?: number): Promise<void> {
    const outcome = await workerOutcome(service, timeoutMs ?? config.timeouts.timeToReadyMs, config.timeouts.workerGraceMs);
    service.state = outcome.state;
    service.failure = outcome.failure;
  }

  async waitForReady(
    run: ProjectRun,
    timeoutMs?: number,
  ): Promise<{ state: ExecutionState; url?: string; failure?: FailureDetail }> {
    const outcomes = await Promise.all(
      run.services.map(async (service): Promise<ReadyOutcome | null> => {
        if (service.role === 'worker' || service.plan.expectedPort === null) {
          // Was READY on the spot, with no check at all: a worker whose install failed
          // or which crashed on boot made the whole project READY (audit A-03).
          if (service.state !== ExecutionState.READY) await this.waitForWorker(service, timeoutMs);
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

    const failed = run.services.find((s) => s.state !== ExecutionState.READY && s.state !== ExecutionState.COMPLETED);
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
    // The gateway's address when there is one: it is the one at which the page's own
    // `/api` calls work (`Gateway`).
    const entry = run.entry();
    return { state: ExecutionState.READY, url: run.gateway && entry?.role === 'web' ? run.gateway.url : entry?.url };
  }
}

/**
 * Wait for a service with no port: until it has started (its install and build are
 * done) and is still running a short while later.
 *
 * A worker that finished with exit 0 is COMPLETED, not failed — a one-off job is allowed
 * to end. One that died, or never got as far as starting, fails with what it said.
 */
async function workerOutcome(
  service: ServiceRun,
  timeoutMs: number,
  graceMs: number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<{ state: ExecutionState; failure?: FailureDetail }> {
  const deadline = Date.now() + timeoutMs;
  let exited = false;
  void service.handle.exit.then(() => { exited = true; }, () => { exited = true; });
  while (!service.handle.sentinels.has(Sentinel.START_BEGIN) && !exited && Date.now() < deadline) {
    await sleep(250);
  }
  if (!exited && service.handle.sentinels.has(Sentinel.START_BEGIN)) await sleep(graceMs);

  let liveness: ContainerLiveness;
  try {
    liveness = await service.handle.liveness();
  } catch (err) {
    liveness = { kind: 'unknown', error: err instanceof Error ? err.message : String(err) };
  }
  const reached = service.handle.phaseReached();
  if (liveness.kind === 'running') {
    return service.handle.sentinels.has(Sentinel.START_BEGIN)
      ? { state: ExecutionState.READY }
      : {
          state: ExecutionState.FAILED,
          failure: {
            code: FailureCode.READINESS_TIMEOUT,
            message: `It had not finished installing after ${Math.round(timeoutMs / 1000)} s.`,
            ...(reached !== 'none' ? { phase: reached } : {}),
            confidence: 'medium',
          },
        };
  }
  // Nothing definite: say so rather than inventing a failure or a success.
  if (liveness.kind === 'unknown') {
    return {
      state: ExecutionState.FAILED,
      failure: { code: FailureCode.UNKNOWN_RUNTIME_ERROR, message: `Its state could not be read${liveness.error ? `: ${liveness.error}` : ''}.`, confidence: 'low' },
    };
  }
  const verdict = classifyPostReadyExit(liveness, lastErrorLine(service.logs), service.memoryMb);
  if (!verdict) return { state: ExecutionState.READY };
  if (!verdict.failure) return { state: ExecutionState.COMPLETED };
  // The classifier speaks of an application that had been ready; a worker never was, and
  // one that died installing must not be told "it started correctly".
  const when = reached === 'start' ? ' after it started' : reached === 'none' ? ' before it started' : ` during its ${reached}`;
  return {
    state: ExecutionState.FAILED,
    failure: {
      ...verdict.failure,
      message: verdict.failure.message.replace(' after it had become ready', when),
      ...(reached !== 'start' ? { remedy: `It stopped${when}; the end of its log says why.` } : {}),
      ...(reached !== 'none' ? { phase: reached } : {}),
    },
  };
}

export { workerOutcome };

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
/**
 * Wait until a service has finished installing, or has stopped trying.
 *
 * The wrapper prints `INSTALL_OK` or `INSTALL_FAIL` around the install step, so this
 * needs no new plumbing — it watches the log the service is already writing.
 *
 * Resolves rather than rejects, always. Its job is to decide when the *next* service may
 * start, and every outcome answers that: finished, failed, the container died, or it
 * took longer than anyone should wait. A hang here would stop the project rather than
 * pace it, which is worse than installing concurrently ever was.
 */
export function waitForInstall(
  logs: LogManager,
  opts: { timeoutMs: number; hasExited?: () => Promise<boolean> | boolean; cancelled?: () => boolean },
): Promise<'ok' | 'failed' | 'exited' | 'timeout' | 'cancelled'> {
  return new Promise((resolve) => {
    let done = false;
    // Declared before the scan below, which can finish immediately — reading a `const`
    // timer from inside `finish` before that line ran threw `Cannot access 'timer'
    // before initialization`, turning the fast path into the only broken one.
    let timer: NodeJS.Timeout | undefined;
    let poll: NodeJS.Timeout | undefined;

    const finish = (outcome: 'ok' | 'failed' | 'exited' | 'timeout' | 'cancelled'): void => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (poll) clearInterval(poll);
      logs.off('sentinel', onSentinel);
      resolve(outcome);
    };

    // `sentinel`, not `entry`.
    //
    // `LogManager.ingest` recognises a phase marker, emits it on its own channel and
    // *returns* — it never reaches the buffer and never becomes an `entry`. The first
    // version of this watched `entry` and scanned the buffer, so it could not see an
    // install finish at all: it fell through to the timeout every time, and the only
    // reason a live run ever proceeded was that the container had died and `hasExited`
    // fired. The tests passed because they pushed to the buffer by hand, which is the
    // one route production never takes.
    const onSentinel = (marker: string): void => {
      if (marker.includes(Sentinel.INSTALL_OK)) finish('ok');
      else if (marker.includes(Sentinel.INSTALL_FAIL)) finish('failed');
    };

    logs.on('sentinel', onSentinel);
    timer = setTimeout(() => finish('timeout'), opts.timeoutMs);
    // A container that died mid-install prints nothing more, so the sentinel never
    // arrives — waiting the full timeout for a corpse delays every sibling behind it.
    // Asked of the container, not of our own bookkeeping.
    //
    // The first version read the service's recorded state, which is set by the readiness
    // check — and readiness runs *after* this loop finishes. So a container that was
    // OOM-killed during its install stayed "STARTING" for the full ten-minute budget
    // while the next service waited behind it. Observed exactly once, which was enough.
    poll = setInterval(() => {
      if (opts.cancelled?.()) {
        finish('cancelled');
        return;
      }
      void Promise.resolve(opts.hasExited?.())
        .then((exited) => {
          if (exited) finish('exited');
        })
        // A rejecting predicate must not become an unhandled rejection inside a timer.
        .catch(() => undefined);
    }, 500);
  });
}

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

/**
 * The limit a service starts with: the policy's initial value, or — after a shared install
 * needed more — what that install needed, capped by what the VM has free and never below
 * the initial value.
 */
async function startingMemory(
  opts: ProjectLaunchOptions,
  shared: { memoryMb?: number },
  exec: ExecutionManager,
  service: string,
): Promise<number | undefined> {
  const initial = opts.memory?.initialFor?.(service) ?? opts.memory?.initialMb;
  if (shared.memoryMb === undefined) return initial;
  const free = exec.availableMb ? await exec.availableMb() : (exec.memory?.freeMb() ?? null);
  const wanted = free === null ? shared.memoryMb : Math.min(shared.memoryMb, free);
  return Math.max(wanted, initial ?? 0);
}

/**
 * The container's state once it has stopped, or its last answer after a bounded wait.
 *
 * Docker's OOM flag is only readable on a stopped container, and the wrapper exits a
 * moment after printing its install-failed marker. Polled, not slept: it returns as soon
 * as the container has stopped, and gives up after `timeoutMs` with whatever it last saw.
 */
async function settledLiveness(handle: LaunchHandle, timeoutMs = 15_000): Promise<ContainerLiveness | undefined> {
  const deadline = Date.now() + timeoutMs;
  let last: ContainerLiveness | undefined;
  for (;;) {
    last = await handle.liveness?.().catch(() => undefined);
    if (!last || last.kind !== 'running' || Date.now() >= deadline) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
}
