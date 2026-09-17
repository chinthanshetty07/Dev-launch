import type {
  EnvVar,
  PackageJsonSummary,
  PythonSummary,
  RepositoryMetadata,
  RunPlan,
  WorkspacePackage,
} from '@devlaunch/shared';
import { RunPlanSchema } from '@devlaunch/shared';
import type { RepositoryAnalyzer } from '../analysis/RepositoryAnalyzer.js';
import {
  NODE_FRAMEWORKS,
  PYTHON_FRAMEWORKS,
  PYTHON_REQUIREMENT_SIGNALS,
  bindingArgs,
  type NodeFramework,
} from './frameworks.js';

export interface PlanningOutcome {
  plan: RunPlan | null;
  /** Detector that matched, e.g. "vite", "django". */
  detected: string | null;
  /** Why no plan could be produced. Present only when plan is null. */
  reason?: string;
  /** Several runnable packages: a person picks, rather than a model guessing. */
  choices?: WorkspacePackage[];
  warnings: string[];
}

/** Only image we have per language; recorded so a mismatch surfaces as a warning. */
const NODE_IMAGE_VERSION = '20';
const PYTHON_IMAGE_VERSION = '3.12';

function detectPackageManager(lockfiles: string[]): 'npm' | 'yarn' | 'pnpm' {
  if (lockfiles.includes('pnpm-lock.yaml')) return 'pnpm';
  if (lockfiles.includes('yarn.lock')) return 'yarn';
  return 'npm';
}

function installFor(pm: 'npm' | 'yarn' | 'pnpm'): string {
  // `npm ci` would be stricter but fails outright when a lockfile is out of step with
  // package.json, which is common in repositories nobody has run in a while.
  if (pm === 'npm') return 'npm install --no-audit --no-fund';
  if (pm === 'pnpm') return 'pnpm install';
  return 'yarn install';
}

/** Warn when a repository's declared Node range plainly excludes the image we have. */
function nodeVersionWarning(engineNode: string | undefined): string | undefined {
  if (!engineNode) return undefined;
  const majors = [...engineNode.matchAll(/(\d+)/g)].map((m) => Number(m[1]));
  if (majors.length === 0) return undefined;
  const satisfied =
    /^[>^~]?=?\s*\d+/.test(engineNode.trim()) && majors.some((m) => m <= Number(NODE_IMAGE_VERSION));
  if (satisfied) return undefined;
  return `Repository requests Node "${engineNode}" but only ${NODE_IMAGE_VERSION} is available.`;
}

function pickScript(pkg: PackageJsonSummary, candidates: string[]): string | undefined {
  return candidates.find((name) => typeof pkg.scripts[name] === 'string');
}

function matchNodeFramework(
  pkg: PackageJsonSummary,
  configs: string[],
): NodeFramework | undefined {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  // Walked in table order, which places meta-frameworks before the build tools they
  // are themselves built on.
  return NODE_FRAMEWORKS.find(
    (fw) => deps[fw.dep] !== undefined || (fw.configFile && configs.includes(fw.configFile)),
  );
}

/**
 * Deterministic plan generation.
 *
 * Every plan here is produced from a repository's own metadata with no model call. The
 * roster is deliberately broad: each framework it covers is one more repository that
 * never reaches the AI fallback, which is the entire argument for the hybrid design.
 */
export class RuleBasedPlanner {
  constructor(private readonly analyzer?: RepositoryAnalyzer) {}

  /**
   * Analyse and plan a repository, resolving a monorepo to its single runnable package.
   *
   * When several packages are runnable the caller is handed the choice rather than the
   * AI: a person picking from a list beats a model guessing, and it is less code.
   */
  async planRepository(root: string): Promise<PlanningOutcome> {
    if (!this.analyzer) throw new Error('planRepository requires an analyzer.');

    const rootMeta = await this.analyzer.analyze(root);
    const runnable = rootMeta.workspace?.runnable ?? [];

    if (runnable.length > 1) {
      return {
        plan: null,
        detected: null,
        reason: `Repository is a monorepo with ${runnable.length} runnable packages.`,
        choices: runnable,
        warnings: rootMeta.warnings,
      };
    }

    if (runnable.length === 1) {
      const target = runnable[0]!;
      const subMeta = await this.analyzer.analyze(root, target.dir);
      const outcome = this.plan(subMeta, target.dir);
      return { ...outcome, warnings: [...rootMeta.warnings, ...outcome.warnings] };
    }

    return this.plan(rootMeta);
  }

  /** Pure: metadata in, plan out. No filesystem access, so every branch is unit-testable. */
  plan(meta: RepositoryMetadata, workingDirectory = '.'): PlanningOutcome {
    const warnings = [...meta.warnings];

    if (meta.packageJson) {
      const outcome = this.planNode(meta, meta.packageJson, workingDirectory, warnings);
      if (outcome) return outcome;
    }

    if (meta.python) {
      const outcome = this.planPython(meta, meta.python, workingDirectory, warnings);
      if (outcome) return outcome;
    }

    return {
      plan: null,
      detected: null,
      reason: meta.packageJson
        ? 'package.json present but no recognised framework or start script.'
        : 'No package.json or recognisable Python project at the working directory.',
      warnings,
    };
  }

  private planNode(
    meta: RepositoryMetadata,
    pkg: PackageJsonSummary,
    workingDirectory: string,
    warnings: string[],
  ): PlanningOutcome | null {
    const pm = detectPackageManager(meta.lockfiles);
    const versionWarning = nodeVersionWarning(pkg.engineNode);
    if (versionWarning) warnings.push(versionWarning);

    const framework = matchNodeFramework(pkg, meta.frameworkConfigs);
    const script = framework
      ? pickScript(pkg, framework.scripts)
      : pickScript(pkg, ['dev', 'start', 'serve']);

    if (!script) {
      if (!framework) return null;
      warnings.push(
        `Detected ${framework.id} but found none of its expected scripts ` +
          `(${framework.scripts.join(', ')}).`,
      );
      return null;
    }

    const port = framework?.defaultPort ?? 3000;
    const args = framework ? bindingArgs(framework, port) : [];
    // `--` is what forwards arguments through the package manager to the script itself.
    const startCommand = `${pm} run ${script}${args.length > 0 ? ` -- ${args.join(' ')}` : ''}`;

    const env: EnvVar[] = [
      { key: 'HOST', value: '0.0.0.0', required: false },
      { key: 'PORT', value: String(port), required: false },
    ];
    if (framework?.id === 'cra') {
      // CRA opens a browser on start, which inside a container just wastes time.
      env.push({ key: 'BROWSER', value: 'none', required: false });
    }
    if (framework?.note) warnings.push(framework.note);

    return {
      detected: framework?.id ?? 'node',
      warnings,
      plan: RunPlanSchema.parse({
        runtime: { language: 'node', version: NODE_IMAGE_VERSION },
        packageManager: pm,
        installCommand: installFor(pm),
        // Dev servers build on the fly; a separate build step would only slow start-up.
        buildCommand: null,
        startCommand,
        workingDirectory,
        expectedPort: port,
        hostBinding: framework ? (framework.binding ?? 'forced') : 'unknown',
        environmentVariables: env,
        healthCheck: { path: '/', method: 'GET', expectedStatusCodes: [200, 204, 302, 304] },
        planSource: 'rule-based',
      }),
    };
  }

  private planPython(
    meta: RepositoryMetadata,
    py: PythonSummary,
    workingDirectory: string,
    warnings: string[],
  ): PlanningOutcome | null {
    const install = py.requirements.length > 0
      ? 'pip install -r requirements.txt'
      : py.hasPyproject
        ? 'pip install .'
        : null;

    if (install === null) {
      warnings.push(
        py.hasPipfile
          ? 'Pipfile-only projects are not supported by the rule-based planner.'
          : 'No requirements.txt or pyproject.toml found.',
      );
      return null;
    }

    const requirementNames = py.requirements
      .map((r) => r.split(/[<>=!~[\s]/)[0]!.trim().toLowerCase())
      .filter(Boolean);
    const signal = Object.keys(PYTHON_REQUIREMENT_SIGNALS).find((k) => requirementNames.includes(k));

    // manage.py is definitive and outranks anything requirements.txt merely mentions.
    const kind = py.hasManagePy
      ? 'django'
      : (signal ?? py.entryCandidates.find((e) => e.framework)?.framework ?? null);

    if (!kind) return null;

    const fw = PYTHON_FRAMEWORKS[kind];
    if (!fw) return null;
    if (fw.note) warnings.push(fw.note);

    const entry = py.entryCandidates.find((e) => e.framework === kind)
      ?? py.entryCandidates.find((e) => e.file !== 'manage.py');
    const moduleName = entry?.file.replace(/\.py$/, '');

    const env: EnvVar[] = [];
    let startCommand: string;

    switch (kind) {
      case 'django':
        startCommand = `python manage.py runserver 0.0.0.0:${fw.defaultPort}`;
        break;

      case 'flask': {
        if (!moduleName) return null;
        // FLASK_APP works across Flask versions; `flask --app` only from 2.2 onward.
        env.push({ key: 'FLASK_APP', value: moduleName, required: false });
        startCommand = `flask run --host=0.0.0.0 --port=${fw.defaultPort}`;
        break;
      }

      case 'fastapi': {
        if (!moduleName) return null;
        const appVar = entry?.appVariable ?? 'app';
        startCommand = `uvicorn ${moduleName}:${appVar} --host 0.0.0.0 --port ${fw.defaultPort}`;
        break;
      }

      case 'streamlit': {
        const file = entry?.file ?? 'app.py';
        // --server.headless suppresses the first-run email prompt, which would
        // otherwise block forever and surface as a readiness timeout.
        startCommand =
          `streamlit run ${file} --server.address 0.0.0.0 ` +
          `--server.port ${fw.defaultPort} --server.headless true`;
        break;
      }

      case 'gradio': {
        const file = entry?.file ?? 'app.py';
        env.push({ key: 'GRADIO_SERVER_NAME', value: '0.0.0.0', required: false });
        env.push({ key: 'GRADIO_SERVER_PORT', value: String(fw.defaultPort), required: false });
        startCommand = `python ${file}`;
        break;
      }

      default:
        return null;
    }

    for (const v of meta.envExample.filter((e) => !e.hasDefault)) {
      env.push({ key: v.key, value: null, required: true });
    }

    return {
      detected: fw.id,
      warnings,
      plan: RunPlanSchema.parse({
        runtime: { language: 'python', version: PYTHON_IMAGE_VERSION },
        packageManager: 'pip',
        installCommand: install,
        buildCommand: null,
        startCommand,
        workingDirectory,
        expectedPort: fw.defaultPort,
        hostBinding: 'forced',
        environmentVariables: env,
        healthCheck: { path: '/', method: 'GET', expectedStatusCodes: [200, 204, 302, 304] },
        planSource: 'rule-based',
      }),
    };
  }
}
