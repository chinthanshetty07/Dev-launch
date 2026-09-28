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

/**
 * How far a session really got, for the strip.
 *
 * Install and build run *inside* the container, after the state machine has already
 * moved on to STARTING and WAITING_FOR_READY. So a session that died compiling a native
 * module was observed at WAITING_FOR_READY and drawn as "Start ok, Readiness failed" —
 * two stages it never reached. The failure's own phase knows better than the observed
 * state here, and it wins.
 */
export function progressOf(
  observed: ExecutionState | null | undefined,
  view: ProgressEvidence | null | undefined,
): ExecutionState | null {
  const phase = view?.failure?.phase;
  if (phase === 'install' || phase === 'build') return 'BUILDING';
  return furthestOf(observed, impliedProgress(view));
}

/**
 * What a session is doing, in a sentence a person who did not build this would follow.
 *
 * Lives beside the projection above and for the same reason: the state names are
 * internal vocabulary — `WAITING_FOR_READY` is precise and tells a first-time user
 * nothing about why they are staring at a spinner. Every client should say the same
 * thing, so it is decided once rather than re-invented in each one.
 */
export function describeState(state: ExecutionState | 'IDLE'): string {
  switch (state) {
    case 'IDLE':
      return 'Nothing running.';
    case 'QUEUED':
      return 'Queued, waiting for a free slot.';
    case 'CLONING':
      return 'Downloading the repository from GitHub.';
    case 'ANALYZING':
      return 'Reading its manifests to work out how it is put together.';
    case 'PLANNING':
      return 'Deciding how to install and start it.';
    case 'VALIDATING':
      return 'Checking the commands against the security allowlist.';
    case 'AWAITING_INPUT':
      return 'Waiting for you — this project needs something only you can supply.';
    case 'BUILDING':
      return 'Installing dependencies inside the container. This is usually the slowest step.';
    case 'STARTING':
      return 'Starting containers — any database this project needs, then installing its dependencies.';
    case 'WAITING_FOR_READY':
      return 'Started — waiting for it to open its port and answer.';
    case 'READY':
      return 'Running and answering requests.';
    case 'PARTIALLY_READY':
      return 'Partly running. Some services are serving; one is not.';
    case 'REPAIRING':
      return 'That did not work. Trying a corrected plan.';
    case 'CLEANING_UP':
      return 'Removing containers.';
    case 'COMPLETED':
      return 'Ran to completion and exited cleanly.';
    case 'FAILED':
      return 'Stopped. The diagnosis is below.';
    case 'CANCELLED':
      return 'Stopped at your request.';
  }
}
