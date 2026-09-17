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
  },

  container: {
    memoryMb: intEnv('DEVLAUNCH_CONTAINER_MEMORY_MB', 1024),
    cpus: intEnv('DEVLAUNCH_CONTAINER_CPUS', 2),
    /** Writable mount point. Root filesystem is read-only from Phase 2 onward. */
    workspacePath: '/workspace',
    wrapperPath: '/devlaunch',
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
