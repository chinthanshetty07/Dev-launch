import { useCallback, useEffect, useRef, useState } from 'react';
import type { ExecutionState, FailureDetail, ServerMessage, WireLogEntry } from '@devlaunch/shared';
import { api, type SessionView } from './api';

export interface LogLine extends WireLogEntry {
  /** Marks a generated notice rather than repository output, e.g. a dropped range. */
  notice?: 'gap' | 'system';
}

export interface SessionStream {
  state: ExecutionState | 'IDLE';
  lines: LogLine[];
  session: SessionView | null;
  url?: string;
  failure?: FailureDetail;
  connected: boolean;
}

const TERMINAL: string[] = ['READY', 'FAILED', 'CANCELLED', 'COMPLETED'];

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
  const [connected, setConnected] = useState(false);
  const lastSeq = useRef(-1);
  const socket = useRef<WebSocket | null>(null);

  const refresh = useCallback(() => {
    if (!sessionId) return;
    api.get(sessionId).then(setSession).catch(() => undefined);
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) {
      setLines([]);
      setState('IDLE');
      setSession(null);
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
          refresh();
        } else if (msg.type === 'end') {
          setConnected(false);
        }
      };

      ws.onclose = () => {
        setConnected(false);
        socket.current = null;
        // Only worth reconnecting while there is more to come.
        if (!closed && !TERMINAL.includes(state)) retry = setTimeout(connect, 1200);
      };
      ws.onerror = () => ws.close();
    };

    setLines([]);
    lastSeq.current = -1;
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
  }, [sessionId, refresh]);

  return {
    state,
    lines,
    session,
    connected,
    url: session?.url,
    failure: session?.failure,
    refresh,
  };
}
