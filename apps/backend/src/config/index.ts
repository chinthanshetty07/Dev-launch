import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Resolve the Docker socket.
 *
 * dockerode defaults to /var/run/docker.sock, which many engines do not use: Colima, Docker
 * Desktop on macOS and OrbStack each put theirs in the user's home. So, in order: an explicit
 * DOCKER_HOST; the engine the `docker` command itself is using (its current context — what
 * the person's own terminal talks to); then the usual places, first that exists.
 */
export function resolveDockerSocket(
  env: NodeJS.ProcessEnv = process.env,
  contextHost: () => string | null = currentContextHost,
  exists: (path: string) => boolean = existsSync,
): string {
  const fromEnv = env.DOCKER_HOST;
  if (fromEnv?.startsWith('unix://')) return fromEnv.slice('unix://'.length);

  const fromContext = contextHost();
  if (fromContext?.startsWith('unix://') && exists(fromContext.slice('unix://'.length))) {
    return fromContext.slice('unix://'.length);
  }

  const candidates = [
    join(homedir(), '.colima', 'default', 'docker.sock'),
    join(homedir(), '.colima', 'docker.sock'),
    join(homedir(), '.docker', 'run', 'docker.sock'),
    join(homedir(), '.orbstack', 'run', 'docker.sock'),
    '/var/run/docker.sock',
  ];
  const found = candidates.find((p) => exists(p));
  if (!found) {
    throw new Error(
      `No Docker socket found. Tried:\n  ${candidates.join('\n  ')}\n` +
        'Is Docker running? Start Docker Desktop, OrbStack or Colima (or the docker service on Linux), then try again.',
    );
  }
  return found;
}

/** The current `docker context`'s endpoint, or null when the docker command is not there. */
function currentContextHost(): string | null {
  try {
    return execFileSync('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch {
    return null;
  }
}

/** Any of the spellings a person reasonably expects to work. */
function boolProperty(name: string): boolean {
  return /^(?:1|true|yes|on)$/i.test(process.env[name] ?? '');
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
     * Prefix for the per-repository package cache volumes.
     *
     * Deliberately outlives a session: its whole purpose is to be there on the next run.
     * The prefix is what makes a stale one findable — `docker volume ls` shows them, and
     * removing one costs nothing but a slower first install.
     */
    cacheVolumePrefix: 'devlaunch-cache-',
    /** Marks a volume as a package cache rather than session state. */
    cacheLabel: 'com.devlaunch.cache',
    /**
     * Marks a volume as a session's workspace: the repository and what its install put
     * there, kept between the containers of one session so a restart need not install
     * again. Removed when the session ends; never shared between sessions.
     */
    workspaceLabel: 'com.devlaunch.workspace',
    workspaceVolumePrefix: 'devlaunch-ws-',
    /**
     * Identifies the process that created a container.
     *
     * Orphan sweeping matched on the managed label alone, which meant any DevLaunch
     * process removed every other one's containers — a developer running `pnpm start`
     * in one terminal and `pnpm test` in another had live containers destroyed
     * underneath them. Scoping by instance keeps a sweep to containers whose creator is
     * genuinely gone.
     */
    instanceLabel: 'com.devlaunch.instance',
    instanceId: randomUUID(),
    /**
     * User-defined network carrying the RFC1918 egress policy installed by
     * scripts/setup-network-policy.sh. If it does not exist the runner falls back to
     * the default bridge and says so — the policy is a hardening layer, not a
     * prerequisite for running at all.
     */
    networkName: process.env.DEVLAUNCH_NETWORK ?? 'devlaunch-net',
    /**
     * The VM cgroup every Dockerfile build runs under, capped at a process count and a
     * memory size by scripts/setup-network-policy.sh. The classic builder accepts no
     * process limit of its own, so without this a fork bomb in a `RUN` step fills the
     * VM's process table (verifier D-2).
     */
    buildCgroup: process.env.DEVLAUNCH_BUILD_CGROUP ?? 'devlaunch-build',
    /**
     * The same, where Docker uses the systemd cgroup driver (most Linux machines): there the
     * parent must be a systemd slice, whose limits the guard sets through systemd.
     */
    buildSlice: process.env.DEVLAUNCH_BUILD_SLICE ?? 'devlaunchbuild.slice',
    /**
     * Each run gets a network of its own, carved from this range, so two runs at once
     * cannot reach each other's databases or services by name (verifier D-8). The egress
     * rules installed by scripts/setup-network-policy.sh cover the whole range;
     * `networkName` above is one /24 inside it, kept for builds and the egress check.
     */
    runNetworkPool: process.env.DEVLAUNCH_NETWORK_POOL ?? '172.31.0.0/16',
    runNetworkPrefix: 'devlaunch-run-',
    runNetworkLabel: 'com.devlaunch.runnet',
  },

  container: {
    memoryMb: intEnv('DEVLAUNCH_CONTAINER_MEMORY_MB', 1024),
    /**
     * How far a single retry may raise that limit after an OOM kill.
     *
     * 1 GB is the right default — one container at a time on a 4 GB VM, with room for a
     * database beside it — and it is also simply too small for some real projects: a
     * Next.js dev build is killed by it every time. The ceiling is what keeps the retry
     * from trading a reported failure for a wedged VM.
     */
    memoryCeilingMb: intEnv('DEVLAUNCH_CONTAINER_MEMORY_CEILING_MB', 2048),
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
    /**
     * A requirements file DevLaunch generates from the repository's pyproject.toml, beside
     * the wrapper and copied after the repository for the same reason: a repository
     * cannot shadow it. Its content is derived at launch, never carried by a plan.
     */
    generatedRequirementsPath: '/workspace/.devlaunch/requirements.txt',
    /**
     * DevLaunch's static file server (`docker/staticServer.ts`), installed the same way and
     * for the same reason: a static site is served by a server DevLaunch chose.
     */
    staticServerPath: '/workspace/.devlaunch/serve.py',
    /** npm needs scratch space, and the rootfs is read-only. */
    tmpSizeMb: intEnv('DEVLAUNCH_CONTAINER_TMP_MB', 64),
  },

  concurrency: {
    /** Colima is provisioned at 4 GB on an 8 GB host; a second container risks OOM. */
    maxSessions: intEnv('DEVLAUNCH_MAX_CONCURRENT_SESSIONS', 1),
    /**
     * How many finished sessions to keep for inspection.
     *
     * Each retains its log buffer — up to 5 MB — so keeping them all would grow the
     * backend's memory without bound over a long-running process.
     */
    retainFinished: intEnv('DEVLAUNCH_RETAIN_FINISHED_SESSIONS', 10),
  },

  ai: {
    /**
     * How many times a failed plan may be rewritten before the original diagnosis stands.
     *
     * Two, and low on purpose. Repair is a model guessing at a plan from a log, and the
     * guesses do not converge: on a repository needing Postgres, attempt one reported a
     * missing setting, attempt two installed a database driver to satisfy a connection
     * string the model had itself invented, and attempt three broke a working async
     * driver by replacing it with a synchronous one. Each attempt was a confident answer
     * to the problem the previous attempt created, and a fourth would have been too.
     *
     * The cost is not only time. Every attempt reinstalls the dependency tree and pushes
     * the real first error further up a log a person has to scroll back through. Raising
     * this buys more guesses, not more accuracy — the failures worth fixing are the ones
     * that stop the guessing being necessary.
     */
    maxRepairAttempts: intEnv('DEVLAUNCH_MAX_REPAIR_ATTEMPTS', 2),
    /**
     * The DevLaunch AI relay (`relay/`): AI help for people with no Groq key of their own,
     * through the maintainer's key, which stays on the relay. Empty until one is deployed;
     * DEVLAUNCH_AI_RELAY_URL overrides it, and `off` turns it off (`AISettings`).
     */
    relayUrl: '',
  },

  /**
   * Whether DevLaunch may edit the repository it cloned.
   *
   * Off by default, and the default is the point. "Run this project" and "change this
   * project" are different promises, and a tool that quietly does the second while
   * claiming the first is one whose output you cannot trust. Without this, a loopback
   * address written into a config file is *found and named* — the file, the line, the
   * replacement — which costs nothing and is always right.
   *
   * It does not, however, run the project. Two shapes cannot be run any other way: a dev
   * server proxying to `http://localhost:8000` (resolved inside the frontend's own
   * container, where localhost is the frontend), and a Python database URL hardcoded to
   * localhost (which reads no variable, so there is nothing to inject). With this on,
   * those literals are rewritten in the clone — a temporary directory DevLaunch owns,
   * never anything the user has checked out — and every edit is logged in full.
   */
  rewriteSource: boolProperty('DEVLAUNCH_REWRITE_SOURCE'),

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
    /**
     * How long a session may sit in AWAITING_INPUT.
     *
     * Concurrency is 1, so a session nobody answers blocks the whole tool. Bounding it
     * means walking away never leaves DevLaunch permanently wedged.
     */
    awaitingInputMs: intEnv('DEVLAUNCH_TIMEOUT_AWAITING_INPUT_MS', 600_000),
    sessionHardCapMs: intEnv('DEVLAUNCH_TIMEOUT_SESSION_HARD_CAP_MS', 3_600_000),
    /**
     * How often a READY session re-checks that its container is still alive.
     *
     * Readiness is a measurement, not a promise: an application can be serving traffic
     * one minute and dead the next. Without this the session keeps reporting READY,
     * and hands out a URL that answers nothing, until the idle clock expires.
     */
    livenessMs: intEnv('DEVLAUNCH_TIMEOUT_LIVENESS_MS', 5_000),
    /**
     * How long a project's worker must stay up after it starts before it counts as running.
     *
     * A worker has no port to ask, so "it started and is still there a moment later" is
     * the evidence available. It used to be READY with no evidence at all.
     */
    workerGraceMs: intEnv('DEVLAUNCH_WORKER_GRACE_MS', 5_000),
    /**
     * How long a database gets to start accepting connections.
     *
     * Applications connect at boot and get one chance, so this is waited on before any
     * of them start. Mongo takes a few seconds cold; MySQL can take considerably longer
     * the first time it initialises its data directory.
     */
    backingReadyMs: intEnv('DEVLAUNCH_TIMEOUT_BACKING_READY_MS', 90_000),
    /** Grace period for SIGTERM before SIGKILL on stop. */
    stopGraceSec: intEnv('DEVLAUNCH_STOP_GRACE_SEC', 5),
  },

  /**
   * Repository intake limits. See docs/planning-strategy.md — "Repository intake".
   * A repository with gigabytes of LFS assets would exhaust the VM's disk long before
   * the clone timeout fired, so size is enforced during the clone, not after.
   */
  intake: {
    allowedHost: process.env.DEVLAUNCH_ALLOWED_GIT_HOST ?? 'github.com',
    maxBytes: intEnv('DEVLAUNCH_REPO_MAX_BYTES', 500 * 1024 * 1024),
    maxFiles: intEnv('DEVLAUNCH_REPO_MAX_FILES', 20_000),
    /** How often the growing clone is measured. */
    sizePollMs: intEnv('DEVLAUNCH_REPO_SIZE_POLL_MS', 750),
    /** Largest individual file the analyzer will read into memory. */
    maxReadBytes: intEnv('DEVLAUNCH_REPO_MAX_READ_BYTES', 512 * 1024),
  },

  /** Capped by bytes first, lines second — 10k lines of webpack output can exceed 50 MB. */
  logs: {
    maxBytes: intEnv('DEVLAUNCH_LOG_MAX_BYTES', 5 * 1024 * 1024),
    maxLines: intEnv('DEVLAUNCH_LOG_MAX_LINES', 10_000),
  },
} as const;
