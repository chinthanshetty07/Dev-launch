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

/**
 * The order states are reached in on the happy path.
 *
 * Lives here rather than in the UI because it is a property of the state machine: it is
 * what lets a consumer answer "how far did this session get" for a session that is no
 * longer advancing. `FAILED`, `CANCELLED`, `REPAIRING` and `CLEANING_UP` are absent on
 * purpose — none of them is a point of progress. `REPAIRING` in particular sends a
 * session *backwards* to `VALIDATING`, so the furthest point reached is a high-water
 * mark, never simply the current state.
 */
export const STATE_PROGRESSION: readonly ExecutionState[] = [
  'QUEUED',
  'CLONING',
  'ANALYZING',
  'PLANNING',
  'VALIDATING',
  'AWAITING_INPUT',
  'BUILDING',
  'STARTING',
  'WAITING_FOR_READY',
  'READY',
];

/** States from which no further transition occurs. */
export const TERMINAL_STATES: readonly ExecutionState[] = [
  ExecutionState.COMPLETED,
  ExecutionState.CANCELLED,
  ExecutionState.FAILED,
];
