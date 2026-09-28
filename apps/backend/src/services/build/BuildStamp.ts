import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
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

/**
 * The directories whose contents decide how a repository is planned and diagnosed.
 *
 * Not the whole tree. A commit touching docs, fixtures or the frontend changes nothing
 * about the answers this process gives, and a warning that fires for one of those
 * teaches people to click past the warning that matters.
 *
 * `docker/runner` is deliberately absent: a Dockerfile change needs the images rebuilt
 * rather than the server restarted, so reporting it here would offer the wrong remedy.
 */
const BEHAVIOURAL_PATHS = ['apps/backend/src', 'packages/shared/src'];

const startedAt = Date.now();
let running: Fingerprint | undefined;

/** What this process is running: one part to show a person, one part to compare. */
interface Fingerprint {
  /** HEAD, for display. Never compared — see `buildStamp`. */
  commit?: string;
  /** Hash of the behavioural source, committed and not. */
  content?: string;
}

/** Resolved once, at startup. A later call cannot change what this process is running. */
export async function recordRunningCommit(cwd: string): Promise<void> {
  running ??= await fingerprint(cwd);
}

export async function buildStamp(cwd: string): Promise<BuildStamp> {
  const now = await fingerprint(cwd);
  return {
    ...(running?.commit ? { running: running.commit } : {}),
    ...(now.commit ? { head: now.commit } : {}),
    // Compared on content, never on the commit.
    //
    // This compared `HEAD` once, and a commit amended only to reword its message fired
    // the banner against a byte-identical tree. That is the failure this whole thing
    // exists to prevent, arriving from the other side: a warning that cries wolf is one
    // people learn to dismiss, and it would have been dismissed on the day it was
    // finally right.
    //
    // Only when both are known. No git, or a checkout this process cannot read, is not
    // evidence of staleness — and a warning that fires on every deployment without a
    // repository beside it is a warning nobody reads by the second week.
    stale: Boolean(running?.content && now.content && running.content !== now.content),
    startedAt,
  };
}

/**
 * What this checkout's behavioural source currently is.
 *
 * Two facts, answering different questions. The commit is for a person to read; the
 * content hash decides staleness, and it covers uncommitted edits as well as commits —
 * a server started before you saved a file is running old code just as surely as one
 * started before you committed it.
 */
async function fingerprint(cwd: string): Promise<Fingerprint> {
  const commit = await git(cwd, ['rev-parse', 'HEAD']);
  // Tree hashes rather than the commit: identical for a reworded commit, different the
  // moment a byte of committed source differs.
  const trees = await git(cwd, ['rev-parse', ...BEHAVIOURAL_PATHS.map((p) => `HEAD:${p}`)]);
  // The *diff*, not `status --porcelain`, and the difference is the whole point: status
  // reports which files are modified and not what is in them, so a second edit to an
  // already-modified file left the fingerprint identical — which is exactly the case
  // this is for, somebody editing one file over and over while a server runs. A live
  // check caught that; every unit test passed, because each happened to edit a file
  // that was clean beforehand.
  const diff = await git(cwd, ['diff', 'HEAD', '--', ...BEHAVIOURAL_PATHS]);
  // An untracked file is in neither HEAD nor that diff, so its name still comes from
  // here. Its *contents* are not covered, which is the smaller gap: a file nothing
  // imports yet cannot change an answer.
  const untracked = await git(cwd, [
    'ls-files', '--others', '--exclude-standard', '--', ...BEHAVIOURAL_PATHS,
  ]);

  return {
    ...(commit ? { commit } : {}),
    // Hashed, because a working tree's diff is unbounded and this is only ever compared.
    ...(trees !== undefined
      ? { content: createHash('sha1').update([trees, diff, untracked].join('\n')).digest('hex') }
      : {}),
  };
}

async function git(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await run('git', args, { cwd, timeout: 2000 });
    return stdout.trim();
  } catch {
    // Not a checkout, no git, or a repository this process cannot read. All of them
    // mean the same thing here: nothing to compare, so say nothing.
    return undefined;
  }
}

/** Test seam: forget the recorded fingerprint so a test can record a different one. */
export function resetRunningCommit(): void {
  running = undefined;
}
