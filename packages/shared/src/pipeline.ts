import { STATE_PROGRESSION, type ExecutionState } from './states.js';

/**
 * How the execution state machine is presented as a pipeline.
 *
 * Here rather than in the UI for the same reason `FailureDetail` carries its own
 * `remedy` prose: what a state *means to a person* is part of the contract, not a
 * rendering detail, and every client should answer "how far did this session get" the
 * same way. The UI supplies colour and layout; the projection is decided once.
 */

export type StageStatus = 'pending' | 'active' | 'done' | 'failed' | 'paused';

/** The pipeline as a user experiences it, which is coarser than the state machine. */
export const PIPELINE_STAGES = [
  { key: 'clone', label: 'Clone', states: ['CLONING'] },
  { key: 'analyze', label: 'Analyze', states: ['ANALYZING'] },
  { key: 'plan', label: 'Plan', states: ['PLANNING'] },
  { key: 'validate', label: 'Validate', states: ['VALIDATING', 'AWAITING_INPUT'] },
  { key: 'start', label: 'Start', states: ['BUILDING', 'STARTING'] },
  { key: 'readiness', label: 'Readiness', states: ['WAITING_FOR_READY'] },
] as const satisfies readonly { key: string; label: string; states: readonly ExecutionState[] }[];

const READY_INDEX = STATE_PROGRESSION.indexOf('READY');

const index = (state: string): number => STATE_PROGRESSION.indexOf(state as ExecutionState);

/**
 * How far a session got, as an index into `STATE_PROGRESSION`.
 *
 * The current state alone cannot answer this. `FAILED` is not a point on the pipeline,
 * so a failed session's current state says nothing about where it died — which is why
 * the caller supplies the furthest state it actually observed. `REPAIRING` is the same
 * problem in reverse: it sends the session back to `VALIDATING`, so a high-water mark
 * is the honest answer rather than the latest transition.
 */
export function progressIndex(
  state: ExecutionState | 'IDLE',
  furthest?: ExecutionState | null,
): number {
  return Math.max(index(state), furthest ? index(furthest) : -1);
}

/**
 * Status of one pipeline stage.
 *
 * A terminal failure marks the stage it stopped in — the single most useful thing the
 * strip can say, and what it previously threw away by greying every stage out.
 */
export function stageStatus(
  stageIndex: number,
  state: ExecutionState | 'IDLE',
  furthest?: ExecutionState | null,
): StageStatus {
  if (state === 'IDLE') return 'pending';

  const stage = PIPELINE_STAGES[stageIndex]!;
  const stageStart = index(stage.states[0]);
  const stageEnd = index(stage.states[stage.states.length - 1]!);
  const progress = progressIndex(state, furthest);

  // A completed session ran every stage by definition, whatever it is doing now.
  if (state === 'COMPLETED' && progress >= READY_INDEX) return 'done';

  if (progress > stageEnd) return 'done';
  if (progress < stageStart) return 'pending';

  // Progress sits inside this stage, so this is where the session is — or where it
  // stopped, which is the whole point of tracking a high-water mark.
  if (state === 'FAILED' || state === 'CANCELLED') return 'failed';
  if (state === 'AWAITING_INPUT') return 'paused';
  return 'active';
}

/**
 * Status of the terminal Ready chip.
 *
 * Separate because reaching READY and *staying* ready are different facts: an
 * application that died after serving traffic failed here and nowhere earlier, which is
 * exactly what the post-readiness liveness check exists to report.
 */
export function readyStatus(
  state: ExecutionState | 'IDLE',
  furthest?: ExecutionState | null,
): StageStatus {
  if (state === 'READY') return 'done';
  if (progressIndex(state, furthest) < READY_INDEX) return 'pending';
  if (state === 'FAILED' || state === 'CANCELLED') return 'failed';
  return 'done';
}

/** The fields of a session snapshot that imply how far it got. */
export interface ProgressEvidence {
  readyAt?: number;
  plan?: unknown;
  failure?: { phase?: 'install' | 'build' | 'start' } | null;
}

/**
 * The furthest point a session snapshot implies, for a client that arrived after the fact.
 *
 * A page loaded once a session has finished sees no transitions, so without this the
 * strip would show a completed run as having done nothing. Each of these fields can
 * only have been set by getting at least that far.
 */
export function impliedProgress(view: ProgressEvidence | null | undefined): ExecutionState | null {
  if (!view) return null;
  if (view.readyAt) return 'READY';
  const phase = view.failure?.phase;
  if (phase === 'start') return 'STARTING';
  if (phase === 'build' || phase === 'install') return 'BUILDING';
  if (view.plan) return 'VALIDATING';
  return null;
}

/** The later of two progression points, either of which may be absent. */
export function furthestOf(
  a: ExecutionState | null | undefined,
  b: ExecutionState | null | undefined,
): ExecutionState | null {
  const ia = a ? index(a) : -1;
  const ib = b ? index(b) : -1;
  if (ia < 0 && ib < 0) return null;
  return ia >= ib ? (a ?? null) : (b ?? null);
}
