import {
  FailureCode,
  type FailureDetail,
  type RepairRecord,
  type RepositoryMetadata,
  type RunPlan,
} from '@devlaunch/shared';
import { RunPlanValidator } from './RunPlanValidator.js';
import { APPROVED_IMAGES } from '../security/ImageAllowlist.js';
import { distributionForModule } from '../analysis/pythonImports.js';

/**
 * Repairs a rule can make from evidence, before a model is asked anything.
 *
 * The AI repair loop was the first and only responder to every failure, and its record
 * on the failures here was poor for a specific reason: a model shown a log guesses at a
 * plan, and its guesses do not converge. A rule shown the same log does not guess. "The
 * start script does not exist and `dev` does" is not a hypothesis; it is what the
 * manifest says. "Uvicorn running on :8080 while the plan expects 8000" is in the log
 * verbatim.
 *
 * Every rule here requires its evidence to be present and quotes it in the record it
 * returns. A rule with no evidence returns nothing, and the caller moves on. That is the
 * property that makes this safe to run first: it cannot invent, so it cannot make a
 * failure worse the way an invented connection string did.
 */

export interface DeterministicRepairInput {
  plan: RunPlan;
  failure: FailureDetail;
  metadata: RepositoryMetadata;
  /** The session log, most recent last. */
  logs: string;
  /** Plans already tried, so a rule never proposes one of them again. */
  previousAttempts: readonly RunPlan[];
}

export interface DeterministicRepair {
  plan: RunPlan;
  record: RepairRecord;
}

/** Identity of the mutable surface, the same one the AI path is checked against. */
function signature(plan: RunPlan): string {
  return JSON.stringify([
    plan.installCommand,
    plan.buildCommand,
    plan.startCommand,
    plan.expectedPort,
    plan.runtime,
    plan.healthCheck.path,
    [...plan.environmentVariables].sort((a, b) => a.key.localeCompare(b.key)),
  ]);
}

const SCRIPT_PREFERENCE = ['dev', 'start', 'serve', 'develop', 'start:dev'];

/** Python console scripts that also run as `python -m`, when they are not on PATH. */
const PYTHON_MODULES = ['uvicorn', 'flask', 'gunicorn', 'streamlit', 'fastapi'];

const LISTENING = [
  /Uvicorn running on https?:\/\/[\w.:-]+:(\d{2,5})/i,
  /Running on https?:\/\/[\w.:-]+:(\d{2,5})/i, // Flask
  /Local:\s+https?:\/\/[\w.:-]+:(\d{2,5})/i, // Vite, CRA, Next
  // The host part is optional *and* may be bare. `running at localhost:8017/` is what
  // one real repository prints, and requiring `http://` in front of the host meant no
  // pattern matched it at all.
  /(?:listening|started|running) (?:on|at) (?:port\s+)?(?:https?:\/\/)?(?:[\w.-]+:)?(\d{2,5})\b/i,
  /listening on port (\d{2,5})/i,
];

export function tryDeterministicRepair(input: DeterministicRepairInput): DeterministicRepair | null {
  const rule = RULES.find((r) => r.applies(input.failure.code));
  const candidates = RULES.filter((r) => r.applies(input.failure.code));
  if (!rule) return null;

  const validator = new RunPlanValidator();
  const seen = new Set([input.plan, ...input.previousAttempts].map(signature));

  for (const candidate of candidates) {
    const proposal = candidate.propose(input);
    if (!proposal) continue;

    // The same gate every plan passes, whatever produced it. A rule that proposes a
    // command the allowlist refuses has proposed nothing.
    const checked = validator.check({ plan: proposal.plan });
    if (!checked.ok) continue;

    // Progress is enforced here, not trusted to the rule: a repair identical to a plan
    // already tried is the definition of a wasted attempt.
    if (seen.has(signature(checked.plan))) continue;

    return { plan: checked.plan, record: proposal.record };
  }
  return null;
}

interface Rule {
  applies(code: FailureCode): boolean;
  propose(input: DeterministicRepairInput): DeterministicRepair | null;
}

const RULES: readonly Rule[] = [
  // --- the start script does not exist, and another does ------------------------
  {
    applies: (c) => c === FailureCode.START_COMMAND_FAILED,
    propose: ({ plan, metadata, failure }) => {
      const missing = /Missing script:\s*["']?([\w:.-]+)["']?/i.exec(plan.startCommand ? failure.evidence ?? '' : '')
        ?? /Missing script:\s*["']?([\w:.-]+)["']?/i.exec(failure.message);
      const scripts = metadata.packageJson?.scripts ?? {};
      if (!missing || !Object.keys(scripts).length) return null;

      const alternative = SCRIPT_PREFERENCE.find((s) => s !== missing[1] && s in scripts);
      if (!alternative) return null;

      const runner = /^(npm|pnpm|yarn)\b/.exec(plan.startCommand)?.[1] ?? 'npm';
      const startCommand = `${runner} run ${alternative}`;
      return {
        plan: { ...plan, startCommand },
        record: {
          source: 'deterministic',
          type: 'START_COMMAND_CORRECTION',
          failureCode: FailureCode.START_COMMAND_FAILED,
          before: { startCommand: plan.startCommand },
          after: { startCommand },
          evidence: [
            `package.json: scripts.${missing[1]} absent; scripts.${alternative} exists`,
          ],
          confidence: 'high',
        },
      };
    },
  },

  // --- pip was asked to build a project that is not a package ------------------------
  {
    applies: (c) => c === FailureCode.DEPENDENCY_INSTALL_FAILED,
    propose: ({ plan, failure, logs, metadata }) => {
      const refusal = /Multiple top-level (?:packages|modules) discovered in a flat-layout[^\n]*/i;
      const found = [failure.evidence ?? '', failure.message, logs.slice(-4000)]
        .map((t) => refusal.exec(t))
        .find((m): m is RegExpExecArray => m !== null);
      if (!found || !/pip install\s+(?:-e\s+)?\.\s*$/.test(plan.installCommand ?? '')) return null;

      // The dependencies are declared; only the project is unbuildable. Names only:
      // the command allowlist permits no `>` or quotes, so a specifier cannot be written.
      const py = metadata.python;
      const deps = (py?.runtimeDependencies ?? py?.dependencies ?? []).filter((d) => /^[a-z0-9][a-z0-9._-]*$/i.test(d));
      if (deps.length === 0) return null;

      const installCommand = `pip install ${deps.join(' ')}`;
      return {
        plan: { ...plan, installCommand },
        record: {
          source: 'deterministic',
          type: 'START_COMMAND_CORRECTION',
          failureCode: FailureCode.DEPENDENCY_INSTALL_FAILED,
          before: { installCommand: plan.installCommand },
          after: { installCommand },
          evidence: [
            found[0].slice(0, 160),
            `pyproject.toml declares ${deps.length} dependencies, which install without building the project`,
          ],
          confidence: 'high',
        },
      };
    },
  },

  // --- psycopg2 cannot build; its maintainers publish a wheel under another name ------
  //
  // The error states the remedy itself: "If you prefer to avoid building psycopg2 from
  // source, please install the PyPI 'psycopg2-binary' package instead." Nothing is
  // inferred here beyond acting on a sentence the tool printed.
  {
    applies: (c) => c === FailureCode.DEPENDENCY_INSTALL_FAILED,
    propose: ({ plan, failure, logs, metadata }) => {
      const needsConfig = /pg_config executable not found/i;
      const found = [failure.evidence ?? '', failure.message, logs.slice(-6000)].some((t) =>
        needsConfig.test(t),
      );
      if (!found) return null;
      if (!/^pip install\s+-r\s+requirements\.txt\s*$/.test((plan.installCommand ?? '').trim())) {
        return null;
      }

      const requirements = metadata.python?.requirements ?? [];
      const args = requirementsAsArguments(requirements, { psycopg2: 'psycopg2-binary' });
      if (!args) return null;

      const evidence = [
        'pip: `pg_config is required to build psycopg2 from source`, and its own error ' +
          'recommends the `psycopg2-binary` wheel instead',
      ];

      // The substitution is not always the whole story. One repository already declares
      // `psycopg2-binary==2.9.5` — and 2.9.5 predates Python 3.12, so no wheel matches,
      // pip falls back to the source distribution, and the same `pg_config` error
      // appears. There the pin is the cause, and unpinning that one package is the only
      // change that reaches it.
      const stuck = pinnedButUnbuildable(args, logs, failure);
      const finalArgs = stuck ? args.map((a) => (a === stuck.pinned ? stuck.name : a)) : args;
      if (stuck) {
        evidence.push(
          `${stuck.pinned} has no wheel for this interpreter, so pip built it from ` +
            `source; installing ${stuck.name} unpinned instead`,
        );
      }

      // Installing the same list under a different spelling is not a repair: it re-runs
      // the identical resolution and fails identically, having spent one of two attempts.
      const unchanged = requirementsAsArguments(requirements, {});
      if (!stuck && unchanged?.join(' ') === finalArgs.join(' ')) return null;

      const installCommand = `pip install ${finalArgs.join(' ')}`;
      if (installCommand === plan.installCommand) return null;

      return {
        plan: { ...plan, installCommand },
        record: {
          source: 'deterministic',
          type: 'START_COMMAND_CORRECTION',
          failureCode: FailureCode.DEPENDENCY_INSTALL_FAILED,
          before: { installCommand: plan.installCommand },
          after: { installCommand },
          evidence: [
            ...evidence,
            `requirements.txt installed by name (${finalArgs.length} packages)`,
          ],
          confidence: 'high',
        },
      };
    },
  },

  // --- a package the application imports is missing, and the error names it -----------
  //
  // Two cases, and they are not the same evidence.
  //
  // A list DevLaunch composed from a project's imports is a good prediction and an
  // incomplete one: nothing in a FastAPI project imports `python-multipart`, and the
  // first request to a form route raises `Form data requires "python-multipart" to be
  // installed.` A model was asked to interpret that — a sentence naming a package.
  //
  // This rule first refused to touch a `-r requirements.txt` install, on the reasoning
  // that a repository which declared its own dependencies owns the gaps in them. That is
  // right about *whose bug it is* and wrong about what DevLaunch can see. One repository
  // imports `flasgger` in its application and lists Flask, Werkzeug, requests and pytest
  // in requirements.txt. The import is a declaration too, and it is the one that decides
  // whether the program runs. So a declared list is extended as well — but only by a
  // module the project's own source imports, never by a name read out of a log alone.
  {
    applies: (c) => c === FailureCode.START_COMMAND_FAILED || c === FailureCode.BUILD_FAILED,
    propose: ({ plan, failure, logs, metadata }) => {
      const install = plan.installCommand ?? '';
      const composed = /^pip install (?!-)[A-Za-z0-9][\w.=-]*(?: [A-Za-z0-9][\w.=-]*)*$/.test(install);
      const declared = /^pip install\s+-r\s+requirements\.txt\s*$/.test(install.trim());
      if (!composed && !declared) return null;

      const text = `${failure.evidence ?? ''}\n${failure.message}\n${logs.slice(-6000)}`;
      const named = missingDistribution(text);
      if (!named) return null;

      // The stricter gate for a list the repository wrote: the source has to import it.
      if (declared) {
        const imports = (metadata.python?.imports ?? []).map((d) => d.toLowerCase());
        if (!imports.includes(named.distribution.toLowerCase())) return null;
      }

      const already = install.slice('pip install '.length).split(/\s+/).map((a) => a.split('==')[0]!.toLowerCase());
      if (already.includes(named.distribution.toLowerCase())) return null;
      // A requirements file may already pin it under a name the error spells differently;
      // installing it twice is harmless, installing it against a pin is not.
      if (declared && (metadata.python?.requirements ?? []).some((r) => r.toLowerCase().startsWith(named.distribution.toLowerCase()))) {
        return null;
      }

      const installCommand = `${install} ${named.distribution}`;
      return {
        plan: { ...plan, installCommand },
        record: {
          source: 'deterministic',
          type: 'START_COMMAND_CORRECTION',
          failureCode: failure.code,
          before: { installCommand: install },
          after: { installCommand },
          evidence: [
            named.quote,
            declared
              ? `requirements.txt does not list it, and this project's own source imports it`
              : "the install list was composed from this project's imports, which do not name it",
          ],
          confidence: 'high',
        },
      };
    },
  },

  // --- a Python console script is not on PATH; the module is -------------------------
  {
    applies: (c) => c === FailureCode.START_COMMAND_FAILED,
    propose: ({ plan, failure, logs }) => {
      const first = plan.startCommand.trim().split(/\s+/)[0] ?? '';
      if (!PYTHON_MODULES.includes(first)) return null;
      const notFound = new RegExp(`\\b${first}\\b.*(?:command not found|not found|No such file)`, 'i');
      const evidence = [failure.evidence ?? '', failure.message, logs.slice(-2000)].find((t) => notFound.test(t));
      if (!evidence && failure.exitCode !== 127) return null;

      const startCommand = `python -m ${plan.startCommand.trim()}`;
      return {
        plan: { ...plan, startCommand },
        record: {
          source: 'deterministic',
          type: 'START_COMMAND_CORRECTION',
          failureCode: FailureCode.START_COMMAND_FAILED,
          before: { startCommand: plan.startCommand },
          after: { startCommand },
          evidence: [
            evidence ? evidence.match(notFound)![0].slice(0, 160) : `exit code 127: ${first} is not on PATH`,
            `${first} is installed as a module and runs as python -m ${first}`,
          ],
          confidence: 'high',
        },
      };
    },
  },

  // --- the runtime is too old, and a newer one is approved -------------------------------
  //
  // The planner already chooses a version from what the repository declares, so reaching
  // here means the declaration was missing or was one it does not recognise — a built-in
  // newer than the table knows about, say. The error names the module, the allowlist
  // names the versions, and moving between them is arithmetic rather than judgement. A
  // model is never asked: it cannot add an image, so its answer is bounded by the same
  // list a rule can read directly.
  {
    applies: (c) => c === FailureCode.WRONG_RUNTIME_VERSION,
    propose: ({ plan, failure, logs }) => {
      // A newer image is the answer to a runtime that is too old, and only to that.
      if (failure.runtimeDirection === 'older') return null;
      const next = nextApprovedVersion(plan.runtime.language, plan.runtime.version);
      if (!next) return null;

      const named =
        /No such built-in module: (node:[a-z_]+)/.exec(`${failure.evidence ?? ''}\n${logs.slice(-4000)}`)?.[1];
      return {
        plan: { ...plan, runtime: { ...plan.runtime, version: next } },
        record: {
          source: 'deterministic',
          type: 'START_COMMAND_CORRECTION',
          failureCode: FailureCode.WRONG_RUNTIME_VERSION,
          before: { runtimeVersion: plan.runtime.version },
          after: { runtimeVersion: next },
          evidence: [
            named
              ? `${named} does not exist in ${plan.runtime.language} ${plan.runtime.version}`
              : failure.message.slice(0, 160),
            `${next} is the next approved ${plan.runtime.language} image`,
          ],
          confidence: 'high',
        },
      };
    },
  },

  // --- the kernel says which port it opened ---------------------------------------------
  //
  // Placed before the log-reading rule because it is better evidence of the same fact.
  // A log line is what the application *claims*; `/proc/net/tcp` inside its own
  // container is what it did. One real repository prints `I am running at
  // localhost:8017/`, which no listening pattern matches and which a model was asked to
  // interpret — twice, wrongly. The socket table needs no interpretation.
  {
    applies: (c) => c === FailureCode.PORT_NOT_LISTENING || c === FailureCode.PORT_BOUND_TO_LOCALHOST,
    propose: ({ plan, failure }) => {
      const socket = failure.observedSocket;
      if (!socket || socket.port === plan.expectedPort) return null;
      if (!Number.isInteger(socket.port) || socket.port < 1 || socket.port > 65535) return null;

      // Both facts at once when both are true. Correcting the port and leaving the
      // loopback bind spends the second of two attempts rediscovering a problem this
      // one already had the evidence for.
      const environmentVariables = [
        ...plan.environmentVariables.filter((v) => v.key !== 'PORT' && v.key !== 'HOST'),
        { key: 'PORT', value: String(socket.port), required: false },
        { key: 'HOST', value: '0.0.0.0', required: false },
      ];
      const startCommand = plan.startCommand
        .replace(/(--port[= ])(\d{2,5})/i, `$1${socket.port}`)
        .replace(/(-p )(\d{2,5})/, `$1${socket.port}`)
        .replace(/(--host[= ]|-H )(127\.0\.0\.1|localhost)\b/i, '$10.0.0.0');

      return {
        plan: { ...plan, startCommand, expectedPort: socket.port, environmentVariables, hostBinding: 'forced' },
        record: {
          source: 'deterministic',
          type: 'PORT_CORRECTION',
          failureCode: failure.code,
          before: { expectedPort: plan.expectedPort, startCommand: plan.startCommand },
          after: { expectedPort: socket.port, startCommand },
          evidence: [
            `the container's socket table shows ${socket.address}:${socket.port} listening, ` +
              `not ${plan.expectedPort}`,
          ],
          confidence: 'high',
        },
      };
    },
  },

  // --- the application opened a different port than the plan expects --------------------
  {
    applies: (c) => c === FailureCode.PORT_NOT_LISTENING,
    propose: ({ plan, logs }) => {
      const tail = logs.slice(-4000);
      let match: RegExpExecArray | null = null;
      for (const re of LISTENING) {
        match = re.exec(tail);
        if (match) break;
      }
      if (!match) return null;
      const port = Number(match[1]);
      if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === plan.expectedPort) return null;

      const environmentVariables = [
        ...plan.environmentVariables.filter((v) => v.key !== 'PORT'),
        { key: 'PORT', value: String(port), required: false },
      ];
      return {
        plan: { ...plan, expectedPort: port, environmentVariables },
        record: {
          source: 'deterministic',
          type: 'PORT_CORRECTION',
          failureCode: FailureCode.PORT_NOT_LISTENING,
          before: { expectedPort: plan.expectedPort },
          after: { expectedPort: port },
          evidence: [`log: ${match[0].slice(0, 160)}`],
          confidence: 'high',
        },
      };
    },
  },

  // --- bound to loopback: the fix is known and the same every time ----------------------
  {
    applies: (c) => c === FailureCode.PORT_BOUND_TO_LOCALHOST,
    propose: ({ plan, failure }) => {
      const hasHost = plan.environmentVariables.some((v) => v.key === 'HOST' && v.value === '0.0.0.0');
      const startCommand = plan.startCommand.replace(/(--host[= ]|-H )(127\.0\.0\.1|localhost)\b/i, '$10.0.0.0');
      if (hasHost && startCommand === plan.startCommand) return null;

      const environmentVariables = [
        ...plan.environmentVariables.filter((v) => v.key !== 'HOST'),
        { key: 'HOST', value: '0.0.0.0', required: false },
      ];
      return {
        plan: { ...plan, startCommand, environmentVariables, hostBinding: 'forced' },
        record: {
          source: 'deterministic',
          type: 'HOST_BINDING_CORRECTION',
          failureCode: FailureCode.PORT_BOUND_TO_LOCALHOST,
          before: { startCommand: plan.startCommand, HOST: plan.environmentVariables.find((v) => v.key === 'HOST')?.value ?? null },
          after: { startCommand, HOST: '0.0.0.0' },
          evidence: [failure.message.slice(0, 160)],
          confidence: 'high',
        },
      };
    },
  },

  // --- the root 404s on a framework whose docs page is a known, explicit path ------------
  {
    applies: (c) => c === FailureCode.APPLICATION_UNHEALTHY || c === FailureCode.READINESS_TIMEOUT,
    propose: ({ plan, logs }) => {
      if (plan.healthCheck.path !== '/') return null;
      const isFastapi = /\buvicorn\b|\bfastapi\b/.test(plan.startCommand);
      if (!isFastapi) return null;
      const notFound = /"GET \/ HTTP\/1\.[01]" 404/.exec(logs.slice(-4000));
      if (!notFound) return null;

      const healthCheck = { ...plan.healthCheck, path: '/docs' };
      return {
        plan: { ...plan, healthCheck },
        record: {
          source: 'deterministic',
          type: 'HEALTHCHECK_CORRECTION',
          failureCode: FailureCode.APPLICATION_UNHEALTHY,
          before: { healthCheckPath: '/' },
          after: { healthCheckPath: '/docs' },
          evidence: [`log: ${notFound[0]}`, 'FastAPI serves its interactive docs at /docs'],
          confidence: 'medium',
        },
      };
    },
  },
];

/**
 * A requirements file rewritten as arguments to `pip install`, with substitutions.
 *
 * Needed because a substitution cannot be made any other way: the file is the
 * repository's, and `-r requirements.txt` will always install what it says. Installing
 * the same list by name is the same install with one entry changed.
 *
 * Returns null rather than an approximation whenever a line cannot be reproduced
 * faithfully — a URL, a VCS reference, an `-e .`, another `-r`, an environment marker.
 * Dropping one of those silently would install a different set of packages than the
 * repository asked for and call it a repair.
 *
 * `==` survives because the command allowlist permits it. `>=` and `<` do not, so a
 * range collapses to the bare name, which is stated in the caller's evidence rather
 * than hidden.
 */
export function requirementsAsArguments(
  requirements: readonly string[],
  substitutions: Readonly<Record<string, string>>,
): string[] | null {
  const out: string[] = [];

  for (const raw of requirements) {
    const line = raw.split(/\s+#/)[0]!.trim();
    if (line === '') continue;
    // Flags, includes, editable installs, direct URLs and markers: not reproducible.
    if (/^-|[;@]|:\/\//.test(line)) return null;

    const parsed = /^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]+\])?\s*(.*)$/.exec(line);
    if (!parsed) return null;
    // An extra cannot be written at all: the allowlist permits no brackets.
    if (parsed[2]) return null;

    const name = substitutions[parsed[1]!.toLowerCase()] ?? parsed[1]!;
    const rest = parsed[3]!.trim();
    const pinned = /^==\s*([A-Za-z0-9][A-Za-z0-9._+-]*)$/.exec(rest);

    // A pin is only carried over when the distribution itself is unchanged: psycopg2's
    // versions are not psycopg2-binary's to assume.
    if (pinned && name === parsed[1]) out.push(`${name}==${pinned[1]}`);
    else out.push(name);
  }

  return out.length > 0 ? out : null;
}

/**
 * A pinned requirement that pip had to build from source, and the pin that forced it.
 *
 * Pip prefers a wheel and only builds when none matches the interpreter, so a source
 * build of a pinned package means the pinned version predates this Python. Unpinning
 * that one package is the only change that reaches it — and it is a change with a
 * consequence, so the caller states it rather than making it quietly.
 *
 * The distribution is read out of pip's own output rather than guessed at, and it has to
 * appear in the repository's requirements for the match to count. No name, no repair.
 */
function pinnedButUnbuildable(
  args: readonly string[],
  logs: string,
  failure: FailureDetail,
): { name: string; pinned: string } | null {
  const text = `${failure.evidence ?? ''}\n${failure.message}\n${logs.slice(-12_000)}`;
  const named =
    /Could not build wheels for ([A-Za-z0-9][A-Za-z0-9._-]*)/i.exec(text) ??
    /Building wheel for ([A-Za-z0-9][A-Za-z0-9._-]*)/i.exec(text) ??
    /writing ([A-Za-z0-9][A-Za-z0-9._-]*)\.egg-info/i.exec(text);
  if (!named) return null;

  // `psycopg2_binary.egg-info` is `psycopg2-binary` on PyPI; setuptools writes the
  // normalised form with underscores.
  const wanted = named[1]!.toLowerCase().replace(/_/g, '-');
  const pinned = args.find((a) => {
    const [name, version] = a.split('==');
    return version !== undefined && name!.toLowerCase().replace(/_/g, '-') === wanted;
  });
  if (!pinned) return null;

  return { name: pinned.split('==')[0]!, pinned };
}

/**
 * A distribution a Python error says is missing, with the line that said so.
 *
 * Two shapes, both of which name the package outright. The first is a library telling
 * you what to install — `Form data requires "python-multipart" to be installed.` The
 * second is the interpreter naming an import, which is a module name and therefore needs
 * translating for the handful of cases where the two differ.
 */
function missingDistribution(text: string): { distribution: string; quote: string } | null {
  const told =
    /(?:requires|needs) ["'`]?([A-Za-z0-9][A-Za-z0-9._-]*)["'`]? to be installed/i.exec(text) ??
    /(?:pip install|Please install) ["'`]?([A-Za-z0-9][A-Za-z0-9._-]*)["'`]?(?:\s|$|\.)/i.exec(text);
  if (told) return { distribution: told[1]!, quote: told[0]!.slice(0, 160) };

  const imported = /ModuleNotFoundError: No module named ['"]([A-Za-z_][A-Za-z0-9_]*)['"]/.exec(text);
  if (!imported) return null;
  const dist = distributionForModule(imported[1]!);
  return dist ? { distribution: dist, quote: imported[0]!.slice(0, 160) } : null;
}

/**
 * The next approved image version for a language, above the one a plan is using.
 *
 * Ordered numerically by major, because that is what these version strings are — `20`,
 * `22`, `3.12`. Returns nothing when the plan is already on the newest, which is the
 * honest answer: the failure stands and its remedy names what is missing.
 */
export function nextApprovedVersion(
  language: string,
  current: string,
  approved: readonly { language: string; version: string }[] = Object.values(APPROVED_IMAGES),
): string | null {
  const versions = approved
    .filter((image) => image.language === language)
    .map((image) => image.version)
    .sort((a, b) => Number.parseFloat(a) - Number.parseFloat(b));

  // Strictly above, and the *nearest* one. With two Node images "nearest above" and
  // "newest" are the same answer, which is precisely why the list is a parameter: the
  // day a third is approved they stop being the same, and the difference is a version
  // nobody chose running a dependency tree resolved for something else. A rule that
  // cannot be told apart from a wrong one is not being tested.
  return versions.find((v) => Number.parseFloat(v) > Number.parseFloat(current)) ?? null;
}
