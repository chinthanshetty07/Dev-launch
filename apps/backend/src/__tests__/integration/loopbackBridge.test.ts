import { describe, it, expect, afterAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ExecutionState, RunPlanSchema } from '@devlaunch/shared';
import { DockerManager } from '../../services/docker/DockerManager.js';
import { ExecutionManager } from '../../services/execution/ExecutionManager.js';
import { CleanupManager } from '../../services/cleanup/CleanupManager.js';
import { LogManager } from '../../services/logs/LogManager.js';

/**
 * An app that listens on loopback only, reached anyway. Docker forwards a published port to
 * the container's own address, and an app on 127.0.0.1 is not there: Vite, started through
 * `concurrently` (`Avinava/simple-vite-react-express`), never saw `--host` and listened on
 * ::1, and the run failed PORT_BOUND_TO_LOCALHOST. The wrapper's bridge forwards to it.
 */
const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../fixtures');
const docker = new DockerManager();
afterAll(async () => {
  await CleanupManager.sweepOrphans(docker);
});

describe('the loopback bridge', () => {
  it('makes an app listening on 127.0.0.1 only reachable, and says so', async () => {
    const logs = new LogManager();
    const plan = RunPlanSchema.parse({
      runtime: { language: 'node', version: '20' },
      packageManager: 'npm',
      installCommand: null,
      buildCommand: null,
      startCommand: 'node server.js',
      workingDirectory: '.',
      expectedPort: 3000,
      planSource: 'rule-based',
    });
    const handle = await new ExecutionManager(docker).launch({
      sessionId: `bridge-${Date.now()}`,
      plan,
      sourceDir: `${FIXTURES}/node-loopback-only`,
      image: 'devlaunch/node:20',
      logs,
    });
    try {
      const outcome = await handle.waitForReady(30_000);
      expect(outcome.state, JSON.stringify(outcome.failure)).toBe(ExecutionState.READY);
      expect(await (await fetch(outcome.url!)).text()).toBe('loopback only\n');
      expect(logs.buffer.all().map((l) => l.text).join('\n')).toMatch(/Port 3000 is listening on loopback only/);
    } finally {
      await handle.cleanup();
    }
  }, 180_000);
});
