/**
 * Failure taxonomy. Extends the original plan's §17 with four classes added during
 * design review — see docs/planning-strategy.md.
 */
export const FailureCode = {
  MISSING_ENV: 'MISSING_ENV',
  WRONG_RUNTIME_VERSION: 'WRONG_RUNTIME_VERSION',
  DEPENDENCY_INSTALL_FAILED: 'DEPENDENCY_INSTALL_FAILED',
  BUILD_FAILED: 'BUILD_FAILED',
  START_COMMAND_FAILED: 'START_COMMAND_FAILED',
  /**
   * The repository imports one of its own files by a path that is not there.
   *
   * Split out of START_COMMAND_FAILED because the two have opposite answers. A *bare*
   * specifier that cannot be found is a dependency, and installing it is a plan change
   * a rule can make. A *relative* one — `require('./routes/users')` in a repository
   * whose file is `users.js` at the root — is the repository being wrong about itself,
   * and no plan reaches it. Conflated, it cost a model call per occurrence, and the
   * model answered by inventing `npm run serve`, a script that does not exist.
   */
  BROKEN_IMPORT: 'BROKEN_IMPORT',
  PORT_NOT_LISTENING: 'PORT_NOT_LISTENING',
  /** Added: app bound 127.0.0.1 inside the container, so port mapping resolves to
   *  nothing. Distinct from PORT_NOT_LISTENING because the remedy differs entirely. */
  PORT_BOUND_TO_LOCALHOST: 'PORT_BOUND_TO_LOCALHOST',
  APPLICATION_UNHEALTHY: 'APPLICATION_UNHEALTHY',
  READINESS_TIMEOUT: 'READINESS_TIMEOUT',
  DATABASE_REQUIRED: 'DATABASE_REQUIRED',
  NETWORK_FAILURE: 'NETWORK_FAILURE',
  PROCESS_TIMEOUT: 'PROCESS_TIMEOUT',
  UNSUPPORTED_PROJECT: 'UNSUPPORTED_PROJECT',
  INVALID_AI_PLAN: 'INVALID_AI_PLAN',
  /** Added: a structurally valid plan carrying a command the allowlist rejects. */
  PLAN_REJECTED_UNSAFE_COMMAND: 'PLAN_REJECTED_UNSAFE_COMMAND',
  /** Added: x86-only native dependency on an arm64 host; no emulation in v1. */
  ARCH_INCOMPATIBLE: 'ARCH_INCOMPATIBLE',
  /** Added: repository exceeded the intake size or file-count cap. */
  REPOSITORY_TOO_LARGE: 'REPOSITORY_TOO_LARGE',
  /**
   * Added: the kernel killed the process for exceeding the container's memory limit.
   * Distinct because the remedy is a configuration change, not a code fix, and on a
   * 1 GB ceiling a React install reaches it routinely.
   */
  OUT_OF_MEMORY: 'OUT_OF_MEMORY',
  /**
   * Added: the application exited *after* it had been reported ready.
   *
   * Distinct from START_COMMAND_FAILED, which means it never started at all. The
   * remedy differs: the command was right, and the interesting evidence is the tail of
   * the log rather than the plan.
   */
  APPLICATION_EXITED: 'APPLICATION_EXITED',
  /**
   * Added: the project drives Docker itself, and the sandbox does not hand it the
   * daemon.
   *
   * Distinct because no configuration fixes it. Every other failure here is a thing the
   * user could supply, change or retry; this one says the project cannot run inside a
   * container that withholds the socket — and withholding it is the point, since
   * mounting it would give any repository root on the host.
   */
  DOCKER_SOCKET_REQUIRED: 'DOCKER_SOCKET_REQUIRED',
  CONTAINER_CREATE_FAILED: 'CONTAINER_CREATE_FAILED',
  UNKNOWN_RUNTIME_ERROR: 'UNKNOWN_RUNTIME_ERROR',
} as const;

export type FailureCode = (typeof FailureCode)[keyof typeof FailureCode];

export interface FailureDetail {
  code: FailureCode;
  message: string;
  exitCode?: number;
  phase?: 'install' | 'build' | 'start';
  /** The log line that decided the classification, so a verdict can be checked. */
  evidence?: string;
  /** What the user can actually do about it. */
  remedy?: string;
  /**
   * 'high' means a signature matched. 'low' means this is the fallback and the message
   * is a guess — saying so is better than implying a diagnosis we do not have.
   */
  confidence?: 'high' | 'medium' | 'low';
  /**
   * Repair attempts made *after* this diagnosis was taken.
   *
   * The first diagnosis is kept because it describes the repository as it was written,
   * where every later one describes a plan the model invented. The cost is that the plan
   * on screen is then not the plan this failure came from: a dashboard showed
   * `uvicorn --port 8080` beside "Nothing is listening on port 8000" with nothing to
   * connect them, which reads as the tool contradicting itself and is why a person
   * retries rather than reads.
   */
  repairAttemptsAfter?: number;
  /**
   * The socket the application actually opened, read from the container's own
   * `/proc/net/tcp`.
   *
   * Carried as a field rather than left in the prose so a repair rule can act on it
   * without parsing English. It is the strongest evidence available about a port: not
   * what a framework defaults to, not what a log line claims, but what the kernel says
   * the process bound.
   */
  observedSocket?: { address: string; port: number; loopbackOnly: boolean };
  /**
   * For a runtime-version failure, which way the runtime is wrong, when the evidence says.
   *
   * The repair for WRONG_RUNTIME_VERSION moves to the next newer approved image, which is
   * the right answer to a missing built-in and the wrong one to a runtime that is too
   * *new*: webpack 4's `md4` hash fails under OpenSSL 3, on Node 22 exactly as on 20. A
   * field, like `observedSocket`, so the rule acts on a fact rather than on prose.
   */
  runtimeDirection?: 'older' | 'newer';
  /**
   * For `OUT_OF_MEMORY`: which memory, the limit it ran under, and how that was known.
   *
   * `container` is the kernel killing a process at the container's cgroup limit — Docker's
   * `OOMKilled`, or a SIGKILL where that cannot be read — and is answered with a larger
   * limit. `node-heap` is V8 refusing to grow its own heap while the container still had
   * room, and is answered with a larger heap. On the final failure, `maximumMb`,
   * `attempts` and `retryable: false` say that the policy has been exhausted.
   */
  memory?: {
    kind: 'container' | 'node-heap';
    limitMb: number;
    detectedBy: string[];
    maximumMb?: number;
    attempts?: number;
    retryable?: boolean;
    nodeHeapMb?: number;
  };
}

/**
 * One run of a service's container, kept across retries so the history is readable.
 *
 * Every launch is an attempt — the first, a memory raise, a repaired plan — and each
 * records what it ran under and how it ended, so a session that took three tries says
 * which three and why, instead of showing only the last.
 */
export interface LaunchAttempt {
  /** The service, in a project; absent for a single-service run. */
  service?: string;
  attempt: number;
  memoryMb: number;
  nodeHeapMb?: number;
  installCommand: string | null;
  startedAt: number;
  durationMs?: number;
  /** The phase the attempt ended in, once it has ended. */
  phase?: 'install' | 'build' | 'start' | 'none';
  /** `ok` once ready or completed; a failure code otherwise; absent while running. */
  result?: 'ok' | FailureCode;
  detectedBy?: string[];
}

/**
 * How a service's install went, in one line of structure: what ran, how many launches it
 * took, and the memory it started with, ended with and could at most have had.
 */
export interface InstallSummary {
  service?: string;
  packageManager: string;
  installCommand: string | null;
  attempts: number;
  memory: { initialMb: number; finalMb: number; maximumMb: number | null };
  result: 'success' | 'running' | FailureCode;
  /** The phase the last attempt ended in, when it failed. */
  phase?: 'install' | 'build' | 'start' | 'none';
}

/**
 * What can be done about a failure, decided before anything is tried.
 *
 * Every failure used to be a generic AI repair task, which spent model calls on things
 * a model cannot fix — a missing secret, a network outage, a memory ceiling — and left
 * fewer for the ones it can. The policy is decided from the failure class alone.
 */
export type Repairability = 'NON_REPAIRABLE' | 'DETERMINISTIC' | 'AI_ONLY';

export type RepairType =
  | 'START_COMMAND_CORRECTION'
  | 'PORT_CORRECTION'
  | 'HOST_BINDING_CORRECTION'
  | 'HEALTHCHECK_CORRECTION'
  /**
   * The container was given more memory and started again.
   *
   * The odd one out: every other repair changes the plan, and this one changes nothing
   * about it. It belongs here anyway, because a person looking at why a run took two
   * attempts deserves the same account of this as of any other — and because the thing
   * that was wrong was DevLaunch's configuration rather than their repository.
   */
  | 'MEMORY_LIMIT_RAISED'
  /** Node was given a larger heap inside the same container, after a V8 heap OOM. */
  | 'NODE_HEAP_RAISED'
  | 'PLAN_REWRITE';

/**
 * One repair that was tried, with the evidence that justified it.
 *
 * Typed and kept, so a person reading a failed session can see what was changed, why,
 * and whether a model or a rule decided it — rather than a plan that silently differs
 * from the one that was planned.
 */
export interface RepairRecord {
  source: 'deterministic' | 'ai';
  type: RepairType;
  /** The failure this repair answered. */
  failureCode: FailureCode;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  /** Facts from the log or the repository that justified the change. */
  evidence: string[];
  confidence: 'high' | 'medium' | 'low';
  /** The model's own account, when a model decided. Displayed, never acted on. */
  note?: string;
  /**
   * Which service was repaired, in a project that runs several.
   *
   * Absent for a single-service run, where there is nothing to disambiguate. Present
   * otherwise because "the start command was corrected" says nothing useful when four
   * applications are running and three of them were already working.
   */
  service?: string;
}
