import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { HealthCheckSchema } from '@devlaunch/shared';
import { parseProcNetTcp } from '../services/ports/PortManager.js';
import { ReadinessChecker, backoffDelays } from '../services/readiness/ReadinessChecker.js';

const HEADER = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';

describe('parseProcNetTcp', () => {
  it('decodes a socket bound to all interfaces', () => {
    // 00000000 = 0.0.0.0, 0BB8 = 3000, state 0A = LISTEN
    const out = parseProcNetTcp(`${HEADER}\n   0: 00000000:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 1 1`);
    expect(out).toEqual([{ port: 3000, address: '0.0.0.0', loopbackOnly: false }]);
  });

  it('decodes a loopback-bound socket, which Docker cannot forward to', () => {
    // 0100007F is 127.0.0.1 in little-endian hex.
    const out = parseProcNetTcp(`${HEADER}\n   0: 0100007F:1F90 00000000:0000 0A 0 0 0 0 0 0 0`);
    expect(out).toEqual([{ port: 8080, address: '127.0.0.1', loopbackOnly: true }]);
  });

  it('ignores sockets that are not in LISTEN state', () => {
    // 01 = ESTABLISHED, not a listener.
    const out = parseProcNetTcp(`${HEADER}\n   0: 00000000:0BB8 0100007F:1F90 01 0 0 0 0 0 0 0`);
    expect(out).toEqual([]);
  });

  it('handles an empty table and malformed lines without throwing', () => {
    expect(parseProcNetTcp('')).toEqual([]);
    expect(parseProcNetTcp(`${HEADER}\n`)).toEqual([]);
    expect(parseProcNetTcp(`${HEADER}\n   garbage`)).toEqual([]);
  });

  it('classifies IPv6 loopback separately from IPv6 wildcard', () => {
    const wildcard = parseProcNetTcp(`${HEADER}\n   0: ${'0'.repeat(32)}:0BB8 ${'0'.repeat(32)}:0000 0A 0 0 0 0 0 0 0`, true);
    expect(wildcard[0]).toMatchObject({ port: 3000, loopbackOnly: false });

    const loopback = parseProcNetTcp(`${HEADER}\n   0: ${'0'.repeat(24)}01000000:0BB8 x:0 0A 0 0 0 0 0 0 0`, true);
    expect(loopback[0]).toMatchObject({ port: 3000, loopbackOnly: true });
  });
});

describe('backoff', () => {
  it('climbs then caps, so a slow start does not poll hot', () => {
    expect(backoffDelays()).toEqual([1000, 2000, 4000, 8000]);
  });
});

describe('ReadinessChecker', () => {
  let server: Server | undefined;
  afterEach(() => { server?.close(); server = undefined; });

  async function listen(handler: Parameters<typeof createServer>[1]): Promise<number> {
    server = createServer(handler);
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    return (server!.address() as { port: number }).port;
  }

  const health = (over = {}) => HealthCheckSchema.parse(over);
  const checker = new ReadinessChecker();

  it('is ready on 200, and the health hint matches', async () => {
    const port = await listen((_q, s) => { s.writeHead(200); s.end('ok'); });
    const r = await checker.waitForReady({ port, healthCheck: health(), timeoutMs: 5000 });
    expect(r.ready).toBe(true);
    expect(r.status).toBe(200);
    expect(r.healthHintOk).toBe(true);
  });

  it('is READY on 404 — a server answered', async () => {
    // The decisive case. Gating readiness on 2xx would fail every API without a
    // root route. The hint records the mismatch; readiness does not care.
    const port = await listen((_q, s) => { s.writeHead(404); s.end('nope'); });
    const r = await checker.waitForReady({ port, healthCheck: health(), timeoutMs: 5000 });
    expect(r.ready).toBe(true);
    expect(r.status).toBe(404);
    expect(r.healthHintOk).toBe(false);
  });

  it('is READY on a 302 redirect, without following it', async () => {
    const port = await listen((_q, s) => { s.writeHead(302, { location: '/login' }); s.end(); });
    const r = await checker.waitForReady({ port, healthCheck: health(), timeoutMs: 5000 });
    expect(r.ready).toBe(true);
    expect(r.status).toBe(302);
  });

  it('is READY on 500 — the application is up, even if unhappy', async () => {
    const port = await listen((_q, s) => { s.writeHead(500); s.end('boom'); });
    const r = await checker.waitForReady({ port, healthCheck: health(), timeoutMs: 5000 });
    expect(r.ready).toBe(true);
    expect(r.status).toBe(500);
  });

  it('honours a custom health path', async () => {
    const port = await listen((q, s) => {
      if (q.url === '/healthz') { s.writeHead(200); s.end('ok'); return; }
      s.writeHead(404); s.end();
    });
    const r = await checker.waitForReady({
      port, healthCheck: health({ path: '/healthz' }), timeoutMs: 5000,
    });
    expect(r.status).toBe(200);
    expect(r.healthHintOk).toBe(true);
  });

  it('retries with backoff before giving up on a closed port', async () => {
    const port = await listen((_q, s) => s.end());
    server!.close(); server = undefined; // free the port so connections are refused
    const r = await checker.waitForReady({ port, healthCheck: health(), timeoutMs: 2500 });
    expect(r.ready).toBe(false);
    expect(r.attempts).toBeGreaterThan(1);
    expect(r.lastError).toBeTruthy();
  });

  it('stops immediately when the container has already exited', async () => {
    const r = await checker.waitForReady({
      port: 1, healthCheck: health(), timeoutMs: 30_000, abortIf: () => true,
    });
    expect(r.abortedEarly).toBe(true);
    expect(r.ready).toBe(false);
    expect(r.attempts).toBe(0);
  });

  it('becomes ready once a slow server starts listening', async () => {
    // Claim a port, release it, then re-bind it shortly afterwards. This makes the
    // checker face real connection refusals before the server appears.
    let started = false;
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const realPort = (probe.address() as { port: number }).port;
    await new Promise<void>((r) => probe.close(() => r()));

    setTimeout(() => {
      server = createServer((_q, s) => { s.writeHead(200); s.end('ok'); });
      server.listen(realPort, '127.0.0.1', () => { started = true; });
    }, 1200);

    const r = await checker.waitForReady({ port: realPort, healthCheck: health(), timeoutMs: 15_000 });
    expect(started).toBe(true);
    expect(r.ready).toBe(true);
    expect(r.attempts).toBeGreaterThan(1);
  }, 30_000);
});
