import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InstanceRegistry, pidAlive } from '../services/cleanup/InstanceRegistry.js';

/** Audit A-12: which DevLaunch processes are alive, so one's startup spares another's runs. */
const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe('the registry of live DevLaunch processes', () => {
  it('lists a process while it runs, and forgets one that died', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'devlaunch-inst-')), 'instances');
    dirs.push(dir);
    const r = new InstanceRegistry(dir);
    await r.register('alive-1', 1111);
    await r.register('dead-1', 2222);
    const live = await r.live((pid) => pid === 1111);
    expect([...live]).toEqual(['alive-1']);
    // The dead one's file is gone; the next startup does not ask again.
    expect((await readdir(dir)).sort()).toEqual(['alive-1.json']);
    await r.unregister('alive-1');
    expect([...(await r.live(() => true))]).toEqual([]);
  });

  it('knows this process is alive and a made-up one is not', () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(2 ** 22 + 12345)).toBe(false);
  });
});
