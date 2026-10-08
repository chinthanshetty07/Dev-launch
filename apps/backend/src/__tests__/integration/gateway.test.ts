import { describe, it, expect, afterAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ExecutionState } from '@devlaunch/shared';
import { DockerManager } from '../../services/docker/DockerManager.js';
import { ExecutionManager } from '../../services/execution/ExecutionManager.js';
import { SessionManager } from '../../services/session/SessionManager.js';
import { RepositoryAnalyzer } from '../../services/analysis/RepositoryAnalyzer.js';
import { RuleBasedPlanner } from '../../services/planning/RuleBasedPlanner.js';
import { ProjectPlanner } from '../../services/planning/ProjectPlanner.js';
import { CleanupManager } from '../../services/cleanup/CleanupManager.js';

/**
 * A project written to sit behind nginx, run for real: its page calls `/api/...` on its own
 * address. Without DevLaunch's gateway those calls reached the frontend and came back 404
 * (`jamall-mahmoudi-dev/django-react-production-stack`, "Cannot POST /api/create_post/").
 */
const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../fixtures');
const docker = new DockerManager();
const analyzer = new RepositoryAnalyzer();
const planner = new RuleBasedPlanner(analyzer);
const mgr = new SessionManager(new ExecutionManager(docker), {
  analyzer, planner, projectPlanner: new ProjectPlanner(analyzer, planner), smokeTest: true,
});

afterAll(async () => {
  await mgr.shutdown();
  await CleanupManager.sweepOrphans(docker);
}, 120_000);

describe('a project written to sit behind nginx', () => {
  it('is given one address at which the page and its /api calls both work, gone when it stops', async () => {
    const s = await mgr.launch({ sourceDir: `${FIXTURES}/project-behind-nginx` });
    const deadline = Date.now() + 240_000;
    while (!([ExecutionState.READY, ExecutionState.PARTIALLY_READY, ExecutionState.FAILED] as ExecutionState[]).includes(s.state)) {
      if (Date.now() > deadline) {
        const tail = s.logs.buffer.all().slice(-25).map((l) => l.text).join('\n');
        throw new Error(`timed out in ${s.state}; last log lines:\n${tail}`);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(s.state, JSON.stringify(s.failure)).toBe(ExecutionState.READY);

    const frontend = s.run!.services.find((sv) => sv.role === 'web')!;
    const address = s.url!;
    expect(address).not.toBe(frontend.url);

    // The page, and its API call with a body, at the one address.
    expect(await (await fetch(address)).text()).toContain('behind nginx');
    const posted = await (await fetch(new URL('/api/create_post/', address), { method: 'POST', body: '{"name":"Test"}' })).json();
    expect(posted).toMatchObject({ from: 'backend', method: 'POST', path: '/api/create_post/', body: '{"name":"Test"}' });
    // The same call at the frontend's own address is what used to happen: a 404.
    expect((await fetch(new URL('/api/create_post/', frontend.url!), { method: 'POST' })).status).toBe(404);
    // The end-to-end check went through the address too.
    expect(s.verification?.checks.map((c) => c.name)).toEqual(expect.arrayContaining(['the project address answers']));

    await mgr.cancel(s.id);
    await expect(fetch(address)).rejects.toThrow();
  }, 360_000);
});
