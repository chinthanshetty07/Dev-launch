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
import { runNetworkName } from '../../services/execution/RunNetworks.js';

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

    // Each on a network of its own, neither able to reach the other (verifier D-8).
    const networkOf = async (id: string) => {
      const info = await docker.getContainer(id).inspect();
      const [name, net] = Object.entries(info.NetworkSettings.Networks)[0]!;
      return { name, ip: net.IPAddress };
    };
    const aNet = await networkOf(aContainers[0]!);
    const bNet = await networkOf(bContainers[0]!);
    expect(aNet.name).toBe(runNetworkName(a.id));
    expect(bNet.name).toBe(runNetworkName(b.id));
    const reach = async (from: string, host: string, port: number) =>
      (await docker.execCapture(docker.getContainer(from), ['node', '-e',
        `const s=require('net').connect(${port},'${host}');s.on('connect',()=>{console.log('REACHED');process.exit(0)});` +
        `s.on('error',()=>{console.log('BLOCKED');process.exit(0)});setTimeout(()=>{console.log('BLOCKED');process.exit(0)},3000)`])).trim();
    const aPort = a.plan!.expectedPort!;
    const bPort = b.plan!.expectedPort!;
    // The check can tell: a run reaches its own service.
    expect(await reach(aContainers[0]!, aNet.ip, aPort)).toBe('REACHED');
    expect(await reach(aContainers[0]!, bNet.ip, bPort)).toBe('BLOCKED');

    await m.cancel(a.id);
    expect(await of(a.id)).toEqual([]);
    expect(await docker.networkExists(aNet.name), "the stopped run's network is gone").toBe(false);
    expect(m.get(b.id)?.state).toBe(ExecutionState.READY);
    expect((await fetch(b.url!)).status).toBe(200);
    expect(await of(b.id)).toEqual(bContainers);
    await m.cancel(b.id);
    expect(await docker.networkExists(bNet.name)).toBe(false);
  }, 600_000);
});
