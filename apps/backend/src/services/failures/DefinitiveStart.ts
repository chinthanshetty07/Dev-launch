/**
 * Start-phase lines after which an application will not come up by itself.
 *
 * A watcher — nodemon, ts-node-dev — keeps its container running after the application it
 * watches has crashed, waiting for a file change that never comes. Readiness saw a running
 * container and kept polling for the whole budget: `niksbanna/mern-boilerplate` waited about
 * 50 seconds with `TSError` already in its log. These lines end the wait at once; the
 * failure is then classified from the log as it always is.
 *
 * Deliberately few, each one a watcher or runtime saying in so many words that it has
 * given up. An error an application logs and survives is not here.
 */
export const DEFINITIVE_START_FAILURES: readonly RegExp[] = [
  /\[nodemon\] app crashed - waiting for file changes/,
  /⨯ Unable to compile TypeScript/,
  /Error: listen EADDRINUSE/,
];

export function definitiveStartFailure(lines: readonly string[]): string | undefined {
  for (const line of lines) {
    if (DEFINITIVE_START_FAILURES.some((p) => p.test(line))) return line.trim();
  }
  return undefined;
}
