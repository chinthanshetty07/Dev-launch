import type Dockerode from 'dockerode';
import { config } from '../../config/index.js';

/**
 * Container hardening.
 *
 * Every control here is asserted by an integration test against a real container —
 * a security claim nothing verifies is just a comment. See security.test.ts.
 */
export interface SecurityOptions {
  sessionId: string;
  /** Named volume reused across runs to cache package downloads. */
  packageCacheVolume?: string;
  /** User-defined network carrying the RFC1918 egress policy, when installed. */
  networkName?: string;
  /**
   * Memory ceiling for this one container, overriding the configured default.
   *
   * Exists so a run killed by the limit can be retried under a larger one. The limit is
   * DevLaunch's own configuration, not a property of the repository, and reporting
   * `OUT_OF_MEMORY` as though the project were at fault was blaming somebody else for a
   * number we chose — a Next.js dev build does not fit in 1 GB and never did.
   */
  memoryMb?: number;
}

export function buildHostConfig(opts: SecurityOptions): Dockerode.HostConfig {
  const binds: string[] = [];
  if (opts.packageCacheVolume) binds.push(`${opts.packageCacheVolume}:/cache`);

  const memoryMb = opts.memoryMb ?? config.container.memoryMb;

  return {
    // --- Resource ceilings -----------------------------------------------------
    Memory: memoryMb * 1024 * 1024,
    // Equal to Memory: without this the container escapes its cap through swap.
    MemorySwap: memoryMb * 1024 * 1024,
    NanoCpus: config.container.cpus * 1_000_000_000,
    PidsLimit: config.container.pidsLimit,

    // --- Filesystem ------------------------------------------------------------
    ReadonlyRootfs: true,
    // The rootfs is read-only, so npm's scratch space must come from somewhere.
    // noexec/nosuid stop /tmp being used to stage an executable payload.
    Tmpfs: { '/tmp': `rw,noexec,nosuid,size=${config.container.tmpSizeMb}m` },

    // --- Privilege -------------------------------------------------------------
    CapDrop: ['ALL'],
    // Blocks privilege escalation through setuid binaries.
    SecurityOpt: ['no-new-privileges'],
    Privileged: false,

    // tini as PID 1: reaps zombies and forwards signals to the exec'd application.
    Init: true,

    // The Docker socket is never mounted. Stated explicitly because its absence is a
    // security property rather than an omission.
    Binds: binds.length > 0 ? binds : undefined,

    NetworkMode: opts.networkName,

    // CleanupManager owns removal, so exit codes stay readable after failure.
    AutoRemove: false,
  };
}

/**
 * Capabilities a repository's own image keeps: Docker's defaults minus the ones nothing
 * ordinary needs. The balanced profile the user chose lets an image run as its own user
 * (often root) and write its own filesystem — official images (postgres, nginx…) start
 * as root and drop to a service user, which needs CHOWN/SETUID/SETGID — but adds nothing,
 * and removes raw sockets (packet spoofing on the shared network), device nodes and the
 * rest below.
 */
const BALANCED_DROPPED_CAPS = ['NET_RAW', 'MKNOD', 'AUDIT_WRITE', 'SETFCAP', 'SYS_CHROOT', 'SETPCAP', 'FSETID'];

/**
 * Host configuration for a repository's own image (its Dockerfile or compose file).
 *
 * The same walls as DevLaunch's own containers where an arbitrary image can live with
 * them — memory, CPU and process ceilings, no-new-privileges, not privileged, no Docker
 * socket, no host mounts, no host namespaces, DevLaunch's network and its egress rules —
 * and the image's own user and a writable root filesystem where it cannot.
 */
export function buildRepoImageHostConfig(opts: { memoryMb?: number; networkName?: string }): Dockerode.HostConfig {
  const memoryMb = opts.memoryMb ?? config.container.memoryMb;
  return {
    Memory: memoryMb * 1024 * 1024,
    MemorySwap: memoryMb * 1024 * 1024,
    NanoCpus: config.container.cpus * 1_000_000_000,
    PidsLimit: config.container.pidsLimit,
    ReadonlyRootfs: false,
    CapDrop: [...BALANCED_DROPPED_CAPS],
    CapAdd: [],
    SecurityOpt: ['no-new-privileges'],
    Privileged: false,
    Init: true,
    // Named explicitly so nothing upstream can widen them.
    Binds: undefined,
    Devices: [],
    PidMode: '',
    IpcMode: 'private',
    UsernsMode: '',
    NetworkMode: opts.networkName,
    AutoRemove: false,
  };
}

/**
 * The cache volume a repository's package downloads belong in.
 *
 * Keyed on what is being installed — a repository, and within it a service — rather than
 * on the session, because both of the slow cases are repeats: a repair re-running the
 * same install seconds later, and a person re-running the same project after a fix.
 *
 * Not shared any wider than that, for two reasons. A cache is a writable surface every
 * container mounting it can see, and one repository's install has no business writing
 * anything another will later read. And a project's services install *at the same time*:
 * giving them one volume puts two package managers in one cache directory concurrently,
 * which is a race to rely on rather than a thing to arrange.
 *
 * A session with no repository URL gets its own, so it still spans that session's repairs
 * without joining anything else.
 */
export function cacheVolumeFor(key: string, service?: string): string {
  // Each part is normalised before they are joined. Normalising the joined string
  // instead lets the separator hide the suffix — `repo.git--api` no longer ends in
  // `.git`, so the same repository cloned with and without it gets two caches and
  // neither is ever warm.
  const clean = (part: string): string =>
    part
      .replace(/^https?:\/\//, '')
      // Tracking parameters are not identity: with them, the same repository pasted
      // from two places gets two caches and neither is ever warm.
      .replace(/[?#].*$/, '')
      .replace(/\.git$/, '')
      .replace(/[^a-zA-Z0-9_.-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase();

  const safe = [key, service]
    .filter((p): p is string => Boolean(p))
    .map(clean)
    .filter(Boolean)
    .join('--')
    // Docker caps a volume name at 255; the prefix and a generous margin fit well inside
    // this, and the tail is the distinguishing end of a path.
    .slice(-64)
    .replace(/^[^a-zA-Z0-9]+/, '');

  return `${config.docker.cacheVolumePrefix}${safe || 'default'}`;
}

export function buildLabels(sessionId: string): Record<string, string> {
  return {
    [config.docker.managedLabel]: 'true',
    [config.docker.sessionLabel]: sessionId,
    // Stamps the creating process, so another instance's sweep leaves this alone.
    [config.docker.instanceLabel]: config.docker.instanceId,
  };
}
