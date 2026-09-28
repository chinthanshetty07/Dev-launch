import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Which commit this process is running, and which one the working tree is on.
 *
 * Exists because of a specific, expensive failure that produced no error of any kind.
 * A development server ran for five days; a commit landed twenty-nine minutes after it
 * started; every launch after that was served by code that predated the fix. Those
 * failures looked exactly like real ones — same UI, same diagnoses, same confidence —
 * and hours went into re-investigating bugs that were already fixed on disk.
 *
 * Nothing in the system could have said so, because nothing knew what it was running.
 *
 * Resolved once at startup for `running`, and per request for `head`: a process cannot
 * change commits without restarting, and the working tree can change under it at any
 * moment, which is exactly the situation worth detecting.
 */
export interface BuildStamp {
  /** The commit this process started from. Undefined outside a git checkout. */
  running?: string;
  /** The commit the working tree is on now. */
  head?: string;
  /** True when the two differ: the code on disk is not the code answering. */
  stale: boolean;
  /** When this process started, so "how long has it been up" is answerable. */
  startedAt: number;
}

const startedAt = Date.now();
let running: string | undefined;

/** Resolved once, at startup. A later call cannot change what this process is running. */
export async function recordRunningCommit(cwd: string): Promise<void> {
  running ??= await headCommit(cwd);
}

export async function buildStamp(cwd: string): Promise<BuildStamp> {
  const head = await headCommit(cwd);
  return {
    ...(running ? { running } : {}),
    ...(head ? { head } : {}),
    // Only when both are known. No git, or a checkout this process cannot read, is not
    // evidence of staleness — and a warning that fires on every deployment without a
    // repository beside it is a warning nobody reads by the second week.
    stale: Boolean(running && head && running !== head),
    startedAt,
  };
}

async function headCommit(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await run('git', ['rev-parse', 'HEAD'], { cwd, timeout: 2000 });
    return stdout.trim() || undefined;
  } catch {
    // Not a checkout, no git, or a repository this process cannot read. All of them
    // mean the same thing here: nothing to compare, so say nothing.
    return undefined;
  }
}

/** Test seam: forget the recorded commit so a test can record a different one. */
export function resetRunningCommit(): void {
  running = undefined;
}
