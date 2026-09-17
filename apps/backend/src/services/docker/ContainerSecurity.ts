import type Dockerode from 'dockerode';
import { config } from '../../config/index.js';

/**
 * Container hardening.
 *
 * PHASE 1 (this file, now): resource limits, correct PID 1, no Docker socket, and a
 * writable workspace so `npm install` can run at all.
 *
 * PHASE 2 (next): read-only root filesystem, capDrop ALL, non-root user, PID limits,
 * and the RFC1918 egress block. The seams are marked below.
 */
export interface SecurityOptions {
  sessionId: string;
  /** Named volume reused across runs to cache package downloads. */
  packageCacheVolume?: string;
}

export function buildHostConfig(opts: SecurityOptions): Dockerode.HostConfig {
  const binds: string[] = [];
  if (opts.packageCacheVolume) {
    binds.push(`${opts.packageCacheVolume}:/cache`);
  }

  return {
    // Resource ceilings. The Colima VM is 4 GB total; see docs/limitations.md.
    Memory: config.container.memoryMb * 1024 * 1024,
    // Prevent the container escaping its memory cap via swap.
    MemorySwap: config.container.memoryMb * 1024 * 1024,
    NanoCpus: config.container.cpus * 1_000_000_000,

    // tini as PID 1: reaps zombies and forwards signals to the exec'd app.
    Init: true,

    // The Docker socket is never mounted. Stated explicitly because its absence is
    // a security property, not an oversight.
    Binds: binds.length > 0 ? binds : undefined,

    AutoRemove: false, // CleanupManager owns removal, so exit codes stay readable.

    // --- PHASE 2 seams ---------------------------------------------------------
    // ReadonlyRootfs: true,
    // CapDrop: ['ALL'],
    // SecurityOpt: ['no-new-privileges'],
    // PidsLimit: 256,
    // Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=64m' },
    // ---------------------------------------------------------------------------
  };
}

export function buildLabels(sessionId: string): Record<string, string> {
  return {
    [config.docker.managedLabel]: 'true',
    [config.docker.sessionLabel]: sessionId,
  };
}
