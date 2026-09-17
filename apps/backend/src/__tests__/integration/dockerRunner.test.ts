import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ExecutionState, FailureCode, RunPlanSchema, type RunPlan } from '@devlaunch/shared';
import { DockerManager } from '../../services/docker/DockerManager.js';
import { ExecutionManager } from '../../services/execution/ExecutionManager.js';
import { CleanupManager } from '../../services/cleanup/CleanupManager.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, '../../../../../fixtures');
const IMAGE = 'devlaunch/node:20';

const docker = new DockerManager();
const exec = new ExecutionManager(docker);

function plan(overrides: Partial<RunPlan>): RunPlan {
  return RunPlanSchema.parse({
    runtime: { language: 'node', version: '20' },
    packageManager: 'npm',
    installCommand: null,
    buildCommand: null,
    startCommand: 'node main.js',
    workingDirectory: '.',
    expectedPort: null,
    planSource: 'rule-based',
    ...overrides,
  });
}

describe('Phase 1 — Docker runner (integration)', () => {
  beforeAll(async () => {
    await docker.ping();
    await docker.ensureImage(IMAGE);
  }, 300_000);

  afterAll(async () => {
    // No orphans may survive the suite.
    await CleanupManager.sweepOrphans(docker);
  });

  it('runs a Node project to completion inside a container', async () => {
    const result = await exec.runToCompletion({
      sessionId: 'it-exit-ok',
      plan: plan({ startCommand: 'node main.js', installCommand: 'npm install --no-audit --no-fund' }),
      sourceDir: `${FIXTURES}/node-exit-ok`,
      image: IMAGE,
    });

    expect(result.state).toBe(ExecutionState.COMPLETED);
    expect(result.exitCode).toBe(0);
    expect(result.phaseReached).toBe('start');
    expect(result.logs.map((l) => l.text).join('\n')).toContain('fixture-node-exit-ok: work complete');
  });

  it('classifies an install failure, and never reaches the start phase', async () => {
    const result = await exec.runToCompletion({
      sessionId: 'it-install-fail',
      // `npm ci` without a lockfile fails immediately and offline.
      plan: plan({ installCommand: 'npm ci' }),
      sourceDir: `${FIXTURES}/node-install-fail`,
      image: IMAGE,
    });

    expect(result.state).toBe(ExecutionState.FAILED);
    expect(result.failure?.code).toBe(FailureCode.DEPENDENCY_INSTALL_FAILED);
    expect(result.phaseReached).toBe('install');
    expect(result.logs.map((l) => l.text).join('\n')).not.toContain('this should never run');
  });

  it('starts a long-running server, maps a port, and streams its logs', async () => {
    const handle = await exec.launch({
      sessionId: 'it-http-server',
      plan: plan({
        startCommand: 'node server.js',
        installCommand: 'npm install --no-audit --no-fund',
        expectedPort: 3000,
      }),
      sourceDir: `${FIXTURES}/node-http-basic`,
      image: IMAGE,
    });

    try {
      const line = await handle.waitForLog((e) => e.text.includes('fixture listening'), 90_000);
      expect(line, 'server should log that it is listening').not.toBeNull();
      expect(line!.text).toContain('0.0.0.0:3000');

      // Port mapping is read back from Docker, never scanned on the host.
      const hostPort = await handle.hostPort();
      expect(hostPort, 'Docker should have assigned a host port').toBeTruthy();
      expect(Number(hostPort)).toBeGreaterThan(0);

      // Still running: a server must not have exited on its own.
      const info = await docker.inspect(handle.container);
      expect(info.State.Running).toBe(true);
    } finally {
      await handle.cleanup();
    }
  });

  it('removes the container after cleanup, leaving no orphans', async () => {
    const handle = await exec.launch({
      sessionId: 'it-cleanup',
      plan: plan({ startCommand: 'node server.js', expectedPort: 3000 }),
      sourceDir: `${FIXTURES}/node-http-basic`,
      image: IMAGE,
    });
    const id = handle.container.id;

    await handle.waitForLog((e) => e.text.includes('fixture listening'), 60_000);
    const { errors } = await handle.cleanup();
    expect(errors).toEqual([]);

    // Inspecting a removed container must fail with 404.
    await expect(docker.getContainer(id).inspect()).rejects.toMatchObject({ statusCode: 404 });

    const managed = await docker.listManaged();
    expect(managed.find((c) => c.Id === id)).toBeUndefined();
  });

  it('serves real traffic on the mapped host port', async () => {
    // The acceptance criterion for Phase 1 is that a known Node project actually runs
    // in isolation — not merely that a container was created. Proving the app answers
    // an HTTP request through Docker's port mapping is what rules out a false green.
    const handle = await exec.launch({
      sessionId: 'it-reachable',
      plan: plan({ startCommand: 'node server.js', expectedPort: 3000 }),
      sourceDir: `${FIXTURES}/node-http-basic`,
      image: IMAGE,
    });

    try {
      await handle.waitForLog((e) => e.text.includes('fixture listening'), 60_000);
      const hostPort = await handle.hostPort();
      expect(hostPort).toBeTruthy();

      const res = await fetch(`http://127.0.0.1:${hostPort}/hello`);
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({
        ok: true,
        fixture: 'node-http-basic',
        url: '/hello',
      });
    } finally {
      await handle.cleanup();
    }
  });

  it('cleanup is idempotent', async () => {
    const handle = await exec.launch({
      sessionId: 'it-idempotent',
      plan: plan({ startCommand: 'node main.js' }),
      sourceDir: `${FIXTURES}/node-exit-ok`,
      image: IMAGE,
    });
    await handle.exit;
    expect((await handle.cleanup()).errors).toEqual([]);
    expect((await handle.cleanup()).errors).toEqual([]);
  });
});
