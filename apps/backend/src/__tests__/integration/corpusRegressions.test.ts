import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ExecutionState, FailureCode, type RunPlan } from '@devlaunch/shared';
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

  it('serves an Angular project on @angular/build without a flag it rejects (angular-realworld)', async () => {
    // `--disable-host-check` belongs to @angular-devkit/build-angular. Every project
    // generated since Angular 18 serves through @angular/build, whose schema has never
    // declared it, and `ng serve` refused to start: `Unknown argument: disable-host-check`.
    const plan = await planFixture('node-angular-build');
    const outcome = await runFixture('node-angular-build', plan);
    expect(outcome.state, JSON.stringify(outcome.failure)).toBe(ExecutionState.READY);
  }, 300_000);

  it('explains a failed start by the start, not by what the install printed (fastify/demo, angular-realworld)', async () => {
    // The install succeeds while printing npm's EBADENGINE warnings and husky's `git
    // command not found`; the start then fails on `node: .env: not found`. The warnings
    // were reported as WRONG_RUNTIME_VERSION — and a repair spent moving to Node 22 —
    // and the husky line as the reason `ng serve` would not run.
    const plan = await planFixture('node-install-noise');
    // Past the configuration gate, as the corpus runs it: the variable is not the point.
    const outcome = await runFixture('node-install-noise', { ...plan, environmentVariables: plan.environmentVariables.filter((v) => v.value !== null) });
    expect(outcome.state).toBe(ExecutionState.FAILED);
    expect(outcome.failure?.code, JSON.stringify(outcome.failure)).toBe(FailureCode.MISSING_ENV);
    expect(outcome.failure?.evidence).toBe('node: .env: not found');
    expect(outcome.failure?.message).toMatch(/loads \.env with --env-file/);
  }, 300_000);

  it('quotes the start, not the install, when the start failed in words nothing recognises', async () => {
    // angular-realworld's `ng serve` refused a flag, which no signature knows. The generic
    // "not found" rule then matched husky's install-time `git command not found`, and the
    // report said the start command could not be run.
    const plan = await planFixture('node-install-noise');
    const exited = await runFixture('node-install-noise', { ...plan, startCommand: 'node bad-flag.js' });
    expect(exited.failure?.evidence, JSON.stringify(exited.failure)).toBe('Error: Unknown argument: disable-host-check');

    // And through the readiness path, where the process lives and never listens.
    const idle = await runFixture('node-install-noise', { ...plan, startCommand: 'node idle.js' }, 20_000);
    expect(idle.failure?.evidence ?? '', JSON.stringify(idle.failure)).not.toMatch(/git command not found/);
    expect(idle.failure?.code).not.toBe(FailureCode.START_COMMAND_FAILED);
  }, 300_000);
});
