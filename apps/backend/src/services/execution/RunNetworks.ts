import { config } from '../../config/index.js';
import type { DockerManager } from '../docker/DockerManager.js';

/**
 * A network of its own for every run.
 *
 * Every run used to share `devlaunch-net`. At the default of one run at a time that is
 * harmless; with more, a run could reach the other's databases and services by their
 * names — compose service names, and DevLaunch's MongoDB and Redis, which have no
 * password (verifier D-8). Docker networks are the boundary Docker already has for
 * this: containers on different bridges cannot reach each other at all.
 *
 * Each network is a /24 from `config.docker.runNetworkPool`, the range the egress rules
 * in scripts/setup-network-policy.sh cover, so a run's own network keeps it off the
 * home network and the VM exactly as `devlaunch-net` did. That is checked, not assumed:
 * an install from before the rules covered the range would otherwise give every run a
 * network with no rules at all. Until the check passes, runs share `devlaunch-net` as
 * before, and the log says why.
 */

/** The run network's name for a session. Docker allows 64 characters; this uses 26. */
export function runNetworkName(sessionId: string): string {
  return `${config.docker.runNetworkPrefix}${sessionId.slice(0, 12).toLowerCase()}`;
}

/**
 * The first /24 in the pool that no Docker network uses (the shared network's own among
 * them), skipping the pool's first. Null when the pool is full or is not a /16.
 */
export function pickRunSubnet(pool: string, used: ReadonlySet<string>): string | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.0\.0\/16$/.exec(pool);
  if (!m) return null;
  for (let n = 1; n <= 254; n++) {
    const subnet = `${m[1]}.${m[2]}.${n}.0/24`;
    if (!used.has(subnet)) return subnet;
  }
  return null;
}

/** What a run network needs from Docker. A subset, so tests can supply it. */
type NetworkDocker = Pick<
  DockerManager,
  'networkExists' | 'createRunNetwork' | 'removeNetwork' | 'usedSubnets' | 'vmGuardedFrom' | 'listRunNetworks' | 'listManaged'
>;

/** How long a check that found the rules missing is believed before it is made again. */
const RECHECK_MS = 5 * 60_000;
/** A check that could not run at all says nothing about the rules; try again soon. */
const RETRY_MS = 30_000;

export class RunNetworks {
  private readonly bySession = new Map<string, string>();
  private guarded: { ok: boolean; at: number; ttl: number } | null = null;
  private checking: Promise<boolean> | null = null;
  /** One network is created at a time, so two runs never pick the same subnet. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly docker: NetworkDocker,
    private readonly warn: (message: string) => void = (m) => console.warn(`WARNING: ${m}`),
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * The network a session's containers join: its own, or the shared one when its own
   * cannot be kept under the egress rules. Undefined when even the shared one is missing,
   * which callers already handle (a repository's own image refuses to run without it).
   */
  async forSession(sessionId: string): Promise<string | undefined> {
    const shared = config.docker.networkName;
    if (!(await this.docker.networkExists(shared))) return undefined;
    // A Docker stand-in without network management (unit tests) gets the shared network.
    if (typeof this.docker.createRunNetwork !== 'function') return shared;
    const known = this.bySession.get(sessionId);
    if (known) return known;
    if (!(await this.available())) return shared;
    return this.serially(async () => {
      const again = this.bySession.get(sessionId);
      if (again) return again;
      const name = runNetworkName(sessionId);
      try {
        await this.create(name, {
          [config.docker.managedLabel]: 'true',
          [config.docker.sessionLabel]: sessionId,
          [config.docker.instanceLabel]: config.docker.instanceId,
        });
      } catch (err) {
        this.warn(`Could not create a network of its own for this run (${err instanceof Error ? err.message : String(err)}); it shares ${shared} with any other run.`);
        return shared;
      }
      this.bySession.set(sessionId, name);
      return name;
    });
  }

  /**
   * Remove a session's network, once none of its containers is left.
   *
   * Docker refuses to remove a network a *running* container is on, but not one a
   * container has been created on and not yet started. A stop that arrives while the run
   * is still starting tears down what exists and gets here while the starter may be
   * between creating a container and starting it — seen in the suite: a database created
   * on a network removed a moment later, which then could never start. So the network
   * stays while any of the session's containers exists; what is left that way goes at
   * this process's shutdown, or at the next start after a crash.
   */
  async release(sessionId: string): Promise<void> {
    const name = this.bySession.get(sessionId) ?? runNetworkName(sessionId);
    this.bySession.delete(sessionId);
    if (typeof this.docker.removeNetwork !== 'function') return;
    if (!(await this.docker.networkExists(name).catch(() => false))) return;
    if (typeof this.docker.listManaged === 'function') {
      const containers = await this.docker.listManaged('all').catch(() => null);
      if (containers === null) return;
      if (containers.some((c) => c.Labels?.[config.docker.sessionLabel] === sessionId)) return;
    }
    await this.docker.removeNetwork(name).catch(() => undefined);
  }

  /**
   * Whether a network from the pool is under the egress rules on this VM: a probe
   * network is made and a container on it tries to reach the VM. Believed for good once
   * true; a false is checked again after a while, so `./devlaunch install` takes effect
   * without a restart.
   */
  private async available(): Promise<boolean> {
    if (this.guarded && (this.guarded.ok || this.now() - this.guarded.at < this.guarded.ttl)) return this.guarded.ok;
    this.checking ??= this.check().finally(() => {
      this.checking = null;
    });
    return this.checking;
  }

  private async check(): Promise<boolean> {
    const probe = `${config.docker.runNetworkPrefix}probe-${config.docker.instanceId.slice(0, 8)}`;
    // true: under the rules. false: the VM answered, so they do not cover the range.
    // A string: why the check could not run, which says nothing about the rules.
    let verdict: boolean | string;
    try {
      await this.serially(() => this.create(probe, {
        [config.docker.managedLabel]: 'true',
        [config.docker.instanceLabel]: config.docker.instanceId,
      }));
      verdict = (await this.docker.vmGuardedFrom(probe)) ?? 'the check container said nothing';
    } catch (err) {
      verdict = err instanceof Error ? err.message : String(err);
    } finally {
      await this.docker.removeNetwork(probe).catch(() => undefined);
    }
    const shared = `runs share ${config.docker.networkName} and two runs at once are not kept apart`;
    if (verdict === false) {
      this.warn(`Networks in ${config.docker.runNetworkPool} are not under DevLaunch's network rules on this VM, so ${shared}. Run: ./devlaunch install`);
    } else if (verdict !== true) {
      this.warn(`Could not check that networks in ${config.docker.runNetworkPool} are under DevLaunch's network rules (${verdict}), so for now ${shared}. Checking again shortly.`);
    }
    const ok = verdict === true;
    this.guarded = { ok, at: this.now(), ttl: verdict === false ? RECHECK_MS : RETRY_MS };
    return ok;
  }

  /** Create a network on a free subnet, trying the next one if another process took it first. */
  private async create(name: string, labels: Record<string, string>): Promise<void> {
    const tried = new Set<string>();
    for (let attempt = 0; ; attempt++) {
      const used = new Set([...(await this.docker.usedSubnets()), ...tried]);
      const subnet = pickRunSubnet(config.docker.runNetworkPool, used);
      if (!subnet) throw new Error(`no free subnet left in ${config.docker.runNetworkPool}`);
      try {
        await this.docker.createRunNetwork(name, subnet, labels);
        return;
      } catch (err) {
        // Another DevLaunch (or the test suite) took the same subnet between our look and
        // our create. Anything else is a real failure.
        if (attempt >= 4 || !/overlap/i.test(err instanceof Error ? err.message : String(err))) throw err;
        tried.add(subnet);
      }
    }
  }

  private serially<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

/**
 * The network a session's containers join, from an ExecutionManager — or, from a stand-in
 * without `networkFor` (unit tests), the shared network when it exists.
 */
export async function sessionNetwork(
  exec: { docker: Pick<DockerManager, 'networkExists'>; networkFor?: (sessionId: string) => Promise<string | undefined> },
  sessionId: string,
): Promise<string | undefined> {
  if (typeof exec.networkFor === 'function') return exec.networkFor(sessionId);
  return (await exec.docker.networkExists(config.docker.networkName)) ? config.docker.networkName : undefined;
}
