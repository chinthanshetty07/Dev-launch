import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ExecutionState } from '@devlaunch/shared';
import { DockerManager } from '../../services/docker/DockerManager.js';
import { ExecutionManager } from '../../services/execution/ExecutionManager.js';
import { CleanupManager } from '../../services/cleanup/CleanupManager.js';
import { RepositoryAnalyzer } from '../../services/analysis/RepositoryAnalyzer.js';
import { RuleBasedPlanner } from '../../services/planning/RuleBasedPlanner.js';
import { imageForRuntime } from '../../services/security/ImageAllowlist.js';

/**
 * The memory ledger against real Docker: a container removed behind its back — by the
 * label sweep, or by anything else that does not release — stops counting as soon as the
 * ledger next asks Docker, instead of holding its limit for the life of the process.
 */
const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../fixtures');
const docker = new DockerManager();

describe('the memory ledger', () => {
  beforeAll(async () => {
    await docker.ping();
  });
  afterAll(async () => {
    await CleanupManager.sweepOrphans(docker);
  });

  it('gives back the memory of a container removed without releasing it', async () => {
    const exec = new ExecutionManager(docker);
    const analyzer = new RepositoryAnalyzer();
    const { plan } = await new RuleBasedPlanner(analyzer).planRepository(`${FIXTURES}/node-http-basic`);
    const handle = await exec.launch({
      sessionId: 'it-memory-ledger', plan: plan!, sourceDir: `${FIXTURES}/node-http-basic`,
      image: imageForRuntime(plan!.runtime.language, plan!.runtime.version), memoryMb: 1024,
    });
    try {
      expect((await handle.waitForReady(60_000)).state).toBe(ExecutionState.READY);
      const free = await exec.availableMb('nobody');
      expect(exec.memory.heldMb()).toBe(1024);

      // What the label sweep does: remove the container, tell no one.
      await docker.remove(handle.container);
      const after = await exec.availableMb('nobody');

      expect(exec.memory.heldMb()).toBe(0);
      // A running node server uses far less than its limit, so the gain is its usage.
      if (free !== null && after !== null) expect(after).toBeGreaterThan(free);
    } finally {
      await handle.cleanup();
    }
  }, 300_000);
});
