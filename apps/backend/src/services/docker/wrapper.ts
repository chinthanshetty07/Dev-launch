import { Sentinel, WrapperExit, type RunPlan } from '@devlaunch/shared';

export const WRAPPER_FILENAME = 'run.sh';

/**
 * The container entrypoint script.
 *
 * Two properties matter here:
 *
 * 1. **Commands arrive through environment variables, never interpolated into the
 *    script body.** The script is byte-identical on every run, so a repository cannot
 *    break out of its intended structure by crafting a command string.
 *
 * 2. **The start command is `exec`d**, so signals reach the application directly and
 *    `docker stop` shuts it down cleanly. That means the container's exit code belongs
 *    to the app, not to this script — which is exactly why the phase sentinels exist.
 *    Exit code alone cannot tell you *which* phase failed; sentinel + code together can.
 *
 * Shell metacharacters inside `$DL_*` are intentionally allowed: real dev scripts chain
 * commands (`tsc && vite build`). The allowlist guards what DevLaunch composes; the
 * container guards what the repository does. See docs/planning-strategy.md.
 */
export function buildWrapperScript(): string {
  return [
    '#!/bin/sh',
    '# DevLaunch container wrapper. Generated from shared sentinel constants.',
    '# Do not edit inside the container; regenerate from wrapper.ts.',
    'set -u',
    '',
    'if ! cd "$DL_WORKDIR" 2>/dev/null; then',
    `  printf '%s\\n' "${Sentinel.FATAL}"`,
    `  printf 'workdir not found: %s\\n' "$DL_WORKDIR"`,
    `  exit ${WrapperExit.WORKDIR_MISSING}`,
    'fi',
    '',
    'if [ -n "$DL_INSTALL_CMD" ]; then',
    `  printf '%s\\n' "${Sentinel.INSTALL_BEGIN}"`,
    '  if sh -c "$DL_INSTALL_CMD"; then',
    `    printf '%s\\n' "${Sentinel.INSTALL_OK}"`,
    '  else',
    `    printf '%s\\n' "${Sentinel.INSTALL_FAIL}"`,
    `    exit ${WrapperExit.INSTALL_FAILED}`,
    '  fi',
    'fi',
    '',
    'if [ -n "$DL_BUILD_CMD" ]; then',
    `  printf '%s\\n' "${Sentinel.BUILD_BEGIN}"`,
    '  if sh -c "$DL_BUILD_CMD"; then',
    `    printf '%s\\n' "${Sentinel.BUILD_OK}"`,
    '  else',
    `    printf '%s\\n' "${Sentinel.BUILD_FAIL}"`,
    `    exit ${WrapperExit.BUILD_FAILED}`,
    '  fi',
    'fi',
    '',
    `printf '%s\\n' "${Sentinel.START_BEGIN}"`,
    'exec sh -c "$DL_START_CMD"',
    '',
  ].join('\n');
}

/**
 * Environment handed to the wrapper. `set -u` in the script means every DL_* variable
 * must be defined, so absent commands are passed as empty strings rather than omitted.
 */
export function buildWrapperEnv(plan: RunPlan, workdir: string): string[] {
  const env: Record<string, string> = {
    DL_WORKDIR: workdir,
    DL_INSTALL_CMD: plan.installCommand ?? '',
    DL_BUILD_CMD: plan.buildCommand ?? '',
    DL_START_CMD: plan.startCommand,
  };

  for (const v of plan.environmentVariables) {
    if (v.value !== null && v.value !== undefined) env[v.key] = v.value;
  }

  if (plan.expectedPort !== null) {
    // Express and similar read PORT; harmless for frameworks that ignore it.
    env.PORT ??= String(plan.expectedPort);
    env.HOST ??= '0.0.0.0';
  }

  return Object.entries(env).map(([k, v]) => `${k}=${v}`);
}
