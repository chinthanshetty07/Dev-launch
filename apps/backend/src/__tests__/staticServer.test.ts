import { describe, it, expect } from 'vitest';
import { RunPlanSchema } from '@devlaunch/shared';
import { ExecutionManager } from '../services/execution/ExecutionManager.js';
import type { DockerManager } from '../services/docker/DockerManager.js';
import { STATIC_SERVER_SCRIPT } from '../services/docker/staticServer.js';
import { validateCommand } from '../services/security/CommandValidator.js';

/**
 * DevLaunch's static server is copied into a container only when the plan starts it.
 * Served for real — 204 for a missing favicon, 404 for anything else missing — in
 * `integration/corpusRegressions.test.ts`.
 */
function installs(startCommand: string) {
  const files: { name: string; body: string; dir: string }[] = [];
  const docker = { installFile: async (_c: unknown, name: string, body: string, dir: string) => { files.push({ name, body, dir }); } };
  const exec = new ExecutionManager(docker as unknown as DockerManager);
  const plan = RunPlanSchema.parse({
    runtime: { language: 'python', version: '3.12' }, packageManager: 'pip', installCommand: null, buildCommand: null,
    startCommand, workingDirectory: '.', expectedPort: 8000, planSource: 'rule-based',
  });
  return (exec as unknown as { installStaticServer(c: unknown, o: unknown): Promise<void> })
    .installStaticServer({}, { plan, sourceDir: '/tmp/x' })
    .then(() => files);
}

describe("DevLaunch's static server", () => {
  it('is installed beside the wrapper when the plan starts it', async () => {
    const files = await installs('python /workspace/.devlaunch/serve.py 8000');
    expect(files).toEqual([{ name: 'serve.py', body: STATIC_SERVER_SCRIPT, dir: '/workspace/.devlaunch' }]);
  });

  it('is not installed for any other plan', async () => {
    expect(await installs('flask run --host=0.0.0.0 --port=5000')).toEqual([]);
    expect(await installs('python -m http.server 8000')).toEqual([]);
  });

  it('is started by a command the validator already accepts', () => {
    // No allowlist change: `python` with a path argument.
    expect(validateCommand('python /workspace/.devlaunch/serve.py 8000').binary).toBe('python');
  });
});
