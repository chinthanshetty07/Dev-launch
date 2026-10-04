import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ExecutionState } from '@devlaunch/shared';
import { DockerManager } from '../../services/docker/DockerManager.js';
import { ExecutionManager } from '../../services/execution/ExecutionManager.js';
import { SessionManager } from '../../services/session/SessionManager.js';
import { RepositoryAnalyzer } from '../../services/analysis/RepositoryAnalyzer.js';
import { RuleBasedPlanner } from '../../services/planning/RuleBasedPlanner.js';
import { CleanupManager } from '../../services/cleanup/CleanupManager.js';
import { config } from '../../config/index.js';

/** Two deployments at once, against real Docker: nothing shared, and stopping one leaves the other. */
const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../fixtures');
const docker = new DockerManager();
let m: SessionManager;

async function until(id: string, states: ExecutionState[]) {
  for (let i = 0; i < 1500; i++) {
    const s = m.get(id);
    if (s && states.includes(s.state)) return s.state;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out: ${m.get(id)?.state}`);
}

describe('two deployments at once', () => {
  beforeAll(async () => {
    await docker.ping();
    const analyzer = new RepositoryAnalyzer();
    m = new SessionManager(new ExecutionManager(docker), { analyzer, planner: new RuleBasedPlanner(analyzer), maxConcurrent: 2, smokeTest: true });
  });
  afterAll(async () => {
    await m.shutdown();
    await CleanupManager.sweepOrphans(docker);
  });

  it('run side by side, own nothing in common, and stop independently', async () => {
    const a = await m.launch({ sourceDir: `${FIXTURES}/node-http-basic` });
    const b = await m.launch({ sourceDir: `${FIXTURES}/python-flask-factory` });
    expect(await until(a.id, [ExecutionState.READY, ExecutionState.PARTIALLY_READY, ExecutionState.FAILED]), JSON.stringify(a.failure)).toBe(ExecutionState.READY);
    expect(await until(b.id, [ExecutionState.READY, ExecutionState.PARTIALLY_READY, ExecutionState.FAILED]), JSON.stringify(b.failure)).toBe(ExecutionState.READY);

    const of = async (id: string) => (await docker.listManaged('all')).filter((c) => c.Labels?.[config.docker.sessionLabel] === id).map((c) => c.Id);
    const aContainers = await of(a.id);
    const bContainers = await of(b.id);
    expect(aContainers.length).toBeGreaterThan(0);
    expect(bContainers.length).toBeGreaterThan(0);
    expect(aContainers.filter((c) => bContainers.includes(c))).toEqual([]);
    expect(a.url).not.toBe(b.url);
    const aVolumes = await docker.listWorkspaceVolumes({ sessionId: a.id });
    const bVolumes = await docker.listWorkspaceVolumes({ sessionId: b.id });
    expect(aVolumes.filter((v) => bVolumes.includes(v))).toEqual([]);

    await m.cancel(a.id);
    expect(await of(a.id)).toEqual([]);
    expect(m.get(b.id)?.state).toBe(ExecutionState.READY);
    expect((await fetch(b.url!)).status).toBe(200);
    expect(await of(b.id)).toEqual(bContainers);
  }, 600_000);
});
