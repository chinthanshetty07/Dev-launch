import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ExecutionState } from '@devlaunch/shared';
import { RunHeader } from './RunHeader';

/**
 * The header's one job beyond saying what is happening: offering the way out of it.
 *
 * READY was the state that offered none. It counted as "finished", so the only control
 * was "Run another" — which cleared the view while the containers stayed up holding the
 * single session slot. The next launch was then refused with "a session is already
 * running", and stopping it meant finding that error banner and its Stop button. The
 * button existed; it was two screens from the application it would have stopped.
 */
function render(state: ExecutionState | 'IDLE') {
  return renderToStaticMarkup(
    <RunHeader
      state={state}
      repoUrl="https://github.com/o/r"
      startedAt={1000}
      readyAt={61_000}
      busy={false}
      onStop={() => undefined}
      onNew={() => undefined}
    />,
  );
}

describe('<RunHeader>', () => {
  it('offers a way to shut down an application that is still running', () => {
    const html = render('READY' as ExecutionState);
    expect(html).toMatch(/Shut down/);
    // Named for what it does. "Stop" on a finished run reads as stopping the run, which
    // already stopped; what is still running is the application it produced.
    expect(html).toMatch(/release the slot/i);
    // "Run another" is offered beside it now. It was kept out of here because it
    // orphaned the session: the view cleared, the containers kept running, and the next
    // launch was refused. That fact changed on 2026-10-06 — a new launch replaces the
    // running one, and the launch page names it before the click — so the button that
    // was a trap is now simply the way to the next repository.
    expect(html).toMatch(/Run another/);
    expect(html).toMatch(/running it stops this one/);
  });

  it('offers the same shut down for a project that is only partly running', () => {
    // It owns containers and holds the only slot exactly as a wholly ready one does.
    // The two states differ in what they promise, not in what there is to stop — and a
    // half-running project is the one somebody is most likely to want rid of.
    const html = render('PARTIALLY_READY' as ExecutionState);
    expect(html).toMatch(/Shut down/);
    expect(html).toMatch(/Run another/);
    // And it does not read as success.
    expect(html).toContain('text-warn');
  });

  it('still stops a run that has not finished', () => {
    for (const state of ['CLONING', 'BUILDING', 'WAITING_FOR_READY'] as ExecutionState[]) {
      expect(render(state), state).toMatch(/>Stop</);
    }
  });

  it('offers nothing to stop once there is nothing running', () => {
    for (const state of ['FAILED', 'CANCELLED', 'COMPLETED'] as ExecutionState[]) {
      const html = render(state);
      expect(html, state).not.toMatch(/>Stop</);
      expect(html, state).not.toMatch(/Shut down/);
      expect(html, state).toMatch(/Run another/);
    }
  });

  it('freezes the clock at READY rather than counting the application\'s uptime', () => {
    // A duration that keeps climbing while the application serves traffic is measuring
    // uptime, not how long the run took — and the number is captioned "elapsed".
    expect(render('READY' as ExecutionState)).toContain('1:00');
    // It stays frozen afterwards: a session shut down at READY still took a minute.
    expect(render('CANCELLED' as ExecutionState)).toContain('1:00');
  });

  it('says nothing about how long a run took when it never got there', () => {
    // Without a READY moment there is no duration to report, and the alternative is
    // worse than silence: a page opened an hour after a failure would claim the run
    // took an hour.
    const html = renderToStaticMarkup(
      <RunHeader
        state={'FAILED' as ExecutionState}
        startedAt={1000}
        busy={false}
        onStop={() => undefined}
        onNew={() => undefined}
      />,
    );
    expect(html).not.toMatch(/title="elapsed">\d/);
  });
});
