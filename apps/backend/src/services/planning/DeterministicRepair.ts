import {
  FailureCode,
  type FailureDetail,
  type RepairRecord,
  type RepositoryMetadata,
  type RunPlan,
} from '@devlaunch/shared';
import { RunPlanValidator } from './RunPlanValidator.js';

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
  /(?:listening|started|running) (?:on|at) (?:port )?(?:https?:\/\/[\w.:-]+:)?(\d{2,5})\b/i,
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
