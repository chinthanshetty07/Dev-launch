import { describe, it, expect, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ExecutionState, FailureCode } from '@devlaunch/shared';
import { RepositoryAnalyzer, readGitlinks } from '../services/analysis/RepositoryAnalyzer.js';
import { SessionManager } from '../services/session/SessionManager.js';
import type { ExecutionManager } from '../services/execution/ExecutionManager.js';

/**
 * `RefugioDiaz1/fullstack-docker-react-node-postgres`: `client` and `server` are git links
 * (mode 160000) with no `.gitmodules`, so their code is nowhere anybody can fetch it.
 * DevLaunch saw two empty folders, asked a model, and reported npm's sign-off line.
 */
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const git = (cwd: string, ...args: string[]) =>
  promisify(execFile)('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd });

async function repoWithLinks(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'devlaunch-links-'));
  dirs.push(d);
  await git(d, 'init', '-q');
  await writeFile(join(d, 'docker-compose.yml'), 'services: {}\n');
  // One proper submodule, declared with a URL; two links declared nowhere.
  await writeFile(join(d, '.gitmodules'), '[submodule "docs"]\n\tpath = docs\n\turl = https://example.com/docs.git\n');
  const sha = '5ae4006587920344d633f1ac8d4a3c8a27f5d794';
  for (const p of ['docs', 'client', 'server']) {
    await mkdir(join(d, p));
    await git(d, 'update-index', '--add', '--cacheinfo', `160000,${sha},${p}`);
  }
  await git(d, 'add', 'docker-compose.yml', '.gitmodules');
  await git(d, 'commit', '-q', '-m', 'x');
  return d;
}

describe('links to other repositories', () => {
  it('are read from git itself, and those with no source are named', async () => {
    const d = await repoWithLinks();
    expect((await readGitlinks(d)).sort()).toEqual(['client', 'docs', 'server']);
    const meta = await new RepositoryAnalyzer().analyze(d);
    expect(meta.submodulesWithoutSource).toEqual(['client', 'server']);
    expect(meta.submodules).toEqual(['docs', 'client', 'server']);
  });

  it('are none without a .git to read', async () => {
    const d = await mkdtemp(join(tmpdir(), 'devlaunch-links-'));
    dirs.push(d);
    expect(await readGitlinks(d)).toEqual([]);
  });
});

describe('a repository whose code is in links nobody can fetch', () => {
  it('is declined at once, by name, without asking a model', async () => {
    const asked: number[] = [];
    const m = new SessionManager({} as ExecutionManager, {
      analyzer: { analyze: async () => ({ warnings: [], envExample: [], lockfiles: [], frameworkConfigs: [], submodulesWithoutSource: ['client', 'server'] }) } as never,
      planner: { planRepository: async () => ({ plan: null, detected: null, reason: 'No known pattern matched.', warnings: [] }) } as never,
      aiPlanner: { plan: async () => { asked.push(1); throw new Error('must not be asked'); } } as never,
    });
    const s = await m.launch({ sourceDir: '/tmp/repo' });
    for (let i = 0; i < 100 && s.state !== ExecutionState.FAILED; i++) await new Promise((r) => setTimeout(r, 10));
    await m.shutdown();
    expect(s.failure?.code).toBe(FailureCode.UNSUPPORTED_PROJECT);
    expect(s.failure?.message).toMatch(/^`client\/`, `server\/` are links to other git repositories, not folders of code/);
    expect(s.failure?.message).toMatch(/no \.gitmodules entry/);
    expect(s.failure?.remedy).toMatch(/git submodule add/);
    expect(asked).toEqual([]);
  });
});
