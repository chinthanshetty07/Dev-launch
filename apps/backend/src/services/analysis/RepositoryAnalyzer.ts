import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type {
  EnvExampleVar,
  PackageJsonSummary,
  PythonEntry,
  PythonSummary,
  RepositoryMetadata,
  WorkspacePackage,
  WorkspaceSummary,
} from '@devlaunch/shared';
import { config } from '../../config/index.js';

const LOCKFILES = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb'];

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

/** Read a file, refusing anything large enough to be a payload rather than a manifest. */
async function readCapped(path: string): Promise<string | null> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > config.intake.maxReadBytes) return null;
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

export function parseEnvExample(content: string): EnvExampleVar[] {
  const out: EnvExampleVar[] = [];
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).replace(/^export\s+/, '').trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    // A value present in .env.example means the variable has a usable default, so it
    // is not something the user must be prompted for.
    const value = line.slice(eq + 1).trim();
    out.push({ key, hasDefault: value.length > 0 });
  }
  return out;
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

function detectPythonFramework(source: string): Pick<PythonEntry, 'framework' | 'appVariable'> {
  if (/^\s*from\s+flask\s+import|^\s*import\s+flask/m.test(source)) {
    const app = /^\s*(\w+)\s*=\s*Flask\s*\(/m.exec(source);
    return { framework: 'flask', appVariable: app?.[1] };
  }
  if (/^\s*from\s+fastapi\s+import|^\s*import\s+fastapi/m.test(source)) {
    const app = /^\s*(\w+)\s*=\s*FastAPI\s*\(/m.exec(source);
    return { framework: 'fastapi', appVariable: app?.[1] };
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
    const python = await this.readPython(base, fileNames);
    const envRaw = await readCapped(join(base, '.env.example'));
    const readme = await this.readReadme(base, fileNames);

    const measured = await measureShallow(root);

    return {
      root: base,
      fileCount: measured.fileCount,
      sizeBytes: measured.sizeBytes,
      hasDockerfile: fileNames.includes('Dockerfile'),
      tsconfig: fileNames.includes('tsconfig.json'),
      packageJson,
      lockfiles: LOCKFILES.filter((l) => fileNames.includes(l)),
      frameworkConfigs: fileNames.filter((n) => FRAMEWORK_CONFIG_PATTERNS.some((p) => p.test(n))),
      python,
      envExample: envRaw ? parseEnvExample(envRaw) : [],
      readmeExcerpt: readme,
      workspace: await this.readWorkspace(base, packageJson, fileNames, warnings),
      warnings,
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
      };
    } catch (err) {
      // A malformed manifest is a fact about the repository, not a crash. The planner
      // will route it to the AI fallback rather than guessing.
      warnings.push(`package.json could not be parsed: ${(err as Error).message}`);
      return undefined;
    }
  }

  private async readPython(base: string, fileNames: string[]): Promise<PythonSummary | undefined> {
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

    // Only plausible entry points are read, not every .py file in the repository.
    const candidates = pyFiles
      .filter((n) => ['app.py', 'main.py', 'wsgi.py', 'asgi.py', 'server.py', 'manage.py'].includes(n))
      .slice(0, 6);

    const entryCandidates: PythonEntry[] = [];
    for (const file of candidates) {
      const source = await readCapped(join(base, file));
      if (source === null) continue;
      entryCandidates.push({ file, ...detectPythonFramework(source) });
    }

    return { requirements, hasPyproject, hasPipfile, hasManagePy, entryCandidates };
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
