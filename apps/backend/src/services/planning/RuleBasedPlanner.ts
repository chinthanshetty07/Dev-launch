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
import { workspaceInstall } from '../analysis/ServiceDiscovery.js';
import { detectNodeInstall, detectPythonInstall, needsManagerToResolve, type NodeManager } from '../analysis/InstallDetection.js';
import {
  NODE_FRAMEWORKS,
  PYTHON_FRAMEWORKS,
  PYTHON_REQUIREMENT_SIGNALS,
  bindingArgs,
  type NodeFramework,
} from './frameworks.js';
import { config } from '../../config/index.js';

/** Join two repository-relative paths, keeping `.` meaning "the working directory". */
function joinPath(base: string, child: string): string {
  return base === '.' || base === '' ? child : `${base}/${child}`;
}

export interface PlanningOutcome {
  plan: RunPlan | null;
  /** Detector that matched, e.g. "vite", "django". */
  detected: string | null;
  /** Why no plan could be produced. Present only when plan is null. */
  reason?: string;
  /**
   * This repository is not an application, and no plan would make it one.
   *
   * Distinct from "no rule matched". A library has no server to start, so a model asked
   * to find one will invent a command — `node dist/main.js` against a build that never
   * ran — and the run fails several minutes later with a diagnosis about the invention
   * rather than about the repository. Saying so at once is both faster and true.
   */
  unrunnable?: boolean;
  /** What a person can do about an unrunnable repository, when the reason is specific. */
  remedy?: string;
  /** Several runnable packages: a person picks, rather than a model guessing. */
  choices?: WorkspacePackage[];
  warnings: string[];
}

/**
 * Node versions DevLaunch ships, oldest first.
 *
 * 20 is the default because a project that runs on it runs on the version its author
 * most likely used, and a newer runtime is a change rather than an improvement. 22
 * exists for repositories that cannot run on 20 at all — see `nodeVersionFor`.
 */
const NODE_IMAGE_VERSIONS = ['20', '22'] as const;
const NODE_IMAGE_VERSION = NODE_IMAGE_VERSIONS[0];
const PYTHON_IMAGE_VERSION = '3.12';
/** `http.server`'s own default, which is what a person running it by hand would see. */
const STATIC_PORT = 8000;

/**
 * Built-in modules that do not exist in every Node DevLaunch ships, and when they arrived.
 *
 * A repository importing one of these has stated its minimum more precisely than any
 * `engines` field would, and more reliably: this one declares no engines at all, and its
 * `import { DatabaseSync } from 'node:sqlite'` is the only thing that says it needs 22.
 * The failure without it is not a dependency error a person can act on — it is
 * `ERR_UNKNOWN_BUILTIN_MODULE`, thrown by the loader, from a module name that looks like
 * every other built-in.
 */
const BUILTIN_SINCE: Readonly<Record<string, number>> = Object.freeze({
  sqlite: 22,
});

/**
 * Which tool installs this project. Decided by `detectNodeInstall`; kept here, with this
 * signature, for the callers that only need the name.
 */
export function detectPackageManager(lockfiles: readonly string[], declared?: string): NodeManager {
  return detectNodeInstall({ lockfiles, ...(declared ? { packageManagerField: declared } : {}) }).packageManager;
}

export { needsManagerToResolve };

/**
 * `<manager> run <script>` with arguments that reach the script as options.
 *
 * `--` belongs to npm alone. npm strips it and passes what follows to the script; without
 * it npm reads `--host` as its own configuration. pnpm and Yarn 2+ do the opposite: they
 * forward a literal `--` to the script, and a CLI that parses `--` as the end of its
 * options — Vite's does — then treats `--host 0.0.0.0` as positional and binds loopback.
 * Yarn 1 strips it with a deprecation warning, and passes options through without it.
 * Measured in the runner image, not recalled: pnpm 9.12, 10.20 and 12.6 and Yarn 4.6
 * all delivered `["--","--host","0.0.0.0"]` to the script.
 */
export function runScript(pm: 'npm' | 'yarn' | 'pnpm', script: string, args: readonly string[]): string {
  if (args.length === 0) return `${pm} run ${script}`;
  return pm === 'npm' ? `npm run ${script} -- ${args.join(' ')}` : `${pm} run ${script} ${args.join(' ')}`;
}

/** The application's own name for its bind address, set alongside `HOST`. */
function bindHostEnv(meta: RepositoryMetadata): EnvVar[] {
  return meta.bindHostEnv ? [{ key: meta.bindHostEnv.key, value: '0.0.0.0', required: false }] : [];
}


/**
 * Warn when a repository's declared Node range plainly excludes the image we have.
 *
 * A heuristic, deliberately: implementing semver range logic for one warning is not
 * worth a dependency. It errs toward silence, except where a bound is unambiguous.
 */
function nodeVersionWarning(engineNode: string | undefined, ourVersion: string): string | undefined {
  if (!engineNode) return undefined;
  const ours = Number(ourVersion);
  const warn =
    `Repository requests Node "${engineNode}"; running ${ourVersion}, the closest of ` +
    `${NODE_IMAGE_VERSIONS.join(' and ')}.`;

  // An upper bound below our version excludes us outright. Checked first, because a
  // range like ">=14 <=16" also contains a lower bound we would otherwise accept.
  const upper = [...engineNode.matchAll(/<=?\s*(\d+)/g)].map((m) => Number(m[1]));
  if (upper.some((v) => v < ours)) return warn;

  const lower = [...engineNode.matchAll(/(?:>=?|\^|~)?\s*(\d+)/g)].map((m) => Number(m[1]));
  if (lower.length === 0) return undefined;

  // Caret and tilde pin a major: "^18" means 18.x, never 20.
  if (/^\s*[\^~]\s*\d+/.test(engineNode) && lower[0] !== ours) return warn;

  return lower.some((v) => v <= ours) ? undefined : warn;
}

/**
 * Whether this package exists to be imported rather than run.
 *
 * Three facts together, because none of them alone is enough: a package can legitimately
 * have no runtime dependencies, and plenty of applications declare `main`. What settles
 * it is that every script it does have is a build or a check, and `main` names something
 * inside a build directory — which is a promise to a consumer, not a way to start.
 */
function looksLikeALibrary(pkg: PackageJsonSummary): boolean {
  const scripts = Object.entries(pkg.scripts);
  if (scripts.length === 0) return false;
  // The name is not enough. This package's `serve` is `tsc --watch`, which compiles and
  // watches and never listens — reading the name alone called a library an application.
  const startsSomething = scripts.some(
    ([name, body]) => /^(?:dev|start|serve|develop)/.test(name) && SERVER_RUNNERS.test(body),
  );
  if (startsSomething) return false;
  if (Object.keys(pkg.dependencies).length > 0) return false;
  return /^(?:\.\/)?(?:dist|lib|build|es|esm|cjs|out)\//.test(pkg.main ?? '');
}

/**
 * Which approved Node version to run this repository on.
 *
 * Two kinds of evidence, and the stronger one is not the manifest. `engines.node` is a
 * declaration a lot of repositories simply do not make; an `import` of a built-in module
 * is one every repository that needs it makes by necessity. So a newer built-in raises
 * the floor outright, and `engines` raises it only when it names a version we have.
 *
 * The lowest version that satisfies the evidence wins. Running everything on the newest
 * available Node would be a different tool: a project pinned to 20 by its author is a
 * project whose dependencies were resolved against 20.
 */
export function nodeVersionFor(meta: RepositoryMetadata): string {
  let floor = Number(NODE_IMAGE_VERSION);

  for (const builtin of meta.nodeBuiltins ?? []) {
    const since = BUILTIN_SINCE[builtin];
    if (since !== undefined) floor = Math.max(floor, since);
  }

  const engine = meta.packageJson?.engineNode;
  if (engine) {
    // Only a lower bound, and only one we can actually satisfy. An upper bound is what
    // `nodeVersionWarning` reports on; silently running a version the repository
    // excluded would be worse than running the default and saying so.
    const lower = [...engine.matchAll(/(?:>=?|\^|~)\s*(\d+)/g)].map((m) => Number(m[1]));
    const wanted = Math.max(...lower, 0);
    if (Number.isFinite(wanted)) floor = Math.max(floor, wanted);
  }

  const match = NODE_IMAGE_VERSIONS.find((v) => Number(v) >= floor);
  // Nothing high enough: the default, and the failure names what is missing. Pretending
  // to satisfy a floor we cannot reach would replace one honest error with a confusing one.
  return match ?? NODE_IMAGE_VERSION;
}

/** Whether a script body invokes `bun` or `bunx` as a command. */
export function runsBun(body: string): boolean {
  return /(?:^|&&|\|\||;|\s)bunx?(?=\s|$)/.test(body);
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
  const matches = NODE_FRAMEWORKS.filter(
    (fw) => deps[fw.dep] !== undefined || (fw.configFile && configs.includes(fw.configFile)),
  );
  if (matches.length <= 1) return matches[0];

  // Several frameworks in one manifest, which is ordinary: a MERN repository declares
  // `express` and `react-scripts` side by side because one manifest holds both halves.
  // Table order alone picks the browser tool, and the browser tool is usually not what
  // the start script runs — this one runs `node ./bin/www`, the API.
  //
  // The script body settles it, because the script body is the author saying what
  // starts. Getting it wrong is not cosmetic: the frameworks differ in default port and
  // in argument style, so a Vite-shaped guess appends `--host 0.0.0.0 --port 5173` to a
  // command that is really `node server.js` and then watches a port nothing will open.
  const started = matches.find((fw) => {
    const script = pickScript(pkg, fw.scripts);
    return script !== undefined && scriptRuns(pkg.scripts[script]!, fw);
  });
  return started ?? matches[0];
}

/**
 * Commands that start something that listens.
 *
 * Deliberately not "anything in a script called `dev`": a compiler in watch mode is a
 * build step with a long life, not a server, and telling the two apart is what
 * distinguishes a library from an application.
 */
const SERVER_RUNNERS =
  /(?:^|&&|;|\s|\/)(?:node|nodemon|ts-node|tsx|babel-node|next|nuxt|vite|astro|remix|gatsby|ng|vue-cli-service|react-scripts|nest|docusaurus|parcel|webpack-dev-server|serve|http-server|live-server|concurrently)\b/;

/** Runners that mean "this script starts a plain Node server", not a framework's CLI. */
const NODE_RUNNERS = /(?:^|&&|;|\s)(?:node|nodemon|ts-node|tsx|babel-node)\b/;

/**
 * Whether this script body actually starts the given framework.
 *
 * A build tool is invoked by name — `vite`, `next dev`, `react-scripts start`. A server
 * framework is not: it is imported by a file that `node` runs. So the two are recognised
 * by different evidence, which is what the script body actually contains in each case.
 */
function scriptRuns(body: string, fw: NodeFramework): boolean {
  if (fw.startedBy === 'node') return NODE_RUNNERS.test(body);
  // The tool's own binary, or the package manager delegating to it.
  return new RegExp(`(?:^|&&|;|\\s|/)${escapeRegExp(toolNameFor(fw))}\\b`).test(body);
}

/** The binary a framework is started by, where it differs from its package name. */
function toolNameFor(fw: NodeFramework): string {
  if (fw.id === 'cra') return 'react-scripts';
  if (fw.id === 'angular') return 'ng';
  if (fw.id === 'vue-cli') return 'vue-cli-service';
  if (fw.id === 'docusaurus') return 'docusaurus';
  if (fw.id === 'webpack-dev-server') return 'webpack';
  if (fw.id === 'remix') return 'remix';
  if (fw.id === 'sveltekit') return 'vite';
  return fw.id;
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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

      // Installed at the root, the way the project planner installs a workspace. Planned
      // from the package alone, this took the package's own evidence — no lockfile, no
      // `packageManager` — and ran `npm install` inside `apps/docs` of a pnpm workspace,
      // where `workspace:*` cannot resolve: `EUNSUPPORTEDPROTOCOL`, before a model was
      // asked to guess. Only one package runs, but the tree it depends on is the root's.
      const workspace = outcome.plan ? await workspaceInstall(root) : null;
      if (!outcome.plan || !workspace) {
        return { ...outcome, warnings: [...rootMeta.warnings, ...outcome.warnings] };
      }
      return {
        ...outcome,
        // The manager too: the install is the workspace's, and a plan naming npm beside a
        // `yarn install` contradicts itself in every summary that reads it.
        plan: RunPlanSchema.parse({ ...outcome.plan, installCommand: workspace.command, installDirectory: '.', packageManager: workspace.manager }),
        warnings: [
          ...rootMeta.warnings,
          `Workspace detected; installing once at the repository root with ${workspace.manager}.`,
          ...outcome.warnings,
        ],
      };
    }

    const atRoot = this.plan(rootMeta);
    if (atRoot.plan || atRoot.unrunnable || !rootMeta.soleService) return atRoot;

    // The root holds configuration and the application holds a directory. Discovery
    // already found it — often because the repository's own compose file named it
    // outright — so declining here and asking a model to read the tree would be asking
    // for an answer already in hand.
    const sole = rootMeta.soleService;
    const subMeta = await this.analyzer.analyze(root, sole.dir);
    const outcome = this.plan(subMeta, sole.dir);
    if (!outcome.plan) return atRoot;

    return {
      ...outcome,
      warnings: [
        ...rootMeta.warnings,
        `Nothing runnable at the repository root; running ${sole.dir} instead (${sole.evidence}).`,
        ...outcome.warnings,
      ],
    };
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

    // A page with nothing to build is served as it stands. Never beside a package.json,
    // even one that could not be planned: a Vite app's index.html is a template whose
    // `<script src="/src/main.tsx">` no browser can run, so serving it would be a READY
    // page that cannot work. Beside Python files that planned to nothing it is served:
    // that is a site with a helper script, not an application.
    if (meta.staticIndex && !meta.packageJson) {
      return {
        detected: 'static',
        warnings,
        plan: RunPlanSchema.parse({
          runtime: { language: 'python', version: PYTHON_IMAGE_VERSION },
          packageManager: 'pip',
          installCommand: null,
          buildCommand: null,
          // No --bind: http.server listens on every interface unless told otherwise,
          // measured — the flag made no difference a test could see.
          startCommand: `python -m http.server ${STATIC_PORT}`,
          workingDirectory,
          expectedPort: STATIC_PORT,
          hostBinding: 'forced',
          environmentVariables: [],
          healthCheck: { path: '/', method: 'GET', expectedStatusCodes: [200] },
          planSource: 'rule-based',
        }),
      };
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
    const install = detectNodeInstall({
      lockfiles: meta.lockfiles,
      ...(pkg.packageManager ? { packageManagerField: pkg.packageManager } : {}),
      ...(meta.yarnBerry ? { yarnBerry: true } : {}),
      ...(meta.pnpmWorkspace ? { pnpmWorkspace: true } : {}),
    });
    const pm = install.packageManager;
    warnings.push(...install.notes);
    const nodeVersion = nodeVersionFor(meta);
    const versionWarning = nodeVersionWarning(pkg.engineNode, nodeVersion);
    if (versionWarning) warnings.push(versionWarning);

    // Said when it is not the default, because it is a decision rather than a detail:
    // the dependency tree resolves against whichever Node runs, and a project pinned to
    // 20 by its author is a project whose packages were chosen for 20.
    if (nodeVersion !== NODE_IMAGE_VERSION) {
      const why = (meta.nodeBuiltins ?? []).find((b) => BUILTIN_SINCE[b] !== undefined);
      warnings.push(
        `Running Node ${nodeVersion} rather than ${NODE_IMAGE_VERSION}` +
          (why ? `: this project imports \`node:${why}\`, which ${NODE_IMAGE_VERSION} does not have.` : '.'),
      );
    }

    // Said before the run rather than after it fails. A literal bind address is the one
    // problem DevLaunch can see coming and can do nothing about, so the earliest useful
    // moment to say so is while the plan is still on screen.
    if (meta.hardcodedBind) {
      warnings.push(
        `${meta.hardcodedBind.file} binds a loopback address in its own source ` +
          `(\`${meta.hardcodedBind.line}\`). Nothing outside the container can reach that, ` +
          'and no environment variable overrides it — edit the line to bind 0.0.0.0.',
      );
    }

    const framework = matchNodeFramework(pkg, meta.frameworkConfigs);
    const candidates = framework ? framework.scripts : ['dev', 'start', 'serve'];
    let script = pickScript(pkg, candidates);

    // A script that runs Bun cannot start here: DevLaunch ships Node, and no Bun. It was
    // planned anyway, died on `sh: 1: bun: not found`, and a model was asked to repair a
    // missing runtime. Another candidate that does not need Bun is taken instead; with
    // none, the repository is declined by name. A `bun.lock` alone is not evidence — two
    // corpus repositories carry one and install and run under npm.
    if (script !== undefined && runsBun(pkg.scripts[script]!)) {
      const instead = candidates.find((n) => pkg.scripts[n] !== undefined && !runsBun(pkg.scripts[n]!));
      if (instead === undefined) {
        return {
          plan: null,
          detected: null,
          unrunnable: true,
          reason:
            `The \`${script}\` script runs \`${pkg.scripts[script]!.slice(0, 80)}\`, which needs ` +
            'the Bun runtime. DevLaunch runs Node 20 and 22 and ships no Bun, so no plan it ' +
            'can make starts this project.',
          remedy:
            'Run it with Bun directly, or give it a script that starts under Node — for a Vite ' +
            'app, `vite` rather than `bunx --bun vite`. Running Bun here would need an approved ' +
            'Bun image, which DevLaunch does not have.',
          warnings,
        };
      }
      warnings.push(`The \`${script}\` script runs Bun, which DevLaunch does not ship; starting \`${instead}\` instead.`);
      script = instead;
    }

    if (!script) {
      const entry = pkg.entryFiles?.[0];

      // A package that builds something for other packages to import. Its scripts
      // compile and test; none of them starts anything, and there is no entry file to
      // start either. `main: dist/index.js` is the giveaway — it names an artefact that
      // does not exist until a build runs, for a consumer rather than for a person.
      if (!entry && looksLikeALibrary(pkg)) {
        return {
          plan: null,
          detected: null,
          unrunnable: true,
          reason:
            `This package is a library, not an application: its scripts are ` +
            `${Object.keys(pkg.scripts).join(', ') || 'absent'}, none of which starts a ` +
            `server, and \`main\` points at ${pkg.main} — a build artefact for another ` +
            'package to import. There is nothing here to open in a browser.',
          warnings,
        };
      }

      if (!framework) return null;
      if (!entry) {
        warnings.push(
          `Detected ${framework.id} but found none of its expected scripts ` +
            `(${framework.scripts.join(', ')}).`,
        );
        return null;
      }
      // A framework with no start script is the commonest shape of a tutorial repository,
      // and `node app.js` is what its README says. Falling to the AI for that was a
      // model call to read a filename — and the model got the port and binding wrong.
      warnings.push(
        `Detected ${framework.id} with no ${framework.scripts.join('/')} script; ` +
          `starting its entry file ${entry} directly.`,
      );
      const port = portFor(framework, meta);
      return {
        detected: framework.id,
        warnings,
        plan: RunPlanSchema.parse({
          runtime: { language: 'node', version: nodeVersion },
          packageManager: pm,
          installCommand: install.installCommand,
          buildCommand: null,
          // Through the manager when it is the only thing that can resolve the
          // dependencies. See `needsManagerToResolve`.
          startCommand: needsManagerToResolve(pkg.packageManager)
            ? `yarn node ${entry}`
            : `node ${entry}`,
          workingDirectory,
          expectedPort: port,
          // The file binds whatever it binds; nothing here forces 0.0.0.0. The verifier
          // reads the truth off the socket table and names it if it is loopback.
          hostBinding: 'unknown',
          environmentVariables: [
            { key: 'HOST', value: '0.0.0.0', required: false },
            { key: 'PORT', value: String(port), required: false },
            ...bindHostEnv(meta),
          ],
          healthCheck: { path: healthPathFor(meta), method: 'GET', expectedStatusCodes: [200, 204, 302, 304] },
          planSource: 'rule-based',
        }),
      };
    }

    const port = portFor(framework, meta);
    const args = framework ? bindingArgs(framework, port, meta.angularDevServer) : [];
    const startCommand = runScript(pm, script, args);

    const env: EnvVar[] = [
      { key: 'HOST', value: '0.0.0.0', required: false },
      { key: 'PORT', value: String(port), required: false },
      ...bindHostEnv(meta),
    ];
    if (framework?.id === 'cra') {
      // CRA opens a browser on start, which inside a container just wastes time.
      env.push({ key: 'BROWSER', value: 'none', required: false });
      // And from react-scripts 3.4.1 it closes the dev server when stdin ends — unless
      // CI=true. A container has no stdin, so the server printed "Starting the
      // development server..." and exited 0, and the run was reported COMPLETED. CI=true
      // changes nothing else about `start`; it makes `build` treat warnings as errors,
      // which a dev-server plan never runs.
      env.push({ key: 'CI', value: 'true', required: false });
    }
    if (framework?.note) warnings.push(framework.note);

    return {
      detected: framework?.id ?? 'node',
      warnings,
      plan: RunPlanSchema.parse({
        runtime: { language: 'node', version: nodeVersion },
        packageManager: pm,
        installCommand: install.installCommand,
        // Dev servers build on the fly; a separate build step would only slow start-up.
        buildCommand: null,
        startCommand,
        workingDirectory,
        expectedPort: port,
        hostBinding: framework ? (framework.binding ?? 'forced') : 'unknown',
        environmentVariables: env,
        healthCheck: { path: healthPathFor(meta), method: 'GET', expectedStatusCodes: [200, 204, 302, 304] },
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
    // "Nothing to install" and "no idea how to install" are different answers, and
    // collapsing them threw away a plannable project: a pyproject that declares no
    // dependencies still says how to start, and there is simply nothing to fetch first.
    // Declaring nothing is not the same as being unplannable. A project whose entry file
    // imports Flask has said what it needs; it simply said it in Python rather than in a
    // manifest. Only a project that declares nothing *and* imports nothing third-party
    // is genuinely beyond a rule here.
    const fromImports = declarableImports(py);
    if (py.requirements.length === 0 && !py.hasPyproject && fromImports.length === 0) {
      warnings.push(
        py.hasPipfile
          ? 'Pipfile-only projects are not supported by the rule-based planner.'
          : 'No requirements.txt or pyproject.toml found.',
      );
      return null;
    }

    const detected = detectPythonInstall(py);
    warnings.push(...detected.notes);
    let install: string | null = detected.installCommand;
    // Filled in below, once the framework — and its runner — are known.
    const installFromImports = detected.source === 'from-imports';

    // Both manifests, because a packaged project declares its framework only in
    // pyproject.toml — and read from requirements.txt alone it declared nothing, planned
    // as nothing, and fell through to a guess.
    const requirementNames = [
      ...py.requirements.map((r) => r.split(/[<>=!~[\s]/)[0]!.trim().toLowerCase()),
      ...(py.dependencies ?? []),
      ...fromImports.map((d) => d.toLowerCase()),
    ].filter(Boolean);
    const signal = Object.keys(PYTHON_REQUIREMENT_SIGNALS).find((k) => requirementNames.includes(k));

    // manage.py is definitive and outranks anything requirements.txt merely mentions.
    // Otherwise a file that imports the framework outranks a dependency list that only
    // mentions it: a repository can depend on Flask and be started by Streamlit.
    const imported = py.entryCandidates.find((e) => e.framework)?.framework ?? null;
    const kind = py.hasManagePy ? 'django' : (imported ?? signal ?? null);

    if (!kind) return null;

    const fw = PYTHON_FRAMEWORKS[kind];
    if (!fw) return null;
    if (fw.note) warnings.push(fw.note);

    // Said before the run, like a hardcoded bind address and for the same reason: there
    // is nothing DevLaunch can set, and the failure it produces — `connection to server
    // at "localhost" (::1), port 5432 failed` — is accurate and explains nothing.
    if (py.hardcodedDatabaseUrl) {
      warnings.push(
        `${py.hardcodedDatabaseUrl.file} hardcodes a database URL pointing at localhost ` +
          `(\`${py.hardcodedDatabaseUrl.url.slice(0, 80)}\`). Inside a container that is ` +
          'this application, not a database. Read the URL from an environment variable ' +
          'and DevLaunch will provision one and fill it in. ' +
          (config.rewriteSource
            ? 'DEVLAUNCH_REWRITE_SOURCE is set, so DevLaunch will point that line at the ' +
              'database it starts; your checkout is untouched.'
            : 'Or set DEVLAUNCH_REWRITE_SOURCE=1 to have DevLaunch point that line at the ' +
              'database it starts; your checkout is untouched.'),
      );
    }

    // The framework is known now, so the install list can include the thing that starts
    // it. `uvicorn main:app` is run by uvicorn, and nothing in a FastAPI project's source
    // imports it: the install was otherwise complete and the run died on
    // `sh: 1: uvicorn: not found`.
    if (installFromImports) {
      const packages = [...fromImports];
      if (fw.runner && !packages.some((d) => d.toLowerCase() === fw.runner)) {
        packages.push(fw.runner);
      }
      install = `pip install ${packages.join(' ')}`;
      warnings.push(
        `No requirements.txt or pyproject.toml, so the ${packages.length} distribution(s) ` +
          `its source imports are installed instead: ${packages.join(', ')}. ` +
          'Versions are not pinned, because the repository pinned none.',
      );
    }

    // An extra the source proves it needs, appended whatever the manifest says.
    //
    // `pip install -r requirements.txt sqlalchemy[asyncio]` is not a contradiction of
    // the file: pip merges the two requirements for the same distribution, so a pin in
    // requirements.txt still decides the version and the extra only adds what the extra
    // adds. Which is the whole safety argument — the repository keeps every decision it
    // made, and gains only the one it did not know it had to make.
    //
    // Appended rather than substituted because the manifest may name the distribution in
    // a form this has no business rewriting: a pin, a marker, a URL.
    const implied = (py.impliedRequirements ?? []).filter(
      (r) => install !== null && !new RegExp(`(?:^|\\s)${r.requirement}(?:$|[\\s<>=!~])`).test(install),
    );
    if (implied.length > 0 && install !== null) {
      install = `${install} ${implied.map((r) => r.requirement).join(' ')}`;
      for (const r of implied) {
        warnings.push(
          `Installing ${r.requirement} as well: the source imports ${r.because}, which ` +
            'does not work without it, and the manifest does not ask for it. Everything ' +
            'the manifest does say is unchanged, including its versions.',
        );
      }
    }

    // A file that imports the framework, or failing that one *named* like an entry
    // point. Not simply the first candidate: the scan deliberately reads every top-level
    // `.py` file so a Streamlit dashboard called `dashboard.py` is found, and one
    // repository's only top-level module is `tests.py` — which was duly started as
    // `FLASK_APP=tests`, and then as `FLASK_APP=app` by a model asked to guess again.
    const entry = py.entryCandidates.find((e) => e.framework === kind)
      ?? py.entryCandidates.find((e) => e.conventional !== false && e.file !== 'manage.py');
    // Inside a package the file path is not the import path: `src/pg_rag/main.py` runs
    // as `pg_rag.main` once installed, and only as that.
    const moduleName = entry?.module ?? entry?.file.replace(/\.py$/, '');

    // The step between installing and starting. A schema-creation script the author
    // documented is exactly what this slot is for, and without it the application runs
    // and answers 500 to everything.
    // The entry may live one level down, in a directory that is not a package — and its
    // own imports only resolve from there. The install stays where the manifest is.
    const runDir = entry?.dir ? joinPath(workingDirectory, entry.dir) : workingDirectory;
    const installDirectory = runDir === workingDirectory ? null : workingDirectory;
    if (entry?.dir) {
      warnings.push(
        `Starting from ${runDir}: ${entry.file} lives there and imports its siblings by ` +
          'bare name, which only resolves with that directory as the working directory. ' +
          `Dependencies are still installed from ${workingDirectory}.`,
      );
    }

    const initScript = (py.initScripts ?? []).find((f) => f !== entry?.file);
    if (initScript) {
      warnings.push(`Running ${initScript} before start: it creates the database schema this application expects.`);
    }

    const env: EnvVar[] = [];
    let startCommand: string;
    // The step between installing and starting, when the framework has one of its own.
    let frameworkBuild: string | null = null;

    switch (kind) {
      case 'django':
        startCommand = `python manage.py runserver 0.0.0.0:${fw.defaultPort}`;
        // Every Django README says to run this before the server, and it is the same
        // command for every Django project there has ever been. Without it the server
        // starts, prints "You have N unapplied migration(s)" to a log nobody reads, and
        // then returns 500 from the first page that touches the database — which reads
        // as DevLaunch having broken the project rather than having skipped a step.
        frameworkBuild = 'python manage.py migrate --noinput';
        break;

      case 'flask': {
        if (!moduleName) return null;
        // FLASK_APP works across Flask versions; `flask --app` only from 2.2 onward.
        // A factory is named when there is no module-level app to find: `module:factory`
        // has meant "call this" since Flask 1.0, and it says what runs rather than relying
        // on discovery.
        const target = entry?.appFactory && !entry.appVariable ? `${moduleName}:${entry.appFactory}` : moduleName;
        env.push({ key: 'FLASK_APP', value: target, required: false });
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
        // The file that imports streamlit, not a conventional name. One repository's
        // program is `dashboard.py`; `streamlit run app.py` failed with
        // `Invalid value: File does not exist`, and a model then guessed `src/app.py`.
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
        // A schema script the author named beats the framework's own step: it is
        // specific to this repository, where `manage.py migrate` is specific to Django.
        // Only one can run, and the repository's own is the more informed of the two.
        buildCommand: initScript ? `python ${initScript}` : frameworkBuild,
        startCommand,
        workingDirectory: runDir,
        ...(installDirectory ? { installDirectory } : {}),
        expectedPort: fw.defaultPort,
        hostBinding: 'forced',
        environmentVariables: env,
        healthCheck: { path: healthPathFor(meta), method: 'GET', expectedStatusCodes: [200, 204, 302, 304] },
        planSource: 'rule-based',
      }),
    };
  }
}

/**
 * Which path to check readiness on.
 *
 * `/` unless the application declares routes and none of them is `/` — then the first
 * parameter-free GET it declares. An API answering 404 at `/` is running, and the check
 * already tolerates that; but a check that hits a real route sees a real answer, and
 * reports a mismatch only when there is one.
 */
/**
 * Which port to watch.
 *
 * A framework whose flags settle the question keeps its default: DevLaunch passes
 * `--port` on the command line and the application obeys, so the number it was given is
 * the number it opens. A framework that binds through the environment cannot be made to
 * obey — `app.listen(8017)` ignores `PORT` entirely — so what the source says wins
 * there, and a repository that hardcodes its port is planned on the port it hardcodes
 * rather than on a default it will never use.
 */
export function portFor(
  framework: NodeFramework | undefined,
  meta: RepositoryMetadata,
): number {
  const fallback = framework?.defaultPort ?? 3000;
  if (framework && framework.argStyle !== 'env') return fallback;
  return meta.declaredPort ?? fallback;
}

export function healthPathFor(meta: RepositoryMetadata): string {
  const routes = meta.httpRoutes ?? [];
  if (routes.length === 0) return '/';
  const gets = routes.filter((r) => r.method === 'GET');
  if (gets.some((r) => r.path === '/')) return '/';
  const concrete = gets.filter((r) => !/[:{}<>*]/.test(r.path)).sort((a, b) => a.path.length - b.path.length);
  return concrete[0]?.path ?? '/';
}

/**
 * How to install a project whose dependencies live in pyproject.toml.
 *
 * `pip install .` when the project is a buildable distribution. When it is not — an
 * ordinary application laid out flat, which setuptools refuses to auto-discover — the
 * dependencies are still declared and still installable, so they are installed by name
 * and the project is left where it is. It is run from its source directory anyway.
 *
 * By name, without version specifiers, because the command allowlist permits no quotes,
 * `>` or `[`: `fastapi[standard]>=0.115` cannot be written as a command argument at all.
 * The constraint is worth stating plainly rather than silently resolving to latest.
 */
/**
 * Imports safe to hand to `pip install`.
 *
 * Names only, and only well-formed ones: the command allowlist permits no quotes or
 * comparison operators, so anything unusual cannot be written as an argument at all.
 * The cap is there because a plan that installs forty packages read out of a script is
 * no longer a plan, it is a guess with a long tail.
 */
function declarableImports(py: PythonSummary): string[] {
  return (py.imports ?? []).filter((d) => /^[a-z0-9][a-z0-9._-]*$/i.test(d)).slice(0, 12);
}

