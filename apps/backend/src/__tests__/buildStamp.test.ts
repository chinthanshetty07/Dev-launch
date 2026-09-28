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

  it('is not stale when it started from the commit the tree is on', async () => {
    await recordRunningCommit(process.cwd());
    const stamp = await buildStamp(process.cwd());
    expect(stamp.running).toMatch(/^[0-9a-f]{40}$/);
    expect(stamp.head).toBe(stamp.running);
    expect(stamp.stale).toBe(false);
  });

  it('is stale when the tree has moved on under it', async () => {
    // A real repository that gains a commit after the process started, which is exactly
    // what a pull or a rebuild does underneath a long-running dev server.
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);

    const dir = await mkdtemp(join(tmpdir(), 'devlaunch-stamp-'));
    const git = (...args: string[]) => run('git', args, { cwd: dir });
    await git('init', '-q');
    await git('config', 'user.email', 't@example.com');
    await git('config', 'user.name', 'T');
    await writeFile(join(dir, 'a.txt'), 'one');
    await git('add', '-A');
    await git('commit', '-qm', 'one');

    await recordRunningCommit(dir);
    expect((await buildStamp(dir)).stale, 'nothing has changed yet').toBe(false);

    await writeFile(join(dir, 'a.txt'), 'two');
    await git('add', '-A');
    await git('commit', '-qm', 'two');

    const stamp = await buildStamp(dir);
    expect(stamp.stale).toBe(true);
    expect(stamp.head).not.toBe(stamp.running);
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
