import { FailureCode, type FailureDetail } from './failures.js';

/**
 * Where a failure belongs, and what can be done about it.
 *
 * `FailureCode` names *what* happened. A person — and any client of the API — also needs to
 * know *whose* it is (the repository's, the user's configuration, this machine, DevLaunch
 * itself), whether trying again could change the outcome, and what to do next. That used to
 * be implied by prose in each failure's remedy; it is one table now, so every failure carries
 * the same three answers and a new code cannot be added without giving them.
 */
export type FailureCategory =
  | 'GIT_ERROR'
  | 'DETECTION_ERROR'
  | 'RUNTIME_ERROR'
  | 'DEPENDENCY_ERROR'
  | 'OOM_ERROR'
  | 'BUILD_ERROR'
  | 'PORT_ERROR'
  | 'DATABASE_ERROR'
  | 'ENV_ERROR'
  | 'STARTUP_ERROR'
  | 'HEALTHCHECK_ERROR'
  | 'SECURITY_ERROR'
  | 'TIMEOUT_ERROR'
  | 'USER_CONFIGURATION_ERROR'
  | 'UNSUPPORTED_PROJECT';

export interface FailureTaxonomy {
  category: FailureCategory;
  /** Whether running the same thing again can succeed without anything changing. */
  retryable: boolean;
  /**
   * Whether DevLaunch itself can recover from it — by a rule repair, a memory raise, or
   * an input the user gives — as opposed to needing a change to the repository or machine.
   */
  recoverable: boolean;
  /** What to do next, when the failure's own remedy does not say something more specific. */
  suggestedAction: string;
}

export const FAILURE_TAXONOMY: Readonly<Record<FailureCode, FailureTaxonomy>> = Object.freeze({
  MISSING_ENV: {
    category: 'USER_CONFIGURATION_ERROR', retryable: false, recoverable: true,
    suggestedAction: 'Supply the variables named in the failure, then launch again.',
  },
  WRONG_RUNTIME_VERSION: {
    category: 'RUNTIME_ERROR', retryable: false, recoverable: true,
    suggestedAction: 'DevLaunch retries on the other Node it ships when that can help; otherwise the repository needs a runtime DevLaunch does not have.',
  },
  DEPENDENCY_INSTALL_FAILED: {
    category: 'DEPENDENCY_ERROR', retryable: false, recoverable: true,
    suggestedAction: 'Read the quoted install error. A stale lockfile is relaxed automatically; a missing or unbuildable package needs the repository fixed.',
  },
  BUILD_FAILED: {
    category: 'BUILD_ERROR', retryable: false, recoverable: false,
    suggestedAction: 'The build step failed in the repository’s own code or configuration; read the quoted error.',
  },
  START_COMMAND_FAILED: {
    category: 'STARTUP_ERROR', retryable: false, recoverable: true,
    suggestedAction: 'Read the quoted error. DevLaunch corrects a wrong script or a ts-node type check by rule; anything else is in the repository.',
  },
  BROKEN_IMPORT: {
    category: 'STARTUP_ERROR', retryable: false, recoverable: false,
    suggestedAction: 'The repository imports one of its own files by a path that is not there — often a case mismatch that works on macOS. Fix the import.',
  },
  PORT_NOT_LISTENING: {
    category: 'PORT_ERROR', retryable: false, recoverable: true,
    suggestedAction: 'DevLaunch moves to the port the application actually opened when it can see one; otherwise read the application’s last output.',
  },
  PORT_BOUND_TO_LOCALHOST: {
    category: 'PORT_ERROR', retryable: false, recoverable: true,
    suggestedAction: 'The application listens on localhost only. DevLaunch rebinds it when the address is configuration; a literal in the source needs editing.',
  },
  APPLICATION_UNHEALTHY: {
    category: 'HEALTHCHECK_ERROR', retryable: true, recoverable: false,
    suggestedAction: 'The application started but failed its health or smoke checks; the failing check is named in the evidence.',
  },
  READINESS_TIMEOUT: {
    category: 'TIMEOUT_ERROR', retryable: true, recoverable: false,
    suggestedAction: 'Nothing answered in time. A very large install or a slow first build may need DEVLAUNCH_TIMEOUT_TIME_TO_READY_MS raised.',
  },
  DATABASE_REQUIRED: {
    category: 'DATABASE_ERROR', retryable: false, recoverable: false,
    suggestedAction: 'The application needs a database or service DevLaunch could not provide or reach; the evidence names it.',
  },
  NETWORK_FAILURE: {
    category: 'GIT_ERROR', retryable: true, recoverable: false,
    suggestedAction: 'Check the URL and that the repository is public, and that this machine is online; then retry.',
  },
  PROCESS_TIMEOUT: {
    category: 'TIMEOUT_ERROR', retryable: true, recoverable: false,
    suggestedAction: 'An operation exceeded its time limit; retry, or raise the matching DEVLAUNCH_TIMEOUT_* setting.',
  },
  UNSUPPORTED_PROJECT: {
    category: 'UNSUPPORTED_PROJECT', retryable: false, recoverable: false,
    suggestedAction: 'This repository is outside what DevLaunch can run; the message says exactly why.',
  },
  INVALID_AI_PLAN: {
    category: 'DETECTION_ERROR', retryable: true, recoverable: false,
    suggestedAction: 'No rule matched and the model’s plan was unusable. Retrying may produce a different plan.',
  },
  PLAN_REJECTED_UNSAFE_COMMAND: {
    category: 'SECURITY_ERROR', retryable: false, recoverable: false,
    suggestedAction: 'A plan asked for something the sandbox refuses; nothing was run.',
  },
  ARCH_INCOMPATIBLE: {
    category: 'RUNTIME_ERROR', retryable: false, recoverable: false,
    suggestedAction: 'A dependency has no build for this machine’s CPU (arm64); the repository needs a version that does.',
  },
  REPOSITORY_TOO_LARGE: {
    category: 'GIT_ERROR', retryable: false, recoverable: false,
    suggestedAction: 'The repository exceeds the intake limit; raise DEVLAUNCH_MAX_REPO_BYTES / DEVLAUNCH_MAX_REPO_FILES if that is intended.',
  },
  OUT_OF_MEMORY: {
    category: 'OOM_ERROR', retryable: false, recoverable: true,
    suggestedAction: 'DevLaunch retries with more memory up to what the VM can give; past that, give the Docker VM more memory.',
  },
  APPLICATION_EXITED: {
    category: 'STARTUP_ERROR', retryable: true, recoverable: false,
    suggestedAction: 'The application started and then stopped; its last output is quoted.',
  },
  DOCKER_SOCKET_REQUIRED: {
    category: 'UNSUPPORTED_PROJECT', retryable: false, recoverable: false,
    suggestedAction: 'The application needs the Docker socket, which DevLaunch never gives a container.',
  },
  CONTAINER_CREATE_FAILED: {
    category: 'RUNTIME_ERROR', retryable: true, recoverable: false,
    suggestedAction: 'Docker could not create the container. Run `./devlaunch doctor` to check Docker and the runner images, then retry.',
  },
  UNKNOWN_RUNTIME_ERROR: {
    category: 'STARTUP_ERROR', retryable: true, recoverable: false,
    suggestedAction: 'No known cause matched. The quoted output is the best evidence there is; retrying may help if it was transient.',
  },
} satisfies Record<FailureCode, FailureTaxonomy>);

/** A failure as an API returns it: what happened, whose it is, and what to do. */
export interface DescribedFailure extends FailureTaxonomy {
  code: FailureCode;
  message: string;
  phase?: FailureDetail['phase'];
  evidence?: string;
  service?: string;
}

/** `failure` with its taxonomy; its own remedy, when it has one, is the suggested action. */
export function describeFailure(failure: FailureDetail & { service?: string }): DescribedFailure {
  const t = FAILURE_TAXONOMY[failure.code] ?? FAILURE_TAXONOMY.UNSUPPORTED_PROJECT;
  return {
    code: failure.code,
    message: failure.message,
    category: t.category,
    retryable: t.retryable,
    recoverable: t.recoverable,
    suggestedAction: failure.remedy ?? t.suggestedAction,
    ...(failure.phase ? { phase: failure.phase } : {}),
    ...(failure.evidence ? { evidence: failure.evidence } : {}),
    ...(failure.service ? { service: failure.service } : {}),
  };
}
