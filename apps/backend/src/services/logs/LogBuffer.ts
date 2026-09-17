import { config } from '../../config/index.js';

export type LogStream = 'stdout' | 'stderr';

export interface LogEntry {
  seq: number;
  ts: number;
  stream: LogStream;
  text: string;
}

export interface LogSlice {
  entries: LogEntry[];
  /** True when entries the caller asked for were already evicted. */
  gap: boolean;
  droppedTotal: number;
}

/**
 * Bounded ring buffer for container output.
 *
 * Capped by **bytes first, lines second**. The original plan specified "last 10,000
 * lines", but a webpack build can emit 10k lines exceeding 50 MB — a line-only cap is
 * an OOM in our own backend on a 4 GB VM.
 *
 * Every entry carries a monotonic sequence number so a reconnecting WebSocket client
 * can resume precisely, and so eviction is detectable rather than silent.
 */
export class LogBuffer {
  private entries: LogEntry[] = [];
  private bytes = 0;
  private nextSeq = 0;
  private droppedTotal = 0;

  constructor(
    private readonly maxBytes: number = config.logs.maxBytes,
    private readonly maxLines: number = config.logs.maxLines,
  ) {}

  push(stream: LogStream, text: string, ts: number = Date.now()): LogEntry {
    const entry: LogEntry = { seq: this.nextSeq++, ts, stream, text };
    this.entries.push(entry);
    this.bytes += Buffer.byteLength(text, 'utf8');
    this.evict();
    return entry;
  }

  private evict(): void {
    while (
      this.entries.length > 0 &&
      (this.bytes > this.maxBytes || this.entries.length > this.maxLines)
    ) {
      const removed = this.entries.shift()!;
      this.bytes -= Buffer.byteLength(removed.text, 'utf8');
      this.droppedTotal++;
    }
  }

  /** Entries strictly after `afterSeq`. Pass -1 for everything retained. */
  since(afterSeq: number): LogSlice {
    const entries = this.entries.filter((e) => e.seq > afterSeq);
    const oldestRetained = this.entries[0]?.seq ?? this.nextSeq;
    // A gap exists when the caller's next expected entry was already evicted.
    const gap = afterSeq + 1 < oldestRetained;
    return { entries, gap, droppedTotal: this.droppedTotal };
  }

  all(): LogEntry[] {
    return [...this.entries];
  }

  get stats() {
    return {
      retained: this.entries.length,
      bytes: this.bytes,
      droppedTotal: this.droppedTotal,
      nextSeq: this.nextSeq,
    };
  }

  clear(): void {
    this.entries = [];
    this.bytes = 0;
    this.droppedTotal = 0;
  }
}
