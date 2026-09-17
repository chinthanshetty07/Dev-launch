import { describe, it, expect, afterEach } from 'vitest';
import { access } from 'node:fs/promises';
import { FailureCode } from '@devlaunch/shared';
import { GitManager } from '../../services/git/GitManager.js';
import { RepositoryAnalyzer } from '../../services/analysis/RepositoryAnalyzer.js';
import { SecurityRejection } from '../../services/security/ImageAllowlist.js';

const git = new GitManager();
const analyzer = new RepositoryAnalyzer();
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c().catch(() => undefined);
});

describe('Phase 5 — repository intake (network)', () => {
  it('clones a public repository and reports its size', async () => {
    const result = await git.clone('https://github.com/octocat/Hello-World');
    cleanups.push(result.cleanup);

    expect(result.url).toBe('https://github.com/octocat/Hello-World.git');
    expect(result.fileCount).toBeGreaterThan(0);
    await expect(access(result.dir)).resolves.toBeUndefined();

    // Shallow by design: a full history is never needed to work out how to run a project.
    const meta = await analyzer.analyze(result.dir);
    expect(meta.root).toBe(result.dir);
    expect(meta.readmeExcerpt).toBeTruthy();
  }, 180_000);

  it('removes the clone directory on cleanup', async () => {
    const result = await git.clone('https://github.com/octocat/Hello-World');
    const { dir } = result;
    await result.cleanup();
    await expect(access(dir)).rejects.toThrow();
  }, 180_000);

  it('fails promptly on a missing repository instead of waiting for credentials', async () => {
    // Without GIT_TERMINAL_PROMPT=0 git blocks forever on a username prompt here, which
    // would consume the entire clone budget and report a timeout rather than the truth.
    const started = Date.now();
    await expect(
      git.clone('https://github.com/chinthanshetty07/definitely-not-a-real-repo-xyz', 60_000),
    ).rejects.toMatchObject({ code: FailureCode.NETWORK_FAILURE });
    expect(Date.now() - started).toBeLessThan(30_000);
  }, 120_000);

  it('rejects a disallowed URL before running git at all', async () => {
    for (const url of [
      'https://gitlab.com/owner/repo',
      'ssh://git@github.com/owner/repo.git',
      'https://token@github.com/owner/repo',
    ]) {
      await expect(git.clone(url)).rejects.toBeInstanceOf(SecurityRejection);
    }
  });

  it('aborts a clone that exceeds the intake size limit', async () => {
    // A one-byte ceiling is unreachable, so the limit must stop the clone rather than
    // being noticed only after the whole repository has landed on disk.
    const tiny = new GitManager({ maxBytes: 1 });
    await expect(tiny.clone('https://github.com/octocat/Hello-World')).rejects.toMatchObject({
      code: FailureCode.REPOSITORY_TOO_LARGE,
    });
  }, 180_000);

  it('aborts a clone that exceeds the intake file-count limit', async () => {
    const tiny = new GitManager({ maxFiles: 0 });
    await expect(tiny.clone('https://github.com/octocat/Hello-World')).rejects.toMatchObject({
      code: FailureCode.REPOSITORY_TOO_LARGE,
    });
  }, 180_000);

  it('leaves nothing behind when a clone is rejected', async () => {
    const tiny = new GitManager({ maxBytes: 1 });
    await expect(tiny.clone('https://github.com/octocat/Hello-World')).rejects.toThrow();
    // The failure path must clean up after itself, not leak a partial clone.
    const { readdir } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = join(tmpdir(), 'devlaunch-repos');
    const left = await readdir(root).catch(() => []);
    expect(left).toEqual([]);
  }, 180_000);
});
