import { createConnection } from 'node:net';
import { join } from 'node:path';
import {
  ExecutionState,
  FailureCode,
  ServiceRunPlanSchema,
  type FailureDetail,
  type ProjectPlan,
  type ServiceRunPlan,
} from '@devlaunch/shared';
import { config } from '../../config/index.js';
import type { ExecutionManager, LaunchHandle } from '../execution/ExecutionManager.js';
import { LaunchStopped, type ProjectRun, type ServiceRun } from '../execution/ProjectExecutor.js';
import { LogManager } from '../logs/LogManager.js';
import type { BuildSandbox } from './BuildSandbox.js';
import type { DockerService, DockerSetup } from './RepoDockerSetup.js';
import { readFile } from 'node:fs/promises';
import { dockerfileProblems, registryProblem } from './DockerfileChecks.js';
import { BUILT_IMAGE_REPO } from './BuildSandbox.js';

/**
 * Run a repository's own Docker setup — the fallback for repositories DevLaunch cannot run
 * its own way — as a project DevLaunch owns end to end.
 *
 * Built in `BuildSandbox`, run under the balanced profile, started in `depends_on` order,
 * and handed back as an ordinary `ProjectRun`: readiness, the end-to-end check, the
 * liveness watch, stop, replace and cleanup are the ones every other run goes through.
 */

/** A failure that ends the launch before anything is ready, with what to tell the user. */
export class DockerSetupFailure extends Error {
  constructor(readonly failure: FailureDetail) {
    super(failure.message);
    this.name = 'DockerSetupFailure';
  }
}

/** A compose service name as a DNS label DevLaunch can use for its own bookkeeping. */
function serviceName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63) || 'app';
}

/** The plans a setup becomes. Pure, so what will run can be read before anything does. */
export function dockerProjectPlan(setup: DockerSetup): ProjectPlan {
  return {
    planSource: 'repo-docker',
    services: setup.services.map((s) => dockerServicePlan(setup, s)),
  };
}

function dockerServicePlan(setup: DockerSetup, s: DockerService): ServiceRunPlan {
  const listens = s.role === 'web' || s.role === 'api';
  return ServiceRunPlanSchema.parse({
    name: serviceName(s.name),
    // A database or a worker has no page to open: it is checked by staying up.
    role: listens ? s.role : 'worker',
    // Read on screen as "on container <this>": the image it runs, or what it was built from.
    runtime: { language: 'container', version: s.image ?? `built from ${s.build?.dockerfile ?? 'Dockerfile'}` },
    packageManager: 'none',
    installCommand: null,
    buildCommand: null,
    startCommand: s.command?.join(' ') ?? "(the image's own command)",
    workingDirectory: s.build?.context ?? '.',
    expectedPort: listens ? (s.ports[0] ?? null) : null,
    environmentVariables: Object.entries(s.environment).map(([key, value]) => ({ key, value, required: false })),
    planSource: 'repo-docker',
    docker: {
      source: setup.source,
      file: setup.file,
      alias: s.name,
      ...(s.image ? { image: s.image } : {}),
      ...(s.build ? { build: s.build } : {}),
      ...(s.command ? { command: s.command } : {}),
      ...(s.entrypoint ? { entrypoint: s.entrypoint } : {}),
      dataPaths: s.dataPaths,
      ports: s.ports,
      database: s.role === 'database',
    },
  });
}

/**
 * Wait until the database itself accepts a connection on 127.0.0.1:port, the container
 * dies, or time runs out.
 *
 * A connection that opens is not enough: Docker's port forwarder accepts on the published
 * port before anything listens behind it, then drops the connection. Seen on the first
 * run — "accepting connections" logged a second before Postgres said it was ready. So a
 * connection counts only once it has stayed open: a database waits for the client to
 * speak, the forwarder with nothing behind it hangs up at once.
 */
export async function acceptsConnections(
  port: number,
  alive: () => Promise<boolean>,
  timeoutMs: number,
  host = '127.0.0.1',
  holdMs = 500,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host, port, timeout: 1000 });
      let settled = false;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(ok);
      };
      socket.once('connect', () => {
        socket.setTimeout(0);
        setTimeout(() => done(true), holdMs);
      });
      socket.once('close', () => done(false));
      socket.once('end', () => done(false));
      socket.once('error', () => done(false));
      socket.once('timeout', () => done(false));
    });
    if (open) return true;
    if (!(await alive())) return false;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

/** TCP ports an image declares (`EXPOSE`, its own or its base image's), in number order. */
export async function imagePorts(exec: ExecutionManager, image: string): Promise<number[]> {
  const info = await exec.docker.client().getImage(image).inspect().catch(() => null);
  const keys = Object.keys((info?.Config?.ExposedPorts as Record<string, unknown> | undefined) ?? {});
  return keys
    .filter((k) => k.endsWith('/tcp'))
    .map((k) => Number(k.split('/')[0]))
    .filter((n) => Number.isInteger(n) && n > 0)
    .sort((a, b) => a - b);
}

async function publishedPort(handle: LaunchHandle, port: number): Promise<number | null> {
  const info = await handle.container.inspect().catch(() => null);
  const mapped = info?.NetworkSettings?.Ports?.[`${port}/tcp`]?.[0]?.HostPort;
  return mapped ? Number(mapped) : null;
}

export class RepoDockerRunner {
  constructor(
    private readonly exec: ExecutionManager,
    private readonly sandbox: BuildSandbox,
  ) {}

  async launch(opts: {
    sessionId: string;
    setup: DockerSetup;
    project: ProjectPlan;
    sourceDir: string;
    logs: LogManager;
    onRun?(run: ProjectRun): void;
    stopped?(): boolean;
    buildTimeoutMs?: number;
    databaseReadyMs?: number;
  }): Promise<ProjectRun> {
    const services: ServiceRun[] = [];
    const built: string[] = [];
    const run: ProjectRun = {
      services,
      backing: [],
      entry: () => services.find((s) => s.role === 'web' && s.url) ?? services.find((s) => s.url) ?? services[0],
      cleanup: async () => {
        const errors: Error[] = [];
        // Dependents first, so nothing loses its database mid-write on the way out.
        for (const s of [...services].reverse()) {
          try {
            errors.push(...(await s.handle.cleanup()).errors);
          } catch (err) {
            errors.push(err instanceof Error ? err : new Error(String(err)));
          }
        }
        // Then the images this run built, and nothing else.
        for (const image of built.splice(0)) await this.sandbox.remove(image);
        return { errors };
      },
    };
    opts.onRun?.(run);
    const halt = async (): Promise<void> => {
      if (!opts.stopped?.()) return;
      await run.cleanup();
      throw new LaunchStopped();
    };

    for (const [i, s] of opts.setup.services.entries()) {
      await halt();
      const plan = opts.project.services[i]!;
      const tag = (line: string) => `[${plan.name}] ${line}`;
      const logs = new LogManager();
      logs.on('entry', (e: { stream: 'stdout' | 'stderr'; text: string; ts: number }) => opts.logs.write(e.stream, tag(e.text), e.ts));

      let image = s.image;
      // What the daemon itself would fetch, judged first: it fetches outside the egress
      // rules (verifier D-1), so a Dockerfile that would make it reach this machine, the
      // VM or the local network is refused by name, before anything is pulled or built.
      const refusals: string[] = [];
      if (s.build) {
        const text = await readFile(join(opts.sourceDir, s.build.dockerfile), 'utf8').catch(() => null);
        if (text === null) refusals.push(`${s.build.dockerfile} cannot be read`);
        else refusals.push(...(await dockerfileProblems(text, s.build.args)));
      }
      if (s.image) {
        // DevLaunch's own images, and those other runs built, are not a repository's to name.
        if (s.image.startsWith('devlaunch/') || s.image.startsWith(`${BUILT_IMAGE_REPO}/`)) {
          refusals.push(`${s.image} is one of DevLaunch's own images`);
        } else {
          const problem = await registryProblem(s.image);
          if (problem) refusals.push(problem);
        }
      }
      if (refusals.length > 0) {
        await run.cleanup();
        throw new DockerSetupFailure({
          code: FailureCode.PLAN_REJECTED_UNSAFE_COMMAND,
          message: `${plan.name}: ${refusals.join('; ')}.`,
          remedy:
            'DevLaunch fetches base images and files only from public registries and addresses, ' +
            'because those fetches are made by Docker itself, outside the network rules that keep a ' +
            'build off this machine and the local network.',
          confidence: 'high',
        });
      }
      if (s.image) {
        // Pulled from its registry every time, never taken from this machine: a compose file
        // naming `stockwatch:test` would otherwise run a private image of the user's own
        // (verifier D-11). An image that is only local fails here, and is said to.
        const pullError = await this.exec.docker.pullImage(s.image).then(() => null, (err: unknown) => String(err instanceof Error ? err.message : err));
        if (pullError !== null) {
          await run.cleanup();
          // Absent from every registry is the repository's problem; an outage is not.
          const absent = /not found|manifest unknown|pull access denied|does not exist|unauthorized|denied/i.test(pullError);
          throw new DockerSetupFailure(absent
            ? {
                code: FailureCode.UNSUPPORTED_PROJECT,
                message: `${plan.name}: ${s.image} could not be pulled from a registry. An image that exists only on this machine is not used.`,
                evidence: pullError.slice(0, 300),
                remedy: 'Check the image name and that it is published publicly; a private image needs credentials DevLaunch does not use.',
                confidence: 'high',
              }
            : {
                code: FailureCode.NETWORK_FAILURE,
                message: `${plan.name}: pulling ${s.image} failed on the network.`,
                evidence: pullError.slice(0, 300),
                confidence: 'medium',
              });
        }
      }
      if (s.build) {
        opts.logs.write('stdout', tag(`Building from ${s.build.dockerfile} in the build sandbox (off the local network, ${config.docker.networkName})...`));
        // A stop or a replace stops the build too (verifier D-3), and the build's memory
        // counts against the VM while it runs, as every container's does.
        const abort = new AbortController();
        const watch = setInterval(() => { if (opts.stopped?.()) abort.abort(); }, 500);
        watch.unref?.();
        const holdId = `build:${opts.sessionId}:${plan.name}`;
        this.exec.memory?.hold(holdId, this.sandbox.memoryMb);
        const result = await this.sandbox.build({
          sessionId: opts.sessionId,
          service: plan.name,
          contextDir: join(opts.sourceDir, s.build.context),
          dockerfile: join(opts.sourceDir, s.build.dockerfile),
          ...(s.build.target ? { target: s.build.target } : {}),
          args: s.build.args,
          timeoutMs: opts.buildTimeoutMs ?? config.timeouts.timeToReadyMs,
          onLine: (stream, line) => opts.logs.write(stream, tag(line)),
          signal: abort.signal,
        }).finally(() => {
          clearInterval(watch);
          this.exec.memory?.release(holdId);
        });
        if (abort.signal.aborted) {
          await run.cleanup();
          await this.sandbox.remove(result.image);
          throw new LaunchStopped();
        }
        if (!result.ok) {
          await run.cleanup();
          await this.sandbox.remove(result.image);
          throw new DockerSetupFailure({
            code: FailureCode.BUILD_FAILED,
            message: result.timedOut
              ? `${plan.name}: the image build did not finish within ${Math.round((opts.buildTimeoutMs ?? config.timeouts.timeToReadyMs) / 1000)} s.`
              : `${plan.name}: the repository's Dockerfile (${s.build.dockerfile}) did not build.`,
            ...(result.error ? { evidence: result.error.slice(0, 500) } : {}),
            remedy: /--mount|heredoc|unknown flag|syntax/i.test(result.error ?? '')
              ? 'The Dockerfile uses BuildKit-only syntax, which the network-isolated builder DevLaunch uses does not support.'
              : 'The build output above shows the step that failed; it fails the same way under `docker build`.',
            phase: 'build',
            confidence: result.error ? 'high' : 'medium',
          });
        }
        built.push(result.image);
        image = result.image;
      }
      await halt();

      // No port in the repository's files: the image may still declare one. Official
      // base images do (`php:apache` exposes 80), and the Dockerfile built on them need not
      // repeat it — read only, it ran as a worker with nothing to open.
      // A lone service only: in a compose project a service with no port is the author
      // saying so — a worker on an image that happens to declare one (ASP.NET's 8080)
      // would be waited on for a page it never serves.
      if (s.ports.length === 0 && s.role !== 'database' && opts.setup.services.length === 1) {
        await this.exec.docker.ensureImage(image!);
        const exposed = await imagePorts(this.exec, image!);
        if (exposed.length > 0) {
          opts.logs.write('stdout', tag(`The image declares port ${exposed.join(', ')}; serving on ${exposed[0]}.`));
          s.ports = exposed;
          plan.expectedPort = exposed[0]!;
          plan.role = opts.setup.services.length === 1 ? 'web' : 'api';
          if (plan.docker) plan.docker.ports = exposed;
        } else if (!plan.environmentVariables.some((v) => v.key === 'PORT')) {
          // Nothing declares a port anywhere. The convention most hosted runtimes follow
          // (Cloud Run, Heroku, Render) is to listen on $PORT, 8080 by default —
          // `GoogleCloudPlatform/cloud-run-hello` does, and declared nothing, so it ran
          // unchecked. Told so and checked there; if it listens elsewhere, the check says.
          opts.logs.write('stdout', tag('Neither the Dockerfile nor its image declares a port; setting PORT=8080, the hosted-runtime convention, and checking 8080.'));
          s.ports = [8080];
          plan.expectedPort = 8080;
          plan.role = 'web';
          plan.environmentVariables = [...plan.environmentVariables, { key: 'PORT', value: '8080', required: false }];
          if (plan.docker) plan.docker.ports = [8080];
        }
      }

      const launch = (memoryMb?: number) =>
        this.exec.launchImage({
          sessionId: opts.sessionId,
          plan,
          image: image!,
          logs,
          networkAliases: [...new Set([s.name, plan.name])],
          ...(memoryMb ? { memoryMb } : {}),
        });
      const entry: ServiceRun = {
        name: plan.name,
        role: plan.role,
        plan,
        handle: await launch(),
        logs,
        state: ExecutionState.STARTING,
        restart: async () => {
          opts.logs.write('stdout', `Restarting ${plan.name}...`);
          await entry.handle.cleanup().catch(() => undefined);
          entry.url = undefined;
          entry.failure = undefined;
          entry.state = ExecutionState.STARTING;
          entry.handle = await launch(entry.memoryMb);
          if (opts.stopped?.()) {
            await entry.handle.cleanup().catch(() => undefined);
            throw new LaunchStopped();
          }
        },
      };
      // The port it was published on, shown beside it as every service's is.
      if (plan.expectedPort !== null) entry.hostPort = (await publishedPort(entry.handle, plan.expectedPort)) ?? undefined;
      services.push(entry);
      await halt();

      // What depends on a database connects at boot; it starts once the database accepts.
      if (s.role === 'database' && s.ports[0]) {
        const port = await publishedPort(entry.handle, s.ports[0]);
        const ok = port !== null && await acceptsConnections(
          port,
          async () => (await entry.handle.liveness()).kind === 'running',
          opts.databaseReadyMs ?? config.timeouts.backingReadyMs,
        );
        opts.logs.write(ok ? 'stdout' : 'stderr', tag(ok ? `accepting connections on ${s.ports[0]}` : `did not accept connections on ${s.ports[0]}; starting what depends on it anyway`));
      }
    }
    return run;
  }
}
