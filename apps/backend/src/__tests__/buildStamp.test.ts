import { describe, it, expect, beforeEach } from 'vitest';
import { buildStamp, recordRunningCommit, resetRunningCommit } from '../services/build/BuildStamp.js';

/**
 * The failure with no error message.
 *
 * A development server ran for five days. A fix landed twenty-nine minutes after it
 * started, and every launch afterwards was served by the code from before it — with the
 * same panels, the same diagnoses and the same confidence as a real failure. Hours went
 * into re-investigating bugs that were already fixed on disk, because nothing in the
 * system knew what it was running.
 */
describe('whether this process is running the code on disk', () => {
  beforeEach(resetRunningCommit);

  /** A checkout shaped like this one, so the behavioural paths exist. */
  async function repo() {
    const { mkdtemp, writeFile, mkdir } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join, dirname } = await import('node:path');
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);

    const dir = await mkdtemp(join(tmpdir(), 'devlaunch-stamp-'));
    const git = (...args: string[]) => run('git', args, { cwd: dir });
    const write = async (rel: string, body: string) => {
      await mkdir(dirname(join(dir, rel)), { recursive: true });
      await writeFile(join(dir, rel), body);
    };

    await git('init', '-q');
    await git('config', 'user.email', 't@example.com');
    await git('config', 'user.name', 'T');
    await write('apps/backend/src/a.ts', 'export const x = 1;');
    await write('packages/shared/src/b.ts', 'export const y = 1;');
    await write('docs/limitations.md', '# docs');
    await write('apps/frontend/src/App.tsx', 'export const App = 0;');
    await git('add', '-A');
    await git('commit', '-qm', 'one');
    return { dir, git, write };
  }


  it('is not stale when it started from the commit the tree is on', async () => {
    await recordRunningCommit(process.cwd());
    const stamp = await buildStamp(process.cwd());
    expect(stamp.running).toMatch(/^[0-9a-f]{40}$/);
    expect(stamp.head).toBe(stamp.running);
    expect(stamp.stale).toBe(false);
  });

  it('is stale when the behavioural source changes under it', async () => {
    const { dir, git, write } = await repo();
    await recordRunningCommit(dir);
    expect((await buildStamp(dir)).stale, 'nothing has changed yet').toBe(false);

    await write('apps/backend/src/a.ts', 'export const x = 2;');
    await git('add', '-A');
    await git('commit', '-qm', 'two');

    const stamp = await buildStamp(dir);
    expect(stamp.stale).toBe(true);
    expect(stamp.head).not.toBe(stamp.running);
  });

  it('is stale when the shared types change, not only the backend', async () => {
    // The Zod schemas and the state machine live there, and a plan validated against a
    // different shape is exactly the sort of difference this exists to catch.
    const { dir, git, write } = await repo();
    await recordRunningCommit(dir);

    await write('packages/shared/src/b.ts', 'export const y = 2;');
    await git('add', '-A');
    await git('commit', '-qm', 'shared');

    expect((await buildStamp(dir)).stale).toBe(true);
  });

  it('is not stale when a commit is reworded and nothing else changes', async () => {
    // The false positive that prompted this. `git commit --amend` on a message produces
    // a new SHA over a byte-identical tree, and comparing SHAs fired the banner against
    // code that had not moved. A warning that cries wolf is one people learn to dismiss
    // — and it would have been dismissed on the day it was finally right.
    const { dir, git } = await repo();
    await recordRunningCommit(dir);
    const before = await buildStamp(dir);

    await git('commit', '--amend', '-qm', 'a better sentence about the same code');

    const after = await buildStamp(dir);
    expect(after.stale, 'a reworded commit changes no behaviour').toBe(false);
    // And the commit on display did move, which is the honest thing to show.
    expect(after.head).not.toBe(before.head);
  });

  it('is not stale for a commit that cannot change an answer', async () => {
    // Docs, fixtures and the frontend. A run is planned and diagnosed by the backend
    // and the shared types; a README that moved is not a reason to distrust a result,
    // and firing for it is how the real signal gets buried.
    const { dir, git, write } = await repo();
    await recordRunningCommit(dir);

    await write('docs/limitations.md', '# changed');
    await write('apps/frontend/src/App.tsx', 'export const App = 1;');
    await git('add', '-A');
    await git('commit', '-qm', 'docs and frontend');

    expect((await buildStamp(dir)).stale).toBe(false);
  });

  it('is stale for an edit that was never committed', async () => {
    // The commonest kind of stale there is: a server started, then a file saved. It is
    // running the version from before the save just as surely as before a commit.
    const { dir, write } = await repo();
    await recordRunningCommit(dir);
    expect((await buildStamp(dir)).stale).toBe(false);

    await write('apps/backend/src/a.ts', 'export const x = 99;');

    expect((await buildStamp(dir)).stale).toBe(true);
  });

  it('notices a second edit to a file that was already modified', async () => {
    // The hole a live check found and every unit test here missed, because each of them
    // happened to edit a file that was clean beforehand. `git status --porcelain` names
    // the modified files and says nothing about their contents, so editing an
    // already-modified file left the fingerprint identical — and that is the ordinary
    // rhythm of development, one file saved over and over while a server runs.
    const { dir, write } = await repo();
    await write('apps/backend/src/a.ts', 'export const x = 2;');
    await recordRunningCommit(dir);
    expect((await buildStamp(dir)).stale, 'started against this edit').toBe(false);

    await write('apps/backend/src/a.ts', 'export const x = 3;');

    expect((await buildStamp(dir)).stale, 'the same file, changed again').toBe(true);
  });

  it('notices a file that did not exist when it started', async () => {
    const { dir, write } = await repo();
    await recordRunningCommit(dir);

    await write('apps/backend/src/new.ts', 'export const z = 1;');

    expect((await buildStamp(dir)).stale).toBe(true);
  });

  it('says nothing at all outside a checkout', async () => {
    // No git, a deployment without the repository beside it, a directory this process
    // cannot read. None of them is evidence of staleness, and a banner that fires on
    // every one of them is a banner nobody reads by the second week.
    resetRunningCommit();
    await recordRunningCommit('/nonexistent-devlaunch-probe');
    const stamp = await buildStamp('/nonexistent-devlaunch-probe');
    expect(stamp.running).toBeUndefined();
    expect(stamp.head).toBeUndefined();
    expect(stamp.stale).toBe(false);
  });

  it('cannot change its mind about what it is running', async () => {
    // A process does not change commits without restarting. If `running` could be
    // re-resolved, it would silently track HEAD and the comparison would always agree
    // with itself — which is precisely the bug, reimplemented.
    await recordRunningCommit(process.cwd());
    const first = (await buildStamp(process.cwd())).running;
    await recordRunningCommit('/nonexistent-devlaunch-probe');
    expect((await buildStamp(process.cwd())).running).toBe(first);
  });

  it('reports when this process started, so uptime is answerable', async () => {
    const stamp = await buildStamp(process.cwd());
    expect(stamp.startedAt).toBeLessThanOrEqual(Date.now());
    expect(stamp.startedAt).toBeGreaterThan(Date.now() - 600_000);
  });
});
