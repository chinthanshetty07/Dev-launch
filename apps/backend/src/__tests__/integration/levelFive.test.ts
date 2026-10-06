import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ExecutionState, FailureCode } from '@devlaunch/shared';
import { DockerManager } from '../../services/docker/DockerManager.js';
import { ExecutionManager } from '../../services/execution/ExecutionManager.js';
import { SessionManager } from '../../services/session/SessionManager.js';
import { RepositoryAnalyzer } from '../../services/analysis/RepositoryAnalyzer.js';
import { RuleBasedPlanner } from '../../services/planning/RuleBasedPlanner.js';
import { ProjectPlanner } from '../../services/planning/ProjectPlanner.js';
import { CleanupManager } from '../../services/cleanup/CleanupManager.js';

/**
 * Level-5 failure scenarios of the production-readiness brief that had no reproduction:
 * each ends in the right failure class at the right stage, and never READY.
 */
const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../fixtures');
const docker = new DockerManager();
const analyzer = new RepositoryAnalyzer();
const created: SessionManager[] = [];
const manager = () => {
  const planner = new RuleBasedPlanner(analyzer);
  const m = new SessionManager(new ExecutionManager(docker), { analyzer, planner, projectPlanner: new ProjectPlanner(analyzer, planner), smokeTest: true });
  created.push(m);
  return m;
};
async function settle(m: SessionManager, id: string, timeoutMs = 300_000): Promise<ExecutionState> {
  const done: ExecutionState[] = [ExecutionState.READY, ExecutionState.PARTIALLY_READY, ExecutionState.FAILED];
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = m.get(id)!;
    if (done.includes(s.state)) return s.state;
    if (Date.now() > deadline) throw new Error(`timed out in ${s.state}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

describe('level-5 failure scenarios', () => {
  beforeAll(async () => {
    await docker.ping();
    await docker.ensureImage('devlaunch/node:20');
  }, 300_000);
  afterAll(async () => {
    for (const m of created) await m.shutdown();
    await CleanupManager.sweepOrphans(docker);
  }, 180_000);

  it('an invalid package.json: said before anything starts, with the parser\'s words, no model asked', async () => {
    const m = manager();
    const s = await m.launch({ sourceDir: `${FIXTURES}/node-bad-manifest` });
    expect(await settle(m, s.id)).toBe(ExecutionState.FAILED);
    expect(s.failure?.code).toBe(FailureCode.INVALID_MANIFEST);
    expect(s.failure?.message).toMatch(/package\.json is not valid JSON/);
    expect(s.launchAttempts ?? []).toEqual([]);
  }, 120_000);

  it('a port conflict inside the application: named as one, not as a missing port or READY', async () => {
    const m = manager();
    const s = await m.launch({ sourceDir: `${FIXTURES}/node-port-conflict` });
    expect(await settle(m, s.id)).toBe(ExecutionState.FAILED);
    expect(s.failure?.code).toBe(FailureCode.PORT_NOT_LISTENING);
    expect(s.failure?.message).toMatch(/already in use/);
  }, 300_000);

  it('a frontend that runs while its backend fails: partly running, the backend named, the frontend kept', async () => {
    const m = manager();
    const s = await m.launch({ sourceDir: `${FIXTURES}/project-backend-fails` });
    expect(await settle(m, s.id)).toBe(ExecutionState.PARTIALLY_READY);
    expect(s.failure?.message).toMatch(/^backend: /);
    const frontend = s.run!.services.find((sv) => sv.name === 'frontend')!;
    expect(frontend.state).toBe(ExecutionState.READY);
    expect(await (await fetch(frontend.url!)).text()).toMatch(/page/);
  }, 300_000);

  it('a dependency from a host that does not exist: a dependency failure naming the host, not a network outage', async () => {
    const m = manager();
    const s = await m.launch({ sourceDir: `${FIXTURES}/node-install-network` });
    expect(await settle(m, s.id)).toBe(ExecutionState.FAILED);
    expect(s.failure?.code).toBe(FailureCode.DEPENDENCY_INSTALL_FAILED);
    expect(s.failure?.phase).toBe('install');
    expect(s.failure?.message).toMatch(/registry\.devlaunch-test\.invalid, which has no address/);
  }, 300_000);
});
