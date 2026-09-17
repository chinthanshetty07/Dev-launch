/**
 * Phase sentinels emitted by the container wrapper script.
 *
 * The wrapper `exec`s the start command so signals reach the application directly,
 * which means the container's exit code belongs to the app, not to our script. These
 * markers in the log stream are what let us attribute a failure to a phase.
 *
 * Shared so the wrapper and the parser can never drift apart.
 */
export const Sentinel = {
  INSTALL_BEGIN: '__DEVLAUNCH:PHASE:INSTALL:BEGIN__',
  INSTALL_OK: '__DEVLAUNCH:PHASE:INSTALL:OK__',
  INSTALL_FAIL: '__DEVLAUNCH:PHASE:INSTALL:FAIL__',
  BUILD_BEGIN: '__DEVLAUNCH:PHASE:BUILD:BEGIN__',
  BUILD_OK: '__DEVLAUNCH:PHASE:BUILD:OK__',
  BUILD_FAIL: '__DEVLAUNCH:PHASE:BUILD:FAIL__',
  START_BEGIN: '__DEVLAUNCH:PHASE:START:BEGIN__',
  FATAL: '__DEVLAUNCH:FATAL__',
} as const;

/** Wrapper exit codes. Chosen above the 0-127 range apps typically use. */
export const WrapperExit = {
  INSTALL_FAILED: 110,
  BUILD_FAILED: 111,
  WORKDIR_MISSING: 112,
} as const;

/** True if a log line is a DevLaunch control marker rather than repository output. */
export function isSentinel(line: string): boolean {
  return line.startsWith('__DEVLAUNCH:');
}
