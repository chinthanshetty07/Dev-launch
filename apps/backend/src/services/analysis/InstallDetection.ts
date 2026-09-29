import { join } from 'node:path';
import type { PythonSummary } from '@devlaunch/shared';
import { config } from '../../config/index.js';
import { readCapped } from './readCapped.js';

/**
 * How a project's dependencies are installed — decided in one place.
 *
 * This decision used to be made twice: the planner mapped a lockfile to a manager for a
 * lone package, and service discovery made the same mapping again for a workspace root,
 * without reading `packageManager` at all. Two copies of a rule disagree the first time
 * one of them is fixed, so both now ask this module.
 */

/** Files that say which tool installed a Node project last, in the order they are trusted. */
export const NODE_LOCKFILES = [
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
] as const;

export type NodeManager = 'npm' | 'yarn' | 'pnpm';

export interface InstallDetection {
  /** The manager that will run the install. Always one DevLaunch ships. */
  packageManager: NodeManager | 'pip';
  /**
   * The manager the repository asked for, when that differs from the one that runs:
   * `bun` (no Bun in the runner images), `poetry` or `pipenv` (installed through pip).
   */
  declaredManager?: 'bun' | 'poetry' | 'pipenv';
  /** The lockfile the command honours, or null when it installs without one. */
  lockfile: string | null;
  /** Lockfiles present that the command does *not* honour — reported, never hidden. */
  ignoredLockfiles?: string[];
  installCommand: string | null;
  /**
   * The same install without the lockfile pinned, for a repair to fall back to when the
   * lockfile turns out to be out of step with the manifest. Null when the command is not
   * a strict one.
   */
  relaxedCommand: string | null;
  projectType: 'node' | 'python';
  /**
   * `high`: a lockfile or an explicit `packageManager` decided it. `medium`: a manifest
   * without a lockfile. `low`: DevLaunch is running something other than what the
   * repository asked for.
   */
  confidence: 'high' | 'medium' | 'low';
  /** Why, when the answer is not the obvious one. Shown as a planning warning. */
  notes: string[];
}

export interface NodeInstallFacts {
  lockfiles: readonly string[];
  /** The manifest's `packageManager`, verbatim, e.g. `yarn@4.6.0`. */
  packageManagerField?: string;
  /** Yarn 2+: a `yarn.lock` in the Berry format, or a `.yarnrc.yml`. */
  yarnBerry?: boolean;
  /** A `pnpm-workspace.yaml`: only pnpm reads it, so it names the manager with no lockfile. */
  pnpmWorkspace?: boolean;
}

/**
 * Whether this project's dependencies will only resolve through its package manager.
 *
 * Yarn 2 and later default to Plug'n'Play: there is no `node_modules`, resolution comes
 * from a generated `.pnp.cjs`, and `node server.js` cannot find a single dependency —
 * while `yarn node server.js` finds all of them. Measured in the runner image rather
 * than assumed: a Yarn 4.6.0 install produced `.pnp.cjs` and no `node_modules`, and bare
 * node failed on `require('lodash')` where `yarn node` returned 4.17.21.
 */
export function needsManagerToResolve(declared?: string): boolean {
  const major = /^yarn@(\d+)/.exec(declared ?? '')?.[1];
  return major !== undefined && Number(major) >= 2;
}

/**
 * The Node install for a directory's facts.
 *
 * `packageManager` first, because it is the author saying so and a lockfile is only
 * evidence of what ran last. With a lockfile the install is strict — `npm ci`,
 * `--frozen-lockfile`, `--immutable` — so the versions that run are the ones the
 * repository recorded. A lockfile out of step with its manifest makes a strict install
 * fail, which is common in repositories nobody has run in a while; `relaxedCommand` is
 * what the lockfile repair rule falls back to, and it falls back only on that error.
 */
export type NodeInstallDetection = InstallDetection & { packageManager: NodeManager; installCommand: string };

export function detectNodeInstall(facts: NodeInstallFacts): NodeInstallDetection {
  const notes: string[] = [];
  const pinned = /^([a-z]+)@(\d+)?/.exec(facts.packageManagerField ?? '');
  const has = (f: string) => facts.lockfiles.includes(f);

  const bun = pinned?.[1] === 'bun' || has('bun.lock') || has('bun.lockb');
  let manager: NodeManager;
  if (pinned?.[1] === 'npm' || pinned?.[1] === 'yarn' || pinned?.[1] === 'pnpm') manager = pinned[1];
  else if (has('pnpm-lock.yaml') || facts.pnpmWorkspace) manager = 'pnpm';
  else if (has('yarn.lock')) manager = 'yarn';
  else manager = 'npm';

  const explicit = pinned !== null && pinned[1] !== 'bun';
  let lockfile: string | null = null;
  let installCommand: string;
  let relaxedCommand: string | null = null;

  if (manager === 'npm') {
    lockfile = has('package-lock.json') ? 'package-lock.json' : has('npm-shrinkwrap.json') ? 'npm-shrinkwrap.json' : null;
    installCommand = lockfile ? 'npm ci --no-audit --no-fund' : 'npm install --no-audit --no-fund';
    if (lockfile) relaxedCommand = 'npm install --no-audit --no-fund';
  } else if (manager === 'pnpm') {
    lockfile = has('pnpm-lock.yaml') ? 'pnpm-lock.yaml' : null;
    installCommand = lockfile ? 'pnpm install --frozen-lockfile' : 'pnpm install';
    if (lockfile) relaxedCommand = 'pnpm install --no-frozen-lockfile';
  } else {
    lockfile = has('yarn.lock') ? 'yarn.lock' : null;
    const berry = facts.yarnBerry === true || (pinned?.[1] === 'yarn' && Number(pinned[2] ?? 1) >= 2);
    installCommand = lockfile ? (berry ? 'yarn install --immutable' : 'yarn install --frozen-lockfile') : 'yarn install';
    if (lockfile) relaxedCommand = 'yarn install';
  }

  if (bun) {
    // Recognised, and said, rather than silently installed with something else: the
    // repository recorded its tree with Bun, DevLaunch has no Bun, and the lockfile it
    // wrote means nothing to npm. Scripts that *run* Bun are declined by the planner.
    notes.push(
      'This project records its dependencies with Bun, which DevLaunch does not ship; ' +
        `installing with ${manager} from package.json instead, so versions may differ from the Bun lockfile.`,
    );
  }

  return {
    packageManager: manager,
    ...(bun ? { declaredManager: 'bun' as const } : {}),
    lockfile,
    installCommand,
    relaxedCommand,
    projectType: 'node',
    confidence: bun ? 'low' : lockfile || explicit ? 'high' : 'medium',
    notes,
  };
}

/** Whether a `yarn.lock` is Yarn 2+'s format. Berry files open with `__metadata:`. */
export function isBerryLockfile(contents: string | null): boolean {
  return contents !== null && /^__metadata:/m.test(contents.slice(0, 2000));
}

/** Read the facts `detectNodeInstall` needs from a directory on disk. */
export async function readNodeInstallFacts(dir: string, fileNames?: readonly string[]): Promise<NodeInstallFacts> {
  const present = async (f: string) =>
    fileNames ? fileNames.includes(f) : (await readCapped(join(dir, f))) !== null;
  const lockfiles: string[] = [];
  for (const f of NODE_LOCKFILES) if (await present(f)) lockfiles.push(f);

  let packageManagerField: string | undefined;
  const manifest = await readCapped(join(dir, 'package.json'));
  if (manifest !== null) {
    try {
      const pm = (JSON.parse(manifest) as { packageManager?: unknown }).packageManager;
      if (typeof pm === 'string') packageManagerField = pm;
    } catch {
      /* an unreadable manifest decides nothing */
    }
  }

  const yarnBerry =
    (lockfiles.includes('yarn.lock') && isBerryLockfile(await readCapped(join(dir, 'yarn.lock')))) ||
    (await present('.yarnrc.yml'));

  return {
    lockfiles,
    ...(packageManagerField ? { packageManagerField } : {}),
    yarnBerry,
    pnpmWorkspace: await present('pnpm-workspace.yaml'),
  };
}

/**
 * The messages each manager prints when a strict install refuses a lockfile that does not
 * match the manifest, or that it cannot read in this version.
 *
 * Only these. A strict install that fails for any other reason — a registry error, a
 * build script — would fail the same way relaxed, and retrying it hides the real cause.
 */
export const LOCKFILE_OUT_OF_DATE: readonly RegExp[] = Object.freeze([
  // npm ci
  /`npm ci` can only install packages when your package\.json and package-lock\.json/i,
  /npm (?:ERR!|error) code EUSAGE/i,
  // yarn 1
  /Your lockfile needs to be updated, but yarn was run with `--frozen-lockfile`/i,
  // yarn 2+
  /YN0028:.*The lockfile would have been modified by this install, which is explicitly forbidden/i,
  // pnpm
  /ERR_PNPM_OUTDATED_LOCKFILE/,
  /ERR_PNPM_LOCKFILE_BREAKING_CHANGE/,
  /ERR_PNPM_LOCKFILE_CONFIG_MISMATCH/,
  /ERR_PNPM_BROKEN_LOCKFILE/,
]);

/** The relaxed form of a strict install command, or null when it is not one. */
export function relaxedInstall(command: string | null): string | null {
  if (!command) return null;
  const c = command.trim();
  if (/^npm ci\b/.test(c)) return c.replace(/^npm ci\b/, 'npm install');
  if (/^pnpm install\b.*--frozen-lockfile\b/.test(c)) return c.replace(/--frozen-lockfile\b/, '--no-frozen-lockfile');
  if (/^yarn install\b.*--(?:frozen-lockfile|immutable)\b/.test(c)) {
    return c.replace(/\s*--(?:frozen-lockfile|immutable)\b/, '');
  }
  return null;
}

/**
 * The manifest-based half of a Python install: which file says what to install, and how.
 *
 * `from-imports` means no manifest names anything and the planner installs what the
 * entry files import, which it can only do once it knows the framework.
 */
export function detectPythonInstall(
  py: PythonSummary,
): InstallDetection & { source: 'requirements' | 'pyproject' | 'from-imports' | 'none'; declaredCount: number } {
  const declared = (py.runtimeDependencies ?? py.dependencies ?? []).filter((d) => /^[a-z0-9][a-z0-9._-]*$/i.test(d));
  const base: Partial<InstallDetection> & { packageManager: 'pip'; projectType: 'python'; relaxedCommand: null } = {
    packageManager: 'pip' as const,
    projectType: 'python' as const,
    relaxedCommand: null,
    ...(py.hasPoetryLock || py.hasPoetry ? { declaredManager: 'poetry' as const } : py.hasPipfile ? { declaredManager: 'pipenv' as const } : {}),
  };
  // pip reads neither. Recognised and reported, so a reader knows the versions that run
  // may not be the locked ones — poetry.lock was resolved for the author's Python, and
  // DevLaunch has one.
  const ignored = [...(py.hasPoetryLock ? ['poetry.lock'] : []), ...(py.hasPipfileLock ? ['Pipfile.lock'] : [])];
  const lockfile = null;
  Object.assign(base, ignored.length ? { ignoredLockfiles: ignored } : {});

  if (py.requirements.length > 0) {
    return { ...base, lockfile: null, installCommand: 'pip install -r requirements.txt', confidence: 'high', notes: [], source: 'requirements', declaredCount: py.requirements.length };
  }
  if (py.hasPyproject) {
    if (py.packageable !== false) {
      return { ...base, lockfile, installCommand: 'pip install .', confidence: 'high', notes: [], source: 'pyproject', declaredCount: declared.length };
    }
    if (declared.length === 0) {
      return {
        ...base,
        lockfile,
        installCommand: null,
        confidence: 'medium',
        notes: [
          'pyproject.toml declares no dependencies and the project is not a buildable ' +
            'package, so nothing is installed. Imports it needs may be missing.',
        ],
        source: 'none',
        declaredCount: 0,
      };
    }
    // Through a requirements file DevLaunch writes from pyproject.toml at launch, so the
    // version ranges the project declares survive — the allowlist permits no `<`, `>` or
    // quotes on a command line. A poetry.lock is not used: it was resolved for the
    // author's Python, and DevLaunch has one Python.
    return {
      ...base,
      lockfile: null,
      installCommand: `pip install -r ${config.container.generatedRequirementsPath}`,
      confidence: 'high',
      notes: [
        `Installing ${declared.length} declared ${declared.length === 1 ? 'dependency' : 'dependencies'} with the version ranges pyproject.toml ` +
          'gives them: this project has several top-level directories and no package ' +
          'configuration, so `pip install .` cannot build it. DevLaunch writes the ranges into ' +
          `${config.container.generatedRequirementsPath} inside the container — never into the ` +
          'repository.',
      ],
      source: 'pyproject',
      declaredCount: declared.length,
    };
  }
  return {
    ...base,
    lockfile: null,
    installCommand: null,
    confidence: 'low',
    notes: [],
    source: 'from-imports',
    declaredCount: 0,
  };
}
