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
    // The image points TMPDIR at the volume, but the volume shadows the image path it
    // mounts over, so the directory has to be made here rather than assumed to exist.
    'if [ -n "${TMPDIR:-}" ]; then mkdir -p "$TMPDIR" 2>/dev/null || true; fi',
    '',
    'if [ -n "$DL_INSTALL_CMD" ]; then',
    `  printf '%s\\n' "${Sentinel.INSTALL_BEGIN}"`,
    // A workspace installs once at its root, not once per package: its packages depend
    // on each other through `workspace:*`, which no package manager can resolve for a
    // single package in isolation. So the install may run somewhere other than the
    // directory the service starts from. A subshell keeps that move local — the build
    // and start steps must still run in DL_WORKDIR.
    // Reused: the workspace volume already holds what this exact install command
    // produced, finished, in an earlier container of the same session. ExecutionManager
    // decides that, never a plan — DL_ is a control prefix no plan may set.
    '  if [ "${DL_INSTALL_REUSED:-0}" = "1" ]; then',
    "    printf '%s\\n' '[devlaunch] The packages are already installed: an earlier attempt in this session ran the same install command to completion. Not installing again.'",
    `    printf '%s\\n' "${Sentinel.INSTALL_OK}"`,
    '  elif (cd "$DL_INSTALL_DIR" && sh -c "$DL_INSTALL_CMD"); then',
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
export function buildWrapperEnv(
  plan: RunPlan,
  workdir: string,
  installDir?: string,
  control: { nodeHeapMb?: number; installReused?: boolean; legacyOpenssl?: boolean } = {},
): string[] {
  const env: Record<string, string> = {};

  // Application variables first.
  for (const v of plan.environmentVariables) {
    if (v.value !== null && v.value !== undefined) env[v.key] = v.value;
  }

  if (plan.expectedPort !== null) {
    // Express and similar read PORT; harmless for frameworks that ignore it.
    env.PORT ??= String(plan.expectedPort);
    env.HOST ??= '0.0.0.0';
  }

  // Control variables LAST, and unconditionally.
  //
  // Assignment order is the security boundary here: the wrapper takes its commands
  // from these names, so a plan variable called DL_START_CMD would otherwise replace
  // an allowlisted command with arbitrary text. ExecutionManager also rejects the
  // DL_ prefix outright — this ordering is the second layer, so a future caller that
  // skips validation still cannot be exploited.
  env.DL_WORKDIR = workdir;
  // Defaults to the working directory, so a single-service plan behaves exactly as it
  // did before this existed.
  env.DL_INSTALL_DIR = installDir ?? workdir;
  env.DL_INSTALL_CMD = plan.installCommand ?? '';
  env.DL_BUILD_CMD = plan.buildCommand ?? '';
  env.DL_START_CMD = plan.startCommand;
  // Set either way, so nothing else can supply it.
  env.DL_INSTALL_REUSED = control.installReused === true ? '1' : '0';

  // A larger V8 heap, after a heap OOM, set by DevLaunch and never by a plan: the validator
  // refuses NODE_OPTIONS from every plan, because `--require` in it runs code before the
  // start command. This composes one flag from one integer, and is assigned here, with
  // the other control variables, so nothing a plan carries can replace it.
  //
  // And OpenSSL's legacy algorithms, for webpack 4 (`RunPlan.legacyOpenssl`): one fixed flag,
  // composed here the same way — a plan says yes or no, never what goes in.
  const nodeOptions: string[] = [];
  if (control.nodeHeapMb !== undefined && Number.isInteger(control.nodeHeapMb) && control.nodeHeapMb > 0) {
    nodeOptions.push(`--max-old-space-size=${control.nodeHeapMb}`);
  }
  if (control.legacyOpenssl === true) nodeOptions.push('--openssl-legacy-provider');
  if (nodeOptions.length > 0) env.NODE_OPTIONS = nodeOptions.join(' ');

  return Object.entries(env).map(([k, v]) => `${k}=${v}`);
}
