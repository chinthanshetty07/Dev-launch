import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ExecutionState } from '@devlaunch/shared';
import { DockerManager } from '../../services/docker/DockerManager.js';
import { ExecutionManager } from '../../services/execution/ExecutionManager.js';
import { SessionManager } from '../../services/session/SessionManager.js';
import { RepositoryAnalyzer } from '../../services/analysis/RepositoryAnalyzer.js';
import { RuleBasedPlanner } from '../../services/planning/RuleBasedPlanner.js';
import { ProjectPlanner } from '../../services/planning/ProjectPlanner.js';
import { CleanupManager } from '../../services/cleanup/CleanupManager.js';

/**
 * The end-to-end smoke test against real containers: the in-container connection checks
 * run in DevLaunch's own Node and Python images, against databases it really started.
 */
const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../fixtures');
const docker = new DockerManager();
const analyzer = new RepositoryAnalyzer();
const created: SessionManager[] = [];

function newManager(): SessionManager {
  const planner = new RuleBasedPlanner(analyzer);
  const m = new SessionManager(new ExecutionManager(docker), {
    analyzer, planner, projectPlanner: new ProjectPlanner(analyzer, planner), smokeTest: true,
  });
  created.push(m);
  return m;
}

async function until(m: SessionManager, id: string, states: ExecutionState[], timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = m.get(id);
    if (s && states.includes(s.state)) return s.state;
    if (Date.now() > deadline) throw new Error(`timed out; ${s?.state} ${JSON.stringify(s?.failure)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe('the smoke test, for real', () => {
  beforeAll(async () => {
    await docker.ping();
  });
  afterAll(async () => {
    await Promise.all(created.map((m) => m.shutdown().catch(() => undefined)));
    await CleanupManager.sweepOrphans(docker);
  });

  it('verifies a frontend, its API and its database before calling it READY (node-fullstack)', async () => {
    const m = newManager();
    const s = await m.launch({ sourceDir: `${FIXTURES}/node-fullstack` });
    const first = await until(m, s.id, [ExecutionState.AWAITING_INPUT, ExecutionState.READY, ExecutionState.PARTIALLY_READY, ExecutionState.FAILED]);
    if (first === ExecutionState.AWAITING_INPUT) await m.resolve(s.id, { env: { PAYMENT_API_KEY: 'supplied-by-the-test' } });
    const end = await until(m, s.id, [ExecutionState.READY, ExecutionState.PARTIALLY_READY, ExecutionState.FAILED]);

    const checks = s.verification?.checks.map((c) => `${c.kind}:${c.name}:${c.passed}${c.skipped ? ':skipped' : ''}`) ?? [];
    expect(end, `${JSON.stringify(s.failure)}\n${checks.join('\n')}`).toBe(ExecutionState.READY);
    expect(s.verification?.passed).toBe(true);
    // Every kind of check ran, and none was skipped: the connections were made from
    // inside the Node containers.
    expect(new Set(s.verification!.checks.map((c) => c.kind))).toEqual(new Set(['http', 'wiring', 'dependency']));
    expect(s.verification!.checks.some((c) => c.skipped)).toBe(false);
    expect(checks).toContain('dependency:backend → mongodb:true');
  }, 600_000);

  it('runs the database check from a Python container too (python-async-postgres)', async () => {
    const m = newManager();
    const s = await m.launch({ sourceDir: `${FIXTURES}/python-async-postgres` });
    const end = await until(m, s.id, [ExecutionState.READY, ExecutionState.PARTIALLY_READY, ExecutionState.FAILED]);
    expect(end, JSON.stringify(s.failure)).toBe(ExecutionState.READY);
    const dep = s.verification?.checks.find((c) => c.kind === 'dependency');
    expect(dep).toMatchObject({ name: 'app → postgres', passed: true, target: 'postgres:5432' });
    expect(dep?.skipped).toBeUndefined();
  }, 600_000);
});
