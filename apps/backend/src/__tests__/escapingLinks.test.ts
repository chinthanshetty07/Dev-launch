import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, readFile, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitManager, removeEscapingLinks } from '../services/git/GitManager.js';
import { execFileSync } from 'node:child_process';

/**
 * A-02. git checks links out as links, and the analyzer reads the clone on this machine:
 * `.env.example -> /Users/<name>/project/.env` had a file from outside the repository read
 * as its example, its values copied into a container with internet access.
 */
const scratch: string[] = [];
afterAll(async () => {
  await Promise.all(scratch.map((d) => rm(d, { recursive: true, force: true })));
});

const exists = (p: string) => lstat(p).then(() => true, () => false);

describe('links in a clone', () => {
  it('are removed when they lead outside it, and kept when they stay inside', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'devlaunch-host-'));
    const root = await mkdtemp(join(tmpdir(), 'devlaunch-clone-'));
    scratch.push(outside, root);
    await writeFile(join(outside, 'secret.env'), 'API_KEY=real-host-secret\n');
    await mkdir(join(root, 'docs'));
    await writeFile(join(root, 'docs', 'README.md'), '# inside\n');

    await symlink(join(outside, 'secret.env'), join(root, '.env.example')); // absolute, out
    await symlink('../' + outside.split('/').pop() + '/secret.env', join(root, 'up.env')); // relative, out
    await symlink('docs/README.md', join(root, 'README.md')); // inside: kept
    await symlink('.env.example', join(root, 'chained.env')); // inside, but through an outward link
    await symlink('nowhere.txt', join(root, 'dangling')); // undecided target
    // A neighbour whose name begins with the clone's: inside by string prefix only.
    const neighbour = `${root}-evil`;
    scratch.push(neighbour);
    await mkdir(neighbour);
    await writeFile(join(neighbour, 'x'), 'x');
    await symlink(join(neighbour, 'x'), join(root, 'prefix.txt'));
    await mkdir(join(root, 'pkg'));
    await symlink('/etc', join(root, 'pkg', 'etc')); // deep, directory, out

    const removed = await removeEscapingLinks(root);

    expect(await exists(join(root, '.env.example'))).toBe(false);
    expect(await exists(join(root, 'up.env'))).toBe(false);
    expect(await exists(join(root, 'chained.env'))).toBe(false);
    expect(await exists(join(root, 'dangling'))).toBe(false);
    expect(await exists(join(root, 'pkg', 'etc'))).toBe(false);
    expect(await readFile(join(root, 'README.md'), 'utf8')).toBe('# inside\n');
    expect(removed.map((r) => r.split(' -> ')[0]).sort()).toEqual(['.env.example', 'chained.env', 'dangling', 'pkg/etc', 'prefix.txt', 'up.env']);
    // The file outside was never touched.
    expect(await readFile(join(outside, 'secret.env'), 'utf8')).toContain('real-host-secret');
  });
});

describe('a real clone (verifier D-6)', () => {
  it('has its outward links removed before anything reads it, and says which', async () => {
    // A real git repository, served to the real clone code: git's own `insteadOf` setting
    // maps the GitHub URL the clone insists on to this local repository, so DevLaunch's
    // GitHub-only rule is untouched.
    const outside = await mkdtemp(join(tmpdir(), 'devlaunch-host-'));
    const src = await mkdtemp(join(tmpdir(), 'devlaunch-src-'));
    const roots = await mkdtemp(join(tmpdir(), 'devlaunch-clones-'));
    scratch.push(outside, src, roots);
    await writeFile(join(outside, 'secret.env'), 'API_KEY=real-host-secret\n');
    await writeFile(join(src, 'README.md'), '# hi\n');
    await symlink(join(outside, 'secret.env'), join(src, '.env.example'));
    await symlink('README.md', join(src, 'ALIAS.md'));
    const git = (...a: string[]) => execFileSync('git', a, { cwd: src, stdio: 'pipe' });
    git('init', '-q');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'links');

    // DevLaunch asks for `…/links.git`; serve a bare copy under exactly that name.
    const served = await mkdtemp(join(tmpdir(), 'devlaunch-served-'));
    scratch.push(served);
    execFileSync('git', ['clone', '-q', '--bare', src, join(served, 'links.git')], { stdio: 'pipe' });
    const saved = { ...process.env };
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = `url.file://${served}/.insteadOf`;
    process.env.GIT_CONFIG_VALUE_0 = 'https://github.com/devlaunch-test/';
    try {
      const clone = await new GitManager({ rootDir: roots }).clone('https://github.com/devlaunch-test/links');
      expect(clone.removedLinks?.map((l) => l.split(' -> ')[0])).toEqual(['.env.example']);
      expect(await exists(join(clone.dir, '.env.example'))).toBe(false);
      expect(await readFile(join(clone.dir, 'ALIAS.md'), 'utf8')).toBe('# hi\n');
      await clone.cleanup();
    } finally {
      for (const k of ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  }, 60_000);
});
