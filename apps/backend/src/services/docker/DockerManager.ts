import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Dockerode from 'dockerode';
import tarFs from 'tar-fs';
import { config } from '../../config/index.js';

export interface CreateContainerOptions {
  image: string;
  /** Wrapper env: DL_WORKDIR, DL_INSTALL_CMD, DL_BUILD_CMD, DL_START_CMD, plus plan vars. */
  env: string[];
  labels: Record<string, string>;
  hostConfig: Dockerode.HostConfig;
  workingDir: string;
  /** Internal port to expose. Phase 3 consumes the resulting host mapping. */
  exposePort?: number | null;
}

export interface ExitResult {
  exitCode: number;
  timedOut: boolean;
}

/**
 * Thin, honest wrapper over the Docker API.
 *
 * The lifecycle is deliberately `create → cp → start` rather than `run`: the container
 * must exist before the repository can be copied in, and the wrapper script must be in
 * place before the entrypoint executes.
 */
export class DockerManager {
  private readonly docker: Dockerode;

  constructor(socketPath: string = config.docker.socketPath) {
    this.docker = new Dockerode({ socketPath });
  }

  async ping(): Promise<void> {
    await this.docker.ping();
  }

  async imageExists(image: string): Promise<boolean> {
    try {
      await this.docker.getImage(image).inspect();
      return true;
    } catch {
      return false;
    }
  }

  /** Pull only when absent — pulls are slow and the image set is allowlisted. */
  async ensureImage(image: string): Promise<void> {
    if (await this.imageExists(image)) return;
    const stream = await this.docker.pull(image);
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(stream, (err) => (err ? reject(err) : resolve()));
    });
  }

  async ensureVolume(name: string): Promise<void> {
    try {
      await this.docker.getVolume(name).inspect();
    } catch {
      await this.docker.createVolume({ Name: name });
    }
  }

  async createContainer(opts: CreateContainerOptions): Promise<Dockerode.Container> {
    const exposed: Record<string, Record<string, never>> = {};
    const bindings: Record<string, Array<{ HostPort: string }>> = {};
    if (opts.exposePort) {
      const key = `${opts.exposePort}/tcp`;
      exposed[key] = {};
      // Empty HostPort lets Docker assign a free port; we read the mapping back
      // rather than scanning the host. See docs/planning-strategy.md.
      bindings[key] = [{ HostPort: '' }];
    }

    return this.docker.createContainer({
      Image: opts.image,
      Entrypoint: ['/bin/sh', `${config.container.wrapperPath}/run.sh`],
      Env: opts.env,
      Labels: opts.labels,
      WorkingDir: opts.workingDir,
      ExposedPorts: opts.exposePort ? exposed : undefined,
      HostConfig: { ...opts.hostConfig, PortBindings: opts.exposePort ? bindings : undefined },
      Tty: false, // Keep stdout/stderr framed separately for demuxing.
      OpenStdin: false,
    });
  }

  /**
   * Copy a host directory's *contents* into `destPath` inside the container.
   *
   * `putArchive` requires the destination to already exist, and neither /workspace nor
   * /devlaunch exists in a stock base image — and a stopped container cannot be exec'd
   * into to create them. So instead of extracting *into* the destination, we rewrite
   * each tar entry to sit under it and extract at `/`, letting the archive create the
   * directory itself.
   */
  async copyDirInto(
    container: Dockerode.Container,
    hostDir: string,
    destPath: string,
  ): Promise<void> {
    const prefix = destPath.replace(/^\/+/, '').replace(/\/+$/, '');
    if (prefix === '') {
      await container.putArchive(tarFs.pack(hostDir), { path: '/' });
      return;
    }

    const pack = tarFs.pack(hostDir, {
      map: (header) => {
        header.name = `${prefix}/${header.name}`.replace(/\/+/g, '/');
        return header;
      },
    });
    await container.putArchive(pack, { path: '/' });
  }

  /** Place the generated wrapper script, staged through a temp dir so the repo is untouched. */
  async installWrapper(
    container: Dockerode.Container,
    scriptBody: string,
    destPath: string,
  ): Promise<void> {
    const staging = await mkdtemp(join(tmpdir(), 'devlaunch-wrapper-'));
    try {
      const file = join(staging, 'run.sh');
      await writeFile(file, scriptBody, 'utf8');
      await chmod(file, 0o755);
      await this.copyDirInto(container, staging, destPath);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  async start(container: Dockerode.Container): Promise<void> {
    await container.start();
  }

  async followLogs(container: Dockerode.Container): Promise<NodeJS.ReadableStream> {
    return (await container.logs({
      follow: true,
      stdout: true,
      stderr: true,
      timestamps: false,
    })) as unknown as NodeJS.ReadableStream;
  }

  /**
   * Wait for exit, bounded. On timeout the container is stopped so the caller is never
   * left holding a running container it believes has finished.
   */
  async waitForExit(container: Dockerode.Container, timeoutMs: number): Promise<ExitResult> {
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;

    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        resolve('timeout');
      }, timeoutMs);
    });

    try {
      const result = await Promise.race([container.wait(), timeout]);
      if (result === 'timeout') {
        await this.stop(container);
        return { exitCode: -1, timedOut: true };
      }
      const status = (result as { StatusCode?: number }).StatusCode ?? -1;
      return { exitCode: status, timedOut };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async stop(container: Dockerode.Container): Promise<void> {
    try {
      await container.stop({ t: config.timeouts.stopGraceSec });
    } catch (err) {
      // 304 = already stopped, 404 = already gone. Both are the desired end state.
      const code = (err as { statusCode?: number }).statusCode;
      if (code !== 304 && code !== 404) throw err;
    }
  }

  async remove(container: Dockerode.Container): Promise<void> {
    try {
      await container.remove({ force: true, v: true });
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode !== 404) throw err;
    }
  }

  async inspect(container: Dockerode.Container): Promise<Dockerode.ContainerInspectInfo> {
    return container.inspect();
  }

  /** Every container DevLaunch has ever created and not removed. */
  async listManaged(): Promise<Dockerode.ContainerInfo[]> {
    return this.docker.listContainers({
      all: true,
      filters: { label: [`${config.docker.managedLabel}=true`] },
    });
  }

  getContainer(id: string): Dockerode.Container {
    return this.docker.getContainer(id);
  }
}
