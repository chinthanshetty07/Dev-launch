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
import { config } from '../../config/index.js';
import { BuildSandbox, builtImageTag } from '../../services/docker/BuildSandbox.js';
import { runNetworkName } from '../../services/execution/RunNetworks.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A repository's own Docker setup, run for real: the fallback for what DevLaunch cannot
 * run its own way, at the balanced safety level the user chose. Built in the
 * network-isolated sandbox, run under the balanced profile, checked like any other run,
 * and gone without trace when it stops.
 */
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
    smokeTest: true,
  });
  created.push(mgr);
  return mgr;
}

async function until(sessions: SessionManager, id: string, states: ExecutionState[], timeoutMs = 600_000): Promise<ExecutionState> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = sessions.get(id);
    if (s && states.includes(s.state)) return s.state;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${states.join('/')}; session is ${s?.state} (${JSON.stringify(s?.failure)})`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

const SETTLED = [ExecutionState.READY, ExecutionState.PARTIALLY_READY, ExecutionState.FAILED];
const log = (s: { logs: { buffer: { all(): { text: string }[] } } }) => s.logs.buffer.all().map((l) => l.text).join('\n');
const leftovers = async (sessionId: string) => {
  const client = docker.client();
  const containers = await client.listContainers({ all: true, filters: { label: [`${config.docker.sessionLabel}=${sessionId}`] } });
  const images = await client.listImages({ filters: { label: [`${config.docker.sessionLabel}=${sessionId}`] } });
  return { containers: containers.length, images: images.length };
};

describe("a repository's own Docker setup", () => {
  beforeAll(async () => {
    await docker.ping();
  }, 60_000);

  afterAll(async () => {
    for (const mgr of created) await mgr.shutdown();
    await CleanupManager.sweepOrphans(docker);
  }, 180_000);

  it('runs a Go service from its Dockerfile, under the balanced profile, and leaves nothing behind', async () => {
    const m = newManager();
    const s = await m.launch({ sourceDir: `${FIXTURES}/docker-go-api` });
    expect(await until(m, s.id, SETTLED), JSON.stringify(s.failure)).toBe(ExecutionState.READY);
    expect(s.project?.planSource).toBe('repo-docker');
    expect(log(s)).toMatch(/Running it from its own Dockerfile instead/);
    expect(await (await fetch(s.url!)).text()).toMatch(/hello from a Go service/);
    expect(s.verification?.passed).toBe(true);

    const info = await s.run!.services[0]!.handle.container.inspect();
    expect(info.HostConfig.Privileged).toBe(false);
    expect(info.HostConfig.CapAdd ?? []).toEqual([]);
    expect(info.HostConfig.CapDrop).toContain('NET_RAW');
    expect(info.HostConfig.SecurityOpt).toContain('no-new-privileges');
    // Was `devlaunch-net`: every run now has a network of its own, under the same egress
    // rules (verifier D-8), so two runs at once cannot reach each other.
    expect(info.HostConfig.NetworkMode).toBe(runNetworkName(s.id));
    expect(info.HostConfig.Binds ?? []).toEqual([]);
    expect(info.HostConfig.Memory).toBeGreaterThan(0);

    await m.cancel(s.id);
    expect(await leftovers(s.id)).toEqual({ containers: 0, images: 0 });
    expect(await docker.networkExists(runNetworkName(s.id))).toBe(false);
  }, 900_000);

  it('runs a compose project in depends_on order, reaching its databases by their compose names', async () => {
    const m = newManager();
    const s = await m.launch({ sourceDir: `${FIXTURES}/docker-compose-stack` });
    expect(await until(m, s.id, SETTLED), JSON.stringify(s.failure)).toBe(ExecutionState.READY);
    expect(s.run!.services.map((sv) => sv.name)).toEqual(['db', 'cache', 'api']);
    // The API answers 200 only when it reaches both db:5432 and cache:6379.
    const res = await fetch(s.url!);
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/reached db and cache/);
    // The database counted as accepting only once Postgres itself said so.
    const text = log(s);
    expect(text.indexOf('[db] accepting connections on 5432')).toBeGreaterThan(text.indexOf('database system is ready to accept connections'));

    await m.cancel(s.id);
    expect(await leftovers(s.id)).toEqual({ containers: 0, images: 0 });
  }, 900_000);

  it('serves on the port its base image declares when its own Dockerfile names none', async () => {
    // `FROM nginx` and no EXPOSE of its own: the port comes from the image. Read only from
    // the repository's files, this ran as a worker with nothing to open.
    const m = newManager();
    const s = await m.launch({ sourceDir: `${FIXTURES}/docker-base-image-port` });
    expect(await until(m, s.id, SETTLED), JSON.stringify(s.failure)).toBe(ExecutionState.READY);
    expect(log(s)).toMatch(/The image declares port 80; serving on 80/);
    expect(await (await fetch(s.url!)).text()).toMatch(/served on the port nginx declares/);
    await m.cancel(s.id);
    expect(await leftovers(s.id)).toEqual({ containers: 0, images: 0 });
  }, 900_000);

  it('falls back to the PORT convention when nothing declares a port', async () => {
    // GoogleCloudPlatform/cloud-run-hello declares none and listens on $PORT (8080).
    const m = newManager();
    const s = await m.launch({ sourceDir: `${FIXTURES}/docker-port-convention` });
    expect(await until(m, s.id, SETTLED), JSON.stringify(s.failure)).toBe(ExecutionState.READY);
    expect(log(s)).toMatch(/setting PORT=8080, the hosted-runtime convention/);
    expect(await (await fetch(s.url!)).text()).toMatch(/listening on PORT/);
    await m.cancel(s.id);
  }, 900_000);

  it('refuses a compose file that asks for privileges or the Docker socket, naming them, and starts nothing', async () => {
    const m = newManager();
    const s = await m.launch({ sourceDir: `${FIXTURES}/docker-refused` });
    await until(m, s.id, [ExecutionState.FAILED]);
    expect(s.failure?.code).toBe(FailureCode.UNSUPPORTED_PROJECT);
    expect(s.failure?.message).toMatch(/`privileged`/);
    expect(s.failure?.message).toMatch(/Docker socket/);
    expect(await leftovers(s.id)).toEqual({ containers: 0, images: 0 });
  }, 120_000);

  it('refuses a download the Docker daemon would make itself, naming it, and builds nothing', async () => {
    // `ADD http://169.254.169.254/…` is fetched by dockerd on the VM's own network, outside
    // the egress rules a RUN step meets (verifier D-1).
    const m = newManager();
    const s = await m.launch({ sourceDir: `${FIXTURES}/docker-daemon-fetch` });
    expect(await until(m, s.id, [ExecutionState.FAILED])).toBe(ExecutionState.FAILED);
    expect(s.failure?.code).toBe(FailureCode.PLAN_REJECTED_UNSAFE_COMMAND);
    expect(s.failure?.message).toMatch(/ADD http:\/\/169\.254\.169\.254/);
    expect(log(s)).not.toMatch(/Step 1\//);
    expect(await leftovers(s.id)).toEqual({ containers: 0, images: 0 });
  }, 120_000);

  it('keeps a build and the container it makes off the local network and cloud metadata', async () => {
    const m = newManager();
    const s = await m.launch({ sourceDir: `${FIXTURES}/docker-breakout` });
    expect(await until(m, s.id, SETTLED), JSON.stringify(s.failure)).toBe(ExecutionState.READY);
    // The RUN probes print when the container starts; wait for them.
    const deadline = Date.now() + 60_000;
    while (!/RUN (BLOCKED|REACHED) 192\.168\.1\.1/.test(log(s)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));
    const text = log(s);
    for (const phase of ['BUILD', 'RUN']) {
      for (const target of ['169.254.169.254', '172.17.0.1', '172.31.250.1', '10.0.0.1', '192.168.1.1']) {
        expect(text, `${phase} ${target}`).toContain(`${phase} BLOCKED ${target}`);
      }
    }
    // Probe results only: the logged build step itself contains the script's own words.
    expect(text).not.toMatch(/(?:BUILD|RUN) REACHED/);
    await m.cancel(s.id);
  }, 900_000);
});

describe('the build process cap (verifier D-2)', () => {
  it('is in place on this VM, as ./devlaunch install leaves it', async () => {
    expect(await new BuildSandbox(docker.client()).ready()).toBeNull();
  }, 60_000);

  it('stops a build step that starts processes without end, and the VM carries on', async () => {
    // Not a real fork bomb: 3,000 sleeping processes, more than the cap (2,048) and far
    // fewer than would hurt the VM if the cap were missing. Without the cap all 3,000
    // start and the build succeeds — measured — so success here would mean no cap.
    const dir = await mkdtemp(join(tmpdir(), 'devlaunch-cap-'));
    await writeFile(join(dir, 'Dockerfile'), 'FROM alpine:3.20\nRUN i=0; while [ $i -lt 3000 ]; do sleep 20 & i=$((i+1)); done; echo "started $i"\n');
    const sandbox = new BuildSandbox(docker.client(), { memoryMb: 1024, cpus: 1 });
    const lines: string[] = [];
    const sessionId = `cap-test-${Date.now()}`;
    try {
      const r = await sandbox.build({
        sessionId, service: 'cap', contextDir: dir, dockerfile: join(dir, 'Dockerfile'),
        timeoutMs: 180_000, onLine: (_s, l) => lines.push(l),
      });
      expect(r.ok).toBe(false);
      expect(lines.join('\n')).toMatch(/can't fork|Resource temporarily unavailable/);
      expect(lines.join('\n')).not.toMatch(/started 3000/);
    } finally {
      await sandbox.remove(builtImageTag(sessionId, 'cap'));
      await rm(dir, { recursive: true, force: true });
    }
    // The VM still starts containers.
    await expect(docker.ping()).resolves.toBeUndefined();
  }, 240_000);
});
