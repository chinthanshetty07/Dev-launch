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

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../fixtures');
const docker = new DockerManager();
const analyzer = new RepositoryAnalyzer();
const created: SessionManager[] = [];

function newManager(): SessionManager {
  const planner = new RuleBasedPlanner(analyzer);
  const mgr = new SessionManager(new ExecutionManager(docker), {
    analyzer,
    planner,
    projectPlanner: new ProjectPlanner(analyzer, planner),
  });
  created.push(mgr);
  return mgr;
}

async function until(
  sessions: SessionManager,
  id: string,
  states: ExecutionState[],
  timeoutMs = 180_000,
): Promise<ExecutionState> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = sessions.get(id);
    if (s && states.includes(s.state)) return s.state;
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for ${states.join('/')}; session is ${s?.state} ` +
          `(${JSON.stringify(s?.failure)})`,
      );
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe('a repository made of several services', () => {
  beforeAll(async () => {
    await docker.ping();
    await docker.ensureImage('devlaunch/node:20');
  }, 300_000);

  afterAll(async () => {
    for (const mgr of created) await mgr.shutdown();
    await CleanupManager.sweepOrphans(docker);
  }, 180_000);

  it('runs both halves of a frontend/backend repository', async () => {
    // The shape that made a real repository look broken: running only the frontend
    // produced a page that loaded and then failed every request it made.
    const sessions = newManager();
    const s = await sessions.launch({ sourceDir: `${FIXTURES}/node-fullstack` });

    expect(await until(sessions, s.id, [ExecutionState.READY, ExecutionState.FAILED])).toBe(
      ExecutionState.READY,
    );

    expect(s.project?.services.map((sv) => `${sv.role}:${sv.name}`)).toEqual([
      'web:frontend',
      'api:backend',
    ]);
    // Both are actually running, not merely planned.
    expect(s.run?.services.every((sv) => sv.state === ExecutionState.READY)).toBe(true);

    // The URL a person is given is the web front door, not whichever started first.
    const entry = s.run!.entry()!;
    expect(entry.role).toBe('web');
    expect(s.url).toBe(entry.url);
    expect((await fetch(s.url!)).status).toBe(200);

    await sessions.stop(s.id);
  }, 300_000);

  it('lets one service reach another by name', async () => {
    // The point of running them together. Container-to-container resolution is what
    // replaces the hardcoded localhost the browser cannot satisfy.
    const sessions = newManager();
    const s = await sessions.launch({ sourceDir: `${FIXTURES}/node-fullstack` });
    await until(sessions, s.id, [ExecutionState.READY, ExecutionState.FAILED]);
    expect(s.state).toBe(ExecutionState.READY);

    const web = s.run!.services.find((sv) => sv.role === 'web')!;
    const reply = await docker.execCapture(web.handle.container, [
      'node',
      '-e',
      "fetch('http://backend:5000').then(r=>r.text()).then(t=>console.log(t)).catch(e=>console.log('FAILED:'+(e.cause?.code||e.message)))",
    ]);

    expect(reply, 'the web service must be able to reach the api service by name').toContain(
      '"service":"backend"',
    );

    await sessions.stop(s.id);
  }, 300_000);

  it('tags every log line with the service that produced it', async () => {
    // One stream carrying several services is unreadable without attribution, and the
    // existing socket protocol carries one stream per session.
    const sessions = newManager();
    const s = await sessions.launch({ sourceDir: `${FIXTURES}/node-fullstack` });
    await until(sessions, s.id, [ExecutionState.READY, ExecutionState.FAILED]);

    const text = s.logs.buffer.all().map((l) => l.text);
    expect(text.some((l) => /^\[frontend]/.test(l))).toBe(true);
    expect(text.some((l) => /^\[backend]/.test(l))).toBe(true);

    await sessions.stop(s.id);
  }, 300_000);

  it('releases every container when the session ends', async () => {
    const sessions = newManager();
    const s = await sessions.launch({ sourceDir: `${FIXTURES}/node-fullstack` });
    await until(sessions, s.id, [ExecutionState.READY, ExecutionState.FAILED]);
    const ids = s.run!.services.map((sv) => sv.handle.container.id);
    expect(ids.length).toBe(2);

    await sessions.stop(s.id);

    const alive = await docker.listManaged();
    for (const id of ids) {
      expect(alive.map((c) => c.Id), 'a stopped project must leave nothing running').not.toContain(id);
    }
  }, 300_000);

  it('leaves a single-service repository on the path that already works', async () => {
    const sessions = newManager();
    const s = await sessions.launch({ sourceDir: `${FIXTURES}/node-http-basic` });
    await until(sessions, s.id, [ExecutionState.READY, ExecutionState.FAILED]);

    expect(s.state).toBe(ExecutionState.READY);
    expect(s.project, 'one service is not a project').toBeUndefined();
    expect(s.run).toBeUndefined();
    expect(s.handle).toBeDefined();

    await sessions.stop(s.id);
  }, 300_000);
});
