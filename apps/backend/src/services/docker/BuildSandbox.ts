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
export function buildOptions(req: Omit<BuildRequest, 'onLine' | 'timeoutMs' | 'signal'>, memoryMb: number, cpus: number): Record<string, unknown> {
  const inside = relative(req.contextDir, req.dockerfile);
  const dockerfile = inside.startsWith('..') ? OUTSIDE_DOCKERFILE : inside;
  return {
    t: builtImageTag(req.sessionId, req.service),
    dockerfile,
    // The classic builder: the one that runs RUN steps on a network we name.
    version: '1',
    networkmode: config.docker.networkName,
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
  ) {}

  /** The sandbox exists only on DevLaunch's network; without it, nothing is built. */
  async ready(): Promise<string | null> {
    const nets = await this.docker.listNetworks({ filters: { name: [config.docker.networkName] } });
    return nets.some((n) => n.Name === config.docker.networkName)
      ? null
      : `the ${config.docker.networkName} network does not exist (run ./devlaunch install), so a build could not be kept off the local network`;
  }

  async build(req: BuildRequest): Promise<BuildResult> {
    const image = builtImageTag(req.sessionId, req.service);
    const started = Date.now();
    const missing = await this.ready();
    if (missing) return { ok: false, image, error: `Not building: ${missing}.`, timedOut: false, durationMs: 0 };

    const opts = buildOptions(req, this.limits.memoryMb, this.limits.cpus);
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
