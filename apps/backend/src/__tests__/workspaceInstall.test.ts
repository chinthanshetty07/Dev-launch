import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import type Dockerode from 'dockerode';
import { Sentinel } from '@devlaunch/shared';
import { waitForInstall } from '../services/execution/ProjectExecutor.js';
import { LogManager } from '../services/logs/LogManager.js';

/**
 * A workspace's packages reference each other as `workspace:*`, which no package manager
 * resolves for one package alone — so every service is given the *root* install, the
 * whole tree, once per service. They then ran at the same time, and a NestJS plus
 * Next.js monorepo needed more memory than the VM had: both containers were killed
 * mid-fetch, by DevLaunch's own limit.
 *
 * Every test here drives the real ingestion path — a Docker-framed stream through
 * `attach()` — rather than calling `buffer.push` or emitting `entry` by hand.
 *
 * That distinction is the whole reason these exist. The first version of them did poke
 * the buffer directly, and passed against a `waitForInstall` that could not work at all:
 * `LogManager.ingest` recognises a phase marker, emits it on the `sentinel` channel and
 * returns, so an install sentinel never becomes an `entry` and never reaches the buffer.
 * The feature fell through to its timeout every time, and the tests said it was fine.
 */

/** A log stream shaped exactly as Docker delivers one, header bytes and all. */
function dockerFramed(lines: string[]): { logs: LogManager; done: Promise<void> } {
  const logs = new LogManager();
  const stream = new PassThrough();
  const container = {
    modem: {
      demuxStream: (src: NodeJS.ReadableStream, out: PassThrough) => {
        src.on('data', (chunk: Buffer) => out.write(chunk));
        src.on('end', () => out.end());
      },
    },
  } as unknown as Dockerode.Container;

  const done = logs.attach(container, stream);
  for (const line of lines) stream.write(Buffer.from(`${line}\n`));
  return { logs, done, } as { logs: LogManager; done: Promise<void> };
}

describe('waiting for a service to finish installing', () => {
  const soon = { timeoutMs: 2000 };

  it('resolves when the install succeeds', async () => {
    const { logs } = dockerFramed([]);
    const waiting = waitForInstall(logs, soon);
    dockerFramedInto(logs, ['npm notice something', Sentinel.INSTALL_OK]);
    expect(await waiting).toBe('ok');
  });

  it('resolves when the install fails, because the next service still has to start', async () => {
    // A failed install is a finished install. Holding the siblings hostage to it would
    // turn one repository's broken dependency into a project that never starts at all.
    const { logs } = dockerFramed([]);
    const waiting = waitForInstall(logs, soon);
    dockerFramedInto(logs, [Sentinel.INSTALL_FAIL]);
    expect(await waiting).toBe('failed');
  });

  it('is not fooled by ordinary output that merely mentions installing', async () => {
    // Real installs print a great deal. Only the wrapper's own marker ends the wait.
    const { logs } = dockerFramed([]);
    const waiting = waitForInstall(logs, { timeoutMs: 400 });
    dockerFramedInto(logs, ['added 412 packages', 'install finished', 'done in 8s']);
    expect(await waiting).toBe('timeout');
  });

  it('gives up on a container that died mid-install', async () => {
    // No more output is coming, so the sentinel never arrives. Waiting the full budget
    // for a corpse delays every sibling behind it.
    const { logs } = dockerFramed([]);
    expect(await waitForInstall(logs, { timeoutMs: 30_000, hasExited: () => true })).toBe('exited');
  });

  it('asks asynchronously, because only Docker knows whether it died', async () => {
    // The first version asked our own bookkeeping, which is not written until readiness
    // — and readiness runs after the loop that does this waiting. A container killed
    // during its install therefore stayed "starting" for the full ten-minute budget.
    const { logs } = dockerFramed([]);
    expect(await waitForInstall(logs, { timeoutMs: 30_000, hasExited: async () => true }))
      .toBe('exited');
  });

  it('survives a liveness probe that throws, without leaving a rejection loose', async () => {
    // Inside a timer, an unhandled rejection is not a test failure — it is a process
    // that dies somewhere else, later. So the assertion has to be about the rejection
    // itself, not merely about this function returning.
    const seen: unknown[] = [];
    const watch = (reason: unknown): void => { seen.push(reason); };
    process.on('unhandledRejection', watch);
    try {
      const { logs } = dockerFramed([]);
      const outcome = await waitForInstall(logs, {
        timeoutMs: 400,
        hasExited: async () => { throw new Error('docker gone'); },
      });
      // Give any escaped rejection a turn to surface before judging.
      await new Promise((r) => setTimeout(r, 50));
      expect(outcome).toBe('timeout');
      expect(seen, 'a probe that throws must not escape the timer').toEqual([]);
    } finally {
      process.off('unhandledRejection', watch);
    }
  });

  it('stops waiting when the session is stopped, instead of for the whole install', async () => {
    // Audit A-05: a stop mid-launch left this waiting up to ten minutes.
    let stopped = false;
    const waiting = waitForInstall(new LogManager(), { timeoutMs: 60_000, cancelled: () => stopped });
    stopped = true;
    await expect(waiting).resolves.toBe('cancelled');
  });

  it('gives up rather than hanging when nothing is ever said', async () => {
    // A service with no install command prints no sentinel at all. Proceeding late beats
    // a project that never starts.
    const { logs } = dockerFramed([]);
    expect(await waitForInstall(logs, { timeoutMs: 60 })).toBe('timeout');
  });

  it('stops listening once it has an answer', async () => {
    // Otherwise every service leaves a listener on a stream that outlives it.
    const { logs } = dockerFramed([]);
    const waiting = waitForInstall(logs, soon);
    dockerFramedInto(logs, [Sentinel.INSTALL_OK]);
    await waiting;
    expect(logs.listenerCount('sentinel')).toBe(0);
  });
});

/** Feed more lines through the same real path, after a listener is attached. */
function dockerFramedInto(logs: LogManager, lines: string[]): void {
  const stream = new PassThrough();
  const container = {
    modem: {
      demuxStream: (src: NodeJS.ReadableStream, out: PassThrough) => {
        src.on('data', (chunk: Buffer) => out.write(chunk));
      },
    },
  } as unknown as Dockerode.Container;
  void logs.attach(container, stream);
  for (const line of lines) stream.write(Buffer.from(`${line}\n`));
}
