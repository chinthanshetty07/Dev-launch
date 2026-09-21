import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverServices, workspaceInstall } from '../services/analysis/ServiceDiscovery.js';
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

  it('does not run a workspace root as a service', async () => {
    // Found running DevLaunch through itself: the root was reported as a third service
    // and classified browser-facing, because the placeholder name given to '.' happened
    // to be "app". Its `dev` script delegates to a package already in the list, so
    // running it would start a second copy of that service competing for the same port.
    const root = await repo({
      'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n",
      'package.json': pkg('monorepo', { dev: 'pnpm --filter web dev', test: 'pnpm -r test' }),
      'apps/web/package.json': pkg('web', { dev: 'vite' }, { react: '18' }),
      'apps/api/package.json': pkg('api', { start: 'node s.js' }, { express: '4' }),
    });

    const { services } = await discoverServices(root);
    expect(services.map((s) => s.dir)).toEqual(['apps/web', 'apps/api']);
  });

  it('does not run an npm workspace root either', async () => {
    const root = await repo({
      'package.json': { name: 'monorepo', workspaces: ['packages/*'], scripts: { dev: 'npm -w web run dev' } },
      'packages/web/package.json': pkg('web', { dev: 'vite' }, { react: '18' }),
      'packages/api/package.json': pkg('api', { start: 'node s.js' }, { express: '4' }),
    });
    const { services } = await discoverServices(root);
    expect(services.map((s) => s.dir)).toEqual(['packages/web', 'packages/api']);
  });

  it('does not let a placeholder name decide the root is browser-facing', async () => {
    // Without workspaces the root is a real candidate, but its role must come from what
    // it contains — not from the name discovery invented for it.
    const root = await repo({
      'package.json': pkg('thing', { start: 'node worker.js' }),
      'api/package.json': pkg('api', { start: 'node s.js' }, { express: '4' }),
    });
    const { services } = await discoverServices(root);
    expect(services.find((s) => s.dir === '.')?.role).toBe('worker');
  });

  it('installs a workspace once at its root, with the tool that wrote its lockfile', async () => {
    // Running DevLaunch through itself failed here: each package was installed on its
    // own, and its siblings are referenced as `workspace:*`, which npm rejects outright
    // with EUNSUPPORTEDPROTOCOL. Only a workspace-aware install at the root can resolve
    // it, and only the manager that wrote the lockfile understands the protocol.
    const pnpmRepo = await repo({
      'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n",
      'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
      'package.json': pkg('mono', { dev: 'x' }),
      'apps/web/package.json': pkg('web', { dev: 'vite' }, { react: '18' }),
    });
    expect(await workspaceInstall(pnpmRepo)).toMatchObject({ manager: 'pnpm' });

    const yarnRepo = await repo({
      'package.json': { name: 'mono', workspaces: ['apps/*'] },
      'yarn.lock': '# yarn lockfile v1\n',
      'apps/web/package.json': pkg('web', { dev: 'vite' }, { react: '18' }),
    });
    expect(await workspaceInstall(yarnRepo)).toMatchObject({ manager: 'yarn' });
  });

  it('has no root install for a repository that is not a workspace', async () => {
    // Two sibling directories are not a workspace. Installing at the root would find no
    // manifest to install from.
    const root = await repo({
      'frontend/package.json': pkg('web', { dev: 'vite' }, { react: '18' }),
      'backend/package.json': pkg('api', { start: 'node s.js' }, { express: '4' }),
    });
    expect(await workspaceInstall(root)).toBeNull();
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

  it('reads the connection variable from the service that will use it', async () => {
    // The bug this closes: a provisioned, healthy MongoDB still produced
    // `connect ECONNREFUSED 127.0.0.1:27017`, because the URL was injected as MONGO_URI
    // and the service reads MONGODB_URI. An unread variable is no database at all.
    const root = await repo({
      'frontend/package.json': pkg('web', { dev: 'vite' }, { react: '18' }),
      'backend/package.json': pkg('api', { start: 'node s.js' }, { express: '4', mongoose: '8' }),
      'backend/.env.example': 'PORT=5000\nMONGODB_URI=mongodb://localhost:27017/app\n',
    });
    const { backing } = await discoverServices(root);
    expect(backing.find((b) => b.kind === 'mongodb')?.urlEnvKey).toBe('MONGODB_URI');
  });

  it('finds the connection variable in source when no example file is shipped', async () => {
    const root = await repo({
      'frontend/package.json': pkg('web', { dev: 'vite' }, { react: '18' }),
      'backend/package.json': pkg('api', { start: 'node s.js' }, { express: '4', mongoose: '8' }),
      'backend/src/db.js': "mongoose.connect(process.env.MONGO_URL || 'mongodb://localhost');",
    });
    const { backing } = await discoverServices(root);
    expect(backing.find((b) => b.kind === 'mongodb')?.urlEnvKey).toBe('MONGO_URL');
  });

  it('offers every alias when a service names none of them', async () => {
    // With no evidence, one guess is a coin flip and an unread variable costs nothing.
    const root = await repo({
      'frontend/package.json': pkg('web', { dev: 'vite' }, { react: '18' }),
      'backend/package.json': pkg('api', { start: 'node s.js' }, { express: '4', mongoose: '8' }),
    });
    const { backing } = await discoverServices(root);
    const mongo = backing.find((b) => b.kind === 'mongodb')!;
    expect(mongo.urlEnvKeys).toContain('MONGODB_URI');
    expect(mongo.urlEnvKeys!.length).toBeGreaterThan(1);
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
    // The variable the service declares for itself, not the rule's first guess: the
    // backend's .env.example lives in backend/, which the root-level analyzer never reads.
    expect(meta.backing?.[0]?.urlEnvKey).toBe('MONGODB_URI');
  });

  it('leaves a single-service repository description unchanged', async () => {
    const meta = await new RepositoryAnalyzer().analyze(`${FIXTURES}/node-http-basic`);
    expect(meta.services).toBeUndefined();
    expect(meta.backing).toBeUndefined();
  });
});

describe('a Python project that declares its dependencies in pyproject.toml', () => {
  it('finds the database it needs, and the driver it declared', async () => {
    // The gap this closes, taken from a real run. The repository is a package —
    // `pip install .`, PEP 621 metadata, no requirements.txt — so dependency discovery
    // read nothing, found no database, provisioned no Postgres and injected no
    // connection string. The application fell back to its own `localhost` default inside
    // a container where nothing listens and died in its startup hook with
    // `ConnectionRefusedError: [Errno 111]`, having never been told where its database
    // was. Nothing in the failure pointed at the missing half.
    const root = await repo({
      'pyproject.toml': `
[build-system]
requires = ["hatchling"]

[project]
name = "pg-rag"
version = "0.1.0"
dependencies = [
  "fastapi>=0.115",
  "uvicorn[standard]>=0.30",
  "sqlalchemy[asyncio]>=2.0",
  "asyncpg>=0.29",   # the driver the app is written against
]

[tool.ruff]
select = ["E", "F"]
`,
      'src/pg_rag/main.py': 'from fastapi import FastAPI\napp = FastAPI()\n',
    });

    const { backing } = await discoverServices(root);
    expect(backing.map((b) => b.kind)).toEqual(['postgres']);
    expect(backing[0]!.driver).toBe('asyncpg');
  });

  it('is not cut short by an extras bracket', async () => {
    // `uvicorn[standard]` contains a `]`, so an array reader that ends on the first one
    // it sees stops there and never reaches what follows. In the repository that
    // prompted this, what followed was the database driver — so the dependency list
    // parsed cleanly, looked complete, and silently omitted the one entry that decides
    // whether a database gets started.
    const root = await repo({
      'pyproject.toml': `
[project]
name = "svc"
dependencies = [
  "uvicorn[standard]>=0.30",
  "fastapi>=0.115",
  "redis>=5",
]
`,
      'app.py': 'x = 1\n',
    });

    // Both entries after the bracket survive: the service is recognised at all (fastapi)
    // and its backing service is found (redis).
    const { backing } = await discoverServices(root);
    expect(backing.map((b) => b.kind)).toEqual(['redis']);
  });

  it('reads Poetry dependencies too, and not the interpreter', async () => {
    const root = await repo({
      'pyproject.toml': `
[tool.poetry]
name = "svc"

[tool.poetry.dependencies]
python = "^3.12"
fastapi = "^0.115"
psycopg2-binary = "^2.9"

[tool.poetry.group.dev.dependencies]
pytest = "^8"
`,
      'app.py': 'x = 1\n',
    });

    const { backing } = await discoverServices(root);
    expect(backing.map((b) => b.kind)).toEqual(['postgres']);
    expect(backing[0]!.driver).toBe('psycopg2-binary');
  });

  it('does not mistake an unrelated table for a dependency list', async () => {
    // A name-only reader that wandered outside the dependency tables would pick up tool
    // settings and report databases nobody asked for — worse than finding none, because
    // it starts a server the repository never wanted.
    const root = await repo({
      'pyproject.toml': `
[project]
name = "svc"
dependencies = ["fastapi"]

[tool.something]
redis = "not a dependency"
mysql = "also not"
`,
      'app.py': 'x = 1\n',
    });

    const { backing } = await discoverServices(root);
    expect(backing).toEqual([]);
  });

  it('still reads requirements.txt, and merges both when a repository has each', async () => {
    const root = await repo({
      'requirements.txt': 'fastapi\nredis\n',
      'pyproject.toml': '[project]\nname = "svc"\ndependencies = ["asyncpg"]\n',
      'app.py': 'x = 1\n',
    });

    const { backing } = await discoverServices(root);
    expect(backing.map((b) => b.kind).sort()).toEqual(['postgres', 'redis']);
  });
});

describe('a repository whose compose file says where everything is', () => {
  /** The shape of a real repository that failed: services two levels down, under `app/`. */
  const build = () =>
    repo({
      'docker-compose.yml': `
services:
  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_DB: pgrag
  backend:
    build: ./app/backend
    ports: ["8000:8000"]
    environment:
      DATABASE_URL: postgresql+asyncpg://postgres:postgres@postgres:5432/pgrag
    depends_on: [postgres]
  mcp:
    build: ./app/backend
    command: ["uv", "run", "python", "-m", "pg_rag.mcp_integration.server"]
    ports: ["8001:8001"]
  frontend:
    build: ./app/frontend
    ports: ["3000:80"]
    depends_on: [backend]
`,
      'app/backend/pyproject.toml': '[project]\nname = "pg-rag"\ndependencies = ["fastapi", "sqlalchemy[asyncio]", "asyncpg"]\n',
      'app/backend/src/main.py': 'from fastapi import FastAPI\napp = FastAPI()\n',
      'app/frontend/package.json': pkg('web', { dev: 'vite' }, { react: '18', vite: '5' }),
      'app/frontend/src/App.tsx': 'export default () => null;\n',
    });

  it('finds services convention would have walked straight past', async () => {
    // Discovery looked inside `apps/`, `packages/` and `services/`. This repository uses
    // `app/` — singular — so nothing was found, the whole repository fell through to the
    // AI planner, and it guessed `pip install -e .` at a root containing no Python
    // package at all. The compose file names both paths outright.
    const root = await build();
    const meta = await new RepositoryAnalyzer().analyze(root, '.');
    const seen = (meta.services ?? []).map((s) => `${s.name}:${s.dir}:${s.role}`).sort();
    expect(seen).toEqual(['backend:app/backend:api', 'frontend:app/frontend:web']);
  });

  it('takes the port the author published, unless the dev server cannot use it', async () => {
    const meta = await new RepositoryAnalyzer().analyze(await build(), '.');
    const backend = meta.services!.find((s) => s.name === 'backend')!;
    const frontend = meta.services!.find((s) => s.name === 'frontend')!;
    expect(backend.declaredPort).toBe(8000);
    // `3000:80` describes nginx serving a built bundle in the production image. DevLaunch
    // runs vite instead, and 80 is not a port a non-root dev server can bind — this
    // assertion once demanded 80 and would have handed vite a permission error.
    expect(frontend.declaredPort).toBeUndefined();
  });

  it('keeps the database image the author chose', async () => {
    // pgvector is not an optional detail: plain `postgres` starts, and then the
    // application's first `CREATE EXTENSION vector` fails. No dependency list says this.
    const meta = await new RepositoryAnalyzer().analyze(await build(), '.');
    expect(meta.backing).toHaveLength(1);
    const db = meta.backing![0] as { kind: string; image?: string; database?: string };
    expect(db.kind).toBe('postgres');
    expect(db.image).toBe('pgvector/pgvector:pg16');
    expect(db.database).toBe('pgrag');
  });

  it('runs one service per directory, choosing the image default over an override', async () => {
    // `backend` and `mcp` are the same image started two ways. A `command:` override
    // means the author is running something other than what the image is for, so the
    // service without one is the directory's real identity.
    const meta = await new RepositoryAnalyzer().analyze(await build(), '.');
    const inBackendDir = (meta.services ?? []).filter((s) => s.dir === 'app/backend');
    expect(inBackendDir.map((s) => s.name)).toEqual(['backend']);
  });
});

describe('a compose port the dev server cannot use', () => {
  it('does not hand the dev server a privileged port from the production image', async () => {
    // `3000:80` describes nginx serving a built bundle in the author's production image.
    // DevLaunch runs the dev server instead, and adopting 80 hands vite `--port 80` — which
    // a non-root process cannot bind. The dev server's own default is the right port.
    const root = await repo({
      'docker-compose.yml': 'services:\n  frontend:\n    build: ./web\n    ports: ["3000:80"]\n',
      'web/package.json': pkg('web', { dev: 'vite' }, { vite: '5' }),
      'web/src/main.ts': 'export {};\n',
    });
    const meta = await new RepositoryAnalyzer().analyze(root, '.');
    // Single service: the analyzer reports no services list, so probe discovery directly.
    const { services } = await discoverServices(root, ['web']);
    expect(services).toEqual([]);
    expect(meta.services).toBeUndefined();
    // The overlay is exercised through a two-service shape too.
    const root2 = await repo({
      'docker-compose.yml':
        'services:\n  frontend:\n    build: ./web\n    ports: ["3000:80"]\n  api:\n    build: ./api\n    ports: ["8000:8000"]\n',
      'web/package.json': pkg('web', { dev: 'vite' }, { vite: '5' }),
      'web/src/main.ts': 'export {};\n',
      'api/requirements.txt': 'fastapi\n',
      'api/main.py': 'from fastapi import FastAPI\napp = FastAPI()\n',
    });
    const meta2 = await new RepositoryAnalyzer().analyze(root2, '.');
    const web = meta2.services!.find((s) => s.dir === 'web')!;
    const api = meta2.services!.find((s) => s.dir === 'api')!;
    expect(web.declaredPort).toBeUndefined();
    expect(api.declaredPort).toBe(8000);
  });
});

describe('what to install versus what to detect from', () => {
  it('installs only what the application needs to run', async () => {
    // Detection wants everything declared: a database driver in a dev group still means
    // a database. Installing wants only the runtime set — `pytest` and `httpx` in a
    // runtime container are a slower build and a wider surface for nothing.
    const { pyprojectDepsBySection } = await import('../services/analysis/ServiceDiscovery.js');
    const out = pyprojectDepsBySection(`
[project]
name = "svc"
dependencies = [
    "fastapi>=0.135.2",
    "uvicorn>=0.42.0",
]

[project.optional-dependencies]
lint = ["ruff>=0.6"]

[dependency-groups]
dev = [
    "httpx>=0.28.1",
    "pytest>=9.0.2",
]
`);
    expect(out.runtime).toEqual(['fastapi', 'uvicorn']);
    expect(out.all).toEqual(expect.arrayContaining(['fastapi', 'uvicorn', 'ruff', 'httpx', 'pytest']));
  });

  it('separates Poetry groups the same way', async () => {
    const { pyprojectDepsBySection } = await import('../services/analysis/ServiceDiscovery.js');
    const out = pyprojectDepsBySection(`
[tool.poetry.dependencies]
python = "^3.12"
fastapi = "^0.115"

[tool.poetry.group.dev.dependencies]
pytest = "^8"
`);
    expect(out.runtime).toEqual(['fastapi']);
    expect(out.all).toEqual(expect.arrayContaining(['fastapi', 'pytest']));
  });
});

describe('the variable a service reads its connection string from', () => {
  it('finds a connection variable the alias list never predicted', async () => {
    // A real repository passes `process.env.CONNECTION_STRING` to mongoose.connect. It
    // is not MONGO_URI, so a provisioned, healthy MongoDB was injected under four names
    // the application never read and it crashed at boot with
    // `The uri parameter to openUri() must be a string, got "undefined"`.
    const root = await repo({
      'package.json': pkg('api', { start: 'node server.js' }, { mongoose: '^6' }),
      'config/dbConnection.js': 'mongoose.connect(process.env.CONNECTION_STRING);',
    });
    const meta = await new RepositoryAnalyzer().analyze(root);
    const mongo = meta.backing?.find((b) => b.kind === 'mongodb');
    expect(mongo?.urlEnvKey).toBe('CONNECTION_STRING');
    // The aliases stay too: unread, they cost nothing, and a config file the scan did
    // not reach may use one of them.
    expect(mongo?.urlEnvKeys).toContain('MONGODB_URI');
  });

  it('reads source in subdirectories, not only at the service root', async () => {
    // The fallback walk started one level below its own depth limit, so it read the
    // root's files and descended into none of them — and a repository whose entire
    // database configuration lives in `config/` was read as declaring nothing.
    const root = await repo({
      'package.json': pkg('api', { start: 'node server.js' }, { mongoose: '^6' }),
      'lib/deep/db.js': 'mongoose.connect(process.env.DB_CONNECTION_URI);',
    });
    const meta = await new RepositoryAnalyzer().analyze(root);
    expect(meta.backing?.[0]?.urlEnvKey).toBe('DB_CONNECTION_URI');
  });

  it('refuses a variable that ends in URL but names something else', async () => {
    // Writing a database address into CLIENT_URL would break a working application to
    // fix one that is not broken.
    const root = await repo({
      'package.json': pkg('api', { start: 'node server.js' }, { mongoose: '^6' }),
      'server.js': 'const a = process.env.CLIENT_URL; const b = process.env.WEBHOOK_URL;',
    });
    const meta = await new RepositoryAnalyzer().analyze(root);
    expect(meta.backing?.[0]?.urlEnvKey).not.toBe('CLIENT_URL');
    expect(meta.backing?.[0]?.urlEnvKeys).not.toContain('WEBHOOK_URL');
  });

  it('will not attribute an unnamed variable when two kinds could claim it', async () => {
    // `DATA_URI` names neither, and guessing which server it points at is how a cache
    // URL ends up in a database driver.
    const root = await repo({
      'package.json': pkg('api', { start: 'node s.js' }, { mongoose: '^6', redis: '^4' }),
      's.js': 'const x = process.env.DATA_URI;',
    });
    const meta = await new RepositoryAnalyzer().analyze(root);
    for (const b of meta.backing ?? []) expect(b.urlEnvKeys).not.toContain('DATA_URI');
  });

  it('attributes a variable that names its kind even when two are present', async () => {
    const root = await repo({
      'package.json': pkg('api', { start: 'node s.js' }, { mongoose: '^6', redis: '^4' }),
      's.js': 'const x = process.env.MONGO_CONNECTION_STRING;',
    });
    const meta = await new RepositoryAnalyzer().analyze(root);
    expect(meta.backing?.find((b) => b.kind === 'mongodb')?.urlEnvKey).toBe('MONGO_CONNECTION_STRING');
    expect(meta.backing?.find((b) => b.kind === 'redis')?.urlEnvKeys).not.toContain('MONGO_CONNECTION_STRING');
  });
});

describe('what the application says about its own address', () => {
  it('reads a port the source hardcodes', async () => {
    // `const port = 8017` beside `app.listen(port, ...)`. Lower case, which the previous
    // pattern — anchored to the environment-variable spelling — never matched.
    const root = await repo({
      'package.json': pkg('api', { dev: 'node server.js' }, { express: '^4' }),
      'server.js': "const port = 8017\nconst hostname = 'localhost'\napp.listen(port, hostname)",
    });
    const meta = await new RepositoryAnalyzer().analyze(root);
    expect(meta.declaredPort).toBe(8017);
  });

  it('names the file and line when a loopback bind is a literal', async () => {
    const root = await repo({
      'package.json': pkg('api', { dev: 'node server.js' }, { express: '^4' }),
      'server.js': "const port = 8017\nconst hostname = 'localhost'\napp.listen(port, hostname)",
    });
    const meta = await new RepositoryAnalyzer().analyze(root);
    expect(meta.hardcodedBind?.file).toBe('server.js');
    expect(meta.hardcodedBind?.line).toContain('localhost');
  });

  it('reports no hardcoded bind when the address is a variable', async () => {
    // `process.env.HOST` is configuration, and configuration is exactly what DevLaunch
    // can set. Reporting it as unfixable would stop a repair that works.
    const root = await repo({
      'package.json': pkg('api', { dev: 'node server.js' }, { express: '^4' }),
      'server.js': 'app.listen(process.env.PORT, process.env.HOST)',
    });
    const meta = await new RepositoryAnalyzer().analyze(root);
    expect(meta.hardcodedBind).toBeUndefined();
  });

  it('ignores a loopback literal that is not given to listen', async () => {
    const root = await repo({
      'package.json': pkg('api', { dev: 'node server.js' }, { express: '^4' }),
      'server.js': "const docs = 'http://localhost:3000/docs'\napp.listen(3000)",
    });
    const meta = await new RepositoryAnalyzer().analyze(root);
    expect(meta.hardcodedBind).toBeUndefined();
  });
});

describe('a repository whose only application is in a subdirectory', () => {
  it('reports the sole service when the root holds only configuration', async () => {
    const root = await repo({
      'docker-compose.yml': 'services:\n  web:\n    build: ./src\n    ports:\n      - 8003:8000\n',
      'src/requirements.txt': 'fastapi\nuvicorn\n',
      'src/app/main.py': 'from fastapi import FastAPI\napp = FastAPI()\n',
    });
    const meta = await new RepositoryAnalyzer().analyze(root);
    expect(meta.soleService?.dir).toBe('src');
    // Still not a multi-service project: there is one of it.
    expect(meta.services).toBeUndefined();
  });

  it('reports no sole service when the application is at the root', async () => {
    // The ordinary case, and re-planning the root as if it were a subdirectory would be
    // the same analysis twice.
    const root = await repo({
      'package.json': pkg('api', { start: 'node s.js' }, { express: '^4' }),
      's.js': 'app.listen(3000)',
    });
    const meta = await new RepositoryAnalyzer().analyze(root);
    expect(meta.soleService).toBeUndefined();
  });

  it('reports no sole service when there are two', async () => {
    const root = await repo({
      'frontend/package.json': pkg('web', { dev: 'vite' }, { react: '^18', vite: '^5' }),
      'backend/package.json': pkg('api', { start: 'node s.js' }, { express: '^4' }),
    });
    const meta = await new RepositoryAnalyzer().analyze(root);
    expect(meta.soleService).toBeUndefined();
    expect(meta.services).toHaveLength(2);
  });
});

describe('a dev server proxying to an address its own container cannot reach', () => {
  it('finds a Vite proxy target pointing at localhost', async () => {
    // The dev server resolves this itself, inside the frontend's container, so
    // `localhost` is the frontend. Every request the page makes returns 502 through a
    // stack that is otherwise working perfectly.
    const root = await repo({
      'frontend/package.json': pkg('web', { dev: 'vite' }, { react: '^18', vite: '^5' }),
      'frontend/vite.config.js':
        "export default { server: { proxy: { '/api': { target: 'http://localhost:8000' } } } }",
      'backend/package.json': pkg('api', { start: 'node s.js' }, { express: '^4' }),
    });
    const meta = await new RepositoryAnalyzer().analyze(root);
    const web = meta.services?.find((s) => s.role === 'web');
    expect(web?.devProxy).toMatchObject({ file: 'vite.config.js', target: 'http://localhost:8000' });
  });

  it('finds the shorthand form as well', async () => {
    const root = await repo({
      'frontend/package.json': pkg('web', { dev: 'vite' }, { react: '^18', vite: '^5' }),
      'frontend/vite.config.js': "export default { server: { proxy: { '/api': 'http://localhost:8000' } } }",
      'backend/package.json': pkg('api', { start: 'node s.js' }, { express: '^4' }),
    });
    const meta = await new RepositoryAnalyzer().analyze(root);
    expect(meta.services?.find((s) => s.role === 'web')?.devProxy?.target).toBe('http://localhost:8000');
  });

  it('finds a Create React App proxy declared in the manifest', async () => {
    const root = await repo({
      'frontend/package.json': { ...pkg('web', { start: 'react-scripts start' }, { 'react-scripts': '^5' }), proxy: 'http://localhost:5000' },
      'backend/package.json': pkg('api', { start: 'node s.js' }, { express: '^4' }),
    });
    const meta = await new RepositoryAnalyzer().analyze(root);
    expect(meta.services?.find((s) => s.role === 'web')?.devProxy?.target).toBe('http://localhost:5000');
  });

  it('ignores a proxy that already points at a reachable host', async () => {
    // `http://api:8000` is what the fix looks like. Warning about it would be noise.
    const root = await repo({
      'frontend/package.json': pkg('web', { dev: 'vite' }, { react: '^18', vite: '^5' }),
      'frontend/vite.config.js': "export default { server: { proxy: { '/api': 'http://api:8000' } } }",
      'backend/package.json': pkg('api', { start: 'node s.js' }, { express: '^4' }),
    });
    const meta = await new RepositoryAnalyzer().analyze(root);
    expect(meta.services?.find((s) => s.role === 'web')?.devProxy).toBeUndefined();
  });

  it('ignores a localhost URL that is not a proxy target', async () => {
    // A build-time constant, not something the dev server forwards. There is no proxy
    // here at all, so naming a line to change would send someone after a problem they
    // do not have.
    const root = await repo({
      'frontend/package.json': pkg('web', { dev: 'vite' }, { react: '^18', vite: '^5' }),
      'frontend/vite.config.js':
        "export default { define: { 'API_BASE': 'http://localhost:8000' }, server: { port: 5173 } }",
      'backend/package.json': pkg('api', { start: 'node s.js' }, { express: '^4' }),
    });
    const meta = await new RepositoryAnalyzer().analyze(root);
    expect(meta.services?.find((s) => s.role === 'web')?.devProxy).toBeUndefined();
  });
});
