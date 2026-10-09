import { describe, it, expect, afterAll } from 'vitest';
import { DockerManager } from '../../services/docker/DockerManager.js';
import { ExecutionManager } from '../../services/execution/ExecutionManager.js';
import { BackingProvisioner } from '../../services/execution/BackingProvisioner.js';
import { CleanupManager } from '../../services/cleanup/CleanupManager.js';

/**
 * The Postgres a project names, when it is 18. Postgres 18 keeps its data one level up
 * (`/var/lib/postgresql`) and refuses to start with anything mounted at the old
 * `/var/lib/postgresql/data`, so every `postgres:18` (`fastapi/full-stack-fastapi-template`'s
 * compose file) fell back to DevLaunch's Postgres 16, with a log line that explained nothing.
 */
const docker = new DockerManager();
afterAll(async () => {
  await CleanupManager.sweepOrphans(docker);
});

describe('postgres:18 under the sandbox profile', () => {
  it('starts as the version the project asked for, with no fallback', async () => {
    const lines: string[] = [];
    const result = await new BackingProvisioner(new ExecutionManager(docker)).provision({
      sessionId: `pg18-${Date.now()}`,
      backing: [{ kind: 'postgres', evidence: 'compose.yml: postgres:18', image: 'postgres:18', neededBy: ['backend'] }],
      repoName: 'full-stack-fastapi-template',
      logs: { write: (_s, line) => lines.push(line) },
    });
    try {
      const log = lines.join('\n');
      expect(log, log).toMatch(/postgres is accepting connections/);
      expect(log).not.toMatch(/did not start under the sandbox profile|Falling back/);
      expect(log).toMatch(/from postgres:18\.\.\./);
    } finally {
      await result.cleanup();
    }
  }, 240_000);
});
