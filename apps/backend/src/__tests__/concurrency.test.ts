import { describe, it, expect, afterEach } from 'vitest';
import { ExecutionState, RunPlanSchema } from '@devlaunch/shared';
import { SessionManager, SessionConflict } from '../services/session/SessionManager.js';
import type { ExecutionManager, ReadyOutcome } from '../services/execution/ExecutionManager.js';
import { LogManager } from '../services/logs/LogManager.js';

const saved = process.env.DEVLAUNCH_MAX_CONCURRENT_DEPLOYMENTS;
afterEach(() => {
  if (saved === undefined) delete process.env.DEVLAUNCH_MAX_CONCURRENT_DEPLOYMENTS;
  else process.env.DEVLAUNCH_MAX_CONCURRENT_DEPLOYMENTS = saved;
});

function manager() {
  const ready: ReadyOutcome = { state: ExecutionState.READY, hostPort: '1', url: 'http://localhost:1/', readiness: { ready: true, attempts: 1, elapsedMs: 1 } as ReadyOutcome['readiness'] };
  const exec = {
    async launch(o: { logs?: LogManager }) {
      return { container: { id: 'c' }, logs: o.logs ?? new LogManager(), waitForReady: async () => ready, clearStartupBudget: () => undefined, cleanup: async () => ({ errors: [] }) };
    },
  } as unknown as ExecutionManager;
  return new SessionManager(exec, {
    analyzer: { analyze: async () => ({ warnings: [], envExample: [], lockfiles: [], frameworkConfigs: [] }) } as never,
    planner: { planRepository: async () => ({ plan: RunPlanSchema.parse({ runtime: { language: 'node', version: '20' }, packageManager: 'npm', installCommand: null, buildCommand: null, startCommand: 'node s.js', workingDirectory: '.', expectedPort: 3000, planSource: 'rule-based' }), detected: 'node', warnings: [] }) } as never,
  });
}

describe('how many deployments run at once', () => {
  it('is read when a deployment starts, so a limit in .env is honoured', async () => {
    const m = manager();
    process.env.DEVLAUNCH_MAX_CONCURRENT_DEPLOYMENTS = '2';
    const a = await m.launch({ sourceDir: '/tmp/a', image: 'devlaunch/node:20' });
    const b = await m.launch({ sourceDir: '/tmp/b', image: 'devlaunch/node:20' });
    expect(a.id).not.toBe(b.id);
    const third = m.launch({ sourceDir: '/tmp/c', image: 'devlaunch/node:20' });
    await expect(third).rejects.toBeInstanceOf(SessionConflict);
    await expect(third).rejects.toThrow(/2 deployments are already running.*DEVLAUNCH_MAX_CONCURRENT_DEPLOYMENTS/);
    await m.shutdown();
  });

  it('is one by default, because the Docker VM is the limit', async () => {
    delete process.env.DEVLAUNCH_MAX_CONCURRENT_DEPLOYMENTS;
    const m = manager();
    await m.launch({ sourceDir: '/tmp/a', image: 'devlaunch/node:20' });
    await expect(m.launch({ sourceDir: '/tmp/b', image: 'devlaunch/node:20' })).rejects.toThrow(/already running/);
    await m.shutdown();
  });

  it('ignores a nonsense value, zero, and more than the machine could ever hold', () => {
    for (const v of ['lots', '0', '-1', '1.5', '99']) {
      process.env.DEVLAUNCH_MAX_CONCURRENT_DEPLOYMENTS = v;
      expect(manager().maxConcurrent(), v).toBe(1);
    }
    process.env.DEVLAUNCH_MAX_CONCURRENT_DEPLOYMENTS = '3';
    expect(manager().maxConcurrent()).toBe(3);
  });
});
