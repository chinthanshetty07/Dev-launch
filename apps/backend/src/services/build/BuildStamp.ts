import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
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
  /** Hash of the behavioural source files as they are on disk. */
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
  const content = await sourceHash(cwd);
  return {
    ...(commit ? { commit } : {}),
    ...(content ? { content } : {}),
  };
}

/**
 * A hash of the source files on disk, which is the only thing that decides behaviour.
 *
 * Reading the files, and not asking git about them, after two false positives that were
 * both git artefacts rather than changes. The first compared commit SHAs, so rewording a
 * commit fired the banner over a byte-identical tree. The second hashed tree objects plus
 * `git diff HEAD`, so *committing* pending work fired it — content moved out of the diff
 * and into the trees while not one file changed.
 *
 * Both were the same mistake: measuring how the code is recorded instead of what it says.
 * A file's bytes are what this process loaded, so a file's bytes are what to compare. It
 * needs no git at all, and it is right for a checkout with no repository, a shallow
 * clone, a dirty tree, an untracked file, and a file written by something that has never
 * heard of git.
 *
 * 92 files and 1.3 MB at the time of writing, read on a health request that a dashboard
 * makes on mount and on a state change. If that ever becomes a cost, cache it against the
 * newest mtime — but measure before believing it is one.
 */
async function sourceHash(cwd: string): Promise<string | undefined> {
  const hash = createHash('sha1');
  let seen = 0;

  // Sorted at every level, so the hash depends on the files and not on the order a
  // filesystem happened to return them in.
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (SOURCE_SUFFIXES.some((ext) => entry.name.endsWith(ext))) {
        const body = await readFile(full).catch(() => null);
        if (body === null) continue;
        hash.update(full).update(body);
        seen++;
      }
    }
  };

  for (const path of BEHAVIOURAL_PATHS) await walk(resolve(cwd, path));
  // Nothing read means the paths are not there: a deployment without its sources beside
  // it, not a change. Say nothing rather than compare emptiness to emptiness.
  return seen > 0 ? hash.digest('hex') : undefined;
}

/** What the runtime actually loads. A `.md` beside the code changes no answer. */
const SOURCE_SUFFIXES = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json'];

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
