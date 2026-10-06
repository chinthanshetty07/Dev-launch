import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, rm, stat, readdir, readlink, realpath, unlink } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { FailureCode } from '@devlaunch/shared';
import { config } from '../../config/index.js';
import { SecurityRejection } from '../security/ImageAllowlist.js';

export interface CloneResult {
  dir: string;
  url: string;
  /** The ref that was asked for, when one was. Absent means the default branch. */
  ref?: string;
  /** The commit actually checked out, so a result can say what it was measured against. */
  commit: string | null;
  sizeBytes: number;
  fileCount: number;
  cleanup: () => Promise<void>;
  /** Symbolic links removed because they pointed outside the clone; relative paths. */
  removedLinks?: string[];
}

export interface TreeMeasurement {
  sizeBytes: number;
  fileCount: number;
  exceeded: boolean;
}

/**
 * Validate and normalise a repository URL.
 *
 * v1 accepts public HTTPS on one host only. Rejecting ssh://, other hosts, and any URL
 * carrying credentials keeps the threat model small: every accepted URL is something
 * anyone could fetch anonymously, so DevLaunch never handles a secret.
 */
export function normaliseRepoUrl(input: string): string {
  const raw = input.trim();
  if (raw.length === 0 || raw.length > 512) {
    throw new SecurityRejection(FailureCode.UNSUPPORTED_PROJECT, 'Repository URL is empty or too long.');
  }

  // scp-style (git@host:owner/repo) is not a URL and would otherwise slip past parsing.
  if (/^[\w.-]+@/.test(raw)) {
    throw new SecurityRejection(
      FailureCode.UNSUPPORTED_PROJECT,
      'SSH-style URLs are not supported. Use a public https:// URL.',
    );
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SecurityRejection(FailureCode.UNSUPPORTED_PROJECT, `Not a valid URL: ${raw}`);
  }

  if (url.protocol !== 'https:') {
    throw new SecurityRejection(
      FailureCode.UNSUPPORTED_PROJECT,
      `Only https:// is supported, got "${url.protocol}".`,
    );
  }
  if (url.username || url.password) {
    throw new SecurityRejection(
      FailureCode.UNSUPPORTED_PROJECT,
      'URLs carrying credentials are rejected. Only public repositories are supported.',
    );
  }

  const host = url.hostname.replace(/^www\./, '').toLowerCase();
  if (host !== config.intake.allowedHost) {
    throw new SecurityRejection(
      FailureCode.UNSUPPORTED_PROJECT,
      `Only ${config.intake.allowedHost} is supported, got "${url.hostname}".`,
    );
  }

  const match = /^\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.pathname);
  if (!match) {
    throw new SecurityRejection(
      FailureCode.UNSUPPORTED_PROJECT,
      `Expected a path like /owner/repo, got "${url.pathname}".`,
    );
  }
  const [, owner, repo] = match;
  if (owner === '..' || repo === '..') {
    throw new SecurityRejection(FailureCode.UNSUPPORTED_PROJECT, 'Invalid owner or repository name.');
  }

  return `https://${config.intake.allowedHost}/${owner}/${repo}.git`;
}

/**
 * Validate a branch, tag or commit to check out.
 *
 * A repository's default branch is not always its application. `nuxt/starter` keeps the
 * app on `v3` and a directory of templates on its default branch, and a result recorded
 * against "whatever the default branch was that day" cannot be reproduced at all.
 *
 * The ref reaches `git fetch` as an argument, so it is held to a narrow shape rather than
 * to git's own much looser rules: nothing that begins with `-` (an option), no `..`, no
 * `@{`, no whitespace or metacharacters. Every real branch and tag name in the corpus fits;
 * one that does not is refused by name rather than passed through and interpreted.
 */
export function normaliseRef(input: string): string {
  const ref = input.trim();
  const ok =
    /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(ref) &&
    !ref.includes('..') &&
    !ref.includes('//') &&
    !/(?:\.lock|\/|\.)$/.test(ref);
  if (!ok) {
    throw new SecurityRejection(
      FailureCode.UNSUPPORTED_PROJECT,
      `"${input.slice(0, 80)}" is not a branch, tag or commit DevLaunch will fetch. ` +
        'Use letters, digits, ".", "_", "-" and "/".',
    );
  }
  return ref;
}

/**
 * A repository URL as a person pastes it, which is often the page they were looking at.
 *
 * `https://github.com/owner/repo/tree/v3` names a branch as plainly as a `ref` field does,
 * and refusing it as "not a path like /owner/repo" sent the user to strip the part that
 * carried the information. Everything after `/tree/` is the ref — GitHub resolves a
 * branch containing a slash the same way.
 */
export function splitRepoInput(input: string): { repoUrl: string; ref?: string } {
  const raw = input.trim();
  const m = /^(https:\/\/(?:www\.)?github\.com\/[^/]+\/[^/]+?)\/tree\/(.+?)\/?$/i.exec(raw);
  if (!m) return { repoUrl: raw };
  // Not URL-decoded: every character a ref may contain is already URL-safe, so an
  // encoded one is refused below rather than decoded into something else.
  return { repoUrl: m[1]!, ref: normaliseRef(m[2]!) };
}

/** The commit checked out in a clone, or null if git cannot say. Never fails a clone. */
async function headOf(dir: string): Promise<string | null> {
  try {
    const { stdout } = await promisify(execFile)('git', ['-C', dir, 'rev-parse', 'HEAD']);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** Why git refused a ref, in words a person can act on, when the stderr says so. */
function missingRef(stderr: string): boolean {
  return /couldn't find remote ref|not our ref|unadvertised object|remote error: .*not found/i.test(stderr);
}

/** Walk a directory, stopping early once a limit is passed. */
export async function measureTree(
  dir: string,
  maxBytes: number,
  maxFiles: number,
): Promise<TreeMeasurement> {
  let sizeBytes = 0;
  let fileCount = 0;

  const walk = async (current: string): Promise<boolean> => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return false; // Vanished mid-clone; not an error worth failing over.
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (await walk(full)) return true;
      } else if (entry.isFile()) {
        fileCount++;
        try {
          sizeBytes += (await stat(full)).size;
        } catch {
          /* raced with the clone */
        }
        if (sizeBytes > maxBytes || fileCount > maxFiles) return true;
      }
    }
    return false;
  };

  const exceeded = await walk(dir);
  return { sizeBytes, fileCount, exceeded };
}

/**
 * Remove every symbolic link in a clone that resolves outside it.
 *
 * git checks a link out as a link, and DevLaunch reads the clone on this machine: a
 * repository committing `.env.example -> /Users/<name>/project/.env` had that file read
 * as its example, and its values copied into a container with open internet access.
 * A link that stays inside the clone is ordinary (a shared config, a README alias) and
 * is kept; one that leaves it — absolute, `../…`, or through another link — is removed
 * before anything reads the tree. A dangling link is removed too: what it would point at
 * is not decided yet. Returns what was removed, relative to the clone.
 */
export async function removeEscapingLinks(root: string): Promise<string[]> {
  const base = await realpath(root);
  const removed: string[] = [];
  const walk = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        const target = await realpath(full).catch(() => null);
        const inside = target !== null && (target === base || target.startsWith(base + sep));
        if (!inside) {
          const pointsAt = await readlink(full).catch(() => '?');
          await unlink(full);
          removed.push(`${relative(root, full)} -> ${pointsAt}`);
        }
      } else if (entry.isDirectory() && entry.name !== '.git') {
        await walk(full);
      }
    }
  };
  await walk(root);
  return removed;
}

export interface GitManagerOptions {
  rootDir?: string;
  /** Overridable so the abort path can be exercised against a real clone. */
  maxBytes?: number;
  maxFiles?: number;
}

export class GitManager {
  private readonly rootDir: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;

  constructor(opts: GitManagerOptions = {}) {
    this.rootDir = opts.rootDir ?? join(tmpdir(), 'devlaunch-repos');
    this.maxBytes = opts.maxBytes ?? config.intake.maxBytes;
    this.maxFiles = opts.maxFiles ?? config.intake.maxFiles;
  }

  /**
   * Shallow-clone a public repository into an isolated directory.
   *
   * Size is enforced *during* the clone rather than after: a repository with gigabytes
   * of assets would fill the disk long before any timeout fired.
   */
  async clone(
    inputUrl: string,
    timeoutMs = config.timeouts.cloneMs,
    inputRef?: string,
  ): Promise<CloneResult> {
    const url = normaliseRepoUrl(inputUrl);
    const ref = inputRef === undefined ? undefined : normaliseRef(inputRef);

    // Every clone lives under one dedicated root, so cleanup's rm -rf can never reach
    // anything else. The root is created, never cleared: wiping it here would destroy a
    // concurrent clone.
    await mkdir(this.rootDir, { recursive: true });
    const base = await mkdtemp(join(this.rootDir, 'repo-'));
    const dir = resolve(base, 'repo');
    const cleanup = () => rm(base, { recursive: true, force: true });

    const env = {
      ...process.env,
      // Without this git blocks forever on a credential prompt for a private or
      // non-existent repository instead of failing.
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '',
      // LFS payloads can be enormous and are never needed to determine how to run.
      GIT_LFS_SKIP_SMUDGE: '1',
    };

    // Without a ref, one clone of the default branch. With one, the same shallow,
    // submodule-free fetch of exactly that ref — a branch, a tag or a commit, since
    // GitHub serves any reachable commit by id — checked out detached.
    const steps: string[][] = ref
      ? [
          ['init', '-q', dir],
          ['-C', dir, 'remote', 'add', 'origin', url],
          ['-C', dir, 'fetch', '--depth', '1', '--no-tags', '--no-recurse-submodules', 'origin', ref],
          ['-C', dir, 'checkout', '-q', '--detach', 'FETCH_HEAD'],
        ]
      : [['clone', '--depth', '1', '--single-branch', '--no-recurse-submodules', '--no-tags', url, dir]];

    let stderr = '';
    let child: ReturnType<typeof spawn> | undefined;
    let stopped = false;
    const git = (argv: string[]) =>
      new Promise<number>((resolveExit, rejectExit) => {
        if (stopped) return resolveExit(-1);
        child = spawn('git', argv, { env, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stderr!.on('data', (c: Buffer) => {
          stderr = (stderr + c.toString('utf8')).slice(-4000);
        });
        child.on('error', rejectExit);
        child.on('close', (c) => resolveExit(c ?? -1));
      });
    const stop = () => {
      stopped = true;
      child?.kill('SIGKILL');
    };

    let limitError: SecurityRejection | undefined;
    // One walk at a time: each is a stat of every file, and starting one every interval
    // regardless let them pile up on a large clone (audit A-22).
    let measuring = false;
    const monitor = setInterval(() => {
      if (measuring) return;
      measuring = true;
      void (async () => {
        const m = await measureTree(dir, this.maxBytes, this.maxFiles).finally(() => {
          measuring = false;
        });
        if (!m.exceeded) return;
        limitError = new SecurityRejection(
          FailureCode.REPOSITORY_TOO_LARGE,
          `Repository exceeds the intake limit (${this.maxBytes} bytes / ` +
            `${this.maxFiles} files). Aborted after ${m.sizeBytes} bytes.`,
        );
        stop();
      })();
    }, config.intake.sizePollMs);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    timer.unref?.();

    try {
      let code = 0;
      for (const step of steps) {
        code = await git(step);
        if (code !== 0) break;
      }

      if (limitError) throw limitError;
      if (timedOut) {
        throw new SecurityRejection(
          FailureCode.PROCESS_TIMEOUT,
          `Clone exceeded ${timeoutMs}ms.`,
        );
      }
      if (code !== 0 && ref && missingRef(stderr)) {
        throw new SecurityRejection(
          FailureCode.UNSUPPORTED_PROJECT,
          `${url} has no branch, tag or commit "${ref}".`,
        );
      }
      if (code !== 0) {
        throw new SecurityRejection(
          FailureCode.NETWORK_FAILURE,
          `git clone failed (exit ${code}): ${stderr.trim() || 'no output'}`,
        );
      }

      // Checked again after the clone finishes: a repository small enough to land
      // between two polls would otherwise slip past the monitor entirely.
      const measured = await measureTree(dir, this.maxBytes, this.maxFiles);
      if (measured.exceeded) {
        throw new SecurityRejection(
          FailureCode.REPOSITORY_TOO_LARGE,
          `Repository exceeds the intake limit (${this.maxBytes} bytes / ${this.maxFiles} files).`,
        );
      }

      const commit = await headOf(dir);
      // After the commit is read (git itself never follows these) and before anything
      // else in DevLaunch reads a file of the clone.
      const removedLinks = await removeEscapingLinks(dir);

      return {
        dir, url, ref, commit, sizeBytes: measured.sizeBytes, fileCount: measured.fileCount, cleanup,
        ...(removedLinks.length ? { removedLinks } : {}),
      };
    } catch (err) {
      await cleanup().catch(() => undefined);
      throw err;
    } finally {
      clearInterval(monitor);
      clearTimeout(timer);
    }
  }
}
