import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { FailureCode } from '@devlaunch/shared';
import { config } from '../../config/index.js';
import { SecurityRejection } from '../security/ImageAllowlist.js';

export interface CloneResult {
  dir: string;
  url: string;
  sizeBytes: number;
  fileCount: number;
  cleanup: () => Promise<void>;
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
  async clone(inputUrl: string, timeoutMs = config.timeouts.cloneMs): Promise<CloneResult> {
    const url = normaliseRepoUrl(inputUrl);

    // Every clone lives under one dedicated root, so cleanup's rm -rf can never reach
    // anything else. The root is created, never cleared: wiping it here would destroy a
    // concurrent clone.
    await mkdir(this.rootDir, { recursive: true });
    const base = await mkdtemp(join(this.rootDir, 'repo-'));
    const dir = resolve(base, 'repo');
    const cleanup = () => rm(base, { recursive: true, force: true });

    const child = spawn(
      'git',
      [
        'clone',
        '--depth', '1',
        '--single-branch',
        '--no-recurse-submodules',
        '--no-tags',
        url,
        dir,
      ],
      {
        env: {
          ...process.env,
          // Without this git blocks forever on a credential prompt for a private or
          // non-existent repository instead of failing.
          GIT_TERMINAL_PROMPT: '0',
          GIT_ASKPASS: '',
          // LFS payloads can be enormous and are never needed to determine how to run.
          GIT_LFS_SKIP_SMUDGE: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let stderr = '';
    child.stderr.on('data', (c: Buffer) => {
      stderr = (stderr + c.toString('utf8')).slice(-4000);
    });

    let limitError: SecurityRejection | undefined;
    const monitor = setInterval(() => {
      void (async () => {
        const m = await measureTree(dir, this.maxBytes, this.maxFiles);
        if (!m.exceeded) return;
        limitError = new SecurityRejection(
          FailureCode.REPOSITORY_TOO_LARGE,
          `Repository exceeds the intake limit (${this.maxBytes} bytes / ` +
            `${this.maxFiles} files). Aborted after ${m.sizeBytes} bytes.`,
        );
        child.kill('SIGKILL');
      })();
    }, config.intake.sizePollMs);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    timer.unref?.();

    try {
      const code = await new Promise<number>((resolveExit, rejectExit) => {
        child.on('error', rejectExit);
        child.on('close', (c) => resolveExit(c ?? -1));
      });

      if (limitError) throw limitError;
      if (timedOut) {
        throw new SecurityRejection(
          FailureCode.PROCESS_TIMEOUT,
          `Clone exceeded ${timeoutMs}ms.`,
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

      return { dir, url, sizeBytes: measured.sizeBytes, fileCount: measured.fileCount, cleanup };
    } catch (err) {
      await cleanup().catch(() => undefined);
      throw err;
    } finally {
      clearInterval(monitor);
      clearTimeout(timer);
    }
  }
}
