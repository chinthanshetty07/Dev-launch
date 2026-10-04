import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { caseMismatchWarning, findCaseMismatches } from './CaseImports.js';
import { foreignRuntimes } from './ForeignRuntimes.js';
import { dirname, join, relative } from 'node:path';
import type {
  BackingService,
  EnvExampleVar,
  HttpRoute,
  PackageJsonSummary,
  PythonEntry,
  PythonSummary,
  RepositoryMetadata,
  ServiceCandidate,
  WorkspacePackage,
  WorkspaceSummary,
} from '@devlaunch/shared';
import { config } from '../../config/index.js';
import { readCapped } from './readCapped.js';
import { readNodeInstallFacts } from './InstallDetection.js';
import { parseEnvExample } from './parseEnvExample.js';
import {
  backingFromEnvKeys,
  findBindHostVariable,
  discoverServices,
  findDeclaredPort,
  findHardcodedLoopbackBind,
  findNodeBuiltins,
  pyprojectDepsBySection,
} from './ServiceDiscovery.js';
import { readCompose, type ComposeService, type ComposeSummary } from './ComposeFile.js';
import {
  driversForConnectionUrls,
  hardcodedDatabaseUrl,
  impliedRequirements,
  importedDistributions,
  localImports,
} from './pythonImports.js';


const FRAMEWORK_CONFIG_PATTERNS = [
  /^vite\.config\.[cm]?[jt]s$/,
  /^next\.config\.[cm]?[jt]s$/,
  /^nuxt\.config\.[cm]?[jt]s$/,
  /^svelte\.config\.[cm]?[jt]s$/,
  /^astro\.config\.[cm]?[jt]s$/,
  /^webpack\.config\.[cm]?[jt]s$/,
  /^remix\.config\.[cm]?[jt]s$/,
  /^angular\.json$/,
];

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}


/**
 * Minimal `packages:` reader for pnpm-workspace.yaml.
 *
 * A full YAML parser is a dependency this needs for one list of strings. Only the
 * common block-sequence form is understood; anything else yields no packages, which
 * degrades to "not a monorepo" rather than to a wrong answer.
 */
export function parsePnpmWorkspace(content: string): string[] {
  const lines = content.split('\n');
  const start = lines.findIndex((l) => /^packages\s*:/.test(l.trim()));
  if (start === -1) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const m = /^-\s*['"]?([^'"#]+?)['"]?\s*$/.exec(trimmed);
    if (!m) break; // Left the sequence.
    out.push(m[1]!.trim());
  }
  return out;
}

const ENTRY_FILES = ['app.py', 'main.py', 'wsgi.py', 'asgi.py', 'server.py', 'manage.py'];

/** How many of a repository's own files the import walk will read. Bounded, not exhaustive. */
const MAX_IMPORT_FILES = 12;

/** How many top-level .py files are read looking for the one that starts the application. */
const MAX_ENTRY_SCAN = 12;

/** Never the program: packaging, configuration, and the schema scripts read separately. */
const SKIP_AS_ENTRY = ['setup.py', 'conftest.py', '__init__.py'];

/** Directories that hold something other than the application. */
const SKIP_AS_ENTRY_DIR = /^(?:tests?|docs?|examples?|scripts?|migrations?|static|templates|venv|env|node_modules|__pycache__|build|dist)$/i;

/**
 * Scripts that create a database schema, by name.
 *
 * Deliberately short and literal. `setup.py` is packaging and must never be run this
 * way; `seed.py` and `migrate.py` write or alter data rather than creating the
 * structure an application needs before it can answer at all.
 */
const DB_INIT_SCRIPTS = [
  'db_create.py', 'create_db.py', 'createdb.py', 'init_db.py', 'initdb.py',
  'create_tables.py', 'create_table.py', 'setup_db.py', 'make_db.py',
];

/**
 * A Flask factory Flask itself would call: named `create_app` or `make_app`, defined at
 * module level, and taking no argument without a default. `def create_app(test_config=None)`
 * qualifies — the tutorial's own signature; `def create_app(config)` does not, because
 * nothing here knows what to pass it.
 */
function flaskFactory(source: string): string | undefined {
  const m = /^def\s+(create_app|make_app)\s*\(([^)]*)\)/m.exec(source);
  if (!m) return undefined;
  const params = m[2]!.split(',').map((p) => p.trim()).filter(Boolean);
  const callable = params.every((p) => p.includes('=') || p.startsWith('*'));
  return callable ? m[1] : undefined;
}

/**
 * The certificate and key a repository's README serves TLS with, for uvicorn.
 *
 * Read from the README because that is where a repository says how it is run, and only
 * believed when both files are really there: the README is untrusted text, and a path
 * that is absolute, climbs out with `..`, or holds anything but plain path characters is
 * not a path DevLaunch will hand to a start command. `nkwus/fastapi-starter` refuses plain
 * HTTP with a 403 on every route, and documents
 * `uvicorn main:app ... --ssl-certfile certs/localhost.pem --ssl-keyfile certs/localhost-key.pem`.
 */
async function readReadmeTls(base: string, fileNames: string[]): Promise<Pick<RepositoryMetadata, 'tls'>> {
  const name = fileNames.find((n) => /^readme(\.md|\.rst|\.txt)?$/i.test(n));
  if (!name) return {};
  const raw = await readCapped(join(base, name));
  if (raw === null) return {};
  const safe = (p: string) => /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/.test(p) && !p.split('/').includes('..');
  for (const line of raw.split('\n')) {
    if (!/\buvicorn\b/.test(line)) continue;
    const cert = /--ssl-certfile[= ]+["']?([^\s"']+)/.exec(line)?.[1];
    const key = /--ssl-keyfile[= ]+["']?([^\s"']+)/.exec(line)?.[1];
    if (!cert || !key || !safe(cert) || !safe(key)) continue;
    if (!(await exists(join(base, cert))) || !(await exists(join(base, key)))) continue;
    return { tls: { certFile: cert, keyFile: key, evidence: line.trim().slice(0, 200) } };
  }
  return {};
}

function detectPythonFramework(source: string): Pick<PythonEntry, 'framework' | 'appVariable' | 'appFactory'> {
  if (/^\s*from\s+flask\s+import|^\s*import\s+flask/m.test(source)) {
    // Module level only. `app = Flask(__name__)` indented inside `create_app` is a local,
    // and reporting it as the app object named something Flask cannot import.
    const app = /^(\w+)\s*=\s*Flask\s*\(/m.exec(source);
    const factory = flaskFactory(source);
    return { framework: 'flask', appVariable: app?.[1], ...(factory ? { appFactory: factory } : {}) };
  }
  if (/^\s*from\s+fastapi\s+import|^\s*import\s+fastapi/m.test(source)) {
    const app = /^\s*(\w+)\s*=\s*FastAPI\s*\(/m.exec(source);
    return { framework: 'fastapi', appVariable: app?.[1] };
  }
  // Neither has an app object to name: the file itself is the program, which is exactly
  // why finding *which* file matters. A repository whose dashboard is `dashboard.py` was
  // started as `streamlit run app.py` — a file that does not exist — because nothing
  // here recognised Streamlit at all and the planner fell back to a default name.
  if (/^\s*import\s+streamlit|^\s*from\s+streamlit\s+import/m.test(source)) {
    return { framework: 'streamlit' };
  }
  if (/^\s*import\s+gradio|^\s*from\s+gradio\s+import/m.test(source)) {
    return { framework: 'gradio' };
  }
  if (/\bdjango\b/.test(source)) return { framework: 'django' };
  return { framework: null };
}

/**
 * Inspect a repository's own metadata to describe how it is put together.
 *
 * Reads manifests and configuration only — never the whole tree — and never decides
 * anything. Turning this description into a Run Plan is Phase 6's job; keeping the two
 * apart is what lets the rule-based planner be tested without a filesystem.
 */
export class RepositoryAnalyzer {
  async analyze(root: string, subdir = '.'): Promise<RepositoryMetadata> {
    const base = subdir === '.' ? root : join(root, subdir);
    const warnings: string[] = [];

    const entries = await readdir(base, { withFileTypes: true }).catch(() => []);
    const fileNames = entries.filter((e) => e.isFile()).map((e) => e.name);

    const packageJson = await this.readPackageJson(join(base, 'package.json'), warnings);
    if (packageJson) packageJson.entryFiles = await this.findEntryFiles(base, fileNames, packageJson.main);
    const python = await this.readPython(
      base,
      fileNames,
      entries.filter((e) => e.isDirectory()).map((e) => e.name),
    );
    const envRaw = await readCapped(join(base, '.env.example'));
    const readme = await this.readReadme(base, fileNames);

    const measured = await measureShallow(root);
    const nodeFacts = await readNodeInstallFacts(base, fileNames);

    // Only for the repository itself: a subdirectory analysed on its own belongs to a
    // repository whose warnings are already being reported.
    const declaredSubmodules = subdir === '.' ? await readSubmodulePaths(root) : [];
    // Git's own record, which a `.gitmodules` file may not match: a link with no entry there
    // has no URL anybody could fetch it from.
    const gitlinks = subdir === '.' ? await readGitlinks(root) : [];
    const submodulesWithoutSource = gitlinks.filter((p) => !declaredSubmodules.includes(p));
    const submodules = [...declaredSubmodules, ...submodulesWithoutSource];
    if (submodules.length) warnings.push(submoduleWarning(submodules));
    // Once, for the whole repository: an import that only resolves on a case-insensitive
    // file system breaks here whichever service contains it.
    const caseMismatches = subdir === '.' ? await findCaseMismatches(root) : [];
    if (caseMismatches.length) warnings.push(caseMismatchWarning(caseMismatches));

    return {
      root: base,
      fileCount: measured.fileCount,
      sizeBytes: measured.sizeBytes,
      hasDockerfile: fileNames.includes('Dockerfile'),
      tsconfig: fileNames.includes('tsconfig.json'),
      packageJson,
      lockfiles: [...nodeFacts.lockfiles],
      ...(nodeFacts.yarnBerry ? { yarnBerry: true } : {}),
      ...(nodeFacts.pnpmWorkspace ? { pnpmWorkspace: true } : {}),
      frameworkConfigs: fileNames.filter((n) => FRAMEWORK_CONFIG_PATTERNS.some((p) => p.test(n))),
      ...(fileNames.includes('index.html') ? { staticIndex: true } : {}),
      ...(submodules.length ? { submodules } : {}),
      ...(submodulesWithoutSource.length ? { submodulesWithoutSource } : {}),
      ...(caseMismatches.length ? { caseMismatches } : {}),
      ...(foreignRuntimes(fileNames).length ? { foreignRuntimes: foreignRuntimes(fileNames) } : {}),
      python,
      envExample: envRaw ? parseEnvExample(envRaw) : [],
      readmeExcerpt: readme,
      ...(await readReadmeTls(base, fileNames)),
      ...(await this.readRoutes(base, fileNames, packageJson?.entryFiles ?? [], python?.entryCandidates.map((e) => e.file) ?? [])),
      ...(await this.readBinding(base, packageJson)),
      ...(fileNames.includes('angular.json') ? await readAngularDevServer(join(base, 'angular.json')) : {}),
      workspace: await this.readWorkspace(base, packageJson, fileNames, warnings),
      ...(await this.readServices(base, envRaw ? parseEnvExample(envRaw) : [], python)),
      warnings,
    };
  }

  /**
   * The address and port this application's own code opens.
   *
   * Read for every repository, not only for a service inside a project. The
   * multi-service path already consulted the source for a declared port, because
   * siblings refer to a service *by port* and cannot be told a guess. A lone
   * application has the same problem with nobody to notice: it binds 8017, DevLaunch
   * watches 3000, and a healthy application is reported as never having started.
   */
  private async readBinding(
    base: string,
    pkg: PackageJsonSummary | undefined,
  ): Promise<Pick<RepositoryMetadata, 'declaredPort' | 'hardcodedBind' | 'bindHostEnv' | 'nodeBuiltins'>> {
    if (!pkg) return {};
    const declaredPort = await findDeclaredPort(base, {
      name: pkg.name,
      scripts: pkg.scripts,
      dependencies: pkg.dependencies,
    });
    // The variable first. `host: process.env.SERVER_HOSTNAME ?? '127.0.0.1'` contains a
    // loopback literal, and read as a hardcoded bind it was reported as unfixable — when
    // it is only the default of a variable DevLaunch can set.
    const bindHostEnv = await findBindHostVariable(base);
    const hardcodedBind = bindHostEnv ? undefined : await findHardcodedLoopbackBind(base);
    const nodeBuiltins = await findNodeBuiltins(base, pkg.entryFiles ?? [], pkg.main);
    return {
      ...(declaredPort ? { declaredPort } : {}),
      ...(hardcodedBind ? { hardcodedBind } : {}),
      ...(bindHostEnv ? { bindHostEnv } : {}),
      ...(nodeBuiltins.length ? { nodeBuiltins } : {}),
    };
  }

  /**
   * The runnable parts of the repository, and the infrastructure they expect.
   *
   * Returns nothing for an ordinary single-service repository, which keeps the existing
   * path untouched for the case it already handles correctly.
   */
  private async readServices(
    base: string,
    envExample: EnvExampleVar[],
    python?: PythonSummary,
  ): Promise<Pick<RepositoryMetadata, 'services' | 'soleService' | 'backing'>> {
    // The compose file first, because it is a declaration rather than an inference: it
    // names the directories, the ports and the database image outright. Convention-based
    // discovery then fills in *how* to run what it found — which language, which scripts,
    // which variables — since compose says nothing about that.
    const compose = await readCompose(base);
    const { services, candidates, backing } = await discoverServices(
      base,
      (compose?.services ?? []).map((c) => c.dir).filter((d): d is string => Boolean(d)),
    );

    const declared = composeOverlay(services, compose);
    // The overlay runs over the candidates too, so a lone service in a subdirectory
    // carries the port and name its compose file gives it rather than only a path.
    const sole =
      services.length === 0 && candidates.length === 1 && candidates[0]!.dir !== '.'
        ? composeOverlay(candidates, compose)[0]
        : undefined;

    // A repository can name a dependency it never imports — `DATABASE_URL` in
    // .env.example with no driver in the manifest still means a database is expected.
    const fromEnv = backingFromEnvKeys(envExample.map((v) => v.key));
    const merged = [...backing];

    // A connection string written into the source is the plainest declaration of all:
    // `create_engine("postgresql://...")` says this project needs Postgres, whatever its
    // manifest happens to list. It was the one declaration nothing read, so a repository
    // whose only mention of a database is that line got none provisioned and failed with
    // `Connection refused` against a server that was never started.
    const hardcoded = hardcodedBacking(python?.hardcodedDatabaseUrl?.url);
    if (hardcoded && !merged.some((b) => b.kind === hardcoded.kind)) {
      merged.push({ ...hardcoded, neededBy: [] });
    }
    for (const found of fromEnv) {
      const existing = merged.find((b) => b.kind === found.kind);
      // A variable the repository actually names beats the one the rule guessed.
      if (existing) existing.urlEnvKey = found.urlEnvKey ?? existing.urlEnvKey;
      else merged.push({ ...found, neededBy: [] });
    }

    // Anything the compose file states outranks all of it. A project using pgvector
    // needs `pgvector/pgvector`: plain `postgres` starts happily and then fails the
    // application's first `CREATE EXTENSION vector`, which no dependency list reveals.
    for (const found of compose?.backing ?? []) {
      const existing = merged.find((b) => b.kind === found.kind);
      if (existing) Object.assign(existing, { ...found, urlEnvKeys: existing.urlEnvKeys, neededBy: existing.neededBy });
      else merged.push({ ...found, neededBy: [] });
    }

    return {
      ...(declared.length ? { services: declared } : {}),
      ...(sole ? { soleService: sole } : {}),
      ...(merged.length ? { backing: merged } : {}),
    };
  }

  private async readPackageJson(
    path: string,
    warnings: string[],
  ): Promise<PackageJsonSummary | undefined> {
    const raw = await readCapped(path);
    if (raw === null) return undefined;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const workspaces = Array.isArray(parsed.workspaces)
        ? (parsed.workspaces as string[])
        : Array.isArray((parsed.workspaces as { packages?: string[] })?.packages)
          ? (parsed.workspaces as { packages: string[] }).packages
          : undefined;

      return {
        name: typeof parsed.name === 'string' ? parsed.name : undefined,
        scripts: asStringRecord(parsed.scripts),
        dependencies: asStringRecord(parsed.dependencies),
        devDependencies: asStringRecord(parsed.devDependencies),
        engineNode: (parsed.engines as { node?: string } | undefined)?.node,
        workspaces,
        main: typeof parsed.main === 'string' ? parsed.main : undefined,
        packageManager:
          typeof parsed.packageManager === 'string' ? parsed.packageManager : undefined,
      };
    } catch (err) {
      // A malformed manifest is a fact about the repository, not a crash. The planner
      // will route it to the AI fallback rather than guessing.
      warnings.push(`package.json could not be parsed: ${(err as Error).message}`);
      return undefined;
    }
  }

  /**
   * Entry files that exist, `main` first if it does.
   *
   * Only files Node can run directly: a `.ts` main needs a runner the plan would have
   * to guess at, and guessing is what this exists to avoid.
   */
  private async findEntryFiles(base: string, fileNames: string[], main?: string): Promise<string[]> {
    const conventional = [
      'app.js', 'server.js', 'index.js', 'main.js', 'app.mjs', 'server.mjs', 'index.mjs',
      'src/app.js', 'src/server.js', 'src/index.js', 'bin/www',
    ];
    const declared = main?.replace(/^\.\//, '');
    const candidates = [...(declared && /\.(?:c|m)?js$/.test(declared) ? [declared] : []), ...conventional];
    const out: string[] = [];
    for (const rel of candidates) {
      if (out.includes(rel)) continue;
      const exists = rel.includes('/')
        ? await stat(join(base, rel)).then((st) => st.isFile()).catch(() => false)
        : fileNames.includes(rel);
      if (exists) out.push(rel);
    }
    return out;
  }

  /**
   * The routes the application declares, from its entry files and the router files they
   * mount, plus any `.http` request file the author left beside them.
   *
   * Bounded: a fixed set of directories, a few dozen files, each read capped. This reads
   * what is written — `app.get('/states/')` is not an inference — and a mounted router's
   * paths are prefixed by the mount it is registered under, since `/users/:id` in
   * `routes/users.js` is `/api/users/:id` to a client and the former is a wrong answer.
   */
  private async readRoutes(
    base: string,
    fileNames: string[],
    nodeEntries: string[],
    pythonEntries: string[],
  ): Promise<Pick<RepositoryMetadata, 'httpRoutes'>> {
    const routes: HttpRoute[] = [];
    const add = (method: string, path: string, source: string): void => {
      const m = method.toUpperCase();
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'ALL'].includes(m)) return;
      const clean = ('/' + path).replace(/\/{2,}/g, '/').replace(/\?.*$/, '');
      if (routes.some((r) => r.method === m && r.path === clean)) return;
      if (routes.length < 40) routes.push({ method: m as HttpRoute['method'], path: clean, source });
    };

    // --- Node: entry files, then the routers they mount, then conventional route dirs ---
    const mounts = new Map<string, string>(); // resolved file → mount prefix
    for (const entry of nodeEntries.slice(0, 3)) {
      const src = await readCapped(join(base, entry));
      if (src === null) continue;
      for (const m of src.matchAll(/\b(?:app|server|api)\.(get|post|put|patch|delete|all)\(\s*(['"`])([^'"`]+)\2/g)) add(m[1]!, m[3]!, entry);
      const requires = new Map<string, string>();
      for (const m of src.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*require\(\s*['"`]([^'"`]+)['"`]\s*\)/g)) requires.set(m[1]!, m[2]!);
      for (const m of src.matchAll(/import\s+(\w+)\s+from\s+['"`]([^'"`]+)['"`]/g)) requires.set(m[1]!, m[2]!);
      for (const m of src.matchAll(/\.use\(\s*['"`](\/[^'"`]*)['"`]\s*,\s*(?:require\(\s*['"`]([^'"`]+)['"`]\s*\)|(\w+))/g)) {
        const mod = m[2] ?? (m[3] ? requires.get(m[3]) : undefined);
        if (!mod || !mod.startsWith('.')) continue;
        const rel = join(dirname(entry), mod).replace(/^\.\//, '');
        for (const candidate of [rel, `${rel}.js`, `${rel}/index.js`, `${rel}.mjs`, `${rel}.ts`]) mounts.set(candidate, m[1]!);
      }
    }
    const routerFiles = new Set<string>(mounts.keys());
    for (const dir of ['routes', 'src/routes', 'controllers', 'src/controllers']) {
      const entries = await readdir(join(base, dir), { withFileTypes: true }).catch(() => []);
      for (const e of entries) if (e.isFile() && /\.(?:c|m)?[jt]s$/.test(e.name)) routerFiles.add(`${dir}/${e.name}`);
    }
    for (const file of [...routerFiles].slice(0, 20)) {
      const src = await readCapped(join(base, file));
      if (src === null) continue;
      const prefix = mounts.get(file) ?? '';
      for (const m of src.matchAll(/\b(?:router|app|server|api)\.(get|post|put|patch|delete|all)\(\s*(['"`])([^'"`]+)\2/g)) add(m[1]!, prefix + m[3]!, file);
    }

    // --- Python: Flask routes and blueprints, FastAPI routers and their prefixes ---
    const pyMounts = new Map<string, string>(); // module basename → prefix
    const pyFiles = new Set<string>(pythonEntries.slice(0, 3));
    for (const entry of pythonEntries.slice(0, 3)) {
      const src = await readCapped(join(base, entry));
      if (src === null) continue;
      for (const m of src.matchAll(/include_router\(\s*(\w+)(?:\.router)?[^)]*?prefix\s*=\s*['"]([^'"]+)['"]/g)) pyMounts.set(m[1]!, m[2]!);
      for (const m of src.matchAll(/register_blueprint\(\s*(\w+)[^)]*?url_prefix\s*=\s*['"]([^'"]+)['"]/g)) pyMounts.set(m[1]!, m[2]!);
    }
    // Beside the entry point, and one level inside a package. `app/routes/` is the
    // ordinary FastAPI layout and a scan of the working directory walks straight past it.
    const pkgDirs = (await readdir(base, { withFileTypes: true }).catch(() => []))
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !['tests', 'docs', 'node_modules'].includes(e.name))
      .map((e) => e.name)
      .slice(0, 6);
    const routeDirs = ['routers', 'routes', 'api', 'blueprints', 'endpoints', 'views'];
    for (const dir of [
      ...routeDirs,
      ...pythonEntries.flatMap((e) => routeDirs.map((r) => join(dirname(e), r))),
      ...pkgDirs.flatMap((pkg) => routeDirs.map((r) => `${pkg}/${r}`)),
    ]) {
      const entries = await readdir(join(base, dir), { withFileTypes: true }).catch(() => []);
      for (const e of entries) if (e.isFile() && e.name.endsWith('.py') && e.name !== '__init__.py') pyFiles.add(`${dir}/${e.name}`);
    }
    for (const file of [...pyFiles].slice(0, 20)) {
      const src = await readCapped(join(base, file));
      if (src === null) continue;
      const own =
        /APIRouter\([^)]*?prefix\s*=\s*['"]([^'"]+)['"]/.exec(src)?.[1] ??
        /Blueprint\([^)]*?url_prefix\s*=\s*['"]([^'"]+)['"]/.exec(src)?.[1] ?? '';
      const stem = file.split('/').pop()!.replace(/\.py$/, '');
      const prefix = (pyMounts.get(stem) ?? '') + own;
      for (const m of src.matchAll(/@\w+\.route\(\s*['"]([^'"]+)['"](?:[^)]*?methods\s*=\s*\[([^\]]*)\])?/g)) {
        const methods = m[2] ? [...m[2].matchAll(/['"](\w+)['"]/g)].map((x) => x[1]!) : ['GET'];
        for (const method of methods) add(method, prefix + m[1]!, file);
      }
      for (const m of src.matchAll(/@\w+\.(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]/g)) add(m[1]!, prefix + m[2]!, file);
      // Routers built by hand rather than by decorator: `add_api_route` in FastAPI and
      // `add_url_rule` in Flask. A class-based router registers every route this way and
      // declares not a single decorator, so a decorator-only reader reports nothing.
      for (const m of src.matchAll(/\.add_(?:api_route|url_rule)\(\s*['"]([^'"]+)['"][^)]*?methods\s*=\s*[[(]([^\])]*)[\])]/gs)) {
        for (const x of m[2]!.matchAll(/['"](\w+)['"]/g)) add(x[1]!, prefix + m[1]!, file);
      }
      for (const m of src.matchAll(/\.add_(?:api_route|url_rule)\(\s*['"]([^'"]+)['"]((?!methods)[^)])*\)/gs)) {
        add('GET', prefix + m[1]!, file);
      }
    }

    // --- A request file the author tests with, which lists exactly what to call ---
    for (const name of fileNames.filter((n) => /\.(?:http|rest)$/.test(n)).slice(0, 3)) {
      const src = await readCapped(join(base, name));
      if (src === null) continue;
      for (const m of src.matchAll(/^(GET|POST|PUT|PATCH|DELETE)\s+(?:https?:\/\/[^/\s]+)?(\/\S*)/gm)) add(m[1]!, m[2]!, name);
    }

    // GET first: those are the ones a person can open.
    routes.sort((a, b) => Number(b.method === 'GET') - Number(a.method === 'GET'));
    return routes.length ? { httpRoutes: routes } : {};
  }

  private async readPython(
    base: string,
    fileNames: string[],
    dirNames: string[] = [],
  ): Promise<PythonSummary | undefined> {
    const hasRequirements = fileNames.includes('requirements.txt');
    const hasPyproject = fileNames.includes('pyproject.toml');
    const hasPipfile = fileNames.includes('Pipfile');
    const hasManagePy = fileNames.includes('manage.py');
    const pyFiles = fileNames.filter((n) => n.endsWith('.py'));

    if (!hasRequirements && !hasPyproject && !hasPipfile && !hasManagePy && pyFiles.length === 0) {
      return undefined;
    }

    const requirementsRaw = hasRequirements
      ? await readCapped(join(base, 'requirements.txt'))
      : null;
    const requirements = (requirementsRaw ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('#'));

    // Scripts whose *name* says they create the schema. Nothing is inferred from their
    // contents: a name is a claim the author made, and running a file because it looked
    // like it might set something up is the kind of guess this codebase avoids.
    const initScripts = pyFiles.filter((n) => DB_INIT_SCRIPTS.includes(n));

    // The conventional names first, then whatever else is at the working directory.
    //
    // The list alone was not enough: a Streamlit repository's program is `dashboard.py`,
    // and no amount of lengthening a list of names catches the next one. Every top-level
    // .py file is cheap to read and the framework import in it is a declaration. Order is
    // preserved, so `app.py` still outranks anything found this way.
    const conventional = pyFiles.filter((n) => ENTRY_FILES.includes(n));
    const rest = pyFiles.filter((n) => !ENTRY_FILES.includes(n) && !SKIP_AS_ENTRY.includes(n));
    const candidates = [...conventional, ...rest].slice(0, MAX_ENTRY_SCAN);

    const entryCandidates: PythonEntry[] = [];
    // Modules the repository itself provides, so its own files are never mistaken for
    // distributions to install.
    // Both files and directories: `routers/` is a package this repository provides, and
    // reading it as a distribution put `pip install routers` — which does not exist — in
    // the middle of an otherwise correct install command.
    // Grows as the walk descends. A module is "local" relative to the file importing it,
    // and the root's listing cannot know that: `app/app.py` does `from routes.task_route
    // import ...`, where `routes` is a directory inside `app/` — invisible from the root,
    // and duly proposed to pip as a distribution to install.
    const local = new Set([...pyFiles.map((n) => n.replace(/\.py$/, '')), ...dirNames]);
    const imported: string[] = [];
    const extras: { requirement: string; because: string }[] = [];
    let hardcodedDb: { file: string; url: string } | undefined;

    // Walked, not merely scanned: a FastAPI tutorial's main.py imports `fastapi` and
    // `models`, and `models.py` is where `sqlalchemy` appears. Reading the entry file
    // alone installed two of the three distributions the application needs and the run
    // died on `No module named 'sqlalchemy'`. Bounded hard — this follows a repository's
    // own imports, it does not search its tree.
    const visited = new Set<string>();
      const walkImports = async (from: string): Promise<void> => {
      const queue = [from];
      while (queue.length > 0 && visited.size < MAX_IMPORT_FILES) {
        const file = queue.shift()!;
        if (visited.has(file)) continue;
        visited.add(file);
        const source = await readCapped(join(base, file));
        if (source === null) continue;

        if (candidates.includes(file)) {
          entryCandidates.push({
            file,
            conventional: ENTRY_FILES.includes(file),
            ...detectPythonFramework(source),
          });
        }
        // What sits beside this file is local to it, whatever the root looks like.
        for (const sibling of await this.siblingModules(base, file)) local.add(sibling);

        for (const dist of importedDistributions(source, [...local])) {
          if (!imported.includes(dist)) imported.push(dist);
        }
        // What a *part* of a distribution needs, which the line above cannot see: it
        // reduces every import to its top-level name, because that is what pip installs.
        for (const implied of impliedRequirements(source, [...local])) {
          if (!extras.some((e) => e.requirement === implied.requirement)) extras.push(implied);
        }
        // A connection URL names its driver in the scheme, and SQLAlchemy loads it by name
        // at connect time — so nothing imports it and the import scan cannot see it.
        for (const dist of driversForConnectionUrls(source)) {
          if (!imported.includes(dist)) imported.push(dist);
        }
        if (!hardcodedDb) {
          const url = hardcodedDatabaseUrl(source);
          if (url) hardcodedDb = { file, url };
        }
        for (const module of localImports(source, [...local])) {
          for (const next of await this.filesOfLocalModule(base, module)) {
            if (!visited.has(next)) queue.push(next);
          }
        }
      }
      };
    for (const candidate of candidates) await walkImports(candidate);

    // A packaged project keeps its entry point inside the package — `src/pg_rag/main.py`
    // — where a scan of the working directory never looks. Read it under the module path
    // it is importable by once installed, which is the only path that runs it.
    const pyproject = hasPyproject ? await readCapped(join(base, 'pyproject.toml')) : null;
    if (entryCandidates.every((e) => !e.framework)) {
      entryCandidates.push(...(await this.readPackageEntries(base)));
    }
    // Still nothing that imports a framework: look one level down in ordinary
    // directories. A small Flask project keeps its application in `app/app.py` with no
    // `__init__.py` at all, so the package scan above cannot see it and the root scan
    // never looks — and the planner then settled on whatever else was lying around.
    if (entryCandidates.every((e) => !e.framework)) {
      const found = await this.readSubdirectoryEntries(base);
      entryCandidates.push(...found);
      // Walk its imports too. The queue was seeded from the repository root, so a
      // repository whose only Python lives in `app/` collected nothing at all — and the
      // one dependency its application needs and requirements.txt forgot was invisible.
      for (const entry of found) {
        const path = entry.dir ? `${entry.dir}/${entry.file}` : entry.file;
        await walkImports(path);
      }
    }

    return {
      requirements,
      ...(imported.length ? { imports: imported } : {}),
      ...(extras.length ? { impliedRequirements: extras } : {}),
      ...(hardcodedDb ? { hardcodedDatabaseUrl: hardcodedDb } : {}),
      ...(pyproject
        ? {
            dependencies: pyprojectDepsBySection(pyproject).all,
            runtimeDependencies: pyprojectDepsBySection(pyproject).runtime,
          }
        : {}),
      hasPyproject,
      ...(hasPyproject ? { packageable: await this.isPackageable(base, pyproject ?? '') } : {}),
      hasPipfile,
      ...(fileNames.includes('Pipfile.lock') ? { hasPipfileLock: true } : {}),
      ...(fileNames.includes('poetry.lock') ? { hasPoetryLock: true } : {}),
      ...(pyproject && /^\[tool\.poetry\]/m.test(pyproject) ? { hasPoetry: true } : {}),
      hasManagePy,
      ...(initScripts.length ? { initScripts } : {}),
      entryCandidates,
    };
  }

  /**
   * The files behind a local module name: one file, or the modules inside a package.
   *
   * A package's `__init__.py` is often empty and the imports that matter live in the
   * modules beside it — `routers/todos.py` is where a FastAPI project's database
   * dependencies appear. Bounded to one level, because this follows imports rather than
   * searching a tree.
   */
  private async filesOfLocalModule(base: string, module: string): Promise<string[]> {
    const single = `${module}.py`;
    if (await exists(join(base, single))) return [single];

    const entries = await readdir(join(base, module), { withFileTypes: true }).catch(() => []);
    return entries
      .filter((e) => e.isFile() && e.name.endsWith('.py'))
      .slice(0, MAX_IMPORT_FILES)
      .map((e) => `${module}/${e.name}`);
  }

  /**
   * Whether `pip install .` can build this project, modelled on setuptools' own rule.
   *
   * Explicit package configuration settles it, and so does a `src/` layout. Otherwise
   * setuptools auto-discovers, and auto-discovery *fails* — it does not guess — when
   * more than one top-level directory could be a package. Its exclusion list is short
   * and documented, so this can be predicted rather than discovered by failing.
   */
  private async isPackageable(base: string, pyproject: string): Promise<boolean> {
    // Any build backend told where the code is.
    if (/^\s*(packages|py-modules|package-dir)\s*=/m.test(pyproject)) return true;
    if (/\[tool\.setuptools\.packages\.find\]/.test(pyproject)) return true;

    const entries = await readdir(base, { withFileTypes: true }).catch(() => []);
    if (entries.some((e) => e.isDirectory() && e.name === 'src')) return true;

    // Setuptools ignores these when discovering a flat layout; everything else counts.
    const IGNORED_BY_SETUPTOOLS = /^(tests?|docs?|examples?|scripts?|tools?|build|dist|venv|env|node_modules|.*\.egg-info)$/i;
    const candidates = entries.filter(
      (e) => e.isDirectory() && !e.name.startsWith('.') && !IGNORED_BY_SETUPTOOLS.test(e.name),
    );
    return candidates.length <= 1;
  }

  /**
   * Module names that sit beside a file: its directory's own `.py` files and folders.
   *
   * Locality is relative to the importer. `app/app.py` imports `routes.task_route`, and
   * `routes` is a directory inside `app/` — nowhere in the repository root's listing, so
   * a root-only notion of "local" reported it as a distribution to fetch.
   */
  private async siblingModules(base: string, file: string): Promise<string[]> {
    const dir = dirname(file);
    if (dir === '.' || dir === '') return [];
    const entries = await readdir(join(base, dir), { withFileTypes: true }).catch(() => []);
    return entries
      .filter((e) => e.isDirectory() || e.name.endsWith('.py'))
      .map((e) => e.name.replace(/\.py$/, ''));
  }

  /**
   * A framework entry point one level down, in a directory that is not a package.
   *
   * Distinct from `readPackageEntries`, which requires `__init__.py` and reports an
   * importable module path. This is the other shape, and it is at least as common in
   * small projects: `app/app.py` with no `__init__.py`, importing its siblings as
   * `from routes.task_route import ...`. That only resolves with `app/` on the path, so
   * the directory travels with the entry and the plan runs from it.
   *
   * Bounded: immediate subdirectories only, the same conventional filenames, and the
   * first one that actually imports a framework. It is not a search of the tree.
   */
  private async readSubdirectoryEntries(base: string): Promise<PythonEntry[]> {
    const entries = await readdir(base, { withFileTypes: true }).catch(() => []);
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP_AS_ENTRY_DIR.test(e.name))
      .slice(0, MAX_ENTRY_SCAN);

    for (const dir of dirs) {
      for (const file of ENTRY_FILES) {
        const source = await readCapped(join(base, dir.name, file));
        if (source === null) continue;
        const detected = detectPythonFramework(source);
        if (!detected.framework) continue;
        return [{ file, dir: dir.name, conventional: true, ...detected }];
      }
    }
    return [];
  }

  /**
   * Entry points inside a package, under `src/<pkg>/` or `<pkg>/`.
   *
   * Bounded on purpose: one level of package, the same handful of filenames as the root
   * scan, and only the first package found. This is the layout the packaging tools
   * produce, not a search of the tree.
   */
  private async readPackageEntries(base: string): Promise<PythonEntry[]> {
    const out: PythonEntry[] = [];
    for (const parent of ['src', '.']) {
      const dir = parent === '.' ? base : join(base, parent);
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const pkg of entries) {
        if (!pkg.isDirectory() || pkg.name.startsWith('.') || pkg.name === 'src') continue;
        if (!(await stat(join(dir, pkg.name, '__init__.py')).catch(() => null))) continue;
        for (const file of ENTRY_FILES) {
          const source = await readCapped(join(dir, pkg.name, file));
          if (source === null) continue;
          const detected = detectPythonFramework(source);
          if (!detected.framework) continue;
          const rel = parent === '.' ? `${pkg.name}/${file}` : `${parent}/${pkg.name}/${file}`;
          out.push({
            file: rel,
            module: `${pkg.name}.${file.replace(/\.py$/, '')}`,
            conventional: true,
            ...detected,
          });
        }
        // The package itself, when it is the application. The Flask tutorial keeps its
        // factory in `flaskr/__init__.py` and has no `app.py` anywhere, so the names above
        // found nothing and the repository went to a model — which planned it three ways
        // in four runs, one of them with a server it never installed. Counted only when the
        // file *makes* the application: a module-level `app = Flask(...)` or a factory
        // Flask can call. An `__init__.py` that merely imports flask — a Blueprint, an
        // extension — is not an entry point.
        if (out.length === 0) {
          const init = await readCapped(join(dir, pkg.name, '__init__.py'));
          const detected = init === null ? null : detectPythonFramework(init);
          const makesApp = detected?.framework === 'flask'
            && (detected.appFactory !== undefined || detected.appVariable !== undefined);
          if (detected && makesApp) {
            out.push({
              file: parent === '.' ? `${pkg.name}/__init__.py` : `${parent}/${pkg.name}/__init__.py`,
              module: pkg.name,
              conventional: true,
              ...detected,
            });
          }
        }
        if (out.length) return out;
      }
    }
    return out;
  }

  private async readReadme(base: string, fileNames: string[]): Promise<string | undefined> {
    const name = fileNames.find((n) => /^readme(\.md|\.rst|\.txt)?$/i.test(n));
    if (!name) return undefined;
    const raw = await readCapped(join(base, name));
    if (raw === null) return undefined;
    // Excerpt only. The full text would dominate an AI prompt, and it is untrusted
    // input in any case — see docs/planning-strategy.md on prompt injection.
    return raw.slice(0, 4000);
  }

  private async readWorkspace(
    base: string,
    pkg: PackageJsonSummary | undefined,
    fileNames: string[],
    warnings: string[],
  ): Promise<WorkspaceSummary | undefined> {
    let kind: 'npm' | 'pnpm' | undefined;
    let patterns: string[] = [];

    if (fileNames.includes('pnpm-workspace.yaml')) {
      const raw = await readCapped(join(base, 'pnpm-workspace.yaml'));
      if (raw) {
        patterns = parsePnpmWorkspace(raw);
        kind = 'pnpm';
      }
    }
    if (patterns.length === 0 && pkg?.workspaces?.length) {
      patterns = pkg.workspaces;
      kind = 'npm';
    }
    if (!kind || patterns.length === 0) return undefined;

    const dirs = await expandWorkspacePatterns(base, patterns);
    const runnable: WorkspacePackage[] = [];

    for (const dir of dirs) {
      const raw = await readCapped(join(base, dir, 'package.json'));
      if (raw === null) continue;
      try {
        const parsed = JSON.parse(raw) as { name?: string; scripts?: Record<string, string> };
        const scripts = Object.keys(parsed.scripts ?? {});
        // Only packages that can actually be started are candidates to run.
        if (scripts.includes('dev') || scripts.includes('start')) {
          runnable.push({ name: parsed.name ?? dir, dir, scripts });
        }
      } catch {
        warnings.push(`Workspace package at ${dir} has an unreadable package.json.`);
      }
    }

    return { kind, runnable, total: dirs.length };
  }
}

function asStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

/** Expand the `dir/*` forms that cover almost every real workspace declaration. */
export async function expandWorkspacePatterns(base: string, patterns: string[]): Promise<string[]> {
  const out = new Set<string>();
  for (const pattern of patterns) {
    if (pattern.includes('..')) continue; // never escape the repository
    if (!pattern.includes('*')) {
      out.add(pattern.replace(/\/+$/, ''));
      continue;
    }
    const prefix = pattern.slice(0, pattern.indexOf('*')).replace(/\/+$/, '');
    const dir = prefix === '' ? base : join(base, prefix);
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      out.add(relative(base, join(dir, entry.name)));
    }
  }
  return [...out];
}

/** Cheap tree measurement used for reporting, bounded by the intake caps. */
async function measureShallow(root: string): Promise<{ sizeBytes: number; fileCount: number }> {
  let sizeBytes = 0;
  let fileCount = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 8 || fileCount > config.intake.maxFiles) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (entry.isFile()) {
        fileCount++;
        sizeBytes += await stat(full).then((s) => s.size).catch(() => 0);
      }
    }
  };
  await walk(root, 0);
  return { sizeBytes, fileCount };
}

/**
 * Apply what the compose file declares on top of what convention discovered.
 *
 * Discovery answers "what kind of thing lives here"; compose answers "which things exist,
 * where, and on what port". Neither is sufficient alone — compose says nothing about a
 * service's language or scripts, and convention cannot know that `app/backend` listens on
 * 8000 or that `frontend` is the browser's entry point.
 */
function composeOverlay(
  found: ServiceCandidate[],
  compose: ComposeSummary | null,
): ServiceCandidate[] {
  if (!compose || compose.services.length === 0) return found;

  const out = found.map((candidate) => {
    const declared = primaryFor(compose, candidate.dir);
    if (!declared) return candidate;
    return {
      ...candidate,
      // The author's name for the service, which is what their own documentation and
      // their sibling services refer to it by.
      name: declared.name,
      role: declared.role,
      // A compose port below 1024 describes the *production* image — nginx on 80 in
      // front of a built bundle — not the dev server DevLaunch runs, and our non-root
      // runtime could not bind it anyway. Adopting it hands vite `--port 80` and a
      // permission error. The dev server's own default is the right port here.
      ...(declared.containerPort && declared.containerPort >= 1024
        ? { declaredPort: declared.containerPort }
        : {}),
      envKeys: [...new Set([...(candidate.envKeys ?? []), ...declared.declaredKeys])],
      evidence: `docker-compose declares ${declared.name}`,
    };
  });

  // A compose service in a directory discovery could not classify is left out rather
  // than invented: without a language there is nothing to run it with, and a candidate
  // that cannot be planned is worse than one that was never offered.
  return out;
}

/**
 * Which compose service a directory really represents.
 *
 * One directory can back several: a repository here builds both `backend` and `mcp`
 * from `./app/backend`, the same image started two different ways. Only one of them can
 * be the service DevLaunch runs for that directory, so the choice has to be principled
 * rather than "whichever came first in the file".
 *
 * A `command:` override is the giveaway. It means the author is running something other
 * than the image's own default entry point — a side process, a worker, a tool — while
 * the service with no override is the thing the image was built to be.
 */
function primaryFor(compose: ComposeSummary, dir: string): ComposeService | undefined {
  const sharing = compose.services.filter((c) => c.dir === dir);
  if (sharing.length <= 1) return sharing[0];
  return (
    sharing.find((c) => !c.command && c.containerPort !== undefined) ??
    sharing.find((c) => !c.command) ??
    sharing.find((c) => c.containerPort !== undefined) ??
    sharing[0]
  );
}

/**
 * The database a hardcoded connection string names, by its scheme.
 *
 * The URL cannot be used as written — its host is the author's machine — but the scheme
 * says which server to start, and the driver says which dialect to build the replacement
 * with.
 */
function hardcodedBacking(url: string | undefined): Omit<BackingService, 'neededBy'> | undefined {
  if (!url) return undefined;
  const scheme = /^([a-z0-9+]+):\/\//i.exec(url)?.[1]?.toLowerCase();
  if (!scheme) return undefined;

  const kind = scheme.startsWith('postgres')
    ? ('postgres' as const)
    : scheme.startsWith('mysql')
      ? ('mysql' as const)
      : scheme.startsWith('mongodb')
        ? ('mongodb' as const)
        : scheme.startsWith('redis')
          ? ('redis' as const)
          : undefined;
  if (!kind) return undefined;

  // The dialect names the driver after a `+`, and that is what the replacement URL has
  // to be written with: `postgresql+asyncpg://` reaches asyncpg and `postgresql://` does
  // not.
  const driver = scheme.includes('+') ? scheme.split('+')[1] : undefined;
  // No `urlEnvKeys`: this application reads no variable, which is the whole problem.
  // The provisioner falls back to the conventional name for the kind, which costs
  // nothing unread and is right if the repository also happens to read one.
  return {
    kind,
    evidence: `the source hardcodes a ${kind} URL`,
    ...(driver ? { driver } : {}),
  };
}

/**
 * The builder behind `ng serve`, read from the serve target of the first project that has
 * one. `architect` and `targets` are the same thing under two names.
 */
async function readAngularDevServer(file: string): Promise<{ angularDevServer?: string }> {
  const raw = await readCapped(file);
  if (raw === null) return {};
  try {
    const projects = (JSON.parse(raw) as { projects?: Record<string, Record<string, unknown>> }).projects ?? {};
    for (const project of Object.values(projects)) {
      const targets = (project.architect ?? project.targets) as Record<string, { builder?: unknown }> | undefined;
      const builder = targets?.serve?.builder;
      if (typeof builder === 'string') return { angularDevServer: builder };
    }
  } catch {
    /* An unreadable angular.json says nothing about the builder; the default stands. */
  }
  return {};
}

/**
 * Paths git records as links to other repositories (mode 160000), from the index of a
 * checkout. Empty when there is no `.git`, or git cannot read it. `ls-files` reads the
 * index and nothing else: no hook, filter or checkout runs.
 *
 * `.gitmodules` alone missed `RefugioDiaz1/fullstack-docker-react-node-postgres`, whose
 * `client` and `server` are links with no `.gitmodules` at all: DevLaunch saw two empty
 * directories, asked a model, and the model's `npm install` failed in a folder with nothing
 * in it.
 */
export async function readGitlinks(root: string): Promise<string[]> {
  if (!(await exists(join(root, '.git')))) return [];
  try {
    const { stdout } = await promisify(execFile)('git', ['-C', root, 'ls-files', '--stage', '-z'], {
      maxBuffer: 64 * 1024 * 1024,
      timeout: 15_000,
    });
    return stdout
      .split('\0')
      .filter((entry) => entry.startsWith('160000 '))
      .map((entry) => entry.slice(entry.indexOf('\t') + 1))
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** The `path = ...` entries of a root `.gitmodules`, in the order it lists them. */
export async function readSubmodulePaths(root: string): Promise<string[]> {
  const raw = await readCapped(join(root, '.gitmodules'));
  if (raw === null) return [];
  return [...raw.matchAll(/^\s*path\s*=\s*(.+?)\s*$/gm)].map((m) => m[1]!);
}

/**
 * Said before the run, because the failure it prevents does not say it: a bundler that
 * cannot find `realworld/assets/theme/styles.css` names the file, not the submodule.
 */
export function submoduleWarning(paths: readonly string[]): string {
  const shown = paths.slice(0, 5).map((p) => `${p}/`).join(', ') + (paths.length > 5 ? `, and ${paths.length - 5} more` : '');
  return (
    `This repository uses git submodules (${shown}). DevLaunch clones without them, so ` +
    `${paths.length === 1 ? 'that directory is' : 'those directories are'} empty here — ` +
    `anything the application imports, bundles or serves from ${paths.length === 1 ? 'it' : 'them'} will be missing.`
  );
}
