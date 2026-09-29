import { describe, it, expect } from 'vitest';
import {
  MemoryBudget,
  containerCapacityMb,
  memoryLadder,
  memoryPolicy,
  nextMemoryMb,
  nodeHeapMbFor,
} from '../services/execution/MemoryPolicy.js';

const MB = 1024 * 1024;
const policy = (env: Record<string, string> = {}, vmMb: number | null = 5910) =>
  memoryPolicy({ env, vmMemoryBytes: vmMb === null ? null : vmMb * MB });

describe('the memory policy', () => {
  it('climbs 1024 → 2048 → the ceiling by default, and no further', () => {
    // The VM less its reserve, capped at 4096 — on this machine's 5910 MB VM, 4096.
    expect(memoryLadder(policy())).toEqual([1024, 2048, 4096]);
    expect(memoryLadder(policy({}, 16384))).toEqual([1024, 2048, 4096]);
  });

  it('never exceeds the ceiling, even when the next step would', () => {
    // A 3000 MB VM: 2488 after the reserve, below the next doubling.
    expect(memoryLadder(policy({}, 3000))).toEqual([1024, 2048, 2488]);
    expect(nextMemoryMb(policy({}, 3000), 2488, 1)).toBeNull();
  });

  it('honours an explicit initial limit, step, retry limit and ceiling', () => {
    const p = policy({
      DEVLAUNCH_CONTAINER_MEMORY_MB: '768',
      DEVLAUNCH_MEMORY_STEP_MB: '512',
      DEVLAUNCH_MEMORY_RETRY_LIMIT: '3',
      DEVLAUNCH_CONTAINER_MEMORY_CEILING_MB: '2000',
    });
    expect(memoryLadder(p)).toEqual([768, 1280, 1792, 2000]);
    expect(p.maxSource).toBe('DEVLAUNCH_CONTAINER_MEMORY_CEILING_MB');
  });

  it('stops after the configured number of raises, whatever the ceiling', () => {
    const p = policy({ DEVLAUNCH_MEMORY_RETRY_LIMIT: '1' }, 16384);
    expect(memoryLadder(p)).toEqual([1024, 2048]);
    expect(nextMemoryMb(p, 2048, 1)).toBeNull();
  });

  it('does not retry at all when retries are off', () => {
    const p = policy({ DEVLAUNCH_MEMORY_RETRY_ENABLED: 'off' });
    expect(p.retryEnabled).toBe(false);
    expect(memoryLadder(p)).toEqual([1024]);
  });

  it('respects an initial limit above the ceiling, and escalates nothing from it', () => {
    const p = policy({ DEVLAUNCH_CONTAINER_MEMORY_MB: '4096' }, 4096);
    expect(p.initialMb).toBe(4096);
    expect(memoryLadder(p)).toEqual([4096]);
  });

  it('rejects unusable settings, uses the default, and says which', () => {
    const p = policy({
      DEVLAUNCH_CONTAINER_MEMORY_MB: '12',
      DEVLAUNCH_MEMORY_RETRY_LIMIT: 'lots',
      DEVLAUNCH_MEMORY_STEP_MB: '-5',
      DEVLAUNCH_MEMORY_RETRY_ENABLED: 'maybe',
    });
    expect(p.initialMb).toBe(1024);
    expect(p.retryLimit).toBe(2);
    expect(p.stepMb).toBeNull();
    expect(p.retryEnabled).toBe(true);
    expect(p.warnings).toHaveLength(4);
  });

  it('falls back to 2048 when the VM size cannot be read', () => {
    const p = policy({}, null);
    expect(p.maxMb).toBe(2048);
    expect(p.maxSource).toMatch(/fallback/);
  });

  it('is capped by what is free, and says no rather than a smaller number', () => {
    expect(nextMemoryMb(policy(), 1024, 0, 1500)).toBe(1500);
    expect(nextMemoryMb(policy(), 1024, 0, 1000)).toBeNull();
  });
});

describe('the Node heap inside a container', () => {
  it('is three quarters of it, with at least 256 MB left for everything else', () => {
    expect(nodeHeapMbFor(1024)).toBe(768);
    expect(nodeHeapMbFor(2955)).toBe(2216);
    expect(nodeHeapMbFor(512)).toBe(256);
    for (const mb of [300, 512, 1024, 4096]) expect(nodeHeapMbFor(mb)).toBeLessThanOrEqual(mb - 256 > 128 ? mb - 256 : 128);
  });
});

describe('the memory budget', () => {
  it('counts what every other container holds against the VM', () => {
    const budget = new MemoryBudget(() => 4886);
    budget.hold('api', 2955);
    budget.hold('db', 1024);
    expect(budget.freeMb()).toBe(907);
    // What api could have if it gave its own allocation back — the question escalation asks.
    expect(budget.freeMb('api')).toBe(3862);
    budget.release('api');
    expect(budget.heldMb()).toBe(1024);
    expect(budget.holders()).toEqual([{ id: 'db', mb: 1024 }]);
  });

  it('counts others at what they use when that can be read — an idle API is not its limit', async () => {
    // horusyeung: api needed 2955 MB to install and idles at ~400 once it serves; Postgres
    // is limited to 1024 and uses ~70. Counted at their limits, the frontend installing the
    // same tree was refused memory the VM plainly had.
    const budget = new MemoryBudget(() => 5398);
    budget.hold('api', 2955, async () => 400);
    budget.hold('db', 1024, async () => 70);
    expect(budget.freeMb()).toBe(1419);
    expect(await budget.measuredFreeMb()).toBe(4928);
  });

  it('counts a container at its limit when its use cannot be read, and never above it', async () => {
    const budget = new MemoryBudget(() => 5398);
    budget.hold('silent', 2000, async () => null);
    budget.hold('greedy', 1000, async () => 5000);
    budget.hold('unmeasured', 500);
    expect(await budget.measuredFreeMb()).toBe(5398 - 2000 - 1000 - 500);
    expect(await budget.measuredFreeMb('silent')).toBe(5398 - 1000 - 500);
  });

  it('constrains nothing when the VM size is unknown', () => {
    expect(new MemoryBudget(() => null).freeMb()).toBeNull();
    expect(containerCapacityMb(null)).toBeNull();
  });

  it('keeps a reserve for the VM itself', () => {
    expect(containerCapacityMb(5910 * MB, {})).toBe(5398);
    expect(containerCapacityMb(5910 * MB, { DEVLAUNCH_MEMORY_RESERVE_MB: '1024' })).toBe(4886);
  });
});
