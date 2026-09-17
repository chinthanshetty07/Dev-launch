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
}

export function buildHostConfig(opts: SecurityOptions): Dockerode.HostConfig {
  const binds: string[] = [];
  if (opts.packageCacheVolume) binds.push(`${opts.packageCacheVolume}:/cache`);

  return {
    // --- Resource ceilings -----------------------------------------------------
    Memory: config.container.memoryMb * 1024 * 1024,
    // Equal to Memory: without this the container escapes its cap through swap.
    MemorySwap: config.container.memoryMb * 1024 * 1024,
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

export function buildLabels(sessionId: string): Record<string, string> {
  return {
    [config.docker.managedLabel]: 'true',
    [config.docker.sessionLabel]: sessionId,
  };
}
