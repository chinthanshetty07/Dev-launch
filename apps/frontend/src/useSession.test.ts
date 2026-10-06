import { describe, it, expect } from 'vitest';
import { reconnectDelay } from './useSession';

/**
 * The log socket drops for two different reasons and only one of them is worth
 * reconnecting for. Getting that wrong is not a small bug: the page reconnected every
 * 1.2 seconds to a session the server had already closed, for as long as the tab stayed
 * open, because the only check it made read a `state` captured when the socket was
 * built — which is always `IDLE`.
 */
describe('whether a dropped log socket is worth reconnecting', () => {
  const at = (over: Partial<Parameters<typeof reconnectDelay>[0]> = {}) =>
    reconnectDelay({ closed: false, ended: false, state: 'STARTING', attempts: 1, ...over });

  it('reconnects while the session is still running', () => {
    expect(at()).toBeGreaterThan(0);
  });

  it('stops once the session has finished', () => {
    for (const state of ['FAILED', 'CANCELLED', 'COMPLETED'] as const) {
      expect(at({ state }), state).toBeNull();
    }
  });

  it('keeps following an application that is running', () => {
    // READY and PARTIALLY_READY used to count as finished, so a socket dropped by a
    // laptop sleep or a backend restart was never reconnected, and the page kept a green
    // READY over an application that had since died (audit A-14).
    for (const state of ['READY', 'PARTIALLY_READY'] as const) {
      expect(at({ state }), state).toBeGreaterThan(0);
    }
  });

  it('stops when the server said there is no more to come', () => {
    expect(at({ ended: true })).toBeNull();
  });

  it('stops when the socket has no owner any more', () => {
    expect(at({ closed: true })).toBeNull();
  });

  it('backs off rather than asking once a second', () => {
    expect(at({ attempts: 1 })).toBeLessThan(at({ attempts: 3 })!);
  });

  it('gives up rather than retrying a server that is gone for ever', () => {
    expect(at({ attempts: 99 })).toBeNull();
  });

  it('never waits longer than ten seconds', () => {
    expect(at({ attempts: 8 })).toBeLessThanOrEqual(10_000);
  });
});
