import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import { ExecutionState, type ServerMessage, type WireLogEntry } from '@devlaunch/shared';
import { startServer, type StartedServer } from '../../server.js';
import { DockerManager } from '../../services/docker/DockerManager.js';
import { CleanupManager } from '../../services/cleanup/CleanupManager.js';

const docker = new DockerManager();
let server: StartedServer;
const base = () => `http://127.0.0.1:${server.port}`;

type StateMessage = Extract<ServerMessage, { type: 'state' }>;

/** Narrow a message union down to a state change in a given state. */
const isState = (state: ExecutionState) => (m: ServerMessage): m is StateMessage =>
  m.type === 'state' && m.state === state;

/** Read messages until `stop` is satisfied, collecting log entries along the way. */
function listen(
  port: number,
  sessionId: string,
  afterSeq: number,
  stop: (msgs: ServerMessage[], text: string) => boolean,
  timeoutMs = 90_000,
): Promise<{ msgs: ServerMessage[]; entries: WireLogEntry[]; text: string }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/sessions/${sessionId}/logs?afterSeq=${afterSeq}`);
  const msgs: ServerMessage[] = [];
  const entries: WireLogEntry[] = [];

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`timed out; saw: ${entries.map((e) => e.text).join(' | ')}`));
    }, timeoutMs);

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as ServerMessage;
      msgs.push(msg);
      if (msg.type === 'logs') entries.push(...msg.entries);
      const text = entries.map((e) => e.text).join('\n');
      if (stop(msgs, text)) {
        clearTimeout(timer);
        ws.close();
        resolve({ msgs, entries, text });
      }
    });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

async function launch(fixture: string, body: Record<string, unknown> = {}): Promise<string> {
  const res = await fetch(`${base()}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fixture, ...body }),
  });
  const json = (await res.json()) as { id?: string; error?: string };
  if (!res.ok) throw new Error(`launch failed: ${json.error}`);
  return json.id!;
}

describe('Phase 4 — log streaming reaches a client', () => {
  beforeAll(async () => {
    await docker.ping();
    await docker.ensureImage('devlaunch/node:20');
    // AI off: this suite is about log streaming, and `node-bind-localhost` provokes a
    // repairable failure. With a key configured that costs two live model calls, whose
    // latency is a rate-limited external service's to decide — one run spent 90 seconds
    // on them and timed the listener out, then wedged the next test on the concurrency
    // limit. The failure this suite asserts is deterministic; the repair around it is not.
    server = await startServer(0, { ai: false });
  }, 300_000);

  afterAll(async () => {
    await server?.close();
    await CleanupManager.sweepOrphans(docker);
  });

  it('serves health and the list of fixtures', async () => {
    const health = await (await fetch(`${base()}/api/health`)).json();
    expect(health).toMatchObject({ ok: true });
    const fixtures = (await (await fetch(`${base()}/api/fixtures`)).json()) as string[];
    expect(fixtures).toContain('node-http-basic');
  });

  it('streams container output live over a WebSocket', async () => {
    const id = await launch('node-http-basic');
    const { msgs, text } = await listen(server.port, id, -1, (_m, t) =>
      t.includes('fixture listening'),
    );

    expect(msgs[0]).toMatchObject({ type: 'hello', sessionId: id });
    expect(text).toContain('fixture listening on http://0.0.0.0:3000');
    await server.sessions.cancel(id);
  }, 180_000);

  it('announces READY with a URL that actually serves traffic', async () => {
    const id = await launch('node-http-basic');
    const { msgs } = await listen(server.port, id, -1, (m) => m.some(isState(ExecutionState.READY)));

    const ready = msgs.find(isState(ExecutionState.READY));
    expect(ready?.url).toMatch(/^http:\/\/localhost:\d+\//);

    const res = await fetch(ready!.url!);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ fixture: 'node-http-basic' });
    await server.sessions.cancel(id);
  }, 180_000);

  it('resumes from a sequence number without repeating or losing lines', async () => {
    const id = await launch('node-http-basic');

    // First client reads the opening lines, then disconnects.
    const first = await listen(server.port, id, -1, (_m, t) => t.includes('fixture listening'));
    const lastSeq = first.entries.at(-1)!.seq;

    // Second client resumes from exactly there.
    const second = await listen(
      server.port,
      id,
      lastSeq,
      (m) => m.some(isState(ExecutionState.READY)),
    );

    // Nothing already delivered may be delivered again.
    expect(second.entries.every((e) => e.seq > lastSeq)).toBe(true);
    // Sequence numbers must remain strictly increasing across the reconnect.
    const seqs = [...first.entries, ...second.entries].map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);

    await server.sessions.cancel(id);
  }, 180_000);

  it('reports a failure over the stream with a diagnosable code', async () => {
    const id = await launch('node-bind-localhost', { readinessTimeoutMs: 8_000 });
    const { msgs } = await listen(server.port, id, -1, (m) => m.some(isState(ExecutionState.FAILED)));

    const failed = msgs.find(isState(ExecutionState.FAILED));
    expect(failed?.failure?.code).toBe('PORT_BOUND_TO_LOCALHOST');
    expect(failed?.failure?.message).toMatch(/Bind 0\.0\.0\.0 instead/);
  }, 180_000);

  it('refuses a second concurrent session', async () => {
    const id = await launch('node-http-basic');
    const res = await fetch(`${base()}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fixture: 'node-http-basic' }),
    });
    expect(res.status).toBe(409);
    await server.sessions.cancel(id);
  }, 180_000);

  it('rejects an unknown or traversing fixture name', async () => {
    for (const fixture of ['../../etc', 'nope', '/etc/passwd']) {
      const res = await fetch(`${base()}/api/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fixture }),
      });
      expect(res.status, `fixture ${fixture}`).toBe(400);
    }
  });
});
