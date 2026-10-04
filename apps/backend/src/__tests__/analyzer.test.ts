import { describe, it, expect, afterAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { normaliseRepoUrl, measureTree } from '../services/git/GitManager.js';
import {
  RepositoryAnalyzer,
  parsePnpmWorkspace,
  expandWorkspacePatterns,
} from '../services/analysis/RepositoryAnalyzer.js';
import { parseEnvExample } from '../services/analysis/parseEnvExample.js';
import { SecurityRejection } from '../services/security/ImageAllowlist.js';

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../fixtures');
const analyzer = new RepositoryAnalyzer();

/** Scratch directories created by tests, removed afterwards. */
const scratch: string[] = [];
afterAll(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(scratch.map((d) => rm(d, { recursive: true, force: true }).catch(() => undefined)));
});

describe('normaliseRepoUrl', () => {
  it.each([
    ['https://github.com/owner/repo', 'https://github.com/owner/repo.git'],
    ['https://github.com/owner/repo.git', 'https://github.com/owner/repo.git'],
    ['https://github.com/owner/repo/', 'https://github.com/owner/repo.git'],
    ['https://www.github.com/owner/repo', 'https://github.com/owner/repo.git'],
    ['  https://github.com/owner/repo  ', 'https://github.com/owner/repo.git'],
  ])('normalises %s', (input, expected) => {
    expect(normaliseRepoUrl(input)).toBe(expected);
  });

  it.each([
    ['ssh scheme', 'ssh://git@github.com/owner/repo.git'],
    ['scp style', 'git@github.com:owner/repo.git'],
    ['plain http', 'http://github.com/owner/repo'],
    ['file url', 'file:///etc/passwd'],
    ['other host', 'https://gitlab.com/owner/repo'],
    ['lookalike host', 'https://github.com.evil.io/owner/repo'],
    ['credentials embedded', 'https://user:token@github.com/owner/repo'],
    ['too few path segments', 'https://github.com/owner'],
    ['too many path segments', 'https://github.com/owner/repo/tree/main'],
    ['not a url', 'just some text'],
    ['empty', ''],
  ])('rejects %s', (_label, input) => {
    expect(() => normaliseRepoUrl(input)).toThrow(SecurityRejection);
  });

  it('rejects a URL carrying credentials even when the host is allowed', () => {
    // Accepting this would mean DevLaunch handling somebody's token.
    expect(() => normaliseRepoUrl('https://x:y@github.com/o/r')).toThrow(/credentials/i);
  });
});

describe('measureTree', () => {
  it('counts files and reports when a limit is passed', async () => {
    const within = await measureTree(`${FIXTURES}/node-vite-app`, 10 * 1024 * 1024, 1000);
    expect(within.fileCount).toBeGreaterThan(0);
    expect(within.exceeded).toBe(false);

    const overFiles = await measureTree(`${FIXTURES}/node-vite-app`, 10 * 1024 * 1024, 1);
    expect(overFiles.exceeded).toBe(true);

    const overBytes = await measureTree(`${FIXTURES}/node-vite-app`, 1, 1000);
    expect(overBytes.exceeded).toBe(true);
  });
});

describe('parseEnvExample', () => {
  it('separates variables needing a value from those with a default', () => {
    const vars = parseEnvExample(
      '# comment\nSECRET_KEY=\nDATABASE_URL=\nFLASK_ENV=development\n\nexport PORT=5000\n',
    );
    // A default now carries its value too: it is handed to the application, the way
    // `cp .env.example .env` would, rather than only excused from being asked for.
    expect(vars).toEqual([
      { key: 'SECRET_KEY', hasDefault: false },
      { key: 'DATABASE_URL', hasDefault: false },
      { key: 'FLASK_ENV', hasDefault: true, value: 'development' },
      { key: 'PORT', hasDefault: true, value: '5000' },
    ]);
  });

  it('ignores comments, blanks and malformed lines', () => {
    expect(parseEnvExample('#x\n\n  \nnot-a-var\n=novalue\n123BAD=x\n')).toEqual([]);
  });
});

describe('parsePnpmWorkspace', () => {
  it('reads a block sequence of package globs', () => {
    expect(parsePnpmWorkspace("packages:\n  - 'apps/*'\n  - \"packages/*\"\n")).toEqual([
      'apps/*',
      'packages/*',
    ]);
  });

  it('returns nothing when there is no packages key', () => {
    expect(parsePnpmWorkspace('other: true\n')).toEqual([]);
  });
});

describe('expandWorkspacePatterns', () => {
  it('expands dir/* into real directories', async () => {
    const dirs = await expandWorkspacePatterns(`${FIXTURES}/node-monorepo`, ['apps/*', 'packages/*']);
    expect(dirs.sort()).toEqual(['apps/web', 'packages/util']);
  });

  it('refuses a pattern that would escape the repository', async () => {
    expect(await expandWorkspacePatterns(`${FIXTURES}/node-monorepo`, ['../*'])).toEqual([]);
  });
});

describe('RepositoryAnalyzer', () => {
  it('describes a Vite application', async () => {
    const meta = await analyzer.analyze(`${FIXTURES}/node-vite-app`);
    expect(meta.packageJson?.dependencies).toHaveProperty('react');
    expect(meta.packageJson?.devDependencies).toHaveProperty('vite');
    expect(meta.packageJson?.scripts.dev).toBe('vite');
    expect(meta.packageJson?.engineNode).toBe('>=18');
    expect(meta.lockfiles).toContain('package-lock.json');
    expect(meta.frameworkConfigs).toContain('vite.config.ts');
    expect(meta.tsconfig).toBe(true);
    expect(meta.python).toBeUndefined();
    expect(meta.warnings).toEqual([]);
  });

  it('describes a Flask application, including its entry point and app object', async () => {
    const meta = await analyzer.analyze(`${FIXTURES}/python-flask-basic`);
    expect(meta.python?.requirements).toContain('Flask==3.0.3');
    expect(meta.python?.hasManagePy).toBe(false);
    const entry = meta.python?.entryCandidates.find((e) => e.file === 'app.py');
    expect(entry?.framework).toBe('flask');
    // Phase 6 needs the variable name to build a gunicorn target like app:app.
    expect(entry?.appVariable).toBe('app');
    expect(meta.packageJson).toBeUndefined();
  });

  it('separates required environment variables from defaulted ones', async () => {
    const meta = await analyzer.analyze(`${FIXTURES}/python-flask-basic`);
    const required = meta.envExample.filter((v) => !v.hasDefault).map((v) => v.key);
    expect(required).toEqual(['SECRET_KEY', 'DATABASE_URL']);
    expect(meta.envExample.find((v) => v.key === 'PORT')?.hasDefault).toBe(true);
  });

  it('detects Django from manage.py', async () => {
    const meta = await analyzer.analyze(`${FIXTURES}/python-django-basic`);
    expect(meta.python?.hasManagePy).toBe(true);
    expect(meta.python?.requirements).toContain('Django==5.0.6');
  });

  it('finds only the runnable packages in a monorepo', async () => {
    const meta = await analyzer.analyze(`${FIXTURES}/node-monorepo`);
    expect(meta.workspace?.kind).toBe('pnpm');
    expect(meta.workspace?.total).toBe(2);
    // packages/util has only a build script, so it is not something to run.
    expect(meta.workspace?.runnable.map((p) => p.name)).toEqual(['@fixture/web']);
    expect(meta.workspace?.runnable[0]?.dir).toBe('apps/web');
  });

  it('captures a README excerpt without swallowing the whole file', async () => {
    const meta = await analyzer.analyze(`${FIXTURES}/python-flask-basic`);
    expect(meta.readmeExcerpt).toContain('Flask fixture');
    expect(meta.readmeExcerpt!.length).toBeLessThanOrEqual(4000);
  });

  it('records a malformed manifest as a warning instead of throwing', async () => {
    // A broken package.json is a fact about the repository; the planner routes it to
    // the AI fallback rather than guessing.
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'devlaunch-bad-'));
    scratch.push(dir);
    await writeFile(join(dir, 'package.json'), '{ not json', 'utf8');

    const meta = await analyzer.analyze(dir);
    expect(meta.packageJson).toBeUndefined();
    expect(meta.warnings.join(' ')).toMatch(/package\.json could not be parsed/);
  });

  it('returns a usable description for an empty directory', async () => {
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'devlaunch-empty-'));
    scratch.push(dir);

    const meta = await analyzer.analyze(dir);
    expect(meta.packageJson).toBeUndefined();
    expect(meta.python).toBeUndefined();
    expect(meta.lockfiles).toEqual([]);
    expect(meta.envExample).toEqual([]);
  });
});

describe('variables a file documents as optional', () => {
  it('does not require one the file says is optional', () => {
    // DevLaunch's own file: GROQ_API_KEY= under a line explaining the key is optional.
    // Treating the empty value as a demand contradicts the sentence above it, and
    // blocked a session on a key the project explicitly does not need.
    const vars = parseEnvExample(
      ['# Optional. Without a key DevLaunch plans deterministically.', 'GROQ_API_KEY=', 'REAL_SECRET='].join('\n'),
    );
    expect(vars.find((v) => v.key === 'GROQ_API_KEY')?.hasDefault).toBe(true);
    // The one with no such note is still required, or the gate would stop asking for
    // anything at all.
    expect(vars.find((v) => v.key === 'REAL_SECRET')?.hasDefault).toBe(false);
  });

  it('does not let one variable note leak onto the next', () => {
    const vars = parseEnvExample(['# Optional.', 'MAYBE=', '', 'MUST_HAVE='].join('\n'));
    expect(vars.find((v) => v.key === 'MAYBE')?.hasDefault).toBe(true);
    expect(vars.find((v) => v.key === 'MUST_HAVE')?.hasDefault).toBe(false);
  });

  it('recognises the other ways a file says the same thing', () => {
    for (const note of ['# not required', '# leave blank if unused', '# if you have one']) {
      expect(parseEnvExample([note, 'KEY='].join('\n'))[0]?.hasDefault, note).toBe(true);
    }
  });

  it('still treats an undocumented empty value as required', () => {
    expect(parseEnvExample(['# The database password.', 'DB_PASSWORD='].join('\n'))[0]?.hasDefault).toBe(false);
  });
});

describe('what the analyzer reports for a packaged Python project', () => {
  it('carries the database through to metadata, where provisioning reads it', () => {
    // The two halves of this were each tested and the join between them was not, which
    // is where the failure lived: discovery found the dependencies, provisioning read
    // `metadata.backing`, and a repository with only a pyproject.toml produced an empty
    // one. The application was started with no database and no connection string, fell
    // back to its own localhost default, and died in its startup hook with
    // `ConnectionRefusedError: [Errno 111]`.
    return (async () => {
      const { mkdtemp, writeFile, mkdir } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const { tmpdir } = await import('node:os');
      const dir = await mkdtemp(join(tmpdir(), 'devlaunch-pyproj-'));
      await writeFile(
        join(dir, 'pyproject.toml'),
        '[project]\nname = "pg-rag"\ndependencies = ["fastapi", "sqlalchemy[asyncio]", "asyncpg"]\n',
      );
      await mkdir(join(dir, 'src'), { recursive: true });
      await writeFile(join(dir, 'src', 'main.py'), 'from fastapi import FastAPI\napp = FastAPI()\n');

      const meta = await analyzer.analyze(dir, '.');
      expect(meta.backing?.map((b) => b.kind)).toEqual(['postgres']);
      expect(meta.backing?.[0]?.driver).toBe('asyncpg');
    })();
  });
});

describe('a packaged Python project with a src layout', () => {
  it('finds the entry point inside the package and names its module', async () => {
    const { mkdtemp, writeFile, mkdir } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(join(tmpdir(), 'devlaunch-srclayout-'));
    await writeFile(join(dir, 'pyproject.toml'),
      '[project]\nname = "pg-rag"\ndependencies = ["fastapi[standard]>=0.115", "asyncpg>=0.30"]\n');
    await mkdir(join(dir, 'src', 'pg_rag'), { recursive: true });
    await writeFile(join(dir, 'src', 'pg_rag', '__init__.py'), '');
    await writeFile(join(dir, 'src', 'pg_rag', 'main.py'),
      'from fastapi import FastAPI\napp = FastAPI(title="PG-RAG")\n');

    const meta = await analyzer.analyze(dir, '.');
    // The working directory has no .py file at all; the scan that stopped there found
    // nothing and the planner had nothing to start.
    const entry = meta.python?.entryCandidates.find((e) => e.framework === 'fastapi');
    expect(entry?.file).toBe('src/pg_rag/main.py');
    expect(entry?.module).toBe('pg_rag.main');
    expect(entry?.appVariable).toBe('app');
    // And the dependency names, which are the framework signal for a packaged project.
    expect(meta.python?.dependencies).toEqual(expect.arrayContaining(['fastapi', 'asyncpg']));
  });
});

describe('a placeholder in .env.example', () => {
  const declared = (text: string) => Object.fromEntries(parseEnvExample(text).map((v) => [v.key, v.hasDefault]));

  it('is a request, not a default', () => {
    // `sk-your-key-here` counted as a value, so the gate asked for nothing, the container
    // started without OPENAI_API_KEY, and the application died at import with "Missing
    // credentials" — on a repository that had documented the variable perfectly.
    const d = declared(
      'OPENAI_API_KEY=sk-your-key-here\nTOKEN=<your-token>\nPASS=changeme\nSECRET=your_secret_here\nKEY=xxxxxxxx\nURL=${BASE_URL}\n',
    );
    expect(d).toEqual({ OPENAI_API_KEY: false, TOKEN: false, PASS: false, SECRET: false, KEY: false, URL: false });
  });

  it('leaves real defaults alone', () => {
    // The shapes that must not match: these are usable values and asking for them is noise.
    const d = declared(
      'FLASK_ENV=development\nPORT=5000\nLOG_LEVEL=info\nDATABASE_URL=postgresql://postgres:postgres@localhost:5432/app\nOPENAI_CHAT_MODEL=gpt-4o-mini\nCHUNK_SIZE=500\n',
    );
    expect(Object.values(d).every(Boolean)).toBe(true);
  });
});

describe('what the manifest says about an entry point', () => {
  it('records main first, then the conventional files that actually exist', async () => {
    const { mkdtemp, writeFile, mkdir } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(join(tmpdir(), 'devlaunch-entry-'));
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 't', main: './server.js', dependencies: { express: '4' } }));
    await writeFile(join(dir, 'server.js'), 'require("express")().listen(3000)');
    await writeFile(join(dir, 'app.js'), '');
    await mkdir(join(dir, 'src'));
    await writeFile(join(dir, 'src', 'index.js'), '');

    const meta = await analyzer.analyze(dir, '.');
    expect(meta.packageJson?.main).toBe('./server.js');
    expect(meta.packageJson?.entryFiles).toEqual(['server.js', 'app.js', 'src/index.js']);
  });

  it('does not list a main that is not there, or that Node cannot run', async () => {
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(join(tmpdir(), 'devlaunch-entry2-'));
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 't', main: 'src/index.ts', dependencies: { express: '4' } }));
    const meta = await analyzer.analyze(dir, '.');
    expect(meta.packageJson?.entryFiles).toEqual([]);
  });
});

describe('the routes an application declares', () => {
  const build = async (files: Record<string, string>) => {
    const { mkdtemp, writeFile, mkdir } = await import('node:fs/promises');
    const { join, dirname } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(join(tmpdir(), 'devlaunch-routes-'));
    for (const [rel, body] of Object.entries(files)) {
      await mkdir(dirname(join(dir, rel)), { recursive: true });
      await writeFile(join(dir, rel), body);
    }
    return dir;
  };
  const key = (r: { method: string; path: string }) => `${r.method} ${r.path}`;

  it('reads express routes, prefixes a mounted router, and reads the .http file beside them', async () => {
    // The repository that prompted this: an API whose root 404s and whose README says to
    // use the .http file. Every route below was written down; none had to be guessed.
    const dir = await build({
      'package.json': JSON.stringify({ name: 'api', main: 'app.js', dependencies: { express: '4' } }),
      'app.js': `const express = require('express'); const app = express();
const users = require('./routes/users');
app.use('/api/users', users);
app.get('/states/', (q, r) => r.send([]));
app.get('/states/:stateId', (q, r) => r.send({}));
app.post('/districts/', (q, r) => r.send({}));
app.listen(3000);`,
      'routes/users.js': `const router = require('express').Router();
router.get('/', (q, r) => r.send([]));
router.get('/:id', (q, r) => r.send({}));
module.exports = router;`,
      'app.http': 'GET http://localhost:3000/states\n\n###\n\nPOST http://localhost:3000/districts/\n',
    });
    const routes = (await analyzer.analyze(dir, '.')).httpRoutes!.map(key);
    expect(routes).toEqual(expect.arrayContaining(['GET /states/', 'GET /states/:stateId', 'POST /districts/', 'GET /api/users/', 'GET /api/users/:id', 'GET /states']));
    // A mounted router's paths are never reported bare: /users/:id is a wrong answer.
    expect(routes).not.toContain('GET /:id');
  });

  it('reads Flask routes with their methods, and a FastAPI router under its prefix', async () => {
    const flask = await build({
      'requirements.txt': 'flask\n',
      'app.py': `from flask import Flask
app = Flask(__name__)
@app.route('/todos', methods=['GET', 'POST'])
def todos(): return []
@app.route('/todos/<int:id>')
def todo(id): return {}`,
    });
    expect((await analyzer.analyze(flask, '.')).httpRoutes!.map(key)).toEqual(
      expect.arrayContaining(['GET /todos', 'POST /todos', 'GET /todos/<int:id>']),
    );

    const fastapi = await build({
      'requirements.txt': 'fastapi\n',
      'main.py': `from fastapi import FastAPI
from routers import documents
app = FastAPI()
app.include_router(documents.router, prefix="/api/documents")
@app.get("/health")
def health(): return {}`,
      'routers/documents.py': `from fastapi import APIRouter
router = APIRouter()
@router.get("/")
def list_docs(): return []
@router.post("/")
def add(): return {}`,
    });
    expect((await analyzer.analyze(fastapi, '.')).httpRoutes!.map(key)).toEqual(
      expect.arrayContaining(['GET /health', 'GET /api/documents/', 'POST /api/documents/']),
    );
  });

  it('finds a class-based router one level inside a package', async () => {
    // Two misses on one real repository: the routes live in `app/routes/`, which a scan
    // of the working directory walks past, and they are registered with
    // `add_api_route` rather than a decorator. A decorator-only reader looking only at
    // the top level reported no routes at all for a perfectly ordinary FastAPI layout.
    const dir = await build({
      'pyproject.toml': '[project]\nname = "svc"\ndependencies = ["fastapi"]\n',
      'main.py': 'from fastapi import FastAPI\nfrom app.routes import ROUTERS\napp = FastAPI()\nfor r in ROUTERS:\n    app.include_router(r)\n',
      'app/routes/api_health.py': `from app.routes.base import BaseRoute
class ApiHealthRoute(BaseRoute):
    def __init__(self) -> None:
        super().__init__()
        self.router.add_api_route("/api_health", self.api_health, methods=["GET"])`,
      'app/routes/auth.py': `class AuthRoute:
    def __init__(self) -> None:
        self.router.add_api_route("/auth/token", self.token, methods=["POST"])`,
    });
    const routes = (await analyzer.analyze(dir, '.')).httpRoutes!.map(key);
    expect(routes).toEqual(expect.arrayContaining(['GET /api_health', 'POST /auth/token']));
  });

  it('reports nothing for a repository that declares nothing', async () => {
    const dir = await build({ 'package.json': JSON.stringify({ name: 'lib', dependencies: {} }), 'index.js': 'module.exports = 1;' });
    expect((await analyzer.analyze(dir, '.')).httpRoutes).toBeUndefined();
  });
});

describe('whether pip install . can build the project', () => {
  const build = async (files: Record<string, string>, dirs: string[] = []) => {
    const { mkdtemp, writeFile, mkdir } = await import('node:fs/promises');
    const { join, dirname } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const root = await mkdtemp(join(tmpdir(), 'devlaunch-pkg-'));
    for (const d of dirs) await mkdir(join(root, d), { recursive: true });
    for (const [rel, body] of Object.entries(files)) {
      await mkdir(dirname(join(root, rel)), { recursive: true });
      await writeFile(join(root, rel), body);
    }
    return root;
  };
  const PYPROJECT = '[project]\nname = "svc"\ndependencies = ["fastapi", "uvicorn"]\n';

  it('is false for an ordinary application laid out flat', async () => {
    // Taken from a real run: setuptools refused with `Multiple top-level packages
    // discovered in a flat-layout: ['app', 'certs', 'resources']`. The layout is
    // correct for an application; it is simply not a distribution.
    const root = await build({ 'pyproject.toml': PYPROJECT, 'main.py': 'x = 1\n' }, ['app', 'certs', 'resources']);
    expect((await analyzer.analyze(root, '.')).python?.packageable).toBe(false);
  });

  it('is true when the project says where its code is, or uses a src layout', async () => {
    const explicit = await build({ 'pyproject.toml': PYPROJECT + '\n[tool.setuptools]\npackages = ["app"]\n' }, ['app', 'certs']);
    expect((await analyzer.analyze(explicit, '.')).python?.packageable).toBe(true);
    const src = await build({ 'pyproject.toml': PYPROJECT }, ['src', 'certs', 'resources']);
    expect((await analyzer.analyze(src, '.')).python?.packageable).toBe(true);
  });

  it('is true for a single package, ignoring the directories setuptools ignores', async () => {
    const root = await build({ 'pyproject.toml': PYPROJECT }, ['app', 'tests', 'docs', 'scripts', '.github']);
    expect((await analyzer.analyze(root, '.')).python?.packageable).toBe(true);
  });
});

describe('a schema script the application needs before it can answer', () => {
  it('is found by name, and setup.py never is', async () => {
    // Observed: app.py opens todo.db and db_create.py creates its tables. Skipped, the
    // application starts perfectly and answers 500 to every request with
    // `no such table: tasks` — which reads as a broken repository and is a missing step.
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(join(tmpdir(), 'devlaunch-init-'));
    await writeFile(join(dir, 'requirements.txt'), 'Flask==2.2.2\n');
    await writeFile(join(dir, 'app.py'), 'from flask import Flask\napp = Flask(__name__)\n');
    await writeFile(join(dir, 'db_create.py'), 'import sqlite3\n');
    // Packaging, not schema. Running it here would build a wheel, not a database.
    await writeFile(join(dir, 'setup.py'), 'from setuptools import setup\nsetup()\n');
    await writeFile(join(dir, 'seed.py'), 'print("data")\n');

    const meta = await analyzer.analyze(dir, '.');
    expect(meta.python?.initScripts).toEqual(['db_create.py']);
  });
});

describe('what a Python project needs, when it declares it only in its imports', () => {
  /** Build a repository on disk from a path → contents map. */
  async function pyRepo(files: Record<string, string>): Promise<string> {
    const { mkdtemp, writeFile, mkdir } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join, dirname: dir } = await import('node:path');
    const root = await mkdtemp(join(tmpdir(), 'devlaunch-pyimp-'));
    scratch.push(root);
    for (const [path, contents] of Object.entries(files)) {
      const full = join(root, path);
      await mkdir(dir(full), { recursive: true });
      await writeFile(full, contents);
    }
    return root;
  }

  it('follows the repository\'s own imports to the file that names the dependency', async () => {
    // A FastAPI tutorial's main.py imports `fastapi` and `models`; `models.py` is where
    // `sqlalchemy` appears. Reading the entry file alone installed two of the three
    // distributions the application needs, and the run died on `No module named
    // 'sqlalchemy'`.
    const root = await pyRepo({
      'main.py': 'from fastapi import FastAPI\nimport models\napp = FastAPI()\n',
      'models.py': 'from sqlalchemy import Column\n',
    });
    const meta = await analyzer.analyze(root);
    expect(meta.python?.imports).toEqual(['fastapi', 'sqlalchemy']);
  });

  it('never proposes installing a package the repository provides', async () => {
    // `routers/` is a directory in this repository. `pip install routers` does not
    // exist, and one bad name fails the whole install command.
    const root = await pyRepo({
      'main.py': 'from fastapi import FastAPI\nfrom routers import todos\n',
      'routers/__init__.py': '',
      'routers/todos.py': 'from sqlalchemy.orm import Session\n',
    });
    const meta = await analyzer.analyze(root);
    expect(meta.python?.imports).not.toContain('routers');
    expect(meta.python?.imports).toContain('sqlalchemy');
  });

  it('reads the modules inside a package, not only its __init__', async () => {
    // A package's __init__.py is usually empty, and the dependencies live beside it.
    const root = await pyRepo({
      'main.py': 'from fastapi import FastAPI\nimport api\n',
      'api/__init__.py': '',
      'api/auth.py': 'from passlib.context import CryptContext\n',
    });
    const meta = await analyzer.analyze(root);
    expect(meta.python?.imports).toContain('passlib');
  });

  it('reports no imports for a project that declares its dependencies properly', async () => {
    // Nothing is wrong with also reading them, but the planner prefers requirements.txt
    // and this keeps the two facts distinguishable.
    const root = await pyRepo({
      'requirements.txt': 'flask==3.0.0\n',
      'app.py': 'from flask import Flask\napp = Flask(__name__)\n',
    });
    const meta = await analyzer.analyze(root);
    expect(meta.python?.requirements).toEqual(['flask==3.0.0']);
  });
});

describe('which file starts the application', () => {
  async function pyDir(files: Record<string, string>): Promise<string> {
    const { mkdtemp, writeFile, mkdir } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join, dirname: dir } = await import('node:path');
    const root = await mkdtemp(join(tmpdir(), 'devlaunch-entry2-'));
    scratch.push(root);
    for (const [path, contents] of Object.entries(files)) {
      const full = join(root, path);
      await mkdir(dir(full), { recursive: true });
      await writeFile(full, contents);
    }
    return root;
  }

  it('finds a Streamlit program that is not called app.py', async () => {
    // `streamlit run app.py` on a repository whose program is `dashboard.py` fails with
    // `Invalid value: File does not exist`, and a model then guessed `src/app.py`.
    const root = await pyDir({
      'requirements.txt': 'streamlit\npandas\n',
      'dashboard.py': 'import streamlit as st\nst.title("hi")\n',
      'config.py': "KEY = ''\n",
    });
    const meta = await analyzer.analyze(root);
    const entry = meta.python?.entryCandidates.find((e) => e.framework === 'streamlit');
    expect(entry?.file).toBe('dashboard.py');
  });

  it('still prefers a conventional name when there is one', async () => {
    const root = await pyDir({
      'requirements.txt': 'flask\n',
      'app.py': 'from flask import Flask\napp = Flask(__name__)\n',
      'helpers.py': 'from flask import request\n',
    });
    const meta = await analyzer.analyze(root);
    expect(meta.python?.entryCandidates[0]?.file).toBe('app.py');
  });

  it('never treats setup.py as the program', async () => {
    // It is packaging, and running it as an application is how a repository gets
    // installed instead of started.
    const root = await pyDir({
      'requirements.txt': 'streamlit\n',
      'setup.py': 'import streamlit\n',
      'dashboard.py': 'import streamlit as st\n',
    });
    const meta = await analyzer.analyze(root);
    expect(meta.python?.entryCandidates.map((e) => e.file)).not.toContain('setup.py');
  });

  it('recognises Gradio the same way', async () => {
    const root = await pyDir({
      'requirements.txt': 'gradio\n',
      'demo.py': 'import gradio as gr\n',
    });
    const meta = await analyzer.analyze(root);
    expect(meta.python?.entryCandidates.find((e) => e.framework === 'gradio')?.file).toBe('demo.py');
  });
});

describe('an application one level down that is not a package', () => {
  async function pyTree(files: Record<string, string>): Promise<string> {
    const { mkdtemp, writeFile, mkdir } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join, dirname: dir } = await import('node:path');
    const root = await mkdtemp(join(tmpdir(), 'devlaunch-subdir-'));
    scratch.push(root);
    for (const [path, contents] of Object.entries(files)) {
      const full = join(root, path);
      await mkdir(dir(full), { recursive: true });
      await writeFile(full, contents);
    }
    return root;
  }

  it('finds app/app.py when there is no __init__.py anywhere', async () => {
    // The package scan requires `__init__.py` and the root scan never looks down, so
    // this shape had no entry at all — and the planner settled on whatever else was at
    // the root, which in one repository was `tests.py`.
    const root = await pyTree({
      'requirements.txt': 'Flask==2.3.0\n',
      'tests.py': 'import pytest\nimport requests\n',
      'app/app.py': 'from flask import Flask\napp = Flask(__name__)\n',
    });
    const meta = await analyzer.analyze(root);
    const entry = meta.python?.entryCandidates.find((e) => e.framework === 'flask');
    expect(entry).toMatchObject({ file: 'app.py', dir: 'app' });
  });

  it('marks a file named like an entry point as conventional', async () => {
    const root = await pyTree({
      'requirements.txt': 'Flask\n',
      'tests.py': 'import pytest\n',
      'main.py': 'from flask import Flask\napp = Flask(__name__)\n',
    });
    const meta = await analyzer.analyze(root);
    const byName = Object.fromEntries(
      (meta.python?.entryCandidates ?? []).map((e) => [e.file, e.conventional]),
    );
    expect(byName['main.py']).toBe(true);
    expect(byName['tests.py']).toBe(false);
  });

  it('does not go looking inside tests/ for the application', async () => {
    const root = await pyTree({
      'requirements.txt': 'Flask\n',
      'tests/app.py': 'from flask import Flask\napp = Flask(__name__)\n',
    });
    const meta = await analyzer.analyze(root);
    expect(meta.python?.entryCandidates.find((e) => e.dir === 'tests')).toBeUndefined();
  });

  it('never proposes installing a module that sits beside the importer', async () => {
    // `routes` is a directory inside `app/`, invisible from the repository root — and
    // `pip install routes` is not a thing.
    const root = await pyTree({
      'requirements.txt': 'Flask\n',
      'app/app.py': "from flask import Flask\nfrom routes.task import go\nimport flasgger\n",
      'app/routes/task.py': 'def go(): pass\n',
    });
    const meta = await analyzer.analyze(root);
    expect(meta.python?.imports).toContain('flasgger');
    expect(meta.python?.imports).not.toContain('routes');
  });
});

describe('the builder behind ng serve', () => {
  async function withAngularJson(body: unknown): Promise<string | undefined> {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(join(tmpdir(), 'devlaunch-angular-'));
    try {
      await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { start: 'ng serve' } }));
      await writeFile(join(dir, 'angular.json'), typeof body === 'string' ? body : JSON.stringify(body));
      return (await new RepositoryAnalyzer().analyze(dir)).angularDevServer;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it('reads the serve target, under either of its two names', async () => {
    expect(await withAngularJson({ projects: { app: { architect: { serve: { builder: '@angular/build:dev-server' } } } } }))
      .toBe('@angular/build:dev-server');
    // Nx-style workspaces call the same thing `targets`.
    expect(await withAngularJson({ projects: { app: { targets: { serve: { builder: '@angular-devkit/build-angular:dev-server' } } } } }))
      .toBe('@angular-devkit/build-angular:dev-server');
  });

  it('takes the first project that has a serve target, skipping a library that has none', async () => {
    expect(await withAngularJson({
      projects: {
        lib: { architect: { build: { builder: '@angular/build:ng-packagr' } } },
        app: { architect: { serve: { builder: '@angular/build:dev-server' } } },
      },
    })).toBe('@angular/build:dev-server');
  });

  it('says nothing about an angular.json it cannot read', async () => {
    expect(await withAngularJson('{ not json')).toBeUndefined();
    expect(await withAngularJson({ projects: {} })).toBeUndefined();
  });
});
