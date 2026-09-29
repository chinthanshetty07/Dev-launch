import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ExecutionState, type RunPlan } from '@devlaunch/shared';
import { DockerManager } from '../../services/docker/DockerManager.js';
import { ExecutionManager } from '../../services/execution/ExecutionManager.js';
import { CleanupManager } from '../../services/cleanup/CleanupManager.js';
import { RepositoryAnalyzer } from '../../services/analysis/RepositoryAnalyzer.js';
import { RuleBasedPlanner } from '../../services/planning/RuleBasedPlanner.js';
import { imageForRuntime } from '../../services/security/ImageAllowlist.js';
import { cacheVolumeFor } from '../../services/docker/ContainerSecurity.js';

/**
 * One case per failure the real-world corpus found (scripts/corpus).
 *
 * Each fixture reproduces the mechanism of a real repository's failure, offline, and each
 * case drives it through the same path the repository took — analyse, plan by rule, run in
 * the sandbox, wait for readiness. A plan snapshot would prove the plan changed; this
 * proves the change is what makes the application answer.
 */
const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../fixtures');

const docker = new DockerManager();
const exec = new ExecutionManager(docker);
const planner = new RuleBasedPlanner(new RepositoryAnalyzer());

async function planFixture(name: string): Promise<RunPlan> {
  const outcome = await planner.planRepository(`${FIXTURES}/${name}`);
  if (!outcome.plan) throw new Error(`${name} did not plan: ${outcome.reason}`);
  return outcome.plan;
}

async function runFixture(name: string, plan: RunPlan, readinessMs = 90_000) {
  const handle = await exec.launch({
    sessionId: `corpus-${name}`,
    plan,
    sourceDir: `${FIXTURES}/${name}`,
    image: imageForRuntime(plan.runtime.language, plan.runtime.version),
    // As a session mounts it. Without one /cache is on the read-only root filesystem,
    // and corepack cannot fetch the package manager a repository pins.
    packageCacheVolume: cacheVolumeFor(`fixture:${name}`),
  });
  try {
    return await handle.waitForReady(readinessMs);
  } finally {
    await handle.cleanup();
  }
}

describe('failures the real-world corpus found', () => {
  beforeAll(async () => {
    await docker.ping();
  });

  afterAll(async () => {
    await CleanupManager.sweepOrphans(docker);
  });

  it('passes binding flags to a pnpm script as options (sveltejs/realworld)', async () => {
    // pnpm forwards a literal `--` to the script, where npm strips it — measured in the
    // runner image for pnpm 9, 10 and 12. Vite's parser reads everything after `--` as
    // positional, so `pnpm run dev -- --host 0.0.0.0` served on loopback and the run
    // ended PORT_BOUND_TO_LOCALHOST against a plan that looked correct.
    const plan = await planFixture('node-pnpm-vite-args');
    expect(plan.packageManager).toBe('pnpm');
    const outcome = await runFixture('node-pnpm-vite-args', plan);
    expect(outcome.state, JSON.stringify(outcome.failure)).toBe(ExecutionState.READY);
  }, 300_000);
});
