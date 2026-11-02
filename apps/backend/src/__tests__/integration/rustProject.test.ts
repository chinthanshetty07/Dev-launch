import { describe, it, expect, afterAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ExecutionState } from '@devlaunch/shared';
import { DockerManager } from '../../services/docker/DockerManager.js';
import { ExecutionManager } from '../../services/execution/ExecutionManager.js';
import { CleanupManager } from '../../services/cleanup/CleanupManager.js';
import { LogManager } from '../../services/logs/LogManager.js';
import { RepositoryAnalyzer } from '../../services/analysis/RepositoryAnalyzer.js';
import { RuleBasedPlanner } from '../../services/planning/RuleBasedPlanner.js';
import { imageForRuntime } from '../../services/security/ImageAllowlist.js';
import { cacheVolumeFor } from '../../services/docker/ContainerSecurity.js';

/**
 * A Rust web server, from repository to answer: planned by rule, its runner image built on
 * the spot when this machine has none, compiled, started, and reached — on 127.0.0.1:8080,
 * as axum's examples bind it, through the loopback bridge.
 */
const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../fixtures');
const docker = new DockerManager();
afterAll(async () => {
  await CleanupManager.sweepOrphans(docker);
});

describe('a Rust project', () => {
  it('builds and serves an axum app', async () => {
    const analyzer = new RepositoryAnalyzer();
    const dir = `${FIXTURES}/rust-axum-hello`;
    const plan = new RuleBasedPlanner(analyzer).plan(await analyzer.analyze(dir)).plan!;
    expect(plan.runtime).toEqual({ language: 'rust', version: '1' });

    const logs = new LogManager();
    const handle = await new ExecutionManager(docker).launch({
      sessionId: `rust-${Date.now()}`,
      plan,
      sourceDir: dir,
      image: imageForRuntime(plan.runtime.language, plan.runtime.version),
      packageCacheVolume: cacheVolumeFor('fixture:rust-axum-hello'),
      memoryMb: 3072,
      logs,
    });
    try {
      const outcome = await handle.waitForReady(540_000);
      const log = logs.buffer.all().map((l) => l.text).join('\n');
      expect(outcome.state, `${JSON.stringify(outcome.failure)}\n${log.slice(-2000)}`).toBe(ExecutionState.READY);
      expect(await (await fetch(outcome.url!)).text()).toBe('hello from rust\n');
      expect(log).toMatch(/Finished `release` profile/);
    } finally {
      await handle.cleanup();
    }
  }, 900_000);
});
