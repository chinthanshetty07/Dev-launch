import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:http';
import { WebSocket } from 'ws';
import { ExecutionState, parseAfterSeq, FROM_START, type ServerMessage } from '@devlaunch/shared';
import { LogSocketServer } from '../websocket/LogSocketServer.js';
import { LogManager } from '../services/logs/LogManager.js';
import { LogBuffer } from '../services/logs/LogBuffer.js';
import type { Session, SessionManager } from '../services/session/SessionManager.js';

/** Minimal stand-in so the socket layer can be tested without Docker. */
class FakeSessions extends EventEmitter {
  constructor(private readonly session: Session) { super(); }
  get(id: string): Session | undefined {
    return id === this.session.id ? this.session : undefined;
  }
}

function makeSession(buffer?: LogBuffer): Session {
  return {
    id: 'sess-1',
    state: ExecutionState.STARTING,
    plan: {} as Session['plan'],
    logs: new LogManager(buffer),
    createdAt: Date.now(),
  };
}

describe('parseAfterSeq', () => {
  it('defaults to the start for missing or malformed values', () => {
    expect(parseAfterSeq(null)).toBe(FROM_START);
    expect(parseAfterSeq('')).toBe(FROM_START);
    expect(parseAfterSeq('abc')).toBe(FROM_START);
    expect(parseAfterSeq('-5')).toBe(FROM_START);
  });

  it('accepts a real resume point', () => {
    expect(parseAfterSeq('0')).toBe(0);
    expect(parseAfterSeq('42')).toBe(42);
  });
});

describe('LogSocketServer', () => {
  let http: Server;
  let sockets: LogSocketServer;
  let session: Session;
  let fake: FakeSessions;
  let port: number;
  const open: WebSocket[] = [];

  async function boot(buffer?: LogBuffer) {
    session = makeSession(buffer);
    fake = new FakeSessions(session);
    http = createServer();
    sockets = new LogSocketServer(fake as unknown as SessionManager);
    sockets.attach(http);
    await new Promise<void>((r) => http.listen(0, r));
    port = (http.address() as { port: number }).port;
  }

  /** Collect messages until `stop` says we have enough. */
  function collect(ws: WebSocket, stop: (msgs: ServerMessage[]) => boolean): Promise<ServerMessage[]> {
    const msgs: ServerMessage[] = [];
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout; got ${JSON.stringify(msgs)}`)), 5000);
      ws.on('message', (raw) => {
        msgs.push(JSON.parse(raw.toString()) as ServerMessage);
        if (stop(msgs)) { clearTimeout(timer); resolve(msgs); }
      });
      ws.on('error', reject);
    });
  }

  function connect(query = ''): WebSocket {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/sessions/${session.id}/logs${query}`);
    open.push(ws);
    return ws;
  }

  beforeEach(async () => { await boot(); });
  afterEach(async () => {
    for (const ws of open.splice(0)) ws.close();
    sockets.close();
    await new Promise<void>((r) => http.close(() => r()));
  });

  it('greets with hello before anything else', async () => {
    const ws = connect();
    const [first] = await collect(ws, (m) => m.length >= 1);
    expect(first).toMatchObject({ type: 'hello', sessionId: session.id, state: ExecutionState.STARTING });
  });

  it('replays buffered history to a late subscriber', async () => {
    session.logs.buffer.push('stdout', 'first');
    session.logs.buffer.push('stderr', 'second');

    const ws = connect();
    const msgs = await collect(ws, (m) => m.some((x) => x.type === 'logs'));
    const logs = msgs.find((m) => m.type === 'logs')!;
    expect(logs.entries.map((e) => e.text)).toEqual(['first', 'second']);
    expect(logs.entries[1]!.stream).toBe('stderr');
  });

  it('streams entries that arrive after connection', async () => {
    const ws = connect();
    await collect(ws, (m) => m.some((x) => x.type === 'hello'));

    const arrived = collect(ws, (m) => m.some((x) => x.type === 'logs'));
    session.logs.buffer.push('stdout', 'live line');
    session.logs.emit('entry', session.logs.buffer.all().at(-1)!);

    const msgs = await arrived;
    const logs = msgs.find((m) => m.type === 'logs')!;
    expect(logs.entries[0]!.text).toBe('live line');
  });

  it('resumes after a sequence number without repeating what was seen', async () => {
    for (const t of ['a', 'b', 'c', 'd']) session.logs.buffer.push('stdout', t);

    const ws = connect('?afterSeq=1');
    const msgs = await collect(ws, (m) => m.some((x) => x.type === 'logs'));
    const logs = msgs.find((m) => m.type === 'logs')!;
    expect(logs.entries.map((e) => e.text)).toEqual(['c', 'd']);
    expect(msgs.some((m) => m.type === 'gap')).toBe(false);
  });

  it('reports a gap when the resume point has been evicted', async () => {
    await (async () => {
      for (const ws of open.splice(0)) ws.close();
      sockets.close();
      await new Promise<void>((r) => http.close(() => r()));
      await boot(new LogBuffer(1024 * 1024, 2)); // retain only 2 lines
    })();

    for (const t of ['a', 'b', 'c', 'd']) session.logs.buffer.push('stdout', t);

    // A client resuming from seq 0 wants seq 1, which has already been discarded.
    const ws = connect('?afterSeq=0');
    const msgs = await collect(ws, (m) => m.some((x) => x.type === 'logs'));
    const gap = msgs.find((m) => m.type === 'gap');
    expect(gap, 'a dropped range must be announced, never silently skipped').toBeDefined();
    expect(gap!.droppedTotal).toBe(2);
    const logs = msgs.find((m) => m.type === 'logs')!;
    expect(logs.entries.map((e) => e.text)).toEqual(['c', 'd']);
  });

  it('pushes state changes and ends the stream on a terminal state', async () => {
    const ws = connect();
    await collect(ws, (m) => m.some((x) => x.type === 'hello'));

    const changed = collect(ws, (m) => m.some((x) => x.type === 'end'));
    session.state = ExecutionState.READY;
    session.url = 'http://localhost:1234/';
    fake.emit('state', session);
    session.state = ExecutionState.COMPLETED;
    fake.emit('state', session);

    const msgs = await changed;
    const ready = msgs.find((m) => m.type === 'state' && m.state === ExecutionState.READY);
    expect(ready).toMatchObject({ url: 'http://localhost:1234/' });
    expect(msgs.at(-1)).toMatchObject({ type: 'end', reason: 'session-finished' });
  });

  it('rejects the handshake for an unknown session', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/sessions/does-not-exist/logs`);
    open.push(ws);
    const err = await new Promise<Error>((resolve) => ws.on('error', resolve));
    expect(err.message).toMatch(/404/);
  });
});
