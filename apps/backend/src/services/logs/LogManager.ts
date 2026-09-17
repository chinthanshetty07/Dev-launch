import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type Dockerode from 'dockerode';
import { isSentinel } from '@devlaunch/shared';
import { LogBuffer, type LogEntry, type LogStream } from './LogBuffer.js';

/** Splits a byte stream into lines, carrying partial lines across chunk boundaries. */
class LineSplitter {
  private carry = '';

  push(chunk: Buffer, onLine: (line: string) => void): void {
    this.carry += chunk.toString('utf8');
    const parts = this.carry.split('\n');
    this.carry = parts.pop() ?? '';
    for (const line of parts) onLine(line.replace(/\r$/, ''));
  }

  flush(onLine: (line: string) => void): void {
    if (this.carry.length > 0) {
      onLine(this.carry);
      this.carry = '';
    }
  }
}

export interface LogManagerEvents {
  entry: (entry: LogEntry) => void;
  sentinel: (marker: string, ts: number) => void;
  end: () => void;
}

/**
 * Consumes Docker's multiplexed log stream, separates stdout from stderr, splits it
 * into lines, and routes each line to the buffer.
 *
 * Sentinel lines are DevLaunch control markers, not repository output: they are
 * emitted as `sentinel` events and kept out of the user-visible buffer.
 */
export class LogManager extends EventEmitter {
  readonly buffer: LogBuffer;
  private ended = false;

  constructor(buffer: LogBuffer = new LogBuffer()) {
    super();
    this.buffer = buffer;
  }

  /** Attach to a container's follow stream. Resolves when the stream closes. */
  attach(container: Dockerode.Container, stream: NodeJS.ReadableStream): Promise<void> {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const outSplit = new LineSplitter();
    const errSplit = new LineSplitter();

    stdout.on('data', (c: Buffer) => outSplit.push(c, (l) => this.ingest('stdout', l)));
    stderr.on('data', (c: Buffer) => errSplit.push(c, (l) => this.ingest('stderr', l)));

    // Docker frames stdout/stderr into one stream with an 8-byte header per chunk.
    container.modem.demuxStream(stream, stdout, stderr);

    return new Promise<void>((resolve) => {
      const finish = () => {
        if (this.ended) return;
        this.ended = true;
        outSplit.flush((l) => this.ingest('stdout', l));
        errSplit.flush((l) => this.ingest('stderr', l));
        this.emit('end');
        resolve();
      };
      stream.on('end', finish);
      stream.on('close', finish);
      stream.on('error', finish);
    });
  }

  private ingest(stream: LogStream, line: string): void {
    if (line.length === 0) return;
    const ts = Date.now();
    if (isSentinel(line)) {
      this.emit('sentinel', line.trim(), ts);
      return;
    }
    this.emit('entry', this.buffer.push(stream, line, ts));
  }
}
