import { posix } from 'node:path';
import { FailureCode } from '@devlaunch/shared';
import { SecurityRejection } from './ImageAllowlist.js';

/**
 * Reject any path that could escape the workspace.
 *
 * `workingDirectory` arrives from a Run Plan, and an AI-sourced plan is derived from
 * repository text an attacker controls. A value like `../../etc` would otherwise be
 * joined straight onto the workspace root.
 */
export function assertSafeRelativePath(input: string, field = 'workingDirectory'): string {
  if (input.includes('\0')) {
    throw new SecurityRejection(
      FailureCode.PLAN_REJECTED_UNSAFE_COMMAND,
      `${field} contains a null byte.`,
    );
  }

  if (posix.isAbsolute(input) || /^[A-Za-z]:[\\/]/.test(input)) {
    throw new SecurityRejection(
      FailureCode.PLAN_REJECTED_UNSAFE_COMMAND,
      `${field} must be relative, got "${input}".`,
    );
  }

  if (input.includes('\\')) {
    throw new SecurityRejection(
      FailureCode.PLAN_REJECTED_UNSAFE_COMMAND,
      `${field} must use forward slashes, got "${input}".`,
    );
  }

  // Normalise first: "a/../../b" only reveals its escape after resolution.
  const normalised = posix.normalize(input);
  if (normalised === '..' || normalised.startsWith('../')) {
    throw new SecurityRejection(
      FailureCode.PLAN_REJECTED_UNSAFE_COMMAND,
      `${field} escapes the workspace: "${input}".`,
    );
  }

  return normalised === '.' ? '.' : normalised.replace(/\/+$/, '');
}

/** Join a validated relative path onto the container workspace root. */
export function joinWorkspace(root: string, relative: string): string {
  const safe = assertSafeRelativePath(relative);
  const joined = posix.normalize(posix.join(root, safe));
  if (joined !== root && !joined.startsWith(`${root}/`)) {
    throw new SecurityRejection(
      FailureCode.PLAN_REJECTED_UNSAFE_COMMAND,
      `Resolved path "${joined}" escapes workspace root "${root}".`,
    );
  }
  return joined;
}
