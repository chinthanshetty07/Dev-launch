import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FailureCode, RunPlanSchema, type RepositoryMetadata } from '@devlaunch/shared';
import {
  LOCKFILE_OUT_OF_DATE,
  detectNodeInstall,
  detectPythonInstall,
  readNodeInstallFacts,
  relaxedInstall,
} from '../services/analysis/InstallDetection.js';
import { workspaceInstall } from '../services/analysis/ServiceDiscovery.js';
import { tryDeterministicRepair } from '../services/planning/DeterministicRepair.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function dir(files: Record<string, string>): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'devlaunch-install-'));
  dirs.push(d);
  for (const [name, body] of Object.entries(files)) await writeFile(join(d, name), body);
  return d;
}

describe('which install a Node project gets', () => {
  it('npm with package-lock.json installs exactly the lockfile: npm ci (test 1)', () => {
    const d = detectNodeInstall({ lockfiles: ['package-lock.json'] });
    expect(d).toMatchObject({ packageManager: 'npm', lockfile: 'package-lock.json', installCommand: 'npm ci --no-audit --no-fund', confidence: 'high' });
  });

  it('npm without a lockfile falls back to npm install (test 2)', () => {
    const d = detectNodeInstall({ lockfiles: [] });
    expect(d).toMatchObject({ packageManager: 'npm', lockfile: null, installCommand: 'npm install --no-audit --no-fund', relaxedCommand: null, confidence: 'medium' });
  });

  it('Yarn 1 installs frozen, Yarn 2+ immutable (test 3)', () => {
    expect(detectNodeInstall({ lockfiles: ['yarn.lock'] }).installCommand).toBe('yarn install --frozen-lockfile');
    expect(detectNodeInstall({ lockfiles: ['yarn.lock'], yarnBerry: true }).installCommand).toBe('yarn install --immutable');
    expect(detectNodeInstall({ lockfiles: ['yarn.lock'], packageManagerField: 'yarn@4.6.0' }).installCommand).toBe('yarn install --immutable');
  });

  it('pnpm installs from a frozen lockfile (test 4)', () => {
    expect(detectNodeInstall({ lockfiles: ['pnpm-lock.yaml'] })).toMatchObject({ packageManager: 'pnpm', installCommand: 'pnpm install --frozen-lockfile' });
    // pnpm-workspace.yaml names pnpm on its own; with no lockfile there is nothing to freeze.
    expect(detectNodeInstall({ lockfiles: [], pnpmWorkspace: true }).installCommand).toBe('pnpm install');
  });

  it('recognises Bun, and says it is installing with npm instead — there is no Bun here (test 5)', () => {
    // The user's decision: DevLaunch ships no Bun. Recognising it is the requirement;
    // pretending `bun install` ran would be the failure.
    for (const facts of [{ lockfiles: ['bun.lockb'] }, { lockfiles: ['bun.lock'] }, { lockfiles: [], packageManagerField: 'bun@1.1.0' }]) {
      const d = detectNodeInstall(facts);
      expect(d.declaredManager, JSON.stringify(facts)).toBe('bun');
      expect(d.packageManager).toBe('npm');
      expect(d.confidence).toBe('low');
      expect(d.notes.join(' ')).toMatch(/records its dependencies with Bun, which DevLaunch does not ship/);
    }
  });

  it('believes packageManager over a lockfile', () => {
    expect(detectNodeInstall({ lockfiles: ['package-lock.json'], packageManagerField: 'pnpm@9.12.3' }).packageManager).toBe('pnpm');
  });

  it('reads the facts from disk, Berry lockfile format included', async () => {
    const d = await dir({
      'package.json': JSON.stringify({ packageManager: 'yarn@4.6.0' }),
      'yarn.lock': '__metadata:\n  version: 8\n',
    });
    const facts = await readNodeInstallFacts(d);
    expect(facts).toMatchObject({ lockfiles: ['yarn.lock'], packageManagerField: 'yarn@4.6.0', yarnBerry: true });
  });

  it('gives a workspace root the same answer, from its own packageManager', async () => {
    // workspaceInstall used to have its own lockfile table and never read packageManager.
    const d = await dir({
      'package.json': JSON.stringify({ workspaces: ['apps/*'], packageManager: 'pnpm@9.12.3' }),
      'package-lock.json': '{}',
    });
    expect(await workspaceInstall(d)).toEqual({ manager: 'pnpm', command: 'pnpm install' });
  });
});

describe('falling back from a strict install', () => {
  // Captured from the runner image, each against a lockfile that disagrees with package.json.
  const REAL = [
    'npm error `npm ci` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync. Please update your lock file with `npm install` before continuing.',
    'Error: ERR_PNPM_OUTDATED_LOCKFILE',
    'error Your lockfile needs to be updated, but yarn was run with `--frozen-lockfile`.',
    '➤ YN0028: │ The lockfile would have been modified by this install, which is explicitly forbidden.',
  ];

  it('recognises the refusal each manager prints', () => {
    for (const line of REAL) expect(LOCKFILE_OUT_OF_DATE.some((p) => p.test(line)), line).toBe(true);
  });

  it('relaxes exactly the strict commands', () => {
    expect(relaxedInstall('npm ci --no-audit --no-fund')).toBe('npm install --no-audit --no-fund');
    expect(relaxedInstall('pnpm install --frozen-lockfile')).toBe('pnpm install --no-frozen-lockfile');
    expect(relaxedInstall('yarn install --frozen-lockfile')).toBe('yarn install');
    expect(relaxedInstall('yarn install --immutable')).toBe('yarn install');
    expect(relaxedInstall('npm install --no-audit --no-fund')).toBeNull();
    expect(relaxedInstall(null)).toBeNull();
  });

  const plan = (installCommand: string) =>
    RunPlanSchema.parse({
      runtime: { language: 'node', version: '20' }, packageManager: 'npm', installCommand,
      buildCommand: null, startCommand: 'npm run start', workingDirectory: '.', expectedPort: 3000, planSource: 'rule-based',
    });
  const meta = { warnings: [], envExample: [], lockfiles: [], frameworkConfigs: [], packageJson: { scripts: { start: 'node s.js' }, dependencies: {}, devDependencies: {} } } as unknown as RepositoryMetadata;
  const repair = (installCommand: string, logs: string) =>
    tryDeterministicRepair({
      plan: plan(installCommand),
      failure: { code: FailureCode.DEPENDENCY_INSTALL_FAILED, message: 'Dependency installation failed.' },
      metadata: meta, logs, previousAttempts: [],
    });

  it('relaxes on a lockfile refusal, with the refusal as evidence', () => {
    const out = repair('npm ci --no-audit --no-fund', REAL[0]!);
    expect(out?.plan.installCommand).toBe('npm install --no-audit --no-fund');
    expect(out?.record.evidence[0]).toMatch(/can only install packages when/);
  });

  it('does not relax any other install failure — a retry would only bury the cause', () => {
    for (const logs of ['npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/nope', 'npm error code ERESOLVE', 'Killed']) {
      expect(repair('npm ci --no-audit --no-fund', logs), logs).toBeNull();
    }
  });
});

describe('which install a Python project gets', () => {
  const py = (over: Record<string, unknown>) =>
    ({ requirements: [], hasPyproject: false, hasPipfile: false, hasManagePy: false, entryCandidates: [], ...over }) as never;

  it('requirements.txt wins, and pip runs it', () => {
    expect(detectPythonInstall(py({ requirements: ['flask'], hasPyproject: true }))).toMatchObject({ packageManager: 'pip', installCommand: 'pip install -r requirements.txt', source: 'requirements' });
  });

  it('a packageable pyproject is built; a Poetry one is recognised as such', () => {
    const d = detectPythonInstall(py({ hasPyproject: true, packageable: true, hasPoetry: true, hasPoetryLock: true }));
    // pip does not read poetry.lock: reported as present and not honoured.
    expect(d).toMatchObject({ installCommand: 'pip install .', declaredManager: 'poetry', lockfile: null, ignoredLockfiles: ['poetry.lock'] });
  });

  it('an unbuildable pyproject installs its ranges through the generated file', () => {
    const d = detectPythonInstall(py({ hasPyproject: true, packageable: false, runtimeDependencies: ['flask'] }));
    expect(d.installCommand).toBe('pip install -r /workspace/.devlaunch/requirements.txt');
  });

  it('a Pipfile is recognised, and says nothing it cannot do', () => {
    const d = detectPythonInstall(py({ hasPipfile: true, hasPipfileLock: true }));
    expect(d).toMatchObject({ declaredManager: 'pipenv', lockfile: null, ignoredLockfiles: ['Pipfile.lock'], installCommand: null, source: 'from-imports' });
  });
});

describe('a workspace with one application', () => {
  it('names the workspace manager on the plan, beside the workspace install', async () => {
    const { RuleBasedPlanner } = await import('../services/planning/RuleBasedPlanner.js');
    const { RepositoryAnalyzer } = await import('../services/analysis/RepositoryAnalyzer.js');
    const { fileURLToPath } = await import('node:url');
    const { dirname, resolve } = await import('node:path');
    const fixture = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../fixtures/node-workspace-one-app');
    const out = await new RuleBasedPlanner(new RepositoryAnalyzer()).planRepository(fixture);
    expect(out.plan).toMatchObject({ installCommand: 'pnpm install', installDirectory: '.', packageManager: 'pnpm' });
  });
});
