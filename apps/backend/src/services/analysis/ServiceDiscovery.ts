import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
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
const CONTAINER_DIRS = ['apps', 'app', 'packages', 'services', 'src'];

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
// `.py` because the scan already looks for `os.environ[...]` and never had a Python
// file to find it in; `.mjs`/`.cjs` because a repository that picked one of them is
// otherwise read as having no source at all.
const SOURCE_EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx', '.vue', '.svelte', '.mjs', '.cjs', '.py'];
const MAX_SOURCE_FILES = 60;

export interface Manifest {
  name?: string;
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  /** Create React App's dev-server proxy, declared in the manifest rather than a config. */
  proxy?: string;
}

export interface DiscoveryResult {
  /** Runnable parts, only when there are several. A lone one is not a "project". */
  services: ServiceCandidate[];
  /**
   * Every runnable part found, including the case of exactly one.
   *
   * `services` is gated at two on purpose — one service is the ordinary case and must
   * not be routed down the multi-service path. But the gate threw the single candidate
   * away entirely, and with it the only record of *where* it lives: a repository whose
   * whole application sits in `src/`, declared by its own compose file, was planned at
   * the root, found no manifest there, and fell through to the model.
   */
  candidates: ServiceCandidate[];
  backing: BackingService[];
}

/**
 * Discover the runnable parts of a repository and the infrastructure they expect.
 *
 * Returns an empty service list for an ordinary single-service repository: the existing
 * single-service path is correct for those, and inventing a second service would be
 * worse than finding none.
 */
/**
 * Which package manager can install this workspace, and with what command.
 *
 * The lockfile decides, because the workspace protocol is only resolvable by the tool
 * that wrote it. npm understands `workspaces` in package.json but refuses `workspace:*`
 * outright — `EUNSUPPORTEDPROTOCOL` — so a pnpm repository installed with npm fails
 * before it starts.
 */
export async function workspaceInstall(
  root: string,
): Promise<{ manager: 'pnpm' | 'yarn' | 'npm'; command: string } | null> {
  if (!(await isWorkspaceRoot(root))) return null;

  if ((await readCapped(join(root, 'pnpm-lock.yaml'))) !== null) {
    // --no-frozen-lockfile: a lockfile written by a different pnpm version would
    // otherwise abort, and a repository that installs locally should install here.
    return { manager: 'pnpm', command: 'pnpm install --no-frozen-lockfile' };
  }
  if ((await readCapped(join(root, 'yarn.lock'))) !== null) {
    return { manager: 'yarn', command: 'yarn install' };
  }
  if ((await readCapped(join(root, 'pnpm-workspace.yaml'))) !== null) {
    return { manager: 'pnpm', command: 'pnpm install --no-frozen-lockfile' };
  }
  return { manager: 'npm', command: 'npm install --no-audit --no-fund' };
}

/**
 * @param declaredDirs Directories a compose file names outright.
 *
 * Conventions are a guess and a declaration is not. `app/backend` was missed here for
 * exactly one reason — the convention list held `apps` and not `app` — while the
 * repository's own compose file named the path in full. Reading it removes the guess
 * rather than lengthening the list.
 */
export async function discoverServices(
  root: string,
  declaredDirs: readonly string[] = [],
): Promise<DiscoveryResult> {
  const dirs = await candidateDirs(root, declaredDirs);
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
  // not have. It is still carried as a candidate: where it lives is worth knowing.
  if (services.length < 2) {
    return { services: [], candidates: services, backing: [...backing.values()] };
  }

  const sorted = sortByRole(services);
  return { services: sorted, candidates: sorted, backing: [...backing.values()] };
}

/**
 * Does this repository declare workspaces?
 *
 * Either declaration is enough: both mean the root exists to coordinate packages that
 * live elsewhere, and its scripts are shortcuts into them rather than a service of its
 * own.
 */
export async function isWorkspaceRoot(root: string): Promise<boolean> {
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
async function candidateDirs(root: string, declared: readonly string[] = []): Promise<string[]> {
  const out: string[] = ['.', ...declared.filter((d) => d && d !== '.')];
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
  // A declared directory can also be found by convention, and two compose services
  // can be built from one directory; either way it is probed once.
  return [...new Set(out)];
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
      const proxy = await findDevServerProxy(base, manifest);
      if (proxy) candidate.devProxy = proxy;
    }
    // The other end of the same wire, and for a long time the end nobody looked at:
    // this scan ran for `web` only, so an API's own CORS allowlist — the thing that
    // decides whether the page's requests are answered — was never read at all.
    if (role === 'api') {
      const accepted = await findAcceptedOrigins(base);
      if (accepted.length) candidate.acceptsOrigins = accepted;
    }
    return { candidate, backing: backingFor(Object.keys(manifest.dependencies), envKeys) };
  }

  const python = await readPythonDeps(base);
  if (!python) return null;
  const pythonEnvKeys = await serviceEnvKeys(base);
  const isApi = python.deps.some((d) => PYTHON_API_DEPS.includes(d)) || python.hasManagePy;
  if (!isApi) return null;
  const pythonAccepts = await findAcceptedOrigins(base);

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
      ...(pythonAccepts.length ? { acceptsOrigins: pythonAccepts } : {}),
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
  const matched = BACKING_RULES.map((rule) => ({
    rule,
    dep: rule.deps.find((d) => deps.includes(d)),
  })).filter((m): m is { rule: BackingRule; dep: string } => m.dep !== undefined);

  const kinds = matched.map((m) => m.rule.kind);

  return matched.map(({ rule, dep }) => {
    const known = rule.envKeys.filter((k) => declaredKeys.includes(k));
    const custom = customConnectionKeys(declaredKeys, rule, kinds);
    // The service's own name first: it is a fact about this repository, where the alias
    // list is only a prediction about repositories in general.
    const declared = [...custom, ...known];
    return {
      kind: rule.kind,
      evidence: custom.length ? `depends on ${dep} and reads ${custom[0]}` : `depends on ${dep}`,
      // The matched dependency *is* the driver. Carried forward because the connection
      // string has to name it: a repository depending on asyncpg needs
      // `postgresql+asyncpg://`, and the plain scheme sends SQLAlchemy to psycopg2.
      driver: dep,
      urlEnvKey: declared[0],
      // Every alias as well, even when the service named its own: they cost nothing
      // unread, and a repository can read one name in code and another in a config file
      // the scan did not reach.
      urlEnvKeys: [...new Set([...declared, ...rule.envKeys])],
    };
  });
}

/**
 * Variables this service reads a connection string from under a name nobody predicted.
 *
 * `process.env.CONNECTION_STRING` is what one real repository passes to
 * `mongoose.connect`. It is not `MONGO_URI`, so a provisioned, healthy MongoDB was
 * injected under four names the application never read, and it crashed at boot with
 * `The uri parameter to openUri() must be a string, got "undefined"`. The alias list can
 * be lengthened forever and will keep losing this race; what the service's own source
 * says it reads cannot.
 *
 * Two things keep this from guessing. The name has to be shaped like a connection
 * string rather than like a setting, and it has to be attributable: either it names the
 * kind outright, or exactly one kind was detected and there is nothing to confuse it
 * with. A repository needing both Postgres and Redis and reading a bare `DATABASE_URL`
 * gets nothing from here, which is correct — the alias lists already cover it.
 */
function customConnectionKeys(
  declaredKeys: readonly string[],
  rule: BackingRule,
  allKinds: readonly BackingService['kind'][],
): string[] {
  const known = new Set(BACKING_RULES.flatMap((r) => r.envKeys));
  const onlyKind = allKinds.length === 1;

  return declaredKeys.filter((key) => {
    if (known.has(key) || !looksLikeConnectionString(key)) return false;
    const named = KIND_TOKENS[rule.kind].test(key);
    if (named) return true;
    // Unattributable unless it cannot be confused with a sibling's.
    return onlyKind && !BACKING_RULES.some((r) => r.kind !== rule.kind && KIND_TOKENS[r.kind].test(key));
  });
}

/** What a variable of this kind is called, wherever a repository names one explicitly. */
const KIND_TOKENS: Record<BackingService['kind'], RegExp> = {
  mongodb: /MONGO/,
  postgres: /POSTGRE|POSTGRES|\bPG_|_PG_/,
  mysql: /MYSQL|MARIA/,
  redis: /REDIS/,
};

/**
 * Whether a variable name carries a connection string rather than an ordinary setting.
 *
 * The suffix is the signal, and the exclusions are what stop it being a menace: plenty
 * of variables end in `_URL` and point at a frontend, a callback or a webhook. Writing a
 * database's address into `CLIENT_URL` would break a working application to fix one that
 * was not broken.
 */
export function looksLikeConnectionString(key: string): boolean {
  if (!/(?:_URL|_URI|_DSN|CONNECTION_?STRING|^DSN$|^DATABASE$)$/.test(key)) return false;
  return !/^(?:API|CLIENT|FRONTEND|WEB|APP|CORS|ORIGIN|CALLBACK|REDIRECT|WEBHOOK|BASE|SITE|PUBLIC|NEXT_PUBLIC|VITE|REACT_APP|SERVER|HOST)_/.test(
    key,
  );
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
export async function findDeclaredPort(
  base: string,
  manifest: Manifest,
): Promise<number | undefined> {
  const fromScript = /--port[= ](\d{2,5})/.exec(Object.values(manifest.scripts).join(' '));
  if (fromScript) return Number(fromScript[1]);

  for (const file of NODE_ENTRY_FILES) {
    for (const candidate of [file, join('src', file)]) {
      const raw = await readCapped(join(base, candidate));
      if (raw === null) continue;
      const match =
        // `Number(process.env.PORT) || 5001` and `process.env.PORT ?? 5001` are as
        // common as the bare form, and an anchored pattern read neither — so a service
        // whose port was written down was planned on a framework default instead.
        /process\.env\.PORT\s*(?:\|\||\?\?)\s*(\d{2,5})/.exec(raw) ??
        /(?:Number|parseInt)\s*\(\s*process\.env\.PORT[^)]*\)\s*(?:\|\||\?\?)\s*(\d{2,5})/.exec(raw) ??
        /\.listen\(\s*(\d{2,5})/.exec(raw) ??
        // `const port = 8017`, then `app.listen(port, hostname)`. Lower case, because
        // that is how it is written in ordinary JavaScript — the pattern here was
        // anchored to upper case and matched only the environment-variable spelling, so
        // a repository that hardcodes its port declared nothing and was planned on the
        // framework default it does not use.
        /\b(?:const|let|var)\s+port\s*=\s*(\d{2,5})\b/i.exec(raw) ??
        /\bPORT\s*=\s*(\d{2,5})\b/.exec(raw);
      if (match) return Number(match[1]);
    }
  }
  return undefined;
}

const NODE_ENTRY_FILES = [
  'server.js', 'index.js', 'app.js', 'main.js',
  'server.ts', 'index.ts', 'app.ts', 'server.mjs', 'index.mjs',
];

/**
 * A bind address written into the source as a literal, with the line that proves it.
 *
 * `app.listen(port, 'localhost')` cannot be changed by any environment variable, any
 * flag, or any plan. Knowing that *before* repair runs is the difference between one
 * honest failure naming the line to change and two attempts that could never have
 * worked — a rule forcing HOST, then a model rewriting the start command.
 */
export async function findHardcodedLoopbackBind(
  base: string,
): Promise<{ file: string; line: string } | undefined> {
  for (const file of NODE_ENTRY_FILES) {
    for (const candidate of [file, join('src', file)]) {
      const raw = await readCapped(join(base, candidate));
      if (raw === null) continue;

      // Either the literal in the call itself, or a constant the call is given. Both
      // are the same fact; only the spelling differs.
      const direct = /\.listen\s*\([^)]*['"](localhost|127\.0\.0\.1|::1)['"]/.exec(raw);
      if (direct) return { file: candidate, line: direct[0].slice(0, 120) };

      const named = /\b(?:const|let|var)\s+(host|hostname)\s*=\s*['"](localhost|127\.0\.0\.1|::1)['"]/i.exec(raw);
      if (named && new RegExp(`\\.listen\\s*\\([^)]*\\b${named[1]}\\b`).test(raw)) {
        return { file: candidate, line: named[0].slice(0, 120) };
      }
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

/**
 * The browser origins an API's own source will accept, when it names them literally.
 *
 * `cors({ origin: 'http://localhost:5173' })` and its list form are configuration
 * written as code: no variable reaches them, so DevLaunch cannot hand the API the port
 * its frontend actually got. What it can do is notice, and say which line to change.
 *
 * Deliberately the same loopback-literal shape `findCalledOrigins` looks for, and
 * deliberately not narrowed to lines mentioning CORS. A service that hardcodes
 * `http://localhost:5173` anywhere is a service that has an opinion about where its
 * caller lives, and that opinion is what breaks. A port written as `${PORT}` is not
 * matched, which excludes the common `listening on http://localhost:${PORT}` log line.
 */
async function findAcceptedOrigins(base: string): Promise<{ origin: string; file: string }[]> {
  const files = await collectSourceFiles(base);
  const seen = new Set<string>();
  const out: { origin: string; file: string }[] = [];

  for (const file of files) {
    const raw = await readCapped(file);
    if (raw === null) continue;
    for (const match of raw.matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1):(\d{2,5})/g)) {
      const origin = match[0];
      if (seen.has(origin)) continue;
      seen.add(origin);
      out.push({ origin, file: relative(base, file) });
    }
  }
  return out;
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

  // The service's own top-level files, always — not only when nothing else was found.
  //
  // `vite.config.js`, `next.config.js`, `server.js` and `app.js` live here, and they are
  // where a service's configuration is: proxy targets, ports, the variables it reads. A
  // client with a populated `src/` filled the budget from there and never came back for
  // its own root, so its `vite.config.js` was never read — and a repository whose proxy
  // target is `process.env.API_URL || 'http://127.0.0.1:4000'` was recorded as declaring
  // no variables at all. Nothing could be wired to it, and every request its page made
  // through that proxy failed against an address inside its own container.
  //
  // Listed first because it is the smallest and most informative set here: if anything
  // is going to exhaust the budget, it should not be these.
  for (const entry of await readdir(base, { withFileTypes: true }).catch(() => [])) {
    if (out.length >= budget) break;
    if (entry.isFile() && SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      out.push(join(base, entry.name));
    }
  }

  for (const dir of SOURCE_DIRS) await walk(join(base, dir), 0);
  // Some projects keep sources at the root of the service directory, in directories
  // named for what they hold rather than for being source: `config/`, `routes/`,
  // `models/`. This walked from depth 3, one below the limit, so it read the root's own
  // files and descended into none of them — and a repository whose entire database
  // configuration lives in `config/dbConnection.js` was read as declaring nothing.
  if (out.length === 0) await walk(base, 0);
  return [...new Set(out)];
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
      ...(typeof parsed.proxy === 'string' ? { proxy: parsed.proxy } : {}),
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
  const pyproject = await readCapped(join(base, 'pyproject.toml'));
  const managePy = await readCapped(join(base, 'manage.py'));
  if (requirements === null && pyproject === null && managePy === null) return null;

  const deps = [
    ...requirementNames(requirements ?? ''),
    ...(pyproject === null ? [] : pyprojectDeps(pyproject)),
  ];

  return { deps: [...new Set(deps)], hasManagePy: managePy !== null };
}

/** `asyncpg>=0.29`, `sqlalchemy[asyncio]>=2`, `pkg ; python_version<'3.9'` → the name. */
export const requirementName = (line: string): string =>
  line.trim().split(/[=<>~!\[;(, ]/)[0]!.replace(/^["']|["']$/g, '').toLowerCase();

const requirementNames = (raw: string): string[] =>
  raw.split('\n').map(requirementName).filter((d) => d && !d.startsWith('#') && !d.startsWith('-'));

/**
 * Dependency names from a pyproject.toml.
 *
 * A repository with no requirements.txt used to report no dependencies at all, which is
 * not a cosmetic gap: dependencies are how a database is detected. A modern packaged
 * project — `pip install .`, PEP 621 metadata — declared asyncpg, was seen to declare
 * nothing, got no Postgres and no connection string, and fell back to its own
 * `localhost` default inside a container where nothing listens. It failed with
 * `ConnectionRefusedError: [Errno 111]` from its startup hook, having never been told
 * where its database was.
 *
 * Names only, so this is deliberately not a TOML parser: it reads the four tables that
 * can hold dependencies and ignores everything else, rather than half-implementing a
 * format and being wrong in ways nobody can see.
 */
export function pyprojectDeps(raw: string): string[] {
  return pyprojectDepsBySection(raw).all;
}

/**
 * The same read, split by what the dependency is *for*.
 *
 * Detection wants everything declared — a database driver in a dev group still means a
 * database. Installing wants only what the application needs to run: `pytest` and
 * `httpx` in a runtime container are a slower build and a wider attack surface for
 * nothing.
 */
export function pyprojectDepsBySection(raw: string): { all: string[]; runtime: string[] } {
  const names: string[] = [];
  const runtime: string[] = [];
  let section = '';
  // Buffer for an array that spans lines, which is how nearly all of them are written.
  let pending: string | null = null;

  let intoRuntime = false;
  const takeArray = (text: string): void => {
    for (const m of text.matchAll(/["']([^"']+)["']/g)) {
      const name = requirementName(m[1]!);
      names.push(name);
      if (intoRuntime) runtime.push(name);
    }
  };

  for (const rawLine of raw.split('\n')) {
    const line = rawLine.replace(/\s+#.*$/, '').trim();
    if (!line) continue;

    if (pending !== null) {
      pending += line;
      // Depth, not "contains a ]": `uvicorn[standard]>=0.30` is an ordinary entry whose
      // extras bracket would otherwise end the array early and hide every dependency
      // after it — including, in the repository that prompted this, the database driver.
      if (bracketDepth(pending) > 0) continue;
      takeArray(pending);
      pending = null;
      continue;
    }

    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      section = header[1]!.trim();
      continue;
    }

    // PEP 621 `[project] dependencies = [...]`, its optional extras, and PEP 735 groups.
    const isArraySection =
      (section === 'project' && /^dependencies\s*=/.test(line)) ||
      section === 'project.optional-dependencies' ||
      section === 'dependency-groups';

    if (isArraySection && line.includes('=')) {
      // `[project] dependencies` is what the application needs to run. Its optional
      // extras and PEP 735 groups are not.
      intoRuntime = section === 'project';
      const value = line.slice(line.indexOf('=') + 1).trim();
      if (!value.startsWith('[')) continue;
      if (bracketDepth(value) > 0) pending = value;
      else takeArray(value);
      continue;
    }

    // Poetry declares one dependency per line as `name = "^1.2"`.
    if (/^tool\.poetry(\.group\.[^.]+)?\.dependencies$/.test(section)) {
      const key = /^([A-Za-z0-9._-]+)\s*=/.exec(line);
      // `python` is the interpreter constraint, not a package.
      if (key && key[1]!.toLowerCase() !== 'python') {
        names.push(key[1]!.toLowerCase());
        // Poetry's own group tables are dev; the bare table is runtime.
        if (section === 'tool.poetry.dependencies') runtime.push(key[1]!.toLowerCase());
      }
    }
  }

  return { all: names.filter(Boolean), runtime: runtime.filter(Boolean) };
}

/** Unclosed `[` outside of quoted strings, which is what ends a dependency array. */
function bracketDepth(text: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '[') depth++;
    else if (ch === ']') depth--;
  }
  return depth;
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

/**
 * A dev server told to forward some paths to an address the container cannot reach.
 *
 * `server: { proxy: { '/api': 'http://localhost:8000' } }` in vite.config.js, or
 * `"proxy": "http://localhost:5000"` in a Create React App manifest. Both are resolved
 * by the *dev server process*, which runs inside the frontend's own container — so
 * `localhost` is the frontend, not the API, and every request the page makes returns
 * 502 through a stack that is otherwise working perfectly.
 *
 * Nothing here fixes it: the target is a literal in the repository's own file, and
 * DevLaunch does not edit a repository to make it run. What this does is find it, so the
 * dashboard can name the file, the line and the one-word change, instead of leaving a
 * person to work out why a READY project answers nothing.
 */
export async function findDevServerProxy(
  base: string,
  manifest: Manifest & { proxy?: unknown },
): Promise<{ file: string; target: string } | undefined> {
  if (typeof manifest.proxy === 'string' && LOOPBACK_URL.test(manifest.proxy)) {
    return { file: 'package.json', target: manifest.proxy };
  }

  for (const name of VITE_CONFIGS) {
    const raw = await readCapped(join(base, name));
    if (raw === null) continue;
    // Only inside a proxy block: an origin in a comment or a CORS list is not a target
    // the dev server will forward to.
    const block = /proxy\s*:\s*\{[\s\S]{0,600}/.exec(raw);
    if (!block) continue;
    const target = /target\s*:\s*['"`](https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d{2,5})?)['"`]/.exec(block[0])
      ?? /['"`][^'"`]*['"`]\s*:\s*['"`](https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d{2,5})?)['"`]/.exec(block[0]);
    if (target) return { file: name, target: target[1]! };
  }
  return undefined;
}

const VITE_CONFIGS = [
  'vite.config.js', 'vite.config.ts', 'vite.config.mjs', 'vite.config.cjs',
  'vue.config.js', 'next.config.js',
];

const LOOPBACK_URL = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d{2,5})?\/?$/;

/**
 * Node built-in modules an entry file imports, by the bare name after `node:`.
 *
 * Only the prefixed form is read, and that is the point: `node:sqlite` is unambiguous
 * where `sqlite` could be any package on npm. Bounded to the same entry files the port
 * scan reads, plus whatever `main` names — this answers "which runtime does this need",
 * which is decided by the file that runs first.
 */
export async function findNodeBuiltins(
  base: string,
  entryFiles: readonly string[],
  main: string | undefined,
): Promise<string[]> {
  const found = new Set<string>();
  const candidates = [...new Set([...entryFiles, ...(main ? [main] : []), ...NODE_ENTRY_FILES])];

  for (const file of candidates.slice(0, MAX_BUILTIN_SCAN)) {
    const raw = await readCapped(join(base, file));
    if (raw === null) continue;
    for (const m of raw.matchAll(/(?:from\s*|require\s*\(\s*)['"`]node:([a-z_]+)['"`]/g)) {
      found.add(m[1]!);
    }
    for (const m of raw.matchAll(/import\s+['"`]node:([a-z_]+)['"`]/g)) found.add(m[1]!);
  }
  return [...found];
}

/** Entry files read looking for a built-in import. Bounded, like every other scan here. */
const MAX_BUILTIN_SCAN = 8;
