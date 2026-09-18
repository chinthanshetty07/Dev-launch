import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { BackingService, ServiceCandidate, ServiceRole } from '@devlaunch/shared';
import type { EnvExampleVar } from '@devlaunch/shared';
import { readCapped } from './readCapped.js';
import { parseEnvExample } from './parseEnvExample.js';

/**
 * Find every part of a repository that has to run for the project to work.
 *
 * A repository is not one application. `frontend/` calling `backend/` is the ordinary
 * shape of a web project, and starting only one of them yields a page that loads and
 * then fails every request it makes — which reads as a broken tool rather than a
 * half-started application. Deterministic on purpose, like the rest of planning: these
 * are conventions almost every repository follows, so a model should not be asked.
 */

/** Directories worth looking inside. Depth 1, plus the monorepo conventions. */
const CONTAINER_DIRS = ['apps', 'packages', 'services'];

/** Never a service, and expensive to walk. */
const IGNORED = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt',
  'venv', '.venv', '__pycache__', 'vendor', 'target', 'tmp', '.cache',
]);

/** Dependencies that identify a service served to a browser. */
const WEB_DEPS = [
  'react', 'react-dom', 'vue', 'svelte', '@angular/core', 'next', 'nuxt',
  'vite', '@vitejs/plugin-react', 'gatsby', 'solid-js', 'preact',
];

/** Dependencies that identify a service called over HTTP by something else. */
const API_DEPS = [
  'express', 'fastify', 'koa', '@nestjs/core', 'hapi', '@hapi/hapi', 'restify',
  'apollo-server', '@apollo/server', 'graphql-yoga', 'socket.io',
];

/** Directory names that settle the question when dependencies do not. */
const WEB_NAMES = ['frontend', 'client', 'web', 'ui', 'www', 'site', 'app'];
const API_NAMES = ['backend', 'server', 'api', 'service'];

const PYTHON_API_DEPS = ['flask', 'django', 'fastapi', 'starlette', 'tornado', 'bottle'];

interface BackingRule {
  kind: BackingService['kind'];
  deps: string[];
  /** Environment variables that name the same need, for repositories that declare it there. */
  envKeys: string[];
}

const BACKING_RULES: readonly BackingRule[] = [
  {
    kind: 'mongodb',
    deps: ['mongoose', 'mongodb', 'mongojs', 'pymongo', 'motor'],
    envKeys: ['MONGO_URI', 'MONGODB_URI', 'MONGO_URL', 'MONGODB_URL'],
  },
  {
    kind: 'postgres',
    deps: ['pg', 'postgres', 'sequelize', 'typeorm', 'prisma', '@prisma/client', 'knex', 'psycopg2', 'psycopg2-binary', 'asyncpg'],
    envKeys: ['DATABASE_URL', 'POSTGRES_URL', 'POSTGRES_URI', 'PG_URL'],
  },
  {
    kind: 'mysql',
    deps: ['mysql', 'mysql2', 'mariadb', 'pymysql'],
    envKeys: ['MYSQL_URL', 'MYSQL_URI'],
  },
  {
    kind: 'redis',
    deps: ['redis', 'ioredis', 'connect-redis', 'bullmq', 'bull'],
    envKeys: ['REDIS_URL', 'REDIS_URI'],
  },
];

/** Source files worth scanning for a hardcoded API origin. Bounded on purpose. */
const SOURCE_DIRS = ['src', 'app', 'lib', 'source'];
const SOURCE_EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx', '.vue', '.svelte'];
const MAX_SOURCE_FILES = 60;

interface Manifest {
  name?: string;
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
}

export interface DiscoveryResult {
  services: ServiceCandidate[];
  backing: BackingService[];
}

/**
 * Discover the runnable parts of a repository and the infrastructure they expect.
 *
 * Returns an empty service list for an ordinary single-service repository: the existing
 * single-service path is correct for those, and inventing a second service would be
 * worse than finding none.
 */
export async function discoverServices(root: string): Promise<DiscoveryResult> {
  const dirs = await candidateDirs(root);
  const orchestrator = await isWorkspaceRoot(root);
  const services: ServiceCandidate[] = [];
  const backing = new Map<BackingService['kind'], BackingService>();

  for (const dir of dirs) {
    // A workspace root is an orchestrator, not a service. Its `dev` script delegates to
    // one of its own packages, so running it starts a second copy of a service that is
    // already in this list — competing for the same port, against itself.
    if (dir === '.' && orchestrator) continue;

    const service = await inspectDir(root, dir);
    if (!service) continue;
    services.push(service.candidate);
    for (const found of service.backing) {
      const existing = backing.get(found.kind);
      if (existing) existing.neededBy.push(service.candidate.name);
      else backing.set(found.kind, { ...found, neededBy: [service.candidate.name] });
    }
  }

  // One service is the ordinary case and needs none of this. Reporting it as a
  // multi-service repository would route it down a path built for a problem it does
  // not have.
  if (services.length < 2) return { services: [], backing: [...backing.values()] };

  return { services: sortByRole(services), backing: [...backing.values()] };
}

/**
 * Does this repository declare workspaces?
 *
 * Either declaration is enough: both mean the root exists to coordinate packages that
 * live elsewhere, and its scripts are shortcuts into them rather than a service of its
 * own.
 */
async function isWorkspaceRoot(root: string): Promise<boolean> {
  if ((await readCapped(join(root, 'pnpm-workspace.yaml'))) !== null) return true;
  const raw = await readCapped(join(root, 'package.json'));
  if (raw === null) return false;
  try {
    const parsed = JSON.parse(raw) as { workspaces?: unknown };
    const workspaces = parsed.workspaces;
    return (
      (Array.isArray(workspaces) && workspaces.length > 0) ||
      (typeof workspaces === 'object' &&
        workspaces !== null &&
        Array.isArray((workspaces as { packages?: unknown }).packages))
    );
  } catch {
    return false;
  }
}

/** Immediate subdirectories, plus one level inside apps/ packages/ services/. */
async function candidateDirs(root: string): Promise<string[]> {
  const out: string[] = ['.'];
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    if (!entry.isDirectory() || IGNORED.has(entry.name) || entry.name.startsWith('.')) continue;
    out.push(entry.name);

    if (CONTAINER_DIRS.includes(entry.name)) {
      const nested = await readdir(join(root, entry.name), { withFileTypes: true }).catch(() => []);
      for (const child of nested) {
        if (child.isDirectory() && !IGNORED.has(child.name) && !child.name.startsWith('.')) {
          out.push(`${entry.name}/${child.name}`);
        }
      }
    }
  }
  return out;
}

async function inspectDir(
  root: string,
  dir: string,
): Promise<{ candidate: ServiceCandidate; backing: Omit<BackingService, 'neededBy'>[] } | null> {
  const base = dir === '.' ? root : join(root, dir);
  const manifest = await readManifest(join(base, 'package.json'));

  if (manifest) {
    // A package that cannot be started is a library, not a service.
    const scripts = Object.keys(manifest.scripts);
    if (!scripts.includes('dev') && !scripts.includes('start')) return null;

    const { role, evidence } = classifyNode(dir, manifest);
    const envKeys = await serviceEnvKeys(base);
    const candidate: ServiceCandidate = {
      name: manifest.name ?? baseName(dir),
      dir,
      role,
      language: 'node',
      scripts,
      evidence,
      declaredPort: await findDeclaredPort(base, manifest),
      envKeys,
      envExample: await serviceEnvExample(base),
    };
    if (role === 'web') {
      const origins = await findCalledOrigins(base);
      if (origins.length) candidate.callsOrigins = origins;
    }
    return { candidate, backing: backingFor(Object.keys(manifest.dependencies), envKeys) };
  }

  const python = await readPythonDeps(base);
  if (!python) return null;
  const pythonEnvKeys = await serviceEnvKeys(base);
  const isApi = python.deps.some((d) => PYTHON_API_DEPS.includes(d)) || python.hasManagePy;
  if (!isApi) return null;

  return {
    candidate: {
      name: baseName(dir),
      dir,
      role: 'api',
      language: 'python',
      scripts: [],
      evidence: python.hasManagePy ? 'has manage.py' : `requires ${python.deps.find((d) => PYTHON_API_DEPS.includes(d))}`,
      declaredPort: python.hasManagePy ? 8000 : undefined,
      envKeys: pythonEnvKeys,
      envExample: await serviceEnvExample(base),
    },
    backing: backingFor(python.deps, pythonEnvKeys),
  };
}

function classifyNode(dir: string, manifest: Manifest): { role: ServiceRole; evidence: string } {
  const deps = Object.keys(manifest.dependencies);
  // Only a real directory name is evidence. The root has none, and the placeholder it
  // was given happened to be "app" — which is in the list below, so every repository
  // root was classified as browser-facing by accident.
  const name = dir === '.' ? '' : baseName(dir).toLowerCase();

  // Dependencies beat directory names: a folder called `server` that imports React is a
  // server-rendered frontend, and the name is the less reliable signal.
  const web = WEB_DEPS.find((d) => deps.includes(d));
  const api = API_DEPS.find((d) => deps.includes(d));

  if (web && !api) return { role: 'web', evidence: `depends on ${web}` };
  if (api && !web) return { role: 'api', evidence: `depends on ${api}` };
  if (web && api) {
    // Both present: Next.js and friends serve a UI and its API from one process.
    return { role: 'web', evidence: `depends on ${web} and ${api}` };
  }

  if (WEB_NAMES.includes(name)) return { role: 'web', evidence: `directory named ${name}` };
  if (API_NAMES.includes(name)) return { role: 'api', evidence: `directory named ${name}` };
  return { role: 'worker', evidence: 'no web or server framework found' };
}

/**
 * Which databases a service needs, and the variable *it* reads the connection from.
 *
 * The variable name is the whole game. A service that reads `MONGODB_URI` finds nothing
 * in `MONGO_URI`, and an injected variable nobody reads is indistinguishable from no
 * database at all — which is exactly how a provisioned, healthy MongoDB still produced
 * `connect ECONNREFUSED 127.0.0.1:27017`.
 *
 * So the key the service itself declares always wins. With no declaration to go on,
 * every known alias for that kind is offered rather than one guess: an unread variable
 * costs nothing, and guessing wrong costs the whole run.
 */
function backingFor(deps: string[], declaredKeys: string[]): Omit<BackingService, 'neededBy'>[] {
  const out: Omit<BackingService, 'neededBy'>[] = [];
  for (const rule of BACKING_RULES) {
    const dep = rule.deps.find((d) => deps.includes(d));
    if (!dep) continue;
    const declared = rule.envKeys.filter((k) => declaredKeys.includes(k));
    out.push({
      kind: rule.kind,
      evidence: `depends on ${dep}`,
      urlEnvKey: declared[0],
      urlEnvKeys: declared.length ? declared : [...rule.envKeys],
    });
  }
  return out;
}

/**
 * The service's own `.env.example`, with whether each variable ships a value.
 *
 * Distinct from `serviceEnvKeys`, which answers "does this service read X" from source
 * as well. Only a declaration with no value is a *request*: a variable with a default is
 * documentation, and asking a person to supply one they already have is noise.
 */
async function serviceEnvExample(base: string): Promise<EnvExampleVar[] | undefined> {
  for (const name of ['.env.example', '.env.sample', '.env.template']) {
    const raw = await readCapped(join(base, name));
    if (raw !== null) return parseEnvExample(raw);
  }
  return undefined;
}

/**
 * Environment variables a service names for itself.
 *
 * Two sources, because repositories use either: `.env.example` in the service's own
 * directory — which the root-level analyzer never sees — and `process.env.X` in its
 * source, which is the only evidence when no example file is shipped.
 */
async function serviceEnvKeys(base: string): Promise<string[]> {
  const keys = new Set<string>();

  for (const name of ['.env.example', '.env.sample', '.env.template']) {
    const raw = await readCapped(join(base, name));
    if (raw === null) continue;
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq > 0) keys.add(trimmed.slice(0, eq).replace(/^export\s+/, '').trim());
    }
  }

  for (const file of await collectSourceFiles(base, 40)) {
    const raw = await readCapped(file);
    if (raw === null) continue;
    for (const m of raw.matchAll(/process\.env\.([A-Z][A-Z0-9_]{2,})/g)) keys.add(m[1]!);
    // Vite, SvelteKit and friends expose build-time configuration here instead, and a
    // frontend is exactly the kind of service whose API base URL has to be injected.
    for (const m of raw.matchAll(/import\.meta\.env\.([A-Z][A-Z0-9_]{2,})/g)) keys.add(m[1]!);
    for (const m of raw.matchAll(/os\.environ(?:\.get)?[[(]['"]([A-Z][A-Z0-9_]{2,})['"]/g)) keys.add(m[1]!);
  }

  return [...keys];
}

/** Match a backing service to the variable a repository actually reads it from. */
export function backingFromEnvKeys(keys: string[]): Omit<BackingService, 'neededBy'>[] {
  const out: Omit<BackingService, 'neededBy'>[] = [];
  for (const rule of BACKING_RULES) {
    const declared = rule.envKeys.filter((k) => keys.includes(k));
    if (declared.length) {
      out.push({
        kind: rule.kind,
        evidence: `declares ${declared[0]}`,
        urlEnvKey: declared[0],
        urlEnvKeys: declared,
      });
    }
  }
  return out;
}

/**
 * The port a service's own code defaults to.
 *
 * `process.env.PORT || 5000` is the near-universal shape, and the literal is the number
 * that matters: it is what the service binds when nothing overrides it.
 */
async function findDeclaredPort(base: string, manifest: Manifest): Promise<number | undefined> {
  const entryFiles = ['server.js', 'index.js', 'app.js', 'main.js', 'server.ts', 'index.ts', 'app.ts'];
  const fromScript = /--port[= ](\d{2,5})/.exec(Object.values(manifest.scripts).join(' '));
  if (fromScript) return Number(fromScript[1]);

  for (const file of entryFiles) {
    for (const candidate of [file, join('src', file)]) {
      const raw = await readCapped(join(base, candidate));
      if (raw === null) continue;
      const match =
        /process\.env\.PORT\s*\|\|\s*(\d{2,5})/.exec(raw) ??
        /\.listen\(\s*(\d{2,5})/.exec(raw) ??
        /PORT\s*=\s*(\d{2,5})/.exec(raw);
      if (match) return Number(match[1]);
    }
  }
  return undefined;
}

/**
 * Absolute origins a browser-facing service has hardcoded.
 *
 * `fetch('http://localhost:5001/api/...')` runs in the *browser*, so no container alias
 * or internal network can satisfy it — the API has to be published on that exact host
 * port or every request the page makes is refused. Finding it is what turns that from a
 * mystery into a decision.
 */
async function findCalledOrigins(base: string): Promise<string[]> {
  const files = await collectSourceFiles(base);
  const origins = new Set<string>();

  for (const file of files) {
    const raw = await readCapped(file);
    if (raw === null) continue;
    for (const match of raw.matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1):(\d{2,5})/g)) {
      origins.add(match[0]);
    }
  }
  return [...origins];
}

async function collectSourceFiles(base: string, budget = MAX_SOURCE_FILES): Promise<string[]> {
  const out: string[] = [];

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (out.length >= budget || depth > 3) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (out.length >= budget) return;
      if (entry.isDirectory()) {
        if (IGNORED.has(entry.name) || entry.name.startsWith('.')) continue;
        await walk(join(dir, entry.name), depth + 1);
      } else if (SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
        out.push(join(dir, entry.name));
      }
    }
  };

  for (const dir of SOURCE_DIRS) await walk(join(base, dir), 0);
  // Some projects keep sources at the root of the service directory.
  if (out.length === 0) await walk(base, 3);
  return out;
}

async function readManifest(path: string): Promise<Manifest | null> {
  const raw = await readCapped(path);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      name: typeof parsed.name === 'string' ? parsed.name : undefined,
      scripts: asRecord(parsed.scripts),
      dependencies: { ...asRecord(parsed.dependencies), ...asRecord(parsed.devDependencies) },
    };
  } catch {
    // An unreadable manifest is the analyzer's business to report; here it simply means
    // this directory cannot be classified.
    return null;
  }
}

async function readPythonDeps(
  base: string,
): Promise<{ deps: string[]; hasManagePy: boolean } | null> {
  const requirements = await readCapped(join(base, 'requirements.txt'));
  const managePy = await readCapped(join(base, 'manage.py'));
  if (requirements === null && managePy === null) return null;

  const deps = (requirements ?? '')
    .split('\n')
    .map((line) => line.trim().split(/[=<>~!\[; ]/)[0]!.toLowerCase())
    .filter(Boolean);

  return { deps, hasManagePy: managePy !== null };
}

function asRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

const baseName = (dir: string): string => (dir === '.' ? 'root' : dir.split('/').pop()!);

/** Web first: it is the session's entry point, and the URL a person is given. */
function sortByRole(services: ServiceCandidate[]): ServiceCandidate[] {
  const rank: Record<ServiceRole, number> = { web: 0, api: 1, worker: 2 };
  return [...services].sort((a, b) => rank[a.role] - rank[b.role] || a.dir.localeCompare(b.dir));
}
