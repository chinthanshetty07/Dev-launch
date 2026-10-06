import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ExecutionState, RunPlanSchema } from '@devlaunch/shared';
import { DockerManager } from '../../services/docker/DockerManager.js';
import { ExecutionManager } from '../../services/execution/ExecutionManager.js';
import { SessionManager } from '../../services/session/SessionManager.js';
import { RepositoryAnalyzer } from '../../services/analysis/RepositoryAnalyzer.js';
import { RuleBasedPlanner } from '../../services/planning/RuleBasedPlanner.js';
import { ProjectPlanner } from '../../services/planning/ProjectPlanner.js';
import { CleanupManager } from '../../services/cleanup/CleanupManager.js';
import { config } from '../../config/index.js';

/**
 * Stop, cancel mid-install, replace, restart one service, and stopping one run while
 * another keeps going — on real Docker, each followed by a count of everything labelled
 * for that run: containers and volumes. R7 of the production-readiness mission.
 */
const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../fixtures');
const docker = new DockerManager();
const analyzer = new RepositoryAnalyzer();
const managers: SessionManager[] = [];
const manager = (maxConcurrent?: number) => {
  const planner = new RuleBasedPlanner(analyzer);
  const m = new SessionManager(new ExecutionManager(docker), {
    analyzer, planner, projectPlanner: new ProjectPlanner(analyzer, planner),
    ...(maxConcurrent ? { maxConcurrent } : {}),
  });
  managers.push(m);
  return m;
};
async function until(m: SessionManager, id: string, ok: (s: ExecutionState) => boolean, ms = 300_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ok(m.get(id)!.state)) {
    if (Date.now() > deadline) throw new Error(`timed out in ${m.get(id)!.state}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}
const serving = (s: ExecutionState) => s === ExecutionState.READY || s === ExecutionState.PARTIALLY_READY;
async function leftovers(sessionId: string): Promise<{ containers: number; volumes: number }> {
  const client = docker.client();
  const label = [`${config.docker.sessionLabel}=${sessionId}`];
  const containers = await client.listContainers({ all: true, filters: { label } });
  const { Volumes } = await client.listVolumes({ filters: { label } });
  return { containers: containers.length, volumes: (Volumes ?? []).length };
}

describe('the lifecycle of a run, on real Docker', () => {
  beforeAll(async () => {
    await docker.ping();
    await docker.ensureImage('devlaunch/node:20');
    await docker.ensureImage('devlaunch/python:3.12');
  }, 300_000);
  afterAll(async () => {
    for (const m of managers) await m.shutdown();
    await CleanupManager.sweepOrphans(docker);
  }, 180_000);

  it('cancelled during its install, leaves nothing', async () => {
    const m = manager();
    // An install that takes 75 s, run by the plan the fixture is written for.
    const s = await m.launch({
      sourceDir: `${FIXTURES}/python-slow-install`,
      image: 'devlaunch/python:3.12',
      plan: RunPlanSchema.parse({
        runtime: { language: 'python', version: '3.12' }, packageManager: 'pip',
        installCommand: 'python3 slow_install.py', buildCommand: null, startCommand: 'python3 app.py',
        workingDirectory: '.', expectedPort: 8000, planSource: 'rule-based',
      }),
    });
    const deadline = Date.now() + 120_000;
    while (!s.logs.buffer.all().some((l) => /resolving dependencies/.test(l.text)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 300));
    expect(s.logs.buffer.all().some((l) => /resolving dependencies/.test(l.text)), 'the install is under way').toBe(true);
    expect((await leftovers(s.id)).containers, 'its container exists').toBe(1);
    expect(s.state).not.toBe(ExecutionState.READY);
    await m.cancel(s.id);
    expect(s.state).toBe(ExecutionState.CANCELLED);
    expect(await leftovers(s.id)).toEqual({ containers: 0, volumes: 0 });
  }, 300_000);

  it('replaced by a new run, is stopped and leaves nothing, and the new one runs', async () => {
    const m = manager();
    const a = await m.launch({ sourceDir: `${FIXTURES}/node-http-basic` });
    await until(m, a.id, serving);
    const b = await m.launch({ sourceDir: `${FIXTURES}/node-http-basic`, replace: true });
    expect(a.state).toBe(ExecutionState.CANCELLED);
    expect(a.endedReason).toMatch(/^replaced by/);
    expect(await leftovers(a.id)).toEqual({ containers: 0, volumes: 0 });
    await until(m, b.id, serving);
    expect((await fetch(b.url!)).status).toBeLessThan(500);
    await m.cancel(b.id);
    expect(await leftovers(b.id)).toEqual({ containers: 0, volumes: 0 });
  }, 300_000);

  it('restarts one service of a project at the same address, and stops cleanly afterwards', async () => {
    const m = manager();
    const s = await m.launch({ sourceDir: `${FIXTURES}/project-backend-fails` });
    await until(m, s.id, serving);
    const frontend = () => s.run!.services.find((sv) => sv.name === 'frontend')!;
    const before = { url: frontend().url, container: frontend().handle.container.id };
    await m.restart(s.id, 'frontend');
    await until(m, s.id, serving);
    expect(frontend().state).toBe(ExecutionState.READY);
    expect(frontend().url).toBe(before.url);
    expect(frontend().handle.container.id).not.toBe(before.container);
    expect((await fetch(frontend().url!)).status).toBe(200);
    await m.cancel(s.id);
    expect(await leftovers(s.id)).toEqual({ containers: 0, volumes: 0 });
  }, 300_000);

  it('stopped, does not touch another run', async () => {
    const m = manager(2);
    const a = await m.launch({ sourceDir: `${FIXTURES}/node-http-basic` });
    const b = await m.launch({ sourceDir: `${FIXTURES}/node-http-basic` });
    await until(m, a.id, serving);
    await until(m, b.id, serving);
    await m.cancel(a.id);
    expect(await leftovers(a.id)).toEqual({ containers: 0, volumes: 0 });
    expect(b.state).toBe(ExecutionState.READY);
    expect((await fetch(b.url!)).status).toBeLessThan(500);
    expect((await leftovers(b.id)).containers).toBe(1);
    await m.cancel(b.id);
    expect(await leftovers(b.id)).toEqual({ containers: 0, volumes: 0 });
  }, 300_000);
});
