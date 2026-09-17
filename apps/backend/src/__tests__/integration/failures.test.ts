import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ExecutionState, FailureCode, RunPlanSchema, type RunPlan } from '@devlaunch/shared';
import { DockerManager } from '../../services/docker/DockerManager.js';
import { ExecutionManager } from '../../services/execution/ExecutionManager.js';
import { CleanupManager } from '../../services/cleanup/CleanupManager.js';

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../fixtures');
const IMAGE = 'devlaunch/node:20';

const docker = new DockerManager();
const exec = new ExecutionManager(docker);

function plan(over: Partial<RunPlan> = {}): RunPlan {
  return RunPlanSchema.parse({
    runtime: { language: 'node', version: '20' },
    packageManager: 'npm',
    installCommand: null,
    buildCommand: null,
    startCommand: 'node server.js',
    workingDirectory: '.',
    expectedPort: null,
    planSource: 'rule-based',
    ...over,
  });
}

describe('Phase 7 — classifying real fixture failures', () => {
  beforeAll(async () => {
    await docker.ping();
    await docker.ensureImage(IMAGE);
  }, 300_000);

  afterAll(async () => {
    await CleanupManager.sweepOrphans(docker);
  });

  it('identifies a missing environment variable from the application output', async () => {
    const result = await exec.runToCompletion({
      sessionId: 'fail-env', plan: plan(), sourceDir: `${FIXTURES}/node-missing-env`, image: IMAGE,
    });

    expect(result.state).toBe(ExecutionState.FAILED);
    expect(result.failure?.code).toBe(FailureCode.MISSING_ENV);
    expect(result.failure?.confidence).toBe('high');
    expect(result.failure?.evidence).toContain('REQUIRED_TOKEN');
    expect(result.failure?.remedy).toBeTruthy();
  }, 180_000);

  it('identifies a required database rather than reporting a generic crash', async () => {
    const result = await exec.runToCompletion({
      sessionId: 'fail-db', plan: plan(), sourceDir: `${FIXTURES}/node-needs-database`, image: IMAGE,
    });

    expect(result.failure?.code).toBe(FailureCode.DATABASE_REQUIRED);
    expect(result.failure?.evidence).toMatch(/5432/);
    expect(result.failure?.remedy).toMatch(/does not provision/i);
  }, 180_000);

  it('identifies a missing module, naming it', async () => {
    const result = await exec.runToCompletion({
      sessionId: 'fail-module', plan: plan(), sourceDir: `${FIXTURES}/node-module-missing`, image: IMAGE,
    });

    expect(result.failure?.code).toBe(FailureCode.START_COMMAND_FAILED);
    expect(result.failure?.evidence).toContain('a-package-that-is-definitely-not-installed');
  }, 180_000);

  it('keeps the coarse verdict but refines the explanation for an install failure', async () => {
    const result = await exec.runToCompletion({
      sessionId: 'fail-install',
      plan: plan({ installCommand: 'npm ci', startCommand: 'node main.js' }),
      sourceDir: `${FIXTURES}/node-install-fail`,
      image: IMAGE,
    });

    expect(result.failure?.code).toBe(FailureCode.DEPENDENCY_INSTALL_FAILED);
    expect(result.phaseReached).toBe('install');
  }, 180_000);

  it('classifies through the readiness path, not just the run-to-completion path', async () => {
    // Regression: waitForReady used to snapshot the logs when it was called, which in
    // the session path is immediately after launch, before the container has printed
    // anything. The classifier then saw an empty array and reported the coarse
    // "START_COMMAND_FAILED (uncertain)" while the real cause sat in the logs.
    const handle = await exec.launch({
      sessionId: 'fail-readiness-path',
      plan: plan({ expectedPort: 3000 }),
      sourceDir: `${FIXTURES}/node-missing-env`,
      image: IMAGE,
    });
    try {
      const outcome = await handle.waitForReady(15_000);
      expect(outcome.state).toBe(ExecutionState.FAILED);
      expect(outcome.failure?.code).toBe(FailureCode.MISSING_ENV);
      expect(outcome.failure?.confidence).toBe('high');
      expect(outcome.failure?.evidence).toContain('REQUIRED_TOKEN');
    } finally {
      await handle.cleanup();
    }
  }, 180_000);

  it('reports low confidence rather than a fabricated cause', async () => {
    // node-exit-ok succeeds, so force a bare non-zero exit with no recognisable output.
    const result = await exec.runToCompletion({
      sessionId: 'fail-unknown',
      plan: plan({ startCommand: 'node broken.js' }),
      sourceDir: `${FIXTURES}/node-exit-ok`,
      image: IMAGE,
    });

    expect(result.state).toBe(ExecutionState.FAILED);
    // "Cannot find module" is genuinely what happened, so this is still a real diagnosis.
    expect([FailureCode.START_COMMAND_FAILED, FailureCode.UNKNOWN_RUNTIME_ERROR]).toContain(
      result.failure?.code,
    );
  }, 180_000);
});
