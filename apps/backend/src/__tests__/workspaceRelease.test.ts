import { describe, it, expect } from 'vitest';
import { ExecutionState, FailureCode, RunPlanSchema } from '@devlaunch/shared';
import { SessionManager } from '../services/session/SessionManager.js';
import { CleanupManager } from '../services/cleanup/CleanupManager.js';
import type { ExecutionManager, ReadyOutcome } from '../services/execution/ExecutionManager.js';
import type { DockerManager } from '../services/docker/DockerManager.js';
import { LogManager } from '../services/logs/LogManager.js';
import { config } from '../config/index.js';

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
    // The startup sweep used to remove every DevLaunch container and volume, whoever made
    // them; since audit A-12 it spares what a live DevLaunch process owns. Here `live-1`
    // is alive and `dead-1` crashed; `old` predates the instance label.
    const calls: string[] = [];
    const label = (id?: string) => ({ 'com.devlaunch.managed': 'true', ...(id ? { 'com.devlaunch.instance': id } : {}) });
    const networks = [
      { name: 'devlaunch-run-live', labels: label('live-1') },
      { name: 'devlaunch-run-dead', labels: label('dead-1') },
    ];
    const docker = {
      listManaged: async () => [
        { Id: 'mine-live', Labels: label('live-1') },
        { Id: 'crashed', Labels: label('dead-1') },
        { Id: 'old', Labels: label() },
      ],
      getContainer: (id: string) => ({ id }),
      remove: async (c: { id: string }) => { calls.push(`container:${c.id}`); },
      listWorkspaceVolumeLabels: async () => [
        { name: 'ws-live', labels: label('live-1') },
        { name: 'ws-dead', labels: label('dead-1') },
      ],
      listWorkspaceVolumes: async (scope: unknown) => { calls.push(`list:${String(scope)}`); return ['devlaunch-ws-a-1']; },
      removeVolume: async (name: string) => { calls.push(`volume:${name}`); },
      listBuiltImages: async () => [{ id: 'img-live', labels: label('live-1') }, { id: 'img-dead', labels: label('dead-1') }],
      removeImage: async (id: string) => { calls.push(`image:${id}`); },
      listRunNetworks: async () => networks,
      removeNetwork: async (name: string) => { calls.push(`network:${name}`); },
    } as unknown as DockerManager;
    await CleanupManager.sweepAllOrphans(docker, new Set(['live-1']));
    // Built images too, after a crash (verifier D-5): the dead process's, never a live one's.
    // And a dead process's run networks (D-8), last, once nothing is attached to them.
    expect(calls).toEqual(['container:crashed', 'container:old', 'volume:ws-dead', 'image:img-dead', 'network:devlaunch-run-dead']);
    calls.length = 0;
    // Later, this process has made a run network of its own, and is shutting down.
    networks.push({ name: 'devlaunch-run-mine', labels: label(config.docker.instanceId) });
    await CleanupManager.sweepOrphans(docker);
    expect(calls).toContain('list:instance');
    // At this process's shutdown: its own run networks, never another live process's.
    expect(calls.filter((c) => c.startsWith('network:'))).toEqual(['network:devlaunch-run-mine']);
  });
});
