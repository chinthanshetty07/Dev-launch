import type { ExecutionState } from './states.js';
import type { FailureDetail } from './failures.js';

export type LogStream = 'stdout' | 'stderr';

export interface WireLogEntry {
  seq: number;
  ts: number;
  stream: LogStream;
  text: string;
}

/**
 * Messages the server pushes over /ws/sessions/:id/logs.
 *
 * Every entry carries a sequence number so a client that drops its connection can say
 * exactly where it left off. If the entries it missed have already been evicted from
 * the bounded buffer, it is told so explicitly with a `gap` — a silent hole in a log
 * stream is worse than a visible one.
 */
export type ServerMessage =
  /** Always first: the client learns the session's state and where the stream stands. */
  | { type: 'hello'; sessionId: string; state: ExecutionState; nextSeq: number; droppedTotal: number }
  | { type: 'logs'; entries: WireLogEntry[] }
  /** Entries between the client's resume point and `oldestSeq` are gone for good. */
  | { type: 'gap'; droppedTotal: number; oldestSeq: number }
  | { type: 'state'; state: ExecutionState; url?: string; failure?: FailureDetail; reason?: string }
  | { type: 'end'; reason: 'session-finished' | 'session-gone' | 'server-closing' };

/** The only message a client sends; resuming is otherwise done via the query string. */
export type ClientMessage = { type: 'resume'; afterSeq: number };

/** Sentinel for "send me everything you still have". */
export const FROM_START = -1;

export function parseAfterSeq(raw: string | null | undefined): number {
  if (raw === null || raw === undefined || raw === '') return FROM_START;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n >= -1 ? n : FROM_START;
}
