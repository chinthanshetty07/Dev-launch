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
  /**
   * Some services are serving traffic and at least one is not.
   *
   * Added because the alternative was throwing working containers away. A project whose
   * API fails its start command went straight to FAILED and teardown — taking down a
   * frontend that had been serving for a minute, for a reason that had nothing to do
   * with it. Real repositories fail this way constantly: one service has a broken
   * import, a missing dependency, a requirement that does not exist on PyPI, and the
   * rest are fine.
   *
   * Not terminal, because it is not finished: the containers are up, the URLs answer,
   * the slot is held, and the failed service can be restarted once its repository is
   * fixed. Distinct from READY because a person given a green light and a URL will
   * assume the thing works, and distinct from FAILED because something does.
   */
  PARTIALLY_READY: 'PARTIALLY_READY',
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

/**
 * States in which the session owns running containers and holds the slot.
 *
 * READY and PARTIALLY_READY differ in what they promise and not at all in what they
 * own, and every caller that asks "is there something running to stop, watch or time
 * out" wants both. Keeping the list here rather than repeating the pair is what stops
 * the second one being forgotten in the fifth place that checks.
 */
export const SERVING_STATES: readonly ExecutionState[] = [
  ExecutionState.READY,
  ExecutionState.PARTIALLY_READY,
];

/** States from which no further transition occurs. */
export const TERMINAL_STATES: readonly ExecutionState[] = [
  ExecutionState.COMPLETED,
  ExecutionState.CANCELLED,
  ExecutionState.FAILED,
];
