import { useCallback, useEffect, useRef, useState } from 'react';
import type { ExecutionState, FailureDetail, HttpRoute, ReadinessView, RepairRecord, ServerMessage, WireLogEntry } from '@devlaunch/shared';
import { furthestOf, progressOf } from '@devlaunch/shared';
import { api, type SessionView } from './api';

export interface LogLine extends WireLogEntry {
  /** Marks a generated notice rather than repository output, e.g. a dropped range. */
  notice?: 'gap' | 'system';
}

export interface SessionStream {
  state: ExecutionState | 'IDLE';
  /**
   * Furthest state this session was ever seen in.
   *
   * The current state is not enough to say how far a session got: FAILED is not a point
   * on the pipeline, and REPAIRING sends it backwards to VALIDATING. Only a high-water
   * mark answers "where did it stop", which is what the pipeline strip renders.
   */
  furthest: ExecutionState | null;
  lines: LogLine[];
  session: SessionView | null;
  url?: string;
  failure?: FailureDetail;
  repairs?: RepairRecord[];
  routes?: HttpRoute[];
  readiness?: ReadinessView;
  connected: boolean;
}

const TERMINAL: string[] = ['READY', 'FAILED', 'CANCELLED', 'COMPLETED'];

/** Reconnect ceiling. Past this the stream is gone, and retrying is not going to change it. */
const MAX_RECONNECTS = 8;

/**
 * How long to wait before reconnecting a dropped log socket, or null to stop.
 *
 * Pulled out of the close handler because every way this went wrong was a condition
 * rather than a mechanism, and conditions can be tested. It reconnected for ever against
 * a finished session — 1.2 seconds apart, until the tab was closed — because the only
 * check it made read a `state` captured when the socket was built, which is always
 * `IDLE`.
 */
export function reconnectDelay(now: {
  /** The effect is being torn down; this socket has no owner any more. */
  closed: boolean;
  /** The server said there is no more to come, which is not the same as a drop. */
  ended: boolean;
  /** The session's live state, not the one a closure captured. */
  state: ExecutionState | 'IDLE';
  /** Consecutive attempts, including this one. */
  attempts: number;
}): number | null {
  if (now.closed || now.ended || TERMINAL.includes(now.state)) return null;
  if (now.attempts > MAX_RECONNECTS) return null;
  // Backed off, so a server that is down is not asked once a second by a page nobody
  // is watching.
  return Math.min(1200 * now.attempts, 10_000);
}

/**
 * Follow a session's log stream, resuming precisely across a dropped connection.
 *
 * The server assigns every entry a sequence number, so a reconnect asks for exactly
 * what it missed. When those entries have already been evicted from the bounded buffer
 * the gap is rendered, never skipped silently.
 */
export function useSession(sessionId: string | null): SessionStream & { refresh: () => void } {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [state, setState] = useState<ExecutionState | 'IDLE'>('IDLE');
  const [session, setSession] = useState<SessionView | null>(null);
  const [furthest, setFurthest] = useState<ExecutionState | null>(null);
  const [connected, setConnected] = useState(false);
  const lastSeq = useRef(-1);
  const socket = useRef<WebSocket | null>(null);
  /**
   * The live state, for the close handler.
   *
   * `state` itself cannot be read there: the socket effect deliberately excludes it from
   * its dependencies, so the value captured in the closure is whatever it was when the
   * socket was built — `IDLE`. A finished session therefore never looked terminal to the
   * close handler, which reconnected every 1.2 seconds, for ever, against a session the
   * server had already closed. The browser console filled with failures and the retry
   * only stopped when the tab did.
   */
  const live = useRef<ExecutionState | 'IDLE'>('IDLE');
  /** Consecutive reconnects, so a server that is gone is not polled for ever. */
  const attempts = useRef(0);
  /** Set once the server says there is no more to come, which is not the same as a drop. */
  const ended = useRef(false);

  const advance = useCallback((state: ExecutionState) => {
    live.current = state;
    setFurthest((prev) => furthestOf(prev, state));
  }, []);

  const refresh = useCallback(() => {
    if (!sessionId) return;
    api
      .get(sessionId)
      .then((view) => {
        setSession(view);
        // A page opened after the fact has seen no transitions, so the snapshot is the
        // only thing that knows the session has finished — and the close handler has to
        // know that or it reconnects to a stream that has already ended.
        live.current = view.state;
        // A page opened after the fact has no transition history, so the snapshot is the
        // only evidence of how far the session got. And a failure inside the container —
        // install, build — happened *before* the states the machine went on to report,
        // so it is allowed to lower the mark: "Start ok, Readiness failed" on a session
        // that died compiling a native module described two stages it never reached.
        setFurthest((prev) => progressOf(prev, view));
      })
      .catch(() => undefined);
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) {
      setLines([]);
      setState('IDLE');
      setSession(null);
      setFurthest(null);
      lastSeq.current = -1;
      return;
    }

    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const push = (entry: LogLine) => setLines((prev) => [...prev, entry]);

    const connect = () => {
      if (closed) return;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(
        `${proto}://${location.host}/ws/sessions/${sessionId}/logs?afterSeq=${lastSeq.current}`,
      );
      socket.current = ws;

      ws.onopen = () => setConnected(true);

      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data as string) as ServerMessage;
        if (msg.type === 'hello') {
          setState(msg.state);
          advance(msg.state);
          refresh();
        } else if (msg.type === 'logs') {
          for (const e of msg.entries) {
            lastSeq.current = Math.max(lastSeq.current, e.seq);
            push(e);
          }
        } else if (msg.type === 'gap') {
          push({
            seq: -1,
            ts: Date.now(),
            stream: 'stderr',
            text: `${msg.droppedTotal} earlier line(s) dropped; resuming at ${msg.oldestSeq}`,
            notice: 'gap',
          });
        } else if (msg.type === 'state') {
          setState(msg.state);
          advance(msg.state);
          refresh();
        } else if (msg.type === 'end') {
          ended.current = true;
          setConnected(false);
        }
      };

      ws.onclose = () => {
        setConnected(false);
        socket.current = null;
        // Only worth reconnecting while there is more to come. Three conditions, and
        // each one was a way the old check could loop: the effect being torn down, the
        // server having said `end`, and the session having reached a terminal state —
        // read from a ref, because the closure's copy of `state` never changes.
        const next = reconnectDelay({
          closed,
          ended: ended.current,
          state: live.current,
          attempts: (attempts.current += 1),
        });
        if (next === null) return;
        retry = setTimeout(connect, next);
      };
      ws.onerror = () => ws.close();
    };

    setLines([]);
    setFurthest(null);
    lastSeq.current = -1;
    live.current = 'IDLE';
    ended.current = false;
    attempts.current = 0;
    connect();

    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      socket.current?.close();
      socket.current = null;
    };
    // `state` is deliberately excluded: including it would tear down and rebuild the
    // socket on every transition, losing the stream mid-run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, refresh, advance]);

  return {
    state,
    furthest,
    lines,
    session,
    connected,
    url: session?.url,
    failure: session?.failure,
    repairs: session?.repairs,
    routes: session?.routes,
    readiness: session?.readiness,
    refresh,
  };
}
