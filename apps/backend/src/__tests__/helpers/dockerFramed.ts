import { PassThrough } from 'node:stream';
import type Dockerode from 'dockerode';
import type { LogManager } from '../../services/logs/LogManager.js';

/**
 * Feed lines into a LogManager the way a container does.
 *
 * Tests that poke `logs.buffer` or call `logs.write` do not exercise this path at all:
 * `ingest` recognises a sentinel, emits it on its own channel and returns, so a sentinel
 * never reaches the buffer or the 'entry' listeners. A gate that listens for sentinels
 * therefore passes hand-written tests while being unable to work against a real
 * container — which is exactly what happened once, and why this helper exists.
 */
export function dockerFramedInto(logs: LogManager, lines: string[]): void {
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
