import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type Dockerode from 'dockerode';
import { isSentinel } from '@devlaunch/shared';
import { LogBuffer, type LogEntry, type LogStream } from './LogBuffer.js';

/**
 * ANSI escape sequences: colours, cursor movement, and the OSC sequences some tools
 * emit to set a terminal title.
 *
 * Stripped at ingestion rather than at render time, because the failure classifier
 * matches against this text. A line arriving as ESC[31mERROR would silently fail a
 * signature anchored on "ERROR", and the diagnosis would be lost.
 */
const ANSI = new RegExp(
  [
    '[\\u001B\\u009B][[\\]()#;?]*',
    '(?:',
    '(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*',
    '|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)',
    '|',
    '(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~])',
    ')',
  ].join(''),
  'g',
);

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

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
  /**
   * Where each sentinel fell in the log: the sequence number the next line will get.
   *
   * Sentinels never enter the buffer, so without this the log cannot say which phase a
   * line belongs to — and a start that failed was explained by an install-time line.
   * Husky's `git command not found`, printed by a successful install, was reported as
   * the reason `ng serve` would not run. The latest occurrence wins, so a repaired run
   * that reuses this log is divided by its own attempt's markers.
   */
  private readonly marks = new Map<string, number>();

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

  /**
   * Record a line that did not come from a container's stream, and tell listeners.
   *
   * `buffer.push` alone stores a line without emitting, so a connected client sees it
   * only on its next resume. Aggregated service output has to arrive live, which is the
   * whole point of a log stream.
   */
  write(stream: LogStream, text: string, ts = Date.now()): void {
    this.emit('entry', this.buffer.push(stream, text, ts));
  }

  /**
   * The log from a sentinel onwards, or all of it when that sentinel was never seen.
   *
   * A phase that failed failed after it began, so everything from its opening marker is
   * the part that can explain it.
   */
  since(sentinel: string): LogEntry[] {
    const from = this.marks.get(sentinel);
    const all = this.buffer.all();
    return from === undefined ? all : all.filter((e) => e.seq >= from);
  }

  private ingest(stream: LogStream, raw: string): void {
    const line = stripAnsi(raw);
    if (line.length === 0) return;
    const ts = Date.now();
    if (isSentinel(line)) {
      this.marks.set(line.trim(), this.buffer.stats.nextSeq);
      this.emit('sentinel', line.trim(), ts);
      return;
    }
    this.emit('entry', this.buffer.push(stream, line, ts));
  }
}
