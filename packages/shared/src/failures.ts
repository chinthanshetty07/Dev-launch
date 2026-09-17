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
}
