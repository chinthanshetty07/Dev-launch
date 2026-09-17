import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Resolve the Docker socket.
 *
 * dockerode defaults to /var/run/docker.sock, which does not exist on a Colima host —
 * Colima exposes the daemon through its own socket. Probe in order of specificity.
 */
export function resolveDockerSocket(): string {
  const fromEnv = process.env.DOCKER_HOST;
  if (fromEnv?.startsWith('unix://')) return fromEnv.slice('unix://'.length);

  const candidates = [
    join(homedir(), '.colima', 'default', 'docker.sock'),
    join(homedir(), '.colima', 'docker.sock'),
    '/var/run/docker.sock',
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      `No Docker socket found. Tried:\n  ${candidates.join('\n  ')}\n` +
        'Is Colima running? Try: colima start',
    );
  }
  return found;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const config = {
  docker: {
    socketPath: resolveDockerSocket(),
    /** Label applied to every container we create, so cleanup can find orphans. */
    managedLabel: 'com.devlaunch.managed',
    sessionLabel: 'com.devlaunch.session',
    /**
     * User-defined network carrying the RFC1918 egress policy installed by
     * scripts/setup-network-policy.sh. If it does not exist the runner falls back to
     * the default bridge and says so — the policy is a hardening layer, not a
     * prerequisite for running at all.
     */
    networkName: process.env.DEVLAUNCH_NETWORK ?? 'devlaunch-net',
  },

  container: {
    memoryMb: intEnv('DEVLAUNCH_CONTAINER_MEMORY_MB', 1024),
    cpus: intEnv('DEVLAUNCH_CONTAINER_CPUS', 2),
    /** Fork-bomb ceiling. */
    pidsLimit: intEnv('DEVLAUNCH_CONTAINER_PIDS_LIMIT', 256),
    /** Non-root. Matches the `node` user baked into the runner image. */
    user: process.env.DEVLAUNCH_CONTAINER_USER ?? '1000:1000',

    /**
     * The only writable location, backed by an anonymous volume.
     *
     * It must be a volume rather than a rootfs directory for two reasons found by
     * testing: with ReadonlyRootfs the Docker API refuses `docker cp` into the rootfs
     * outright ("container rootfs is marked read-only"), and a volume over a path the
     * image does not pre-create mounts root-owned, which a non-root process cannot
     * write to. The runner image creates /workspace owned by `node` to solve both.
     */
    workspacePath: '/workspace',
    /** Wrapper lives inside the volume, since the rootfs cannot be written to. */
    wrapperPath: '/workspace/.devlaunch',
    /** npm needs scratch space, and the rootfs is read-only. */
    tmpSizeMb: intEnv('DEVLAUNCH_CONTAINER_TMP_MB', 64),
  },

  concurrency: {
    /** Colima is provisioned at 4 GB on an 8 GB host; a second container risks OOM. */
    maxSessions: intEnv('DEVLAUNCH_MAX_CONCURRENT_SESSIONS', 1),
  },

  /**
   * Two independent clocks. The original plan used one ~10 min budget, which would
   * have killed a READY application mid-use — see docs/planning-strategy.md.
   */
  timeouts: {
    cloneMs: intEnv('DEVLAUNCH_TIMEOUT_CLONE_MS', 120_000),
    installMs: intEnv('DEVLAUNCH_TIMEOUT_INSTALL_MS', 300_000),
    startMs: intEnv('DEVLAUNCH_TIMEOUT_START_MS', 120_000),
    readinessMs: intEnv('DEVLAUNCH_TIMEOUT_READINESS_MS', 60_000),
    /** Clone + install + build + start + readiness. */
    timeToReadyMs: intEnv('DEVLAUNCH_TIMEOUT_TIME_TO_READY_MS', 600_000),
    /** Starts once READY. */
    sessionIdleMs: intEnv('DEVLAUNCH_TIMEOUT_SESSION_IDLE_MS', 1_800_000),
    sessionHardCapMs: intEnv('DEVLAUNCH_TIMEOUT_SESSION_HARD_CAP_MS', 3_600_000),
    /** Grace period for SIGTERM before SIGKILL on stop. */
    stopGraceSec: intEnv('DEVLAUNCH_STOP_GRACE_SEC', 5),
  },

  /** Capped by bytes first, lines second — 10k lines of webpack output can exceed 50 MB. */
  logs: {
    maxBytes: intEnv('DEVLAUNCH_LOG_MAX_BYTES', 5 * 1024 * 1024),
    maxLines: intEnv('DEVLAUNCH_LOG_MAX_LINES', 10_000),
  },
} as const;
