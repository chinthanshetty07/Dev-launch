import { describe, it, expect } from 'vitest';
import {
  PIPELINE_STAGES,
  furthestOf,
  impliedProgress,
  readyStatus,
  stageStatus,
  type ExecutionState,
  type StageStatus,
} from '@devlaunch/shared';

const stage = (label: string): number => PIPELINE_STAGES.findIndex((s) => s.label === label);

/** Every stage's status in order, which is what the strip renders. */
const strip = (state: ExecutionState | 'IDLE', furthest?: ExecutionState | null): StageStatus[] => [
  ...PIPELINE_STAGES.map((_, i) => stageStatus(i, state, furthest)),
  readyStatus(state, furthest),
];

describe('pipeline projection', () => {
  it('shows nothing started before a session exists', () => {
    expect(strip('IDLE')).toEqual(['pending', 'pending', 'pending', 'pending', 'pending', 'pending', 'pending']);
  });

  it('marks the running stage active and everything before it done', () => {
    expect(strip('STARTING', 'STARTING')).toEqual([
      'done', 'done', 'done', 'done', 'active', 'pending', 'pending',
    ]);
  });

  it('marks the configuration gate paused rather than active', () => {
    // AWAITING_INPUT is not progress, it is DevLaunch waiting on a person. Rendering it
    // like any other running stage hides the fact that nothing will happen until the
    // user acts.
    expect(stageStatus(stage('Validate'), 'AWAITING_INPUT', 'AWAITING_INPUT')).toBe('paused');
  });

  it('keeps the stages a failed session completed, and marks where it stopped', () => {
    // The defect this replaces: every stage rendered 'pending' on failure, so a run that
    // died at startup was indistinguishable from one that never began. Where it stopped
    // is the single most useful thing the strip can say.
    expect(strip('FAILED', 'STARTING')).toEqual([
      'done', 'done', 'done', 'done', 'failed', 'pending', 'pending',
    ]);
  });

  it('attributes a failure to the readiness stage when the port never answered', () => {
    expect(strip('FAILED', 'WAITING_FOR_READY')).toEqual([
      'done', 'done', 'done', 'done', 'done', 'failed', 'pending',
    ]);
  });

  it('fails at the Ready chip when the application died after serving traffic', () => {
    // Every stage genuinely succeeded; the application then exited. Marking an earlier
    // stage would point at a step that worked — which is the same error as reporting
    // APPLICATION_EXITED as START_COMMAND_FAILED.
    expect(strip('FAILED', 'READY')).toEqual([
      'done', 'done', 'done', 'done', 'done', 'done', 'failed',
    ]);
  });

  it('marks a cancelled session at the point it was abandoned', () => {
    expect(strip('CANCELLED', 'AWAITING_INPUT')).toEqual([
      'done', 'done', 'done', 'failed', 'pending', 'pending', 'pending',
    ]);
  });

  it('does not lose earned progress while a repair is in flight', () => {
    // REPAIRING is not a point on the pipeline and sends the session backwards to
    // VALIDATING, so reading progress from the current state alone blanks the strip.
    expect(strip('REPAIRING', 'WAITING_FOR_READY')).toEqual([
      'done', 'done', 'done', 'done', 'done', 'active', 'pending',
    ]);
  });

  it('does not blank the strip while a session is cleaning up', () => {
    expect(stageStatus(stage('Clone'), 'CLEANING_UP', 'READY')).toBe('done');
  });

  it('shows a completed session as having run every stage', () => {
    expect(strip('COMPLETED', 'READY')).toEqual([
      'done', 'done', 'done', 'done', 'done', 'done', 'done',
    ]);
  });

  it('shows a ready session as ready', () => {
    expect(strip('READY', 'READY')).toEqual([
      'done', 'done', 'done', 'done', 'done', 'done', 'done',
    ]);
  });
});

describe('progress inferred from a snapshot', () => {
  it('infers nothing from an absent session', () => {
    expect(impliedProgress(null)).toBeNull();
    expect(impliedProgress(undefined)).toBeNull();
  });

  it('infers readiness from the moment it was recorded', () => {
    // A page opened after a session finished sees no transitions at all, so the snapshot
    // is the only evidence of how far it got.
    expect(impliedProgress({ readyAt: 1_700_000_000_000 })).toBe('READY');
  });

  it('infers the phase a failure was attributed to', () => {
    expect(impliedProgress({ failure: { phase: 'start' } })).toBe('STARTING');
    expect(impliedProgress({ failure: { phase: 'build' } })).toBe('BUILDING');
    expect(impliedProgress({ failure: { phase: 'install' } })).toBe('BUILDING');
  });

  it('infers that planning succeeded from the presence of a plan', () => {
    expect(impliedProgress({ plan: { startCommand: 'node server.js' } })).toBe('VALIDATING');
  });

  it('prefers the strongest evidence available', () => {
    expect(impliedProgress({ readyAt: 1, plan: {}, failure: { phase: 'start' } })).toBe('READY');
  });

  it('restores a failed run\'s progress from a snapshot alone', () => {
    // The reload case, end to end: no history, and the strip still shows where it died.
    const implied = impliedProgress({ failure: { phase: 'start' } });
    expect(strip('FAILED', implied)).toEqual([
      'done', 'done', 'done', 'done', 'failed', 'pending', 'pending',
    ]);
  });
});

describe('furthestOf', () => {
  it('never moves backwards', () => {
    expect(furthestOf('WAITING_FOR_READY', 'VALIDATING')).toBe('WAITING_FOR_READY');
    expect(furthestOf('VALIDATING', 'WAITING_FOR_READY')).toBe('WAITING_FOR_READY');
  });

  it('ignores states that are not points of progress', () => {
    // FAILED and REPAIRING are not on the progression, so neither can advance or reset
    // the mark.
    expect(furthestOf('STARTING', 'FAILED')).toBe('STARTING');
    expect(furthestOf('STARTING', 'REPAIRING')).toBe('STARTING');
  });

  it('returns null when neither side is a point of progress', () => {
    expect(furthestOf(null, undefined)).toBeNull();
    expect(furthestOf('FAILED', 'CLEANING_UP')).toBeNull();
  });
});
