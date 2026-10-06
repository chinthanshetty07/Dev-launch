import { describe, it, expect } from 'vitest';
import { createServer, type Server } from 'node:net';
import type { AddressInfo } from 'node:net';
import { acceptsConnections } from '../services/docker/RepoDockerRunner.js';

/**
 * Docker's port forwarder accepts a connection before the database behind it listens, then
 * hangs up. The first real run logged "accepting connections" a second before Postgres was
 * ready. A connection only counts once it stays open.
 */
async function listen(onConnect: (s: import('node:net').Socket) => void): Promise<{ server: Server; port: number }> {
  const server = createServer(onConnect);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: (server.address() as AddressInfo).port };
}
const alive = async () => true;

describe('whether a database accepts connections', () => {
  it('is yes when the connection stays open, as a database waiting for a client does', async () => {
    const { server, port } = await listen(() => undefined);
    expect(await acceptsConnections(port, alive, 2000, '127.0.0.1', 100)).toBe(true);
    server.close();
  });

  it('is no while something accepts and hangs up at once, as the forwarder does', async () => {
    const { server, port } = await listen((s) => s.destroy());
    expect(await acceptsConnections(port, alive, 1500, '127.0.0.1', 200)).toBe(false);
    server.close();
  });

  it('is no when nothing listens, and stops early when the container has died', async () => {
    const { server, port } = await listen(() => undefined);
    server.close();
    await new Promise((r) => server.once('close', r));
    const t0 = Date.now();
    expect(await acceptsConnections(port, async () => false, 10_000, '127.0.0.1', 100)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});
