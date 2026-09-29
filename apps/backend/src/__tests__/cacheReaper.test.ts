import { describe, it, expect } from 'vitest';
import { CleanupManager } from '../services/cleanup/CleanupManager.js';
import type { DockerManager } from '../services/docker/DockerManager.js';

/**
 * Teardown removed containers. Nothing removed volumes, and nothing ever had — a
 * production-readiness check found 99 of them, 5.1 GB, 98% reclaimable, on a tool whose
 * job is cloning arbitrary repositories. One had been created by that check's own smoke
 * test. Unbounded disk on a 100 GB VM is a slow leak with a deadline.
 */
const DAY = 24 * 60 * 60 * 1000;

const NOW = 1_800_000_000_000;

function fakeDocker(volumes: { name: string; ageDays: number }[], refuse: string[] = []) {
  const removed: string[] = [];
  return {
    removed,
    docker: {
      listCacheVolumes: async () =>
        volumes.map((v) => ({ name: v.name, createdAt: NOW - v.ageDays * DAY })),
      removeVolume: async (name: string) => {
        if (refuse.includes(name)) throw new Error('volume is in use');
        removed.push(name);
      },
    } as unknown as DockerManager,
  };
}

describe('reaping stale package caches', () => {
  it('removes what is older than the threshold and keeps what is not', async () => {
    const { docker, removed } = fakeDocker([
      { name: 'old-a', ageDays: 30 },
      { name: 'old-b', ageDays: 15 },
      { name: 'fresh', ageDays: 3 },
    ]);
    const n = await CleanupManager.sweepStaleCaches(docker, 14 * DAY, NOW);
    expect(n).toBe(2);
    expect(removed.sort()).toEqual(['old-a', 'old-b']);
  });

  it('keeps a cache exactly at the threshold', async () => {
    // Exactly, to the millisecond — which needs the clock injected, because two calls to
    // `Date.now()` never align and the first version of this test never reached the
    // boundary it was named for. Warm caches are why a repeat run takes 6 seconds
    // instead of 90: the boundary spares, and nothing is gained by being eager.
    const { docker, removed } = fakeDocker([{ name: 'edge', ageDays: 14 }]);
    await CleanupManager.sweepStaleCaches(docker, 14 * DAY, NOW);
    expect(removed).toEqual([]);
  });

  it('removes one a millisecond past it', async () => {
    // The other side of the same boundary, so "spares at the threshold" cannot be
    // satisfied by a reaper that spares everything.
    const { docker, removed } = fakeDocker([{ name: 'edge' , ageDays: 14 }]);
    await CleanupManager.sweepStaleCaches(docker, 14 * DAY - 1, NOW);
    expect(removed).toEqual(['edge']);
  });

  it('survives a volume that is still in use', async () => {
    // Docker refuses to remove a volume a container holds. That must not stop the sweep
    // reaching the rest of the list.
    const { docker, removed } = fakeDocker(
      [{ name: 'busy', ageDays: 40 }, { name: 'idle', ageDays: 40 }],
      ['busy'],
    );
    const n = await CleanupManager.sweepStaleCaches(docker, 14 * DAY, NOW);
    expect(n).toBe(1);
    expect(removed).toEqual(['idle']);
  });

  it('is disabled by a zero age, and touches nothing', async () => {
    // The escape hatch for somebody who wants caches kept for ever. It must not be a
    // cutoff of "now", which would delete everything.
    const { docker, removed } = fakeDocker([{ name: 'ancient', ageDays: 900 }]);
    expect(await CleanupManager.sweepStaleCaches(docker, 0)).toBe(0);
    expect(removed).toEqual([]);
  });

  it('asks only for cache volumes, never for every volume', async () => {
    // The listing is filtered on DevLaunch's own cache label. Matching a name prefix
    // instead would put somebody else's `devlaunch-`-ish volume in range.
    let called = false;
    const docker = {
      listCacheVolumes: async () => { called = true; return []; },
      removeVolume: async () => { throw new Error('should not be reached'); },
    } as unknown as DockerManager;
    await CleanupManager.sweepStaleCaches(docker, 14 * DAY, NOW);
    expect(called).toBe(true);
  });
});
