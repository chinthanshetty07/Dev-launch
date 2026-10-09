import { describe, it, expect } from 'vitest';
import { ensureDocker, type WakeDeps } from '../services/docker/DockerWake.js';

/**
 * Starting Docker when it is stopped. On a Mac Docker lives in the Colima VM; after a
 * restart it was stopped, and every run failed until the person typed `colima start`.
 */

// What `colima list --json` prints, one profile per line.
const STOPPED = '{"name":"default","status":"Stopped","arch":"aarch64","cpus":4,"runtime":"docker"}\n';
const RUNNING = '{"name":"default","status":"Running","arch":"aarch64","cpus":4,"runtime":"docker"}\n';

function machine(over: { up?: boolean; list?: string | Error; startFails?: boolean; env?: NodeJS.ProcessEnv } = {}) {
  let up = over.up ?? false;
  const calls: string[] = [];
  const deps: WakeDeps = {
    ping: async () => up,
    run: async (cmd, args) => {
      calls.push(`${cmd} ${args.join(' ')}`);
      if (args[0] === 'list') {
        if (over.list instanceof Error) throw over.list;
        return over.list ?? STOPPED;
      }
      if (args[0] === 'start') {
        await new Promise((r) => setTimeout(r, 20));
        if (over.startFails) throw new Error('exit status 1\nFATA error starting vm');
        up = true;
      }
      return '';
    },
    sleep: async () => {},
    env: over.env ?? {},
  };
  return { deps, calls };
}

describe('starting Docker when it is stopped', () => {
  it('does nothing when Docker is answering', async () => {
    const m = machine({ up: true });
    expect(await ensureDocker(m.deps)).toEqual({ state: 'running' });
    expect(m.calls).toEqual([]);
  });

  it('starts a stopped Colima VM, and says so', async () => {
    const m = machine();
    const said: string[] = [];
    expect(await ensureDocker({ ...m.deps, log: (l) => said.push(l) })).toEqual({ state: 'started', how: 'Colima' });
    expect(m.calls).toEqual(['colima list --json', 'colima start']);
    expect(said[0]).toMatch(/Docker is stopped\. Starting Colima/);
  });

  it('starts it once when the dashboard and a run ask together', async () => {
    const m = machine();
    const [a, b] = await Promise.all([ensureDocker(m.deps), ensureDocker(m.deps)]);
    expect(a).toEqual(b);
    expect(m.calls.filter((c) => c === 'colima start')).toHaveLength(1);
  });

  it('starts nothing that is not a stopped Colima VM of this person\'s', async () => {
    // Colima not installed: Docker comes from elsewhere.
    const none = machine({ list: Object.assign(new Error('spawn colima ENOENT'), { code: 'ENOENT' }) });
    expect(await ensureDocker(none.deps)).toMatchObject({ state: 'down', why: expect.stringMatching(/Colima is not installed/) });
    // Installed, but no VM: `colima start` would create and download one.
    const noVm = machine({ list: '' });
    expect(await ensureDocker(noVm.deps)).toMatchObject({ state: 'down', why: expect.stringMatching(/no Colima VM/) });
    // Running, yet Docker silent: starting it again would not help.
    const running = machine({ list: RUNNING });
    expect(await ensureDocker(running.deps)).toMatchObject({ state: 'down', why: expect.stringMatching(/Colima is running/) });
    // Turned off.
    const off = machine({ env: { DEVLAUNCH_START_DOCKER: '0' } });
    expect(await ensureDocker(off.deps)).toMatchObject({ state: 'down', why: expect.stringMatching(/turned off/) });
    for (const m of [none, noVm, running, off]) expect(m.calls).not.toContain('colima start');
  });

  it('reports a start that failed, rather than waiting on it', async () => {
    const m = machine({ startFails: true });
    expect(await ensureDocker(m.deps)).toMatchObject({ state: 'down', why: expect.stringMatching(/starting Colima failed: exit status 1/) });
  });
});
