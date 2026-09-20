import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { progressOf, type ExecutionState } from '@devlaunch/shared';
import { PipelineStrip } from './PipelineStrip';

/**
 * The chips as a person reads them: each stage's label and the mark in front of it.
 *
 * Asserting rendered output rather than the projection function means the wiring is
 * covered too — a correct projection rendered through the wrong prop would still be a
 * blank strip on screen, which is the bug this replaces.
 */
function chips(state: ExecutionState | 'IDLE', furthest?: ExecutionState | null): string[] {
  const html = renderToStaticMarkup(<PipelineStrip state={state} furthest={furthest} />);
  return [...html.matchAll(/<span class="w-4 text-center opacity-80">(.*?)<\/span>(.*?)<\/li>/g)].map(
    ([, mark, label]) => `${decode(mark!)} ${label!.trim()}`,
  );
}

/** React escapes the marks on the way out; compare what a reader actually sees. */
const decode = (s: string): string =>
  s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');

/** The colour classes carry the meaning, so a status change is visible in the markup. */
function colours(state: ExecutionState | 'IDLE', furthest?: ExecutionState | null): string[] {
  const html = renderToStaticMarkup(<PipelineStrip state={state} furthest={furthest} />);
  return [...html.matchAll(/text-\[13px\] (border-\S+?) /g)].map(([, cls]) => cls!);
}

describe('<PipelineStrip>', () => {
  it('renders every stage as pending before a session exists', () => {
    expect(chips('IDLE')).toEqual([
      '· Clone', '· Analyze', '· Plan', '· Validate', '· Start', '· Readiness', '· Ready',
    ]);
  });

  it('renders a ready session as complete', () => {
    expect(chips('READY', 'READY')).toEqual([
      'ok Clone', 'ok Analyze', 'ok Plan', 'ok Validate', 'ok Start', 'ok Readiness', '* Ready',
    ]);
  });

  it('keeps completed stages and marks where a failed session stopped', () => {
    // The defect: this rendered seven grey dots, so a run that died at startup looked
    // exactly like one that never began.
    expect(chips('FAILED', 'STARTING')).toEqual([
      'ok Clone', 'ok Analyze', 'ok Plan', 'ok Validate', '× Start', '· Readiness', '· Ready',
    ]);
    expect(colours('FAILED', 'STARTING')[4]).toBe('border-bad');
  });

  it('marks Start, not Readiness, when the container died installing', () => {
    // What a native-module build failure looked like before: Start ok, Readiness ×.
    expect(chips('FAILED', 'BUILDING')).toEqual([
      'ok Clone', 'ok Analyze', 'ok Plan', 'ok Validate', '× Start', '· Readiness', '· Ready',
    ]);
  });

  it('marks only the Ready chip when the application died after serving traffic', () => {
    expect(chips('FAILED', 'READY')).toEqual([
      'ok Clone', 'ok Analyze', 'ok Plan', 'ok Validate', 'ok Start', 'ok Readiness', '× Ready',
    ]);
  });

  it('keeps earned progress while a repair is in flight, and says so', () => {
    const html = renderToStaticMarkup(
      <PipelineStrip state={'REPAIRING' as ExecutionState} furthest={'WAITING_FOR_READY'} />,
    );
    expect(html).toContain('repairing');
    expect(chips('REPAIRING' as ExecutionState, 'WAITING_FOR_READY')).toEqual([
      'ok Clone', 'ok Analyze', 'ok Plan', 'ok Validate', 'ok Start', '» Readiness', '· Ready',
    ]);
  });

  it('shows the configuration gate as waiting rather than working', () => {
    expect(chips('AWAITING_INPUT', 'AWAITING_INPUT')[3]).toBe('? Validate');
    expect(colours('AWAITING_INPUT', 'AWAITING_INPUT')[3]).toBe('border-warn');
  });

  it('surfaces how the plan was produced, which is the hybrid design made visible', () => {
    const html = renderToStaticMarkup(
      <PipelineStrip state="READY" furthest="READY" planSource="rule-based" detected="express" />,
    );
    expect(html).toContain('plan: rule-based');
    expect(html).toContain('detected: express');
  });

  it('does not claim a detector matched when the AI planned it', () => {
    const html = renderToStaticMarkup(
      <PipelineStrip state="READY" furthest="READY" planSource="ai-fallback" detected={null} />,
    );
    expect(html).toContain('plan: ai-fallback');
    expect(html).not.toContain('detected:');
  });
});

describe('progressOf', () => {
  it('lets a failure inside the container overrule what the state machine saw', () => {
    // Install runs after the machine has moved on to WAITING_FOR_READY, so a session
    // that died compiling a native module was drawn as "Start ok, Readiness failed" —
    // two stages it never reached.
    expect(progressOf('WAITING_FOR_READY', { failure: { phase: 'install' } })).toBe('BUILDING');
    expect(progressOf('WAITING_FOR_READY', { failure: { phase: 'build' } })).toBe('BUILDING');
  });

  it('otherwise keeps the furthest point observed', () => {
    expect(progressOf('WAITING_FOR_READY', { failure: { phase: 'start' } })).toBe('WAITING_FOR_READY');
    expect(progressOf('STARTING', { readyAt: 1 })).toBe('READY');
    expect(progressOf(null, null)).toBeNull();
  });
});
