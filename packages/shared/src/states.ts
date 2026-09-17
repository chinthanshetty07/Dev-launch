/**
 * Execution states. Extends §22 with AWAITING_INPUT, which the original plan lacked
 * entirely — both the env-var pre-flight gate and the monorepo package picker need a
 * "blocked on the user" state.
 */
export const ExecutionState = {
  QUEUED: 'QUEUED',
  CLONING: 'CLONING',
  ANALYZING: 'ANALYZING',
  PLANNING: 'PLANNING',
  VALIDATING: 'VALIDATING',
  /** Added: blocked awaiting user input (env vars, workspace choice). */
  AWAITING_INPUT: 'AWAITING_INPUT',
  BUILDING: 'BUILDING',
  STARTING: 'STARTING',
  WAITING_FOR_READY: 'WAITING_FOR_READY',
  READY: 'READY',
  FAILED: 'FAILED',
  REPAIRING: 'REPAIRING',
  CLEANING_UP: 'CLEANING_UP',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
} as const;

export type ExecutionState = (typeof ExecutionState)[keyof typeof ExecutionState];

/** States from which no further transition occurs. */
export const TERMINAL_STATES: readonly ExecutionState[] = [
  ExecutionState.COMPLETED,
  ExecutionState.CANCELLED,
  ExecutionState.FAILED,
];
