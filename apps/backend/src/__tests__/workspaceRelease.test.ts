import { describe, it, expect } from 'vitest';
import { ExecutionState, FailureCode, RunPlanSchema } from '@devlaunch/shared';
import { SessionManager } from '../services/session/SessionManager.js';
import { CleanupManager } from '../services/cleanup/CleanupManager.js';
import type { ExecutionManager, ReadyOutcome } from '../services/execution/ExecutionManager.js';
import type { DockerManager } from '../services/docker/DockerManager.js';
import { LogManager } from '../services/logs/LogManager.js';

/**
 * Workspace volumes outlive containers on purpose, so something has to remove them: the
 * end of the session that made them, and the sweeps for a process that died. Served for
 * real in `integration/workspaceReuse.test.ts`.
 */
describe('a single-service session', () => {
  it('keeps one workspace across its attempts, and releases it when it ends', async () => {
    const keys: (string | undefined)[] = [];
    const released: string[] = [];
    const failed: ReadyOutcome = {
      state: ExecutionState.FAILED, hostPort: null,
      readiness: { ready: false, attempts: 0, elapsedMs: 0 } as ReadyOutcome['readiness'],
      failure: { code: FailureCode.PORT_NOT_LISTENING, message: 'Nothing is listening on port 3000.' },
    };
    const exec = {
      async launch(o: { logs?: LogManager; workspaceKey?: string }) {
        keys.push(o.workspaceKey);
        const logs = o.logs ?? new LogManager();
        return { logs, waitForReady: async () => failed, clearStartupBudget: () => undefined, cleanup: async () => ({ errors: [] }) };
      },
      releaseWorkspaces: async (id: string) => { released.push(id); },
    } as unknown as ExecutionManager;
    const m = new SessionManager(exec, {
      analyzer: { analyze: async () => ({ warnings: [], envExample: [], lockfiles: [], frameworkConfigs: [] }) } as never,
      planner: {
        planRepository: async () => ({
          plan: RunPlanSchema.parse({
            runtime: { language: 'node', version: '20' }, packageManager: 'npm', installCommand: 'npm install',
            buildCommand: null, startCommand: 'npm start', workingDirectory: '.', expectedPort: 3000, planSource: 'rule-based',
          }),
          detected: 'node', warnings: [],
        }),
      } as never,
    });
    const s = await m.launch({ sourceDir: '/tmp/repo', image: 'devlaunch/node:20' });
    for (let i = 0; i < 200 && s.state !== ExecutionState.FAILED; i++) await new Promise((r) => setTimeout(r, 20));
    await m.shutdown();

    expect(keys.length).toBeGreaterThan(0);
    expect(new Set(keys)).toEqual(new Set([`${s.id}:app`]));
    expect(released).toContain(s.id);
  });
});

describe('the sweeps', () => {
  it('remove the workspace volumes in their scope, after the containers', async () => {
    const calls: string[] = [];
    const docker = {
      listManaged: async () => [{ Id: 'c1' }],
      getContainer: (id: string) => ({ id }),
      remove: async () => { calls.push('container'); },
      listWorkspaceVolumes: async (scope: unknown) => { calls.push(`list:${String(scope)}`); return ['devlaunch-ws-a-1', 'devlaunch-ws-b-1']; },
      removeVolume: async (name: string) => { calls.push(`volume:${name}`); },
    } as unknown as DockerManager;
    await CleanupManager.sweepAllOrphans(docker);
    expect(calls).toEqual(['container', 'list:all', 'volume:devlaunch-ws-a-1', 'volume:devlaunch-ws-b-1']);
    calls.length = 0;
    await CleanupManager.sweepOrphans(docker);
    expect(calls).toContain('list:instance');
  });
});
