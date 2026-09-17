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

function plan(overrides: Partial<RunPlan> = {}): RunPlan {
  return RunPlanSchema.parse({
    runtime: { language: 'node', version: '20' },
    packageManager: 'npm',
    installCommand: null,
    buildCommand: null,
    startCommand: 'node server.js',
    workingDirectory: '.',
    expectedPort: 3000,
    hostBinding: 'forced',
    planSource: 'rule-based',
    ...overrides,
  });
}

describe('Phase 3 — port mapping and readiness', () => {
  beforeAll(async () => {
    await docker.ping();
    await docker.ensureImage(IMAGE);
  }, 300_000);

  afterAll(async () => {
    await CleanupManager.sweepOrphans(docker);
  });

  it('reports READY and a working URL for a healthy application', async () => {
    const handle = await exec.launch({
      sessionId: 'rdy-ok', plan: plan(), sourceDir: `${FIXTURES}/node-http-basic`, image: IMAGE,
    });
    try {
      const outcome = await handle.waitForReady(30_000);
      expect(outcome.state).toBe(ExecutionState.READY);
      expect(outcome.readiness.ready).toBe(true);
      expect(outcome.readiness.status).toBe(200);
      expect(outcome.readiness.healthHintOk).toBe(true);
      expect(outcome.url).toMatch(/^http:\/\/localhost:\d+\//);

      const res = await fetch(outcome.url!);
      expect(res.status).toBe(200);
    } finally {
      await handle.cleanup();
    }
  }, 120_000);

  it('distinguishes a started process from a ready application', async () => {
    // The acceptance criterion for this phase. The container is running happily; the
    // application never opens a socket. "Started" and "ready" are different facts.
    const handle = await exec.launch({
      sessionId: 'rdy-never', plan: plan(), sourceDir: `${FIXTURES}/node-never-listens`, image: IMAGE,
    });
    try {
      const info = await docker.inspect(handle.container);
      expect(info.State.Running, 'process must be running').toBe(true);

      const outcome = await handle.waitForReady(8_000);
      expect(outcome.state).toBe(ExecutionState.FAILED);
      expect(outcome.failure?.code).toBe(FailureCode.PORT_NOT_LISTENING);
      expect(outcome.diagnosis?.kind).toBe('not-listening');
    } finally {
      await handle.cleanup();
    }
  }, 120_000);

  it('identifies an application bound to localhost as its own failure class', async () => {
    // A healthy, listening server that Docker simply cannot forward to. Reporting this
    // as PORT_NOT_LISTENING would send the user debugging the wrong problem entirely.
    const handle = await exec.launch({
      sessionId: 'rdy-loopback', plan: plan(), sourceDir: `${FIXTURES}/node-bind-localhost`, image: IMAGE,
    });
    try {
      await handle.waitForLog((e) => e.text.includes('bound to 127.0.0.1'), 30_000);

      const outcome = await handle.waitForReady(8_000);
      expect(outcome.state).toBe(ExecutionState.FAILED);
      expect(outcome.failure?.code).toBe(FailureCode.PORT_BOUND_TO_LOCALHOST);
      expect(outcome.diagnosis?.kind).toBe('loopback-only');
      expect(outcome.failure?.message).toMatch(/Bind 0\.0\.0\.0 instead/);
      // The remedy must be actionable, so the observed address is named.
      if (outcome.diagnosis?.kind === 'loopback-only') {
        expect(outcome.diagnosis.socket.address).toBe('127.0.0.1');
        expect(outcome.diagnosis.socket.port).toBe(3000);
      }
    } finally {
      await handle.cleanup();
    }
  }, 120_000);

  it('retries with backoff until a slow application starts listening', async () => {
    const handle = await exec.launch({
      sessionId: 'rdy-slow',
      plan: plan({
        environmentVariables: [{ key: 'START_DELAY_MS', value: '4000', required: false }],
      }),
      sourceDir: `${FIXTURES}/node-slow-start`,
      image: IMAGE,
    });
    try {
      const outcome = await handle.waitForReady(40_000);
      expect(outcome.state).toBe(ExecutionState.READY);
      expect(outcome.readiness.attempts, 'must have retried').toBeGreaterThan(1);
      expect(outcome.readiness.elapsedMs).toBeGreaterThan(3_000);
    } finally {
      await handle.cleanup();
    }
  }, 120_000);

  it('treats a 404 on / as READY, recording only a health hint', async () => {
    // Countless real APIs have no root route. Failing them would be a false negative.
    const handle = await exec.launch({
      sessionId: 'rdy-404', plan: plan(), sourceDir: `${FIXTURES}/node-404-root`, image: IMAGE,
    });
    try {
      const outcome = await handle.waitForReady(30_000);
      expect(outcome.state).toBe(ExecutionState.READY);
      expect(outcome.readiness.status).toBe(404);
      expect(outcome.readiness.healthHintOk).toBe(false);

      // And the app really is serving on the route it does have.
      const res = await fetch(`http://localhost:${outcome.hostPort}/api`);
      expect(res.status).toBe(200);
    } finally {
      await handle.cleanup();
    }
  }, 120_000);

  it('does not burn the whole budget when the container has already exited', async () => {
    const handle = await exec.launch({
      sessionId: 'rdy-exited',
      plan: plan({ startCommand: 'node main.js' }),
      sourceDir: `${FIXTURES}/node-exit-ok`,
      image: IMAGE,
    });
    try {
      await handle.exit;
      const started = Date.now();
      const outcome = await handle.waitForReady(60_000);
      expect(outcome.state).toBe(ExecutionState.FAILED);
      // Polling a dead container to the full 60s would be a pointless stall.
      expect(Date.now() - started).toBeLessThan(20_000);
    } finally {
      await handle.cleanup();
    }
  }, 120_000);
});
