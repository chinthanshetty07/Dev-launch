import type { ExecutionState } from './states.js';
import type { FailureDetail } from './failures.js';

export type LogStream = 'stdout' | 'stderr';

/**
 * One service of a running project, as a client sees it.
 *
 * A project has several of everything a single-service session had one of — state, URL,
 * failure — and collapsing them into the session's own is what made a dashboard show
 * "READY" beside a page that did not work.
 */
export interface ServiceView {
  name: string;
  role: 'web' | 'api' | 'worker';
  state: ExecutionState;
  /** Where a person can open it. Absent until it is ready, and cleared when it dies. */
  url?: string;
  /** Port inside the container, and the host port it is published on. */
  containerPort: number | null;
  hostPort?: number;
  failure?: FailureDetail;
  /** Live resource use, when it has been sampled. */
  stats?: ServiceStats;
}

/** A database or cache DevLaunch started for the project. */
export interface BackingView {
  kind: 'mongodb' | 'postgres' | 'mysql' | 'redis';
  /** Hostname the services reach it on. */
  alias: string;
  ready: boolean;
  stats?: ServiceStats;
}

/**
 * What a container is currently consuming.
 *
 * Sampled on request rather than streamed: a dashboard polling every few seconds is the
 * whole requirement, and a continuous stats stream per container is a cost paid whether
 * or not anyone is looking.
 */
export interface ServiceStats {
  /** Percentage of one CPU, so 150 means one and a half cores. */
  cpuPercent: number;
  memoryBytes: number;
  memoryLimitBytes: number;
  /** Sampled at this moment, so a stale reading is recognisable as one. */
  sampledAt: number;
}

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
