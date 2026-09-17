import type { Server as HttpServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import {
  TERMINAL_STATES,
  parseAfterSeq,
  type ServerMessage,
  type WireLogEntry,
} from '@devlaunch/shared';
import type { SessionManager, Session } from '../services/session/SessionManager.js';
import type { LogEntry } from '../services/logs/LogBuffer.js';

const PATH_PATTERN = /^\/ws\/sessions\/([^/]+)\/logs$/;

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

const toWire = (e: LogEntry): WireLogEntry => ({
  seq: e.seq,
  ts: e.ts,
  stream: e.stream,
  text: e.text,
});

/**
 * Streams a session's output to connected clients.
 *
 * Clients resume with `?afterSeq=N`. If the entries they missed have already been
 * evicted from the bounded buffer they receive an explicit `gap` rather than a stream
 * that silently skips — a hole you can see beats a hole you cannot.
 */
export class LogSocketServer {
  private readonly wss = new WebSocketServer({ noServer: true });

  constructor(private readonly sessions: SessionManager) {}

  attach(server: HttpServer): void {
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '', 'http://localhost');
      const match = PATH_PATTERN.exec(url.pathname);
      if (!match) {
        socket.destroy();
        return;
      }

      const sessionId = decodeURIComponent(match[1]!);
      const session = this.sessions.get(sessionId);
      if (!session) {
        // Reject during the handshake so the client sees 404, not a silent close.
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }

      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.onConnection(ws, session, parseAfterSeq(url.searchParams.get('afterSeq')));
      });
    });
  }

  private onConnection(socket: WebSocket, session: Session, afterSeq: number): void {
    // Subscribe BEFORE replaying history.
    //
    // Reading the buffer and then subscribing leaves a window in which entries arrive
    // and are lost forever. Subscribing first can only ever produce duplicates, which
    // the sequence-number filter below removes.
    const pending: LogEntry[] = [];
    let live = false;
    let lastSent = afterSeq;

    const onEntry = (entry: LogEntry) => {
      if (!live) {
        pending.push(entry);
        return;
      }
      if (entry.seq <= lastSent) return;
      lastSent = entry.seq;
      send(socket, { type: 'logs', entries: [toWire(entry)] });
    };

    const onState = (changed: Session) => {
      if (changed.id !== session.id) return;
      send(socket, {
        type: 'state',
        state: changed.state,
        url: changed.url,
        failure: changed.failure,
      });
      if (TERMINAL_STATES.includes(changed.state)) {
        send(socket, { type: 'end', reason: 'session-finished' });
      }
    };

    session.logs.on('entry', onEntry);
    this.sessions.on('state', onState);

    const stats = session.logs.buffer.stats;
    send(socket, {
      type: 'hello',
      sessionId: session.id,
      state: session.state,
      nextSeq: stats.nextSeq,
      droppedTotal: stats.droppedTotal,
    });

    const slice = session.logs.buffer.since(afterSeq);
    if (slice.gap) {
      send(socket, {
        type: 'gap',
        droppedTotal: slice.droppedTotal,
        oldestSeq: slice.entries[0]?.seq ?? stats.nextSeq,
      });
    }
    if (slice.entries.length > 0) {
      lastSent = slice.entries[slice.entries.length - 1]!.seq;
      send(socket, { type: 'logs', entries: slice.entries.map(toWire) });
    }

    // Hand over to live streaming, replaying anything that arrived during replay.
    live = true;
    const caughtUp = pending.filter((e) => e.seq > lastSent);
    if (caughtUp.length > 0) {
      lastSent = caughtUp[caughtUp.length - 1]!.seq;
      send(socket, { type: 'logs', entries: caughtUp.map(toWire) });
    }
    pending.length = 0;

    if (TERMINAL_STATES.includes(session.state)) {
      send(socket, { type: 'end', reason: 'session-finished' });
    }

    const detach = () => {
      session.logs.off('entry', onEntry);
      this.sessions.off('state', onState);
    };
    socket.on('close', detach);
    socket.on('error', detach);
  }

  close(): void {
    for (const client of this.wss.clients) {
      send(client, { type: 'end', reason: 'server-closing' });
      client.close();
    }
    this.wss.close();
  }
}
