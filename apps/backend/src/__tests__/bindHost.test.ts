import { describe, it, expect } from 'vitest';
import {
  bindHost,
  cacheMaxAgeMs,
  isLoopback,
  recordUnhandled,
  recordedErrors,
} from '../server.js';

/**
 * The address the API listens on is a security boundary, not a preference.
 *
 * DevLaunch has no authentication — deliberately, because it is a single-user local
 * tool — and `POST /api/sessions` clones a URL and executes its contents. Those two
 * facts are only compatible while the port is unreachable from anywhere else, and for
 * the whole life of the project it was reachable: `http.listen(port)` with no host binds
 * `::`, and a verification confirmed `curl http://192.168.0.2:3939/api/health` → 200
 * from another machine on the LAN.
 */
describe('the address the server binds', () => {
  it('is loopback when nothing asks otherwise', () => {
    expect(bindHost({})).toBe('127.0.0.1');
  });

  it('is loopback when the variable is present but empty', () => {
    // `DEVLAUNCH_HOST=` in a .env file, or an unset shell variable expanded into one.
    // Treating that as "bind everything" would make the dangerous case the easy typo.
    expect(bindHost({ DEVLAUNCH_HOST: '' })).toBe('127.0.0.1');
    expect(bindHost({ DEVLAUNCH_HOST: '   ' })).toBe('127.0.0.1');
  });

  it('honours an explicit request, because some setups genuinely need it', () => {
    // A devcontainer, a VM, a remote workstation. The point is not to forbid it but to
    // make it a decision somebody took rather than the default nobody chose.
    expect(bindHost({ DEVLAUNCH_HOST: '0.0.0.0' })).toBe('0.0.0.0');
    expect(bindHost({ DEVLAUNCH_HOST: ' 192.168.0.2 ' })).toBe('192.168.0.2');
  });

  it('knows which addresses reach only this machine', () => {
    // Drives the startup warning. `0.0.0.0` and `::` are the two that look like an
    // address and mean "everything", which is exactly how this was missed.
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('localhost')).toBe(true);
    expect(isLoopback('::1')).toBe(true);
    expect(isLoopback('0.0.0.0')).toBe(false);
    expect(isLoopback('::')).toBe(false);
    expect(isLoopback('192.168.0.2')).toBe(false);
  });
});

/**
 * How long a package cache is kept.
 *
 * Read here rather than from `config/index.ts` for two reasons, and a verifier found
 * both. That module is evaluated before `loadDotEnv()`, so a value read there honours an
 * exported shell variable and silently ignores the same line in `.env`. And `intEnv`
 * substitutes its default for anything `<= 0`, so a documented "zero disables it" would
 * have quietly meant fourteen days — a knob that does nothing.
 */
describe('how long a package cache is kept', () => {
  const DAYS = 24 * 60 * 60 * 1000;

  it('defaults to a fortnight', () => {
    expect(cacheMaxAgeMs({})).toBe(14 * DAYS);
  });

  it('can actually be disabled, which is the whole point of documenting it', () => {
    // `intEnv` would have turned this into 14 days. A reaper that cannot be turned off
    // is a reaper somebody discovers by losing a cache they wanted.
    expect(cacheMaxAgeMs({ DEVLAUNCH_CACHE_MAX_AGE_DAYS: '0' })).toBe(0);
  });

  it('honours a number', () => {
    expect(cacheMaxAgeMs({ DEVLAUNCH_CACHE_MAX_AGE_DAYS: '3' })).toBe(3 * DAYS);
  });

  it('falls back rather than guessing at nonsense', () => {
    // Empty, unparseable, or negative. None of them is a request for anything, and
    // reading `-1` as "disabled" would be inventing a meaning nobody wrote down.
    for (const raw of ['', '   ', 'soon', '-1']) {
      expect(cacheMaxAgeMs({ DEVLAUNCH_CACHE_MAX_AGE_DAYS: raw }), raw).toBe(14 * DAYS);
    }
  });
});

/**
 * Installing an `unhandledRejection` listener suppresses Node's default, which is to
 * print the stack and exit. The first version of this replaced that with one
 * `console.error` and called it "recorded", which made a crash quieter rather than more
 * durable. The reason has to end up somewhere a person will look.
 */
describe('a failure nothing caught', () => {
  it('is kept where health can show it', () => {
    const before = recordedErrors().length;
    recordUnhandled(new Error('the step blew up'));
    const after = recordedErrors();
    expect(after.length).toBe(before + 1);
    expect(after.at(-1)!.detail).toMatch(/the step blew up/);
    expect(after.at(-1)!.at).toBeLessThanOrEqual(Date.now());
  });

  it('keeps the stack, which is the part worth having', () => {
    recordUnhandled(new Error('with a stack'));
    expect(recordedErrors().at(-1)!.detail).toMatch(/at /);
  });

  it('survives a rejection that is not an Error at all', () => {
    // `Promise.reject('nope')` is legal and common in other people's code.
    recordUnhandled('just a string');
    expect(recordedErrors().at(-1)!.detail).toBe('just a string');
  });

  it('is bounded, because an unbounded record of failures is a leak', () => {
    for (let i = 0; i < 40; i++) recordUnhandled(new Error(`boom ${i}`));
    expect(recordedErrors().length).toBeLessThanOrEqual(20);
    // And it keeps the newest, which are the ones being investigated.
    expect(recordedErrors().at(-1)!.detail).toMatch(/boom 39/);
  });
});
