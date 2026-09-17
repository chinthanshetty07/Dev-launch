import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
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

    // DevLaunch's runner images are built locally and never published, so attempting a
    // pull would fail with an opaque registry error instead of the actual remedy.
    if (image.startsWith('devlaunch/')) {
      throw new Error(
        `Runner image "${image}" is not built. Run ./scripts/build-runner-images.sh`,
      );
    }

    const stream = await this.docker.pull(image);
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(stream, (err) => (err ? reject(err) : resolve()));
    });
  }

  async networkExists(name: string): Promise<boolean> {
    try {
      await this.docker.getNetwork(name).inspect();
      return true;
    } catch {
      return false;
    }
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
      // Non-root. The runner image owns /workspace as this uid.
      User: config.container.user,
      // Declares an anonymous volume at /workspace. This is what makes the workspace
      // writable under ReadonlyRootfs, and what allows `docker cp` to land at all —
      // the API refuses copies into a read-only rootfs, but a volume is a separate
      // mount and accepts them.
      Volumes: { [config.container.workspacePath]: {} },
      ExposedPorts: opts.exposePort ? exposed : undefined,
      HostConfig: { ...opts.hostConfig, PortBindings: opts.exposePort ? bindings : undefined },
      Tty: false, // Keep stdout/stderr framed separately for demuxing.
      OpenStdin: false,
    });
  }

  /**
   * Copy a host directory's contents to `destPath` inside the container.
   *
   * Three constraints shape this, all found by testing rather than documentation:
   *
   * 1. With ReadonlyRootfs the Docker API refuses any copy whose extraction target is
   *    the rootfs — "container rootfs is marked read-only". Only the /workspace volume
   *    accepts writes, so every copy must extract *there*.
   * 2. `putArchive` requires its target to already exist, and a stopped container
   *    cannot be exec'd into to create one. So for a destination *below* the mount,
   *    entries are re-prefixed and extracted at the mount, letting the archive create
   *    the intermediate directory itself.
   * 3. Host ownership and permissions carry through the tar verbatim, and the
   *    container runs as a different uid. A directory staged at mkdtemp's default 0700
   *    arrives unreadable; a file owned by the host user cannot be rewritten by
   *    `npm install`. Both are normalised below.
   */
  async copyDirInto(
    container: Dockerode.Container,
    hostDir: string,
    destPath: string,
    mountBase: string = config.container.workspacePath,
  ): Promise<void> {
    const normalisedDest = destPath.replace(/\/+$/, '');
    const normalisedBase = mountBase.replace(/\/+$/, '');

    let prefix = '';
    if (normalisedDest !== normalisedBase) {
      if (!normalisedDest.startsWith(`${normalisedBase}/`)) {
        throw new Error(
          `Refusing to copy to "${destPath}": only the writable mount at ` +
            `"${normalisedBase}" accepts writes under a read-only rootfs.`,
        );
      }
      prefix = normalisedDest.slice(normalisedBase.length + 1);
    }

    const [uid, gid] = containerUidGid();

    const pack = tarFs.pack(hostDir, {
      map: (header) => {
        if (prefix !== '') {
          header.name = `${prefix}/${header.name}`.replace(/\/+/g, '/');
        }
        // The container user must own what it has to modify — npm rewrites
        // package-lock.json, and a file owned by the host uid is not writable.
        header.uid = uid;
        header.gid = gid;
        header.mode = normaliseMode(header.mode);
        return header;
      },
    });

    await container.putArchive(pack, { path: normalisedBase });
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

    // Kept in a variable so the rejection can be absorbed: if the timeout wins the
    // race, an unobserved rejection here would surface as an unhandled rejection.
    const waiting = container.wait();
    waiting.catch(() => undefined);

    try {
      const result = await Promise.race([waiting, timeout]);
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

  /**
   * Run a command in a running container and capture its stdout.
   *
   * Used for container introspection only (reading /proc), never for executing
   * repository commands — those always go through the wrapper's single lifecycle.
   */
  async execCapture(container: Dockerode.Container, cmd: string[]): Promise<string> {
    const exec = await container.exec({
      Cmd: cmd,
      AttachStdout: true,
      AttachStderr: true,
    });
    const stream = await exec.start({ hijack: true, stdin: false });

    return new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      stdout.on('data', (c: Buffer) => chunks.push(c));
      stderr.on('data', () => undefined);
      container.modem.demuxStream(stream, stdout, stderr);
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      stream.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
      stream.on('error', reject);
    });
  }

  async inspect(container: Dockerode.Container): Promise<Dockerode.ContainerInspectInfo> {
    return container.inspect();
  }

  /**
   * Containers DevLaunch created and has not removed.
   *
   * `scope: 'instance'` restricts this to the current process. Anything wider will
   * match containers a *different* live DevLaunch owns, and removing those destroys a
   * healthy session belonging to someone else.
   */
  async listManaged(scope: 'all' | 'instance' = 'all'): Promise<Dockerode.ContainerInfo[]> {
    const label = [`${config.docker.managedLabel}=true`];
    if (scope === 'instance') {
      label.push(`${config.docker.instanceLabel}=${config.docker.instanceId}`);
    }
    return this.docker.listContainers({ all: true, filters: { label } });
  }

  getContainer(id: string): Dockerode.Container {
    return this.docker.getContainer(id);
  }
}

/** Parse the configured "uid:gid" into numbers. */
function containerUidGid(): [number, number] {
  const [u, g] = config.container.user.split(':');
  const uid = Number.parseInt(u ?? '', 10);
  const gid = Number.parseInt(g ?? u ?? '', 10);
  // A name like "node" cannot be resolved here — the host has no view of the image's
  // passwd file — and NaN would silently corrupt every tar header.
  if (!Number.isInteger(uid) || !Number.isInteger(gid)) {
    throw new Error(
      `container.user must be numeric "uid:gid", got ${JSON.stringify(config.container.user)}.`,
    );
  }
  return [uid, gid];
}

/**
 * Grant group and other whatever read/execute the owner has — never write.
 *
 * A 0700 directory becomes 0755 so it can be traversed; a 0644 file is unchanged.
 * Without this, mkdtemp's 0700 staging directory arrives as `drwx------` and the
 * entrypoint inside it cannot be opened.
 */
function normaliseMode(mode: number | undefined): number {
  const m = mode ?? 0o644;
  const readExec = ((m >> 6) & 0o7) & 0o5;
  return m | (readExec << 3) | readExec;
}
