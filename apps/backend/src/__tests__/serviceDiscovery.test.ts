import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverServices } from '../services/analysis/ServiceDiscovery.js';
import { RepositoryAnalyzer } from '../services/analysis/RepositoryAnalyzer.js';

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../fixtures');

const scratch: string[] = [];
afterAll(async () => {
  await Promise.all(scratch.map((d) => rm(d, { recursive: true, force: true }).catch(() => undefined)));
});

/** Build a repository on disk from a path → contents map. */
async function repo(files: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'devlaunch-svc-'));
  scratch.push(root);
  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, typeof contents === 'string' ? contents : JSON.stringify(contents));
  }
  return root;
}

const pkg = (name: string, scripts: Record<string, string>, deps: Record<string, string> = {}) =>
  ({ name, scripts, dependencies: deps });

describe('service discovery', () => {
  it('finds both halves of a frontend/backend repository with no root manifest', async () => {
    // The shape that made a real repository look broken: DevLaunch ran the frontend, the
    // page loaded, and every request it made was refused because its API was never
    // started.
    const root = await repo({
      'frontend/package.json': pkg('web', { dev: 'vite' }, { react: '18' }),
      'backend/package.json': pkg('api', { start: 'node server.js' }, { express: '4' }),
    });

    const { services } = await discoverServices(root);
    expect(services.map((s) => `${s.role}:${s.dir}`)).toEqual(['web:frontend', 'api:backend']);
  });

  it('reports nothing for an ordinary single-service repository', async () => {
    // Inventing a second service would route a repository that already works down a path
    // built for a problem it does not have.
    const root = await repo({ 'package.json': pkg('solo', { start: 'node server.js' }, { express: '4' }) });
    const { services } = await discoverServices(root);
    expect(services).toEqual([]);
  });

  it('ignores directories that cannot be started', async () => {
    // A package with no dev or start script is a library. Two services plus a library is
    // still two services.
    const root = await repo({
      'frontend/package.json': pkg('web', { dev: 'vite' }, { react: '18' }),
      'backend/package.json': pkg('api', { start: 'node server.js' }, { express: '4' }),
      'shared/package.json': pkg('shared', { build: 'tsc' }),
    });
    const { services } = await discoverServices(root);
    expect(services.map((s) => s.dir)).toEqual(['frontend', 'backend']);
  });

  it('trusts dependencies over directory names', async () => {
    // A folder called `server` that imports React is a server-rendered frontend. The name
    // is the weaker signal and must not win.
    const root = await repo({
      'server/package.json': pkg('ssr', { dev: 'next dev' }, { react: '18', next: '14' }),
      'worker/package.json': pkg('jobs', { start: 'node worker.js' }, { bullmq: '5' }),
    });
    const { services } = await discoverServices(root);
    expect(services.find((s) => s.dir === 'server')?.role).toBe('web');
    expect(services.find((s) => s.dir === 'server')?.evidence).toMatch(/depends on/);
  });

  it('falls back to directory names when no framework is declared', async () => {
    const root = await repo({
      'client/package.json': pkg('c', { dev: 'node dev.js' }),
      'api/package.json': pkg('a', { start: 'node index.js' }),
    });
    const { services } = await discoverServices(root);
    expect(services.map((s) => `${s.role}:${s.dir}`)).toEqual(['web:client', 'api:api']);
    expect(services[0]!.evidence).toMatch(/directory named/);
  });

  it('looks inside apps/ and packages/ as well as the root', async () => {
    const root = await repo({
      'apps/web/package.json': pkg('web', { dev: 'vite' }, { react: '18' }),
      'apps/api/package.json': pkg('api', { start: 'node s.js' }, { fastify: '4' }),
    });
    const { services } = await discoverServices(root);
    expect(services.map((s) => s.dir)).toEqual(['apps/web', 'apps/api']);
  });

  it('finds a Python API beside a Node frontend', async () => {
    const root = await repo({
      'frontend/package.json': pkg('web', { dev: 'vite' }, { react: '18' }),
      'backend/requirements.txt': 'flask==3.0.0\npymongo==4.8.0\n',
    });
    const { services, backing } = await discoverServices(root);
    expect(services.map((s) => `${s.language}:${s.role}`)).toEqual(['node:web', 'python:api']);
    expect(backing.map((b) => b.kind)).toContain('mongodb');
  });

  it('reads the port a service defaults to, which is not the port it will be reached on', async () => {
    // `process.env.PORT || 5000` is the near-universal shape. The literal matters because
    // it is what the service binds when nothing overrides it.
    const root = await repo({
      'frontend/package.json': pkg('web', { dev: 'vite' }, { react: '18' }),
      'backend/package.json': pkg('api', { start: 'node server.js' }, { express: '4' }),
      'backend/server.js': 'const PORT = process.env.PORT || 5000;\nrequire("http").createServer().listen(PORT);',
    });
    const { services } = await discoverServices(root);
    expect(services.find((s) => s.dir === 'backend')?.declaredPort).toBe(5000);
  });

  it('finds the absolute origin a frontend has hardcoded', async () => {
    // Resolved by the browser, so no container alias can satisfy it: the API has to be
    // published on exactly this host port or every request the page makes is refused.
    const root = await repo({
      'frontend/package.json': pkg('web', { dev: 'vite' }, { react: '18' }),
      'frontend/src/api.js': "const API = 'http://localhost:5001';\nfetch(`${API}/api/history`);",
      'backend/package.json': pkg('api', { start: 'node s.js' }, { express: '4' }),
    });
    const { services } = await discoverServices(root);
    expect(services.find((s) => s.role === 'web')?.callsOrigins).toEqual(['http://localhost:5001']);
  });

  it('detects the databases a repository expects but does not contain', async () => {
    const root = await repo({
      'frontend/package.json': pkg('web', { dev: 'vite' }, { react: '18' }),
      'backend/package.json': pkg('api', { start: 'node s.js' }, { express: '4', mongoose: '8', ioredis: '5' }),
    });
    const { backing } = await discoverServices(root);
    expect(backing.map((b) => b.kind).sort()).toEqual(['mongodb', 'redis']);
    expect(backing.find((b) => b.kind === 'mongodb')?.neededBy).toEqual(['api']);
  });
});

describe('the analyzer reports services and backing needs', () => {
  it('describes the full-stack fixture the way a person would', async () => {
    const meta = await new RepositoryAnalyzer().analyze(`${FIXTURES}/node-fullstack`);

    expect(meta.services?.map((s) => `${s.role}:${s.dir}`)).toEqual(['web:frontend', 'api:backend']);
    expect(meta.services?.find((s) => s.role === 'web')?.callsOrigins).toEqual([
      'http://localhost:5001',
    ]);
    // The mismatch real repositories ship: the page calls 5001, the server binds 5000.
    expect(meta.services?.find((s) => s.role === 'api')?.declaredPort).toBe(5000);
    expect(meta.backing?.map((b) => b.kind)).toEqual(['mongodb']);
  });

  it('leaves a single-service repository description unchanged', async () => {
    const meta = await new RepositoryAnalyzer().analyze(`${FIXTURES}/node-http-basic`);
    expect(meta.services).toBeUndefined();
    expect(meta.backing).toBeUndefined();
  });
});
