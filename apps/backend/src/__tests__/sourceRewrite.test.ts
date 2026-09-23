import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, mkdir, readFile, symlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  applySourceRewrites,
  databaseUrlRewrite,
  repointHost,
} from '../services/execution/SourceRewrite.js';

/**
 * This is the one place DevLaunch modifies a repository, and it does so only when
 * `DEVLAUNCH_REWRITE_SOURCE` is set. What earns that latitude is that the change is
 * narrow and provable: the file was identified by analysis, the literal is replaced once
 * and only if it is still there, and nothing outside the clone can be touched. These
 * tests are the proof.
 */

const scratch: string[] = [];
afterAll(async () => {
  await Promise.all(scratch.map((d) => rm(d, { recursive: true, force: true }).catch(() => undefined)));
});

async function repo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'devlaunch-rw-'));
  scratch.push(root);
  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, contents);
  }
  return root;
}

const read = (root: string, file: string): Promise<string> => readFile(join(root, file), 'utf8');

describe('rewriting a loopback literal in the clone', () => {
  it('replaces the exact text, leaving the rest of the file alone', async () => {
    const root = await repo({
      'vite.config.js':
        "export default {\n  plugins: [react()],\n  server: { proxy: { '/api': 'http://localhost:8000' } },\n}\n",
    });
    const applied = await applySourceRewrites(root, [
      { file: 'vite.config.js', from: 'http://localhost:8000', to: 'http://api:8000', reason: 'x' },
    ]);

    expect(applied).toHaveLength(1);
    const after = await read(root, 'vite.config.js');
    expect(after).toContain("'/api': 'http://api:8000'");
    expect(after).toContain('plugins: [react()]');
  });

  it('replaces one occurrence, not every one', async () => {
    // A literal appearing twice is two decisions, and changing both on the evidence of
    // having found one is exactly the latitude this must not take.
    const root = await repo({ 'a.js': 'const a = "http://localhost:8000";\nconst b = "http://localhost:8000";\n' });
    await applySourceRewrites(root, [
      { file: 'a.js', from: 'http://localhost:8000', to: 'http://api:8000', reason: 'x' },
    ]);

    const after = await read(root, 'a.js');
    expect(after).toContain('const a = "http://api:8000"');
    expect(after).toContain('const b = "http://localhost:8000"');
  });

  it('does nothing when the literal is no longer there', async () => {
    // A repair re-enters the launch path with the edit already made. Reporting it twice
    // reads as it having happened twice.
    const root = await repo({ 'a.js': 'const a = "http://api:8000";\n' });
    const applied = await applySourceRewrites(root, [
      { file: 'a.js', from: 'http://localhost:8000', to: 'http://api:8000', reason: 'x' },
    ]);
    expect(applied).toEqual([]);
  });

  it('does nothing when the file does not exist', async () => {
    const root = await repo({ 'a.js': 'x' });
    const applied = await applySourceRewrites(root, [
      { file: 'nope.js', from: 'a', to: 'b', reason: 'x' },
    ]);
    expect(applied).toEqual([]);
  });

  it('refuses a path that climbs out of the clone', async () => {
    const root = await repo({ 'a.js': 'x' });
    const outside = await mkdtemp(join(tmpdir(), 'devlaunch-outside-'));
    scratch.push(outside);
    await writeFile(join(outside, 'secret.txt'), 'http://localhost:8000');

    const applied = await applySourceRewrites(root, [
      { file: '../secret.txt', from: 'http://localhost:8000', to: 'evil', reason: 'x' },
    ]);
    expect(applied).toEqual([]);
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('http://localhost:8000');
  });

  it('refuses an absolute path', async () => {
    const root = await repo({ 'a.js': 'x' });
    const applied = await applySourceRewrites(root, [
      { file: '/etc/hosts', from: 'localhost', to: 'evil', reason: 'x' },
    ]);
    expect(applied).toEqual([]);
  });

  it('refuses a symlink that points out of the clone', async () => {
    // A string test on the path would pass this. Only resolving it does not.
    const root = await repo({ 'a.js': 'x' });
    const outside = await mkdtemp(join(tmpdir(), 'devlaunch-link-'));
    scratch.push(outside);
    const target = join(outside, 'secret.txt');
    await writeFile(target, 'http://localhost:8000');
    await symlink(target, join(root, 'link.txt'));

    const applied = await applySourceRewrites(root, [
      { file: 'link.txt', from: 'http://localhost:8000', to: 'evil', reason: 'x' },
    ]);
    expect(applied).toEqual([]);
    expect(await readFile(target, 'utf8')).toBe('http://localhost:8000');
  });

  it('leaves a file too large to be a config alone', async () => {
    // A minified bundle is not something anyone hand-wrote a proxy target into.
    const root = await repo({ 'big.js': `${'x'.repeat(600_000)}http://localhost:8000` });
    const applied = await applySourceRewrites(root, [
      { file: 'big.js', from: 'http://localhost:8000', to: 'http://api:8000', reason: 'x' },
    ]);
    expect(applied).toEqual([]);
  });
});

describe('repointing a host', () => {
  it('changes the host and nothing else when no port is given', async () => {
    expect(repointHost('http://localhost:8000/api/v1', 'api')).toBe('http://api:8000/api/v1');
  });

  it('changes the port too when the caller knows where the service listens', () => {
    // The port in the literal describes the author's own machine. Keeping it produced
    // `http://backend:5001` against a service listening on 3000 — the same 502 the
    // rewrite exists to prevent, now with a plausible-looking host.
    expect(repointHost('http://localhost:5001', 'backend', 3000)).toBe('http://backend:3000');
  });

  it('adds a port to a target that had none', () => {
    expect(repointHost('http://localhost/api', 'backend', 3000)).toBe('http://backend:3000/api');
  });

  it('leaves a target that already names a reachable host', () => {
    // `http://api:8000` is what the fix looks like. Rewriting it would be a no-op at
    // best and wrong at worst.
    expect(repointHost('http://api:8000', 'other')).toBeNull();
  });

  it('recognises every spelling of loopback', () => {
    expect(repointHost('http://127.0.0.1:5000', 'api')).toBe('http://api:5000');
    expect(repointHost('http://[::1]:5000', 'api')).toBe('http://api:5000');
  });

  it('says nothing about a string that is not a URL', () => {
    expect(repointHost('/api', 'api')).toBeNull();
  });
});

describe('repointing a database URL', () => {
  it('replaces the whole URL, not only its host', async () => {
    // The credentials and database name in the literal describe a server on the author's
    // machine. Repointing the host alone produces `password authentication failed`,
    // which looks like a DevLaunch bug rather than a hardcoded credential.
    const out = databaseUrlRewrite(
      'database.py',
      'postgresql://postgres:test1234!@localhost/TodoApplicationDatabase',
      'postgresql://postgres:devlaunch@postgres:5432/todo-list-fastapi',
    );
    expect(out?.to).toBe('postgresql://postgres:devlaunch@postgres:5432/todo-list-fastapi');
  });

  it('leaves a URL that already points somewhere reachable', () => {
    expect(databaseUrlRewrite('db.py', 'postgresql://u:p@db:5432/x', 'postgresql://a@b/c')).toBeNull();
  });

  it('does nothing when the literal is already what we would write', () => {
    // Reporting an edit that changed nothing is worse than reporting no edit: it tells
    // someone their code was modified when it was not.
    const url = 'postgresql://postgres:devlaunch@localhost:5432/x';
    expect(databaseUrlRewrite('db.py', url, url)).toBeNull();
  });
});

describe('which proxy targets a project would repoint', () => {
  const service = (over: Record<string, unknown>) =>
    ({ name: 'x', role: 'web', workingDirectory: '.', expectedPort: 5173, ...over }) as never;

  const api = service({ name: 'backend', role: 'api', workingDirectory: 'backend', expectedPort: 3000 });
  const web = service({ name: 'frontend', role: 'web', workingDirectory: 'frontend', expectedPort: 5173 });

  it('names the file relative to the repository root, not to the service', async () => {
    // The rewrite is applied at the clone root; a path relative to `frontend/` would
    // miss, silently, and the project would reach READY answering nothing.
    const { proxyRewrites } = await import('../services/execution/ProjectExecutor.js');
    const out = proxyRewrites(
      [api, web],
      { frontend: { file: 'vite.config.js', target: 'http://localhost:5001' } },
      api,
      'backend',
    );
    expect(out[0]?.file).toBe('frontend/vite.config.js');
  });

  it('points at the port the API was planned on, not the one the literal names', async () => {
    const { proxyRewrites } = await import('../services/execution/ProjectExecutor.js');
    const out = proxyRewrites(
      [api, web],
      { frontend: { file: 'vite.config.js', target: 'http://localhost:5001' } },
      api,
      'backend',
    );
    expect(out[0]?.to).toBe('http://backend:3000');
  });

  it('uses the alias the project actually claimed', async () => {
    // Another running project may already answer to `backend`, in which case this one is
    // reachable only as the scoped name — and pointing a config file at a name this
    // project does not have would be worse than leaving it alone.
    const { proxyRewrites } = await import('../services/execution/ProjectExecutor.js');
    const out = proxyRewrites(
      [api, web],
      { frontend: { file: 'vite.config.js', target: 'http://localhost:5001' } },
      api,
      'backend-1a2b3c4d',
    );
    expect(out[0]?.to).toBe('http://backend-1a2b3c4d:3000');
  });

  it('proposes nothing for a service with no proxy', async () => {
    const { proxyRewrites } = await import('../services/execution/ProjectExecutor.js');
    expect(proxyRewrites([api, web], {}, api, 'backend')).toEqual([]);
  });

  it('proposes nothing for a proxy that already points at a reachable host', async () => {
    const { proxyRewrites } = await import('../services/execution/ProjectExecutor.js');
    const out = proxyRewrites(
      [api, web],
      { frontend: { file: 'vite.config.js', target: 'http://backend:3000' } },
      api,
      'backend',
    );
    expect(out).toEqual([]);
  });
});
