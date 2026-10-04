import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ExecutionState, FailureCode, RunPlanSchema } from '@devlaunch/shared';
import { createApp } from '../api/app.js';
import { SessionManager } from '../services/session/SessionManager.js';
import { InMemoryDeploymentStore } from '../services/session/DeploymentStore.js';
import type { ExecutionManager, LaunchHandle, ReadyOutcome } from '../services/execution/ExecutionManager.js';
import { LogManager } from '../services/logs/LogManager.js';

/**
 * The deployment API against a real Express server and a stubbed executor: routing, the
 * one error shape, identity, timeline, records after a "restart", retry and delete.
 */
const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../fixtures');
let outcome: ReadyOutcome;
const exec = {
  async launch(o: { logs?: LogManager }) {
    const logs = o.logs ?? new LogManager();
    logs.buffer.push('stdout', 'server listening');
    return { container: { id: 'c-1' }, logs, waitForReady: async () => outcome, clearStartupBudget: () => undefined, cleanup: async () => ({ errors: [] }) } as unknown as LaunchHandle;
  },
} as unknown as ExecutionManager;
const plan = RunPlanSchema.parse({
  runtime: { language: 'node', version: '20' }, packageManager: 'npm', installCommand: null, buildCommand: null,
  startCommand: 'node server.js', workingDirectory: '.', expectedPort: 3000, environmentVariables: [], planSource: 'rule-based',
});
const store = new InMemoryDeploymentStore();
const sessions = new SessionManager(exec, {
  deploymentStore: store,
  analyzer: { analyze: async () => ({ envExample: [], warnings: [] }) } as never,
  planner: { planRepository: async () => ({ plan, detected: 'node', warnings: [] }) } as never,
});
let server: Server;
let base = '';
beforeAll(async () => {
  server = createServer(createApp({ sessions, fixturesDir: FIXTURES, staticDirs: [] }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await sessions.shutdown();
  await new Promise((r) => server.close(r));
});
const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, body: (res.status === 204 ? null : await res.json()) as any };
};
const settle = async (id: string) => {
  for (let i = 0; i < 200; i++) {
    const s = sessions.get(id);
    if (s && [ExecutionState.READY, ExecutionState.FAILED].includes(s.state as never)) return;
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('the deployment API', () => {
  it('refuses a malformed request in the one error shape', async () => {
    for (const body of [{}, { repoUrl: 'not a url' }, { repoUrl: 'https://gitlab.com/a/b' }, { fixture: '../etc' }]) {
      const r = await call('POST', '/api/deployments', body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(Object.keys(r.body.error).sort(), JSON.stringify(body)).toEqual(['category', 'code', 'message', 'retryable', 'suggestedAction']);
    }
    expect((await call('GET', '/api/deployments/nope-nope-nope')).body.error.code).toBe('NOT_FOUND');
  });

  it('deploys, and reports identity, URLs, timeline, services, logs and health', async () => {
    outcome = { state: ExecutionState.READY, hostPort: '1', url: 'http://localhost:1/', readiness: { ready: true, attempts: 1, elapsedMs: 1 } as ReadyOutcome['readiness'] };
    const created = await call('POST', '/api/deployments', { fixture: 'node-http-basic' });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    await settle(id);

    const d = await call('GET', `/api/deployments/${id}`);
    expect(d.body, JSON.stringify(d.body.failure)).toMatchObject({ id, state: 'READY', live: true, identity: { id } });
    expect(d.body.primaryUrl).toBe('http://localhost:1/');
    const events = (await call('GET', `/api/deployments/${id}/events`)).body.events.map((e: { event: string }) => e.event);
    expect(events[0]).toBe('DEPLOYMENT_CREATED');
    expect(events.at(-1)).toBe('STATE_READY');
    expect((await call('GET', `/api/deployments/${id}/logs`)).body.entries.some((e: { text: string }) => e.text === 'server listening')).toBe(true);
    expect((await call('GET', `/api/deployments/${id}/health`)).body).toMatchObject({ id, state: 'READY', live: true });
    expect((await call('GET', '/api/deployments')).body.deployments.some((x: { id: string }) => x.id === id)).toBe(true);

    const cancelled = await call('POST', `/api/deployments/${id}/cancel`);
    expect(cancelled.body.state).toBe('CANCELLED');
  });

  it('carries a classified failure', async () => {
    outcome = {
      state: ExecutionState.FAILED, hostPort: null, readiness: { ready: false, attempts: 0, elapsedMs: 0 } as ReadyOutcome['readiness'],
      failure: { code: FailureCode.OUT_OF_MEMORY, message: 'killed at 1024 MB', phase: 'install' },
    };
    const { body } = await call('POST', '/api/deployments', { fixture: 'node-http-basic' });
    await settle(body.id);
    const d = await call('GET', `/api/deployments/${body.id}`);
    expect(d.body.failure).toMatchObject({ code: 'OUT_OF_MEMORY', category: 'OOM_ERROR', recoverable: true, phase: 'install' });
  });

  it('keeps a deployment from before a restart, says its logs are gone, and forgets it on DELETE', async () => {
    await store.save({ id: 'before-restart-1', state: 'FAILED', interrupted: true, repoUrl: 'https://github.com/a/b.git', commit: 'abc1234', createdAt: 1, updatedAt: 1, services: [], backing: [], containerIds: [], events: [{ at: 1, event: 'INTERRUPTED_BY_RESTART', severity: 'error' }] });
    const d = await call('GET', '/api/deployments/before-restart-1');
    expect(d.body).toMatchObject({ state: 'FAILED', live: false, interrupted: true, identity: { commit: 'abc1234' } });
    const logs = await call('GET', '/api/deployments/before-restart-1/logs');
    expect(logs.status).toBe(409);
    expect(logs.body.error.message).toMatch(/memory only/);
    expect((await call('DELETE', '/api/deployments/before-restart-1')).status).toBe(204);
    expect((await call('GET', '/api/deployments/before-restart-1')).status).toBe(404);
  });
});
