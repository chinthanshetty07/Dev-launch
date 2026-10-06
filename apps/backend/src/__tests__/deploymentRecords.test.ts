import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecutionState, FailureCode, RunPlanSchema, Sentinel } from '@devlaunch/shared';
import { SessionManager } from '../services/session/SessionManager.js';
import { FileDeploymentStore, InMemoryDeploymentStore, type DeploymentRecord } from '../services/session/DeploymentStore.js';
import { phaseDurations, sentinelRecorder, type DeploymentEvent } from '../services/session/DeploymentEvents.js';
import type { ExecutionManager, ReadyOutcome } from '../services/execution/ExecutionManager.js';
import { LogManager } from '../services/logs/LogManager.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe('the timeline of a container’s phases', () => {
  it('turns the wrapper’s markers into events with each phase’s duration', () => {
    const events: DeploymentEvent[] = [];
    const rec = sentinelRecorder(events, 'api');
    rec(Sentinel.INSTALL_BEGIN, 1000);
    rec(Sentinel.INSTALL_OK, 4000);
    rec(Sentinel.BUILD_BEGIN, 4000);
    rec(Sentinel.BUILD_FAIL, 9000);
    expect(events.map((e) => [e.event, e.service, e.durationMs])).toEqual([
      ['INSTALL_STARTED', 'api', undefined],
      ['INSTALL_SUCCESS', 'api', 3000],
      ['BUILD_STARTED', 'api', undefined],
      ['BUILD_FAILED', 'api', 5000],
    ]);
    expect(events[3]!.severity).toBe('error');
    expect(phaseDurations(events)).toEqual({ install: 3000, build: 5000 });
  });
});

describe('deployment records on disk', () => {
  const rec = (id: string, at: number, state = 'READY'): DeploymentRecord => ({
    id, state: state as DeploymentRecord['state'], createdAt: at, updatedAt: at, services: [], backing: [], containerIds: [], events: [],
  });

  it('are written whole, readable only by their owner, and read back', async () => {
    const d = await mkdtemp(join(tmpdir(), 'devlaunch-records-'));
    dirs.push(d);
    const store = new FileDeploymentStore(join(d, 'deployments'));
    await store.save(rec('11111111-aaaa', 1));
    expect((await store.get('11111111-aaaa'))?.state).toBe('READY');
    expect((await stat(join(d, 'deployments', '11111111-aaaa.json'))).mode & 0o777).toBe(0o600);
  });

  it('never turn a strange id into a path', async () => {
    const store = new FileDeploymentStore(await mkdtemp(join(tmpdir(), 'devlaunch-records-')));
    await expect(store.save(rec('../../etc/x', 1))).rejects.toThrow(/Not a deployment id/);
  });

  it('keep only the newest, so they cannot grow without bound', async () => {
    const d = await mkdtemp(join(tmpdir(), 'devlaunch-records-'));
    dirs.push(d);
    const store = new FileDeploymentStore(d, 3);
    for (let i = 0; i < 5; i++) await store.save(rec(`id-0000000${i}`, i));
    expect((await store.list()).map((r) => r.id)).toEqual(['id-00000004', 'id-00000003', 'id-00000002']);
    expect((await store.list()).length).toBe(3);
  });
});

function manager(store: InMemoryDeploymentStore, outcome: ReadyOutcome) {
  const exec = {
    async launch(o: { logs?: LogManager }) {
      const logs = o.logs ?? new LogManager();
      // What a container's wrapper prints around its install.
      logs.emit('sentinel', Sentinel.INSTALL_BEGIN, Date.now() - 2000);
      logs.emit('sentinel', Sentinel.INSTALL_OK, Date.now());
      return {
        container: { id: 'c-1' }, logs, waitForReady: async () => outcome,
        clearStartupBudget: () => undefined, cleanup: async () => ({ errors: [] }),
      };
    },
  } as unknown as ExecutionManager;
  return new SessionManager(exec, {
    deploymentStore: store,
    analyzer: { analyze: async () => ({ warnings: [], envExample: [], lockfiles: [], frameworkConfigs: [] }) } as never,
    planner: {
      planRepository: async () => ({
        plan: RunPlanSchema.parse({
          runtime: { language: 'node', version: '20' }, packageManager: 'npm', installCommand: 'npm ci',
          buildCommand: null, startCommand: 'npm start', workingDirectory: '.', expectedPort: 3000, planSource: 'rule-based',
        }),
        detected: 'node', warnings: [],
      }),
    } as never,
  });
}
// Fails when time runs out. It used to return quietly, so a wait that never came true
// went on to assertions that could pass anyway.
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 300 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  if (!cond()) throw new Error('until: condition not met within 3 s');
};

describe('a deployment’s record', () => {
  it('is saved with its timeline, ending in its final state', async () => {
    const store = new InMemoryDeploymentStore();
    const ready: ReadyOutcome = { state: ExecutionState.READY, hostPort: '1', url: 'http://localhost:1/', readiness: { ready: true, attempts: 1, elapsedMs: 1 } as ReadyOutcome['readiness'] };
    const m = manager(store, ready);
    const s = await m.launch({ sourceDir: '/tmp/repo', image: 'devlaunch/node:20' });
    await until(() => s.state === ExecutionState.READY);
    await m.flushRecords();
    const r = await store.get(s.id);
    expect(r?.state).toBe('READY');
    const names = r!.events.map((e) => e.event);
    expect(names[0]).toBe('DEPLOYMENT_CREATED');
    expect(names).toContain('ATTEMPT_STARTED');
    expect(names.at(-1)).toBe('STATE_READY');
    expect(r!.events.find((e) => e.event === 'ATTEMPT_STARTED')?.command).toBe('npm ci');
    // The container's own phases, with how long the install took.
    expect(r!.events.find((e) => e.event === 'INSTALL_SUCCESS')?.durationMs).toBeGreaterThanOrEqual(1900);
    // Each state's duration is filed under that state, not the one that followed it.
    const readyEvent = r!.events.find((e) => e.event === "STATE_READY");
    expect(readyEvent?.previous).toBe("WAITING_FOR_READY");
    const durations = phaseDurations(r!.events);
    expect(Object.keys(durations)).toContain('WAITING_FOR_READY');
    expect(Object.keys(durations)).not.toContain('STATE_READY');
    await m.shutdown();
  });

  it('carries a classified failure: category, retryability and next step', async () => {
    const store = new InMemoryDeploymentStore();
    const failed: ReadyOutcome = {
      state: ExecutionState.FAILED, hostPort: null, readiness: { ready: false, attempts: 0, elapsedMs: 0 } as ReadyOutcome['readiness'],
      failure: { code: FailureCode.BROKEN_IMPORT, message: "Cannot find module './feedbackPanel'", phase: 'start' },
    };
    const m = manager(store, failed);
    const s = await m.launch({ sourceDir: '/tmp/repo', image: 'devlaunch/node:20' });
    await until(() => s.state === ExecutionState.FAILED);
    await m.flushRecords();
    const r = await store.get(s.id);
    expect(r?.failure).toMatchObject({ code: 'BROKEN_IMPORT', category: 'STARTUP_ERROR', retryable: false });
    expect(r?.events.some((e) => e.event === 'FAILURE_CLASSIFIED' && /BROKEN_IMPORT \(STARTUP_ERROR/.test(e.detail ?? ''))).toBe(true);
    await m.shutdown();
  });

  it('is marked interrupted when a restart finds it still running', async () => {
    const store = new InMemoryDeploymentStore();
    await store.save({ id: 'old-deploy-1', state: 'WAITING_FOR_READY', createdAt: 1, updatedAt: 1, services: [], backing: [], containerIds: ['c9'], events: [] });
    await store.save({ id: 'old-deploy-2', state: 'READY', createdAt: 2, updatedAt: 2, services: [], backing: [], containerIds: [], events: [] });
    await store.save({ id: 'old-deploy-3', state: 'FAILED', createdAt: 3, updatedAt: 3, services: [], backing: [], containerIds: [], events: [] });
    const m = manager(store, {} as ReadyOutcome);
    expect(await m.recoverInterrupted()).toBe(2);
    const r1 = await store.get('old-deploy-1');
    expect(r1).toMatchObject({ state: 'FAILED', interrupted: true });
    expect(r1?.endedReason).toMatch(/interrupted by a DevLaunch restart while WAITING_FOR_READY/);
    expect(r1?.events.at(-1)?.event).toBe('INTERRUPTED_BY_RESTART');
    expect((await store.get('old-deploy-3'))?.interrupted).toBeUndefined();
    await m.shutdown();
  });

  it('is left alone when another DevLaunch process is still running it', async () => {
    // Audit A-12: a second server, or the test suite, starting up marked the dashboard's
    // running deployment as interrupted.
    const store = new InMemoryDeploymentStore();
    await store.save({ id: 'theirs', instance: 'live-1', state: 'READY', createdAt: 1, updatedAt: 1, services: [], backing: [], containerIds: [], events: [] });
    await store.save({ id: 'crashed', instance: 'dead-1', state: 'READY', createdAt: 2, updatedAt: 2, services: [], backing: [], containerIds: [], events: [] });
    const m = manager(store, {} as ReadyOutcome);
    expect(await m.recoverInterrupted(new Set(['live-1']))).toBe(1);
    expect((await store.get('theirs'))?.state).toBe('READY');
    expect((await store.get('crashed'))?.interrupted).toBe(true);
    await m.shutdown();
  });

  it('never holds a secret value, in the record or in any event', async () => {
    // R8: what is written to ~/.devlaunch/deployments must not carry a typed key, a
    // generated secret or a database password, whatever the plan held.
    const store = new InMemoryDeploymentStore();
    const secret = 'sk-live-NEVER-WRITE-THIS';
    const ready: ReadyOutcome = { state: ExecutionState.READY, hostPort: '1', url: 'http://localhost:1/', readiness: { ready: true, attempts: 1, elapsedMs: 1 } as ReadyOutcome['readiness'] };
    const exec = {
      async launch(o: { logs?: LogManager }) {
        return { container: { id: 'c-1' }, logs: o.logs ?? new LogManager(), waitForReady: async () => ready, clearStartupBudget: () => undefined, cleanup: async () => ({ errors: [] }) };
      },
    } as unknown as ExecutionManager;
    const m = new SessionManager(exec, {
      deploymentStore: store,
      analyzer: { analyze: async () => ({ warnings: [], envExample: [], lockfiles: [], frameworkConfigs: [] }) } as never,
      planner: {
        planRepository: async () => ({
          plan: RunPlanSchema.parse({
            runtime: { language: 'node', version: '20' }, packageManager: 'npm', installCommand: null, buildCommand: null,
            startCommand: 'npm start', workingDirectory: '.', expectedPort: 3000, planSource: 'rule-based',
            environmentVariables: [
              { key: 'OPENAI_API_KEY', value: secret, required: true },
              { key: 'DATABASE_URL', value: 'postgresql://postgres:pw-NEVER@postgres:5432/x', required: false },
            ],
          }),
          detected: 'node', warnings: [],
        }),
      } as never,
    });
    const s = await m.launch({ sourceDir: '/tmp/repo', image: 'devlaunch/node:20' });
    await until(() => s.state === ExecutionState.READY);
    await m.flushRecords();
    const written = JSON.stringify(await store.get(s.id));
    expect(written).toContain('READY');
    expect(written).not.toContain(secret);
    expect(written).not.toContain('pw-NEVER');
    await m.shutdown();
  });

  it('records which process ran it', async () => {
    const store = new InMemoryDeploymentStore();
    const failed: ReadyOutcome = {
      state: ExecutionState.FAILED, hostPort: null, readiness: { ready: false, attempts: 0, elapsedMs: 0 } as ReadyOutcome['readiness'],
      failure: { code: FailureCode.START_COMMAND_FAILED, message: 'x', phase: 'start' },
    };
    const m = manager(store, failed);
    const s = await m.launch({ sourceDir: '/tmp/repo', image: 'devlaunch/node:20' });
    await until(() => s.state === ExecutionState.FAILED);
    await m.flushRecords();
    expect((await store.get(s.id))?.instance).toMatch(/^[0-9a-f-]{36}$/);
    await m.shutdown();
  });
});
