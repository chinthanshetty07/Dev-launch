import { describe, it, expect } from 'vitest';
import {
  FALLBACK_CEILING_MB,
  MAX_CEILING_MB,
  containerMemoryCeilingMb,
} from '../services/execution/MemoryCeiling.js';

/**
 * The ceiling was the constant 2048, chosen when the VM had 3.8 GB. The VM was later
 * given 6 GB and the constant did not notice, so a real repository was still killed at
 * 1477/2048 MB on a machine with gigabytes to spare — and raising the VM had no effect,
 * because nothing connected the two.
 */
const GB = 1024 * 1024 * 1024;

describe('how much memory one container may be raised to', () => {
  it('scales with the machine', () => {
    // Written before the function existed, from the requirement rather than the code.
    expect(containerMemoryCeilingMb({}, 6 * GB)).toBe(3072);
    expect(containerMemoryCeilingMb({}, 8 * GB)).toBe(4096);
    // The VM this was found on, which reports 5.8 GB rather than a round 6.
    expect(containerMemoryCeilingMb({}, 5.8 * GB)).toBe(2969);
  });

  it('is capped, because past a few gigabytes the repository is the problem', () => {
    // Handing a 64 GB workstation 32 GB for one install does not make a failing install
    // succeed; it makes the failure slower and takes the machine with it.
    expect(containerMemoryCeilingMb({}, 64 * GB)).toBe(MAX_CEILING_MB);
    expect(containerMemoryCeilingMb({}, 512 * GB)).toBe(MAX_CEILING_MB);
  });

  it('never offers a small machine more than it has', () => {
    // An earlier version floored this at the old 2048 constant, so a small VM would not
    // get weaker repairs than before. That is the wedge this exists to prevent: on a
    // 2 GB VM it hands one container the entire machine, with the daemon and a database
    // already inside it. A machine that cannot do better than the default should say so
    // and stop — which is what "already at the ceiling" reports.
    expect(containerMemoryCeilingMb({}, 2 * GB)).toBe(1024);
    expect(containerMemoryCeilingMb({}, 1 * GB)).toBe(512);
    // And never more than half, at any size.
    for (const gb of [1, 2, 4, 6, 8, 16]) {
      const mb = containerMemoryCeilingMb({}, gb * GB);
      expect(mb * 1024 * 1024, `${gb}GB`).toBeLessThanOrEqual((gb * GB) / 2);
    }
  });

  it('uses the old constant when the machine cannot be read', () => {
    // Unreadable memory is not evidence of a large machine. Falling back to the value
    // every previous run used cannot regress one.
    expect(containerMemoryCeilingMb({}, null)).toBe(FALLBACK_CEILING_MB);
    expect(containerMemoryCeilingMb({}, 0)).toBe(FALLBACK_CEILING_MB);
    expect(containerMemoryCeilingMb({}, Number.NaN)).toBe(FALLBACK_CEILING_MB);
  });

  it('lets an explicit setting win over any derivation', () => {
    // Somebody who set this knows something `docker info` does not report — that they
    // are willing to spend the memory, or that the VM is about to grow.
    expect(containerMemoryCeilingMb({ DEVLAUNCH_CONTAINER_MEMORY_CEILING_MB: '3584' }, 6 * GB))
      .toBe(3584);
    // Including above the cap: the cap is a default, not a policy.
    expect(containerMemoryCeilingMb({ DEVLAUNCH_CONTAINER_MEMORY_CEILING_MB: '8192' }, 6 * GB))
      .toBe(8192);
  });

  it('ignores a setting it cannot read, rather than guessing', () => {
    for (const raw of ['', '   ', 'lots', '0', '-512']) {
      expect(containerMemoryCeilingMb({ DEVLAUNCH_CONTAINER_MEMORY_CEILING_MB: raw }, 6 * GB), raw)
        .toBe(3072);
    }
  });
});
