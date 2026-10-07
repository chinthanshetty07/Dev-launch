import { relative } from 'node:path';
import type Dockerode from 'dockerode';
import tarFs from 'tar-fs';
import { config } from '../../config/index.js';

/**
 * Where a repository's Dockerfile is built.
 *
 * A default build runs every `RUN` line on Docker's own bridge network, which DevLaunch's
 * egress rules do not cover: measured here, a `RUN wget` reached the home router, the
 * cloud-metadata address and the VM itself, while the same lines on `devlaunch-net`
 * timed out on all three and still reached the package registries.
 *
 * So every build step runs as an ordinary container on `devlaunch-net`, through Docker's
 * classic builder, which is the one that accepts a named network for `RUN`. The obvious
 * alternative — a BuildKit builder on that network — was tried and refused: `buildx`
 * creates its builder container *privileged* even from the rootless image, and a rootless
 * builder of our own cannot start in this VM without relaxing its AppArmor restriction on
 * user namespaces. Neither is acceptable for untrusted Dockerfiles; this needs neither.
 *
 * The cost, stated: BuildKit-only Dockerfile syntax (`RUN --mount`, heredocs) does not
 * build here, and fails with the builder's own message.
 *
 * The classic builder also takes no process limit, so every build is placed under a VM
 * cgroup that has one (`config.docker.buildCgroup`, or the systemd slice `buildSlice` where
 * Docker uses the systemd cgroup driver; kept in place by the guard `./devlaunch install`
 * starts).
 * Measured: a `RUN` starting 3,000 processes started all of them without it, and stopped
 * at 2,048 with "can't fork" under it. Docker creates a missing parent cgroup with *no*
 * limit rather than failing, so the cap is checked before every build, not assumed.
 */

/** Images DevLaunch builds are tagged under this name, so nothing else is ever touched. */
export const BUILT_IMAGE_REPO = 'devlaunch-built';

export interface BuildRequest {
  sessionId: string;
  service: string;
  /** Absolute path of the build context on this machine. */
  contextDir: string;
  /** Absolute path of the Dockerfile. */
  dockerfile: string;
  target?: string;
  args?: Record<string, string>;
  timeoutMs: number;
  onLine: (stream: 'stdout' | 'stderr', line: string) => void;
  signal?: AbortSignal;
}

export interface BuildResult {
  ok: boolean;
  image: string;
  /** The builder's own error, when it gave one. */
  error?: string;
  /** True when the build was stopped by its time limit rather than failing on its own. */
  timedOut: boolean;
  durationMs: number;
}

/** The tag a service's image gets: one per session and service, never anything shared. */
export function builtImageTag(sessionId: string, service: string): string {
  const s = service.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^[^a-z0-9]+/, '') || 'app';
  return `${BUILT_IMAGE_REPO}/${sessionId.slice(0, 12).toLowerCase()}-${s}:latest`;
}

/** Where the Dockerfile is put when it lives outside the context it builds. */
const OUTSIDE_DOCKERFILE = '.devlaunch.Dockerfile';

/**
 * The options Docker's build API is given. Pure, so the sandbox can be checked without
 * Docker: the network, the limits, and that no option grants anything.
 */
/** How Docker places containers in cgroups, which decides how the build cap is named. */
export type CgroupDriver = 'cgroupfs' | 'systemd';

/** The driver `docker info` reports. Anything but `systemd` is cgroupfs (Docker's default). */
export function cgroupDriverOf(info: { CgroupDriver?: string }): CgroupDriver {
  return info.CgroupDriver === 'systemd' ? 'systemd' : 'cgroupfs';
}

/** The parent every build runs under: a cgroup path, or a slice for the systemd driver. */
export function buildCgroupParent(driver: CgroupDriver): string {
  return driver === 'systemd' ? config.docker.buildSlice : `/${config.docker.buildCgroup}`;
}

/** Where the build cap's process limit is read, under /sys/fs/cgroup. */
export function buildCapPath(driver: CgroupDriver): string {
  return `/sys/fs/cgroup/${driver === 'systemd' ? config.docker.buildSlice : config.docker.buildCgroup}/pids.max`;
}

export function buildOptions(
  req: Omit<BuildRequest, 'onLine' | 'timeoutMs' | 'signal'>,
  memoryMb: number,
  cpus: number,
  driver: CgroupDriver = 'cgroupfs',
): Record<string, unknown> {
  const inside = relative(req.contextDir, req.dockerfile);
  const dockerfile = inside.startsWith('..') ? OUTSIDE_DOCKERFILE : inside;
  return {
    t: builtImageTag(req.sessionId, req.service),
    dockerfile,
    // The classic builder: the one that runs RUN steps on a network we name.
    version: '1',
    networkmode: config.docker.networkName,
    // Under the VM's capped cgroup: the only process limit a classic build can have.
    cgroupparent: buildCgroupParent(driver),
    memory: memoryMb * 1024 * 1024,
    memswap: memoryMb * 1024 * 1024,
    cpuperiod: 100_000,
    cpuquota: Math.round(cpus * 100_000),
    // Intermediate containers removed, even after a failed step.
    rm: true,
    forcerm: true,
    labels: {
      [config.docker.managedLabel]: 'true',
      [config.docker.sessionLabel]: req.sessionId,
      [config.docker.instanceLabel]: config.docker.instanceId,
    },
    ...(req.target ? { target: req.target } : {}),
    ...(req.args && Object.keys(req.args).length ? { buildargs: req.args } : {}),
  };
}

/**
 * Why the build cgroup cannot be trusted to cap a build, or null when it can: it must
 * exist and carry a number. `max` is what Docker leaves on a cgroup it created itself
 * because the VM restarted without DevLaunch's boot service.
 */
export function buildCapProblem(pidsMax: string | null): string | null {
  const value = pidsMax?.trim();
  if (value && /^\d+$/.test(value) && Number(value) > 0) return null;
  return `the Docker engine has no process limit for builds (${value ? `the build cgroup's pids.max is ${value}` : 'no build cgroup'}; run ./devlaunch install, which starts the devlaunch-guard container), so a build step could start processes until the machine stalls`;
}

/**
 * Read the build cgroup's `pids.max` from inside the VM. A throwaway container sees the
 * VM's cgroup tree (host cgroup namespace, mounted read-only by Docker) and nothing else:
 * no network, no capabilities, not root.
 */
async function readBuildPidsMax(docker: Dockerode, driver: CgroupDriver): Promise<string | null> {
  const container = await docker.createContainer({
    Image: 'devlaunch/node:20',
    Cmd: ['cat', buildCapPath(driver)],
    User: '1000:1000',
    Labels: { [config.docker.managedLabel]: 'true', [config.docker.instanceLabel]: config.docker.instanceId },
    HostConfig: {
      CgroupnsMode: 'host',
      NetworkMode: 'none',
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      Memory: 64 * 1024 * 1024,
      PidsLimit: 16,
    },
  } as Dockerode.ContainerCreateOptions);
  try {
    await container.start();
    const { StatusCode } = (await container.wait()) as { StatusCode: number };
    if (StatusCode !== 0) return null;
    // Not a TTY, so the log is framed; the value is the last word in it.
    const out = (await container.logs({ stdout: true, stderr: false })).toString('utf8');
    return /(\d+|max)\s*$/.exec(out)?.[1] ?? null;
  } finally {
    await container.remove({ force: true }).catch(() => undefined);
  }
}

export class BuildSandbox {
  /** The memory a build may use, counted against the VM while it runs. */
  get memoryMb(): number {
    return this.limits.memoryMb;
  }

  constructor(
    private readonly docker: Dockerode,
    private readonly limits: { memoryMb: number; cpus: number } = {
      memoryMb: Number(process.env.DEVLAUNCH_BUILD_MEMORY_MB) || 2048,
      cpus: config.container.cpus,
    },
    /** The build cgroup's `pids.max` as the VM has it, or null when it does not exist. */
    private readonly readPidsMax?: () => Promise<string | null>,
  ) {}

  private driverSeen?: Promise<CgroupDriver>;

  /** The engine's cgroup driver, asked once. Anything but `systemd` is treated as cgroupfs. */
  private driver(): Promise<CgroupDriver> {
    this.driverSeen ??= Promise.resolve()
      .then(() => this.docker.info())
      .then(cgroupDriverOf, () => 'cgroupfs' as CgroupDriver);
    return this.driverSeen;
  }

  /**
   * The sandbox exists only on DevLaunch's network and under the capped build cgroup;
   * without either, nothing is built.
   */
  async ready(): Promise<string | null> {
    const nets = await this.docker.listNetworks({ filters: { name: [config.docker.networkName] } });
    if (!nets.some((n) => n.Name === config.docker.networkName)) {
      return `the ${config.docker.networkName} network does not exist (run ./devlaunch install), so a build could not be kept off the local network`;
    }
    const read = this.readPidsMax ?? (async () => readBuildPidsMax(this.docker, await this.driver()));
    const pidsMax = await read().catch(() => null);
    return buildCapProblem(pidsMax);
  }

  async build(req: BuildRequest): Promise<BuildResult> {
    const image = builtImageTag(req.sessionId, req.service);
    const started = Date.now();
    const missing = await this.ready();
    if (missing) return { ok: false, image, error: `Not building: ${missing}.`, timedOut: false, durationMs: 0 };

    const opts = buildOptions(req, this.limits.memoryMb, this.limits.cpus, await this.driver());
    const inside = !relative(req.contextDir, req.dockerfile).startsWith('..');
    const context = tarFs.pack(req.contextDir, ({
      // A Dockerfile outside its context travels with it under a fixed name.
      ...(inside ? {} : { finalize: false, finish: (pack: { entry: (h: object, b: string) => void; finalize: () => void }) => {
        void import('node:fs/promises')
          .then(async ({ readFile }) => {
            pack.entry({ name: OUTSIDE_DOCKERFILE }, await readFile(req.dockerfile, 'utf8'));
            pack.finalize();
          })
          // Never an unhandled rejection (verifier D-14): the build then fails on its own.
          .catch((err: unknown) => (pack as unknown as { destroy(e: unknown): void }).destroy(err));
      } }),
    }) as never);

    const abort = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, req.timeoutMs);
    req.signal?.addEventListener('abort', () => abort.abort(), { once: true });

    try {
      const stream = (await this.docker.buildImage(context as never, { ...opts, abortSignal: abort.signal } as never)) as unknown as NodeJS.ReadableStream;
      const error = await new Promise<string | undefined>((resolve) => {
        let failure: string | undefined;
        this.docker.modem.followProgress(
          stream,
          (err) => resolve(failure ?? (err ? String(err.message ?? err) : undefined)),
          (event: { stream?: string; error?: string; errorDetail?: { message?: string } }) => {
            if (event.stream) {
              for (const line of event.stream.split('\n')) if (line.trim()) req.onLine('stdout', line);
            }
            if (event.error) {
              failure = event.errorDetail?.message ?? event.error;
              req.onLine('stderr', failure);
            }
          },
        );
      });
      return { ok: !error && !timedOut, image, ...(error ? { error } : {}), timedOut, durationMs: Date.now() - started };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      req.onLine('stderr', `The build could not run: ${message}`);
      return { ok: false, image, error: message, timedOut, durationMs: Date.now() - started };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Remove an image DevLaunch built. Never anything outside BUILT_IMAGE_REPO. */
  async remove(image: string): Promise<void> {
    if (!image.startsWith(`${BUILT_IMAGE_REPO}/`)) return;
    await this.docker.getImage(image).remove({ force: true }).catch(() => undefined);
  }
}
