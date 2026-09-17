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

/**
 * Answer the configuration gate, if the project stops at one.
 *
 * The fixture's backend declares APP_SECRET with no value and refuses to start without
 * it, so every test that expects a running project has to supply it — which is the gate
 * doing its job rather than an inconvenience.
 */
async function resolveGate(sessions: SessionManager, id: string): Promise<void> {
  await until(sessions, id, [
    ExecutionState.AWAITING_INPUT,
    ExecutionState.READY,
    ExecutionState.FAILED,
  ]);
  if (sessions.get(id)?.state !== ExecutionState.AWAITING_INPUT) return;
  await sessions.resolve(id, { env: { APP_SECRET: 'supplied-by-the-test' } });
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

  it('provisions the database the repository expects, and injects what it reads', async () => {
    // The last thing standing between a real repository and running: MongoDB was never
    // started, so its backend exited at boot with `connect ECONNREFUSED 127.0.0.1:27017`
    // however well the rest of the project was orchestrated.
    const sessions = newManager();
    const s = await sessions.launch({ sourceDir: `${FIXTURES}/node-fullstack` });
    await resolveGate(sessions, s.id);
    expect(await until(sessions, s.id, [ExecutionState.READY, ExecutionState.FAILED])).toBe(
      ExecutionState.READY,
    );

    expect(s.run?.backing.map((b) => `${b.kind}:${b.ready}`)).toEqual(['mongodb:true']);

    // The backend refuses to serve unless it actually reached the database, so a 200 is
    // proof of the whole chain: provisioned, healthy, named, injected, and connected.
    const api = s.run!.services.find((sv) => sv.role === 'api')!;
    expect(api.state).toBe(ExecutionState.READY);
    const body = (await (await fetch(api.url!)).json()) as { database?: string };
    expect(body).toMatchObject({ ok: true, service: 'backend' });
    expect(body.database).toContain('mongodb:27017');

    await sessions.stop(s.id);
  }, 420_000);

  it('removes the database container with the session', async () => {
    const sessions = newManager();
    const s = await sessions.launch({ sourceDir: `${FIXTURES}/node-fullstack` });
    await resolveGate(sessions, s.id);
    await until(sessions, s.id, [ExecutionState.READY, ExecutionState.FAILED]);
    const dbId = s.run!.backing[0]!.container.id;

    await sessions.stop(s.id);

    const alive = await docker.listManaged();
    expect(alive.map((c) => c.Id), 'a database must not outlive its session').not.toContain(dbId);
  }, 420_000);

  it('publishes the API where the frontend is hardcoded to look', async () => {
    // The last thing standing between a healthy stack and a working page. The browser
    // resolves `http://localhost:5001` itself, so a container alias cannot satisfy it
    // and a random host port guarantees `Failed to fetch`.
    const sessions = newManager();
    const s = await sessions.launch({ sourceDir: `${FIXTURES}/node-fullstack` });
    await resolveGate(sessions, s.id);
    expect(await until(sessions, s.id, [ExecutionState.READY, ExecutionState.FAILED])).toBe(
      ExecutionState.READY,
    );

    const api = s.run!.services.find((sv) => sv.role === 'api')!;
    // 5001 may be occupied on the machine running these tests, in which case DevLaunch
    // says so rather than pretending; the guarantee is that it tried.
    const substituted = s.logs.buffer.all().some((l) => /Port 5001 is in use/.test(l.text));
    if (!substituted) expect(api.hostPort).toBe(5001);

    // Whichever port it landed on, the frontend is told about it and CORS allows it.
    const web = s.run!.services.find((sv) => sv.role === 'web')!;
    const apiUrl = web.plan.environmentVariables.find((v) => v.key === 'VITE_API_URL')?.value;
    expect(apiUrl).toBe(`http://localhost:${api.hostPort}`);

    const corsOrigin = api.plan.environmentVariables.find((v) => v.key === 'CORS_ORIGIN')?.value;
    expect(corsOrigin).toBe(`http://localhost:${web.hostPort}`);

    // And the wiring actually reached the process, not just the plan.
    const page = await (await fetch(web.url!)).text();
    expect(page).toContain(`data-api="http://localhost:${api.hostPort}"`);

    await sessions.stop(s.id);
  }, 420_000);

  it('runs both halves of a frontend/backend repository', async () => {
    // The shape that made a real repository look broken: running only the frontend
    // produced a page that loaded and then failed every request it made.
    const sessions = newManager();
    const s = await sessions.launch({ sourceDir: `${FIXTURES}/node-fullstack` });
    await resolveGate(sessions, s.id);

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
    await resolveGate(sessions, s.id);
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
    await resolveGate(sessions, s.id);
    await until(sessions, s.id, [ExecutionState.READY, ExecutionState.FAILED]);

    const text = s.logs.buffer.all().map((l) => l.text);
    expect(text.some((l) => /^\[frontend]/.test(l))).toBe(true);
    expect(text.some((l) => /^\[backend]/.test(l))).toBe(true);

    await sessions.stop(s.id);
  }, 300_000);

  it('releases every container when the session ends', async () => {
    const sessions = newManager();
    const s = await sessions.launch({ sourceDir: `${FIXTURES}/node-fullstack` });
    await resolveGate(sessions, s.id);
    await until(sessions, s.id, [ExecutionState.READY, ExecutionState.FAILED]);
    const ids = s.run!.services.map((sv) => sv.handle.container.id);
    expect(ids.length).toBe(2);

    await sessions.stop(s.id);

    const alive = await docker.listManaged();
    for (const id of ids) {
      expect(alive.map((c) => c.Id), 'a stopped project must leave nothing running').not.toContain(id);
    }
  }, 300_000);

  it('restarts one service without disturbing the others or its address', async () => {
    // The control a person reaches for when an application wedges. Re-cloning to get it
    // is a heavy answer, and a restart that moved the port would break every sibling
    // that had been told where to find it.
    const sessions = newManager();
    const s = await sessions.launch({ sourceDir: `${FIXTURES}/node-fullstack` });
    await resolveGate(sessions, s.id);
    await until(sessions, s.id, [ExecutionState.READY, ExecutionState.FAILED]);
    expect(s.state).toBe(ExecutionState.READY);

    const before = s.run!.services.find((sv) => sv.role === 'api')!;
    const beforeId = before.handle.container.id;
    const beforePort = before.hostPort;
    const webId = s.run!.services.find((sv) => sv.role === 'web')!.handle.container.id;

    await sessions.restart(s.id, 'backend');
    expect(s.state).toBe(ExecutionState.READY);

    const after = s.run!.services.find((sv) => sv.role === 'api')!;
    expect(after.handle.container.id, 'a restart must be a new container').not.toBe(beforeId);
    // Read back from Docker, not from our own bookkeeping: the recorded port would look
    // unchanged even if the new container had been published somewhere else entirely.
    expect(
      Number(await after.handle.hostPort()),
      'the address siblings were told about must survive',
    ).toBe(beforePort);
    expect(after.plan.environmentVariables.find((v) => v.key === 'MONGODB_URI')?.value).toMatch(
      /^mongodb:\/\/mongodb:27017\//,
    );
    // The untouched service is genuinely untouched.
    expect(s.run!.services.find((sv) => sv.role === 'web')!.handle.container.id).toBe(webId);
    expect((await fetch(after.url!)).status).toBe(200);

    await sessions.stop(s.id);
  }, 420_000);

  it('reports what each container is consuming', async () => {
    const sessions = newManager();
    const s = await sessions.launch({ sourceDir: `${FIXTURES}/node-fullstack` });
    await resolveGate(sessions, s.id);
    await until(sessions, s.id, [ExecutionState.READY, ExecutionState.FAILED]);

    const stats = await sessions.stats(s.id);
    expect(Object.keys(stats).sort()).toEqual(['backend', 'frontend', 'mongodb']);
    for (const [name, sample] of Object.entries(stats)) {
      expect(sample.memoryBytes, `${name} should be using memory`).toBeGreaterThan(0);
      expect(sample.memoryLimitBytes, `${name} should have a ceiling`).toBeGreaterThan(0);
      expect(sample.cpuPercent).toBeGreaterThanOrEqual(0);
    }

    await sessions.stop(s.id);
  }, 420_000);

  it('asks for a secret declared beside the service that needs it', async () => {
    // The gap this closes: the gate read only the repository root, so a backend's
    // API key was never asked for and its container started without one — surfacing as
    // an application crash with the reason buried in its own logs.
    const sessions = newManager();
    const s = await sessions.launch({ sourceDir: `${FIXTURES}/node-fullstack` });

    expect(await until(sessions, s.id, [ExecutionState.AWAITING_INPUT, ExecutionState.FAILED])).toBe(
      ExecutionState.AWAITING_INPUT,
    );
    expect(s.pending?.requiredEnv).toEqual([
      { key: 'APP_SECRET', hasDefault: false, service: 'backend' },
    ]);

    // And nothing DevLaunch supplies itself: the database URL, the sibling addresses and
    // the port are all decided later, so asking would be asking a person to guess.
    const asked = s.pending!.requiredEnv.map((v) => v.key);
    expect(asked).not.toContain('MONGODB_URI');
    expect(asked).not.toContain('CORS_ORIGIN');
    expect(asked).not.toContain('PORT');

    await sessions.resolve(s.id, { env: { APP_SECRET: 'from-the-gate' } });
    expect(await until(sessions, s.id, [ExecutionState.READY, ExecutionState.FAILED])).toBe(
      ExecutionState.READY,
    );

    // The value reached the process, not merely the plan.
    const api = s.run!.services.find((sv) => sv.role === 'api')!;
    const body = (await (await fetch(api.url!)).json()) as { secret?: string };
    expect(body.secret).toBe('from-the-gate');

    await sessions.stop(s.id);
  }, 420_000);

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
