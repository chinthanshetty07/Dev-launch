import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { normaliseRepoUrl, measureTree } from '../services/git/GitManager.js';
import {
  RepositoryAnalyzer,
  parseEnvExample,
  parsePnpmWorkspace,
  expandWorkspacePatterns,
} from '../services/analysis/RepositoryAnalyzer.js';
import { SecurityRejection } from '../services/security/ImageAllowlist.js';

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../fixtures');
const analyzer = new RepositoryAnalyzer();

describe('normaliseRepoUrl', () => {
  it.each([
    ['https://github.com/owner/repo', 'https://github.com/owner/repo.git'],
    ['https://github.com/owner/repo.git', 'https://github.com/owner/repo.git'],
    ['https://github.com/owner/repo/', 'https://github.com/owner/repo.git'],
    ['https://www.github.com/owner/repo', 'https://github.com/owner/repo.git'],
    ['  https://github.com/owner/repo  ', 'https://github.com/owner/repo.git'],
  ])('normalises %s', (input, expected) => {
    expect(normaliseRepoUrl(input)).toBe(expected);
  });

  it.each([
    ['ssh scheme', 'ssh://git@github.com/owner/repo.git'],
    ['scp style', 'git@github.com:owner/repo.git'],
    ['plain http', 'http://github.com/owner/repo'],
    ['file url', 'file:///etc/passwd'],
    ['other host', 'https://gitlab.com/owner/repo'],
    ['lookalike host', 'https://github.com.evil.io/owner/repo'],
    ['credentials embedded', 'https://user:token@github.com/owner/repo'],
    ['too few path segments', 'https://github.com/owner'],
    ['too many path segments', 'https://github.com/owner/repo/tree/main'],
    ['not a url', 'just some text'],
    ['empty', ''],
  ])('rejects %s', (_label, input) => {
    expect(() => normaliseRepoUrl(input)).toThrow(SecurityRejection);
  });

  it('rejects a URL carrying credentials even when the host is allowed', () => {
    // Accepting this would mean DevLaunch handling somebody's token.
    expect(() => normaliseRepoUrl('https://x:y@github.com/o/r')).toThrow(/credentials/i);
  });
});

describe('measureTree', () => {
  it('counts files and reports when a limit is passed', async () => {
    const within = await measureTree(`${FIXTURES}/node-vite-app`, 10 * 1024 * 1024, 1000);
    expect(within.fileCount).toBeGreaterThan(0);
    expect(within.exceeded).toBe(false);

    const overFiles = await measureTree(`${FIXTURES}/node-vite-app`, 10 * 1024 * 1024, 1);
    expect(overFiles.exceeded).toBe(true);

    const overBytes = await measureTree(`${FIXTURES}/node-vite-app`, 1, 1000);
    expect(overBytes.exceeded).toBe(true);
  });
});

describe('parseEnvExample', () => {
  it('separates variables needing a value from those with a default', () => {
    const vars = parseEnvExample(
      '# comment\nSECRET_KEY=\nDATABASE_URL=\nFLASK_ENV=development\n\nexport PORT=5000\n',
    );
    expect(vars).toEqual([
      { key: 'SECRET_KEY', hasDefault: false },
      { key: 'DATABASE_URL', hasDefault: false },
      { key: 'FLASK_ENV', hasDefault: true },
      { key: 'PORT', hasDefault: true },
    ]);
  });

  it('ignores comments, blanks and malformed lines', () => {
    expect(parseEnvExample('#x\n\n  \nnot-a-var\n=novalue\n123BAD=x\n')).toEqual([]);
  });
});

describe('parsePnpmWorkspace', () => {
  it('reads a block sequence of package globs', () => {
    expect(parsePnpmWorkspace("packages:\n  - 'apps/*'\n  - \"packages/*\"\n")).toEqual([
      'apps/*',
      'packages/*',
    ]);
  });

  it('returns nothing when there is no packages key', () => {
    expect(parsePnpmWorkspace('other: true\n')).toEqual([]);
  });
});

describe('expandWorkspacePatterns', () => {
  it('expands dir/* into real directories', async () => {
    const dirs = await expandWorkspacePatterns(`${FIXTURES}/node-monorepo`, ['apps/*', 'packages/*']);
    expect(dirs.sort()).toEqual(['apps/web', 'packages/util']);
  });

  it('refuses a pattern that would escape the repository', async () => {
    expect(await expandWorkspacePatterns(`${FIXTURES}/node-monorepo`, ['../*'])).toEqual([]);
  });
});

describe('RepositoryAnalyzer', () => {
  it('describes a Vite application', async () => {
    const meta = await analyzer.analyze(`${FIXTURES}/node-vite-app`);
    expect(meta.packageJson?.dependencies).toHaveProperty('react');
    expect(meta.packageJson?.devDependencies).toHaveProperty('vite');
    expect(meta.packageJson?.scripts.dev).toBe('vite');
    expect(meta.packageJson?.engineNode).toBe('>=18');
    expect(meta.lockfiles).toContain('package-lock.json');
    expect(meta.frameworkConfigs).toContain('vite.config.ts');
    expect(meta.tsconfig).toBe(true);
    expect(meta.python).toBeUndefined();
    expect(meta.warnings).toEqual([]);
  });

  it('describes a Flask application, including its entry point and app object', async () => {
    const meta = await analyzer.analyze(`${FIXTURES}/python-flask-basic`);
    expect(meta.python?.requirements).toContain('Flask==3.0.3');
    expect(meta.python?.hasManagePy).toBe(false);
    const entry = meta.python?.entryCandidates.find((e) => e.file === 'app.py');
    expect(entry?.framework).toBe('flask');
    // Phase 6 needs the variable name to build a gunicorn target like app:app.
    expect(entry?.appVariable).toBe('app');
    expect(meta.packageJson).toBeUndefined();
  });

  it('separates required environment variables from defaulted ones', async () => {
    const meta = await analyzer.analyze(`${FIXTURES}/python-flask-basic`);
    const required = meta.envExample.filter((v) => !v.hasDefault).map((v) => v.key);
    expect(required).toEqual(['SECRET_KEY', 'DATABASE_URL']);
    expect(meta.envExample.find((v) => v.key === 'PORT')?.hasDefault).toBe(true);
  });

  it('detects Django from manage.py', async () => {
    const meta = await analyzer.analyze(`${FIXTURES}/python-django-basic`);
    expect(meta.python?.hasManagePy).toBe(true);
    expect(meta.python?.requirements).toContain('Django==5.0.6');
  });

  it('finds only the runnable packages in a monorepo', async () => {
    const meta = await analyzer.analyze(`${FIXTURES}/node-monorepo`);
    expect(meta.workspace?.kind).toBe('pnpm');
    expect(meta.workspace?.total).toBe(2);
    // packages/util has only a build script, so it is not something to run.
    expect(meta.workspace?.runnable.map((p) => p.name)).toEqual(['@fixture/web']);
    expect(meta.workspace?.runnable[0]?.dir).toBe('apps/web');
  });

  it('captures a README excerpt without swallowing the whole file', async () => {
    const meta = await analyzer.analyze(`${FIXTURES}/python-flask-basic`);
    expect(meta.readmeExcerpt).toContain('Flask fixture');
    expect(meta.readmeExcerpt!.length).toBeLessThanOrEqual(4000);
  });

  it('records a malformed manifest as a warning instead of throwing', async () => {
    // A broken package.json is a fact about the repository; the planner routes it to
    // the AI fallback rather than guessing.
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'devlaunch-bad-'));
    await writeFile(join(dir, 'package.json'), '{ not json', 'utf8');

    const meta = await analyzer.analyze(dir);
    expect(meta.packageJson).toBeUndefined();
    expect(meta.warnings.join(' ')).toMatch(/package\.json could not be parsed/);
  });

  it('returns a usable description for an empty directory', async () => {
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'devlaunch-empty-'));

    const meta = await analyzer.analyze(dir);
    expect(meta.packageJson).toBeUndefined();
    expect(meta.python).toBeUndefined();
    expect(meta.lockfiles).toEqual([]);
    expect(meta.envExample).toEqual([]);
  });
});
