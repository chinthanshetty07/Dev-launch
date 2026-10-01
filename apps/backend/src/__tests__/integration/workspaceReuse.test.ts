import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ExecutionState, RunPlanSchema, Sentinel, type RunPlan } from '@devlaunch/shared';
import { DockerManager } from '../../services/docker/DockerManager.js';
import { ExecutionManager } from '../../services/execution/ExecutionManager.js';
import { CleanupManager } from '../../services/cleanup/CleanupManager.js';
import { RepositoryAnalyzer } from '../../services/analysis/RepositoryAnalyzer.js';
import { RuleBasedPlanner } from '../../services/planning/RuleBasedPlanner.js';
import { imageForRuntime } from '../../services/security/ImageAllowlist.js';
import { LogManager } from '../../services/logs/LogManager.js';
import { cacheVolumeFor } from '../../services/docker/ContainerSecurity.js';

/**
 * A session's containers keep what an earlier one installed, against real Docker.
 *
 * Every restart used to start from an empty workspace and install everything again — a
 * repair that changed only a port reinstalled the whole tree. Measured on
 * `ejazahm3d/fullstack-turborepo-starter`: three installs of one tree, 197 of 222 seconds.
 */
const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../fixtures');
const docker = new DockerManager();
const REUSED = /The packages are already installed/;

async function run(exec: ExecutionManager, sessionId: string, fixture: string, plan: RunPlan, readyMs = 120_000) {
  const logs = new LogManager();
  const started = Date.now();
  const handle = await exec.launch({
    sessionId, plan, sourceDir: `${FIXTURES}/${fixture}`, logs,
    image: imageForRuntime(plan.runtime.language, plan.runtime.version),
    workspaceKey: `${sessionId}:app`,
    // As a session mounts it; without one /cache is on the read-only root filesystem.
    packageCacheVolume: cacheVolumeFor(`fixture:${fixture}`),
  });
  try {
    const outcome = await handle.waitForReady(readyMs);
    const log = logs.buffer.all().map((l) => l.text).join('\n');
    return { outcome, log, ms: Date.now() - started };
  } finally {
    await handle.cleanup();
  }
}

describe('a workspace kept between the containers of a session', () => {
  let vite: RunPlan;
  beforeAll(async () => {
    await docker.ping();
    const out = await new RuleBasedPlanner(new RepositoryAnalyzer()).planRepository(`${FIXTURES}/node-vite-app`);
    // The fixture's package-lock.json is an empty placeholder, which `npm ci` refuses; a
    // session relaxes that by rule, and this test is about reuse, not lockfiles.
    vite = RunPlanSchema.parse({ ...out.plan!, installCommand: 'npm install --no-audit --no-fund' });
  }, 120_000);
  afterAll(async () => {
    await CleanupManager.sweepOrphans(docker);
  });

  it('skips an install that already finished, and the application still serves', async () => {
    const exec = new ExecutionManager(docker);
    const first = await run(exec, 'it-ws-reuse', 'node-vite-app', vite);
    expect(first.outcome.state, first.log.slice(-1500)).toBe(ExecutionState.READY);
    expect(first.log).not.toMatch(REUSED);

    // A repair that changes only the port: the same install, so nothing to install.
    const moved = RunPlanSchema.parse({ ...vite, startCommand: vite.startCommand.replace(/\d{4}/, '5174'), expectedPort: 5174 });
    const second = await run(exec, 'it-ws-reuse', 'node-vite-app', moved);
    expect(second.outcome.state, second.log.slice(-1500)).toBe(ExecutionState.READY);
    expect(second.log).toMatch(REUSED);
    expect(second.log).not.toMatch(/added \d+ packages/);

    await exec.releaseWorkspaces('it-ws-reuse');
    expect(await docker.listWorkspaceVolumes({ sessionId: 'it-ws-reuse' })).toEqual([]);
  }, 400_000);

  it('installs again when the install command changes', async () => {
    const exec = new ExecutionManager(docker);
    const first = await run(exec, 'it-ws-changed', 'node-vite-app', vite);
    expect(first.outcome.state).toBe(ExecutionState.READY);

    const other = RunPlanSchema.parse({ ...vite, installCommand: `${vite.installCommand} --prefer-offline` });
    const second = await run(exec, 'it-ws-changed', 'node-vite-app', other);
    expect(second.outcome.state, second.log.slice(-1500)).toBe(ExecutionState.READY);
    expect(second.log).not.toMatch(REUSED);
    // The first workspace was removed when the second replaced it.
    expect(await docker.listWorkspaceVolumes({ sessionId: 'it-ws-changed' })).toHaveLength(1);
    await exec.releaseWorkspaces('it-ws-changed');
  }, 400_000);

  it('never reuses an install that was cut off before it finished', async () => {
    // A container stopped, or killed whole, mid-install says neither OK nor FAIL. What it
    // left behind is half a tree, and must be installed again, not trusted.
    const exec = new ExecutionManager(docker);
    const logs = new LogManager();
    const begun = new Promise<void>((r) => logs.on('sentinel', (m: string) => { if (m === Sentinel.INSTALL_BEGIN) r(); }));
    const handle = await exec.launch({
      sessionId: 'it-ws-cut', plan: vite, sourceDir: `${FIXTURES}/node-vite-app`, logs,
      image: imageForRuntime(vite.runtime.language, vite.runtime.version),
      workspaceKey: 'it-ws-cut:app', packageCacheVolume: cacheVolumeFor('fixture:node-vite-app'),
    });
    await begun;
    await handle.cleanup();

    const again = await run(exec, 'it-ws-cut', 'node-vite-app', vite);
    expect(again.outcome.state, again.log.slice(-1500)).toBe(ExecutionState.READY);
    expect(again.log).not.toMatch(REUSED);
    await exec.releaseWorkspaces('it-ws-cut');
  }, 400_000);

  it('never reuses an install that failed', async () => {
    // npm ci with no lockfile fails. The second attempt runs it again rather than
    // trusting what the first left behind.
    const exec = new ExecutionManager(docker);
    const failing = RunPlanSchema.parse({
      runtime: { language: 'node', version: '20' }, packageManager: 'npm', installCommand: 'npm ci',
      buildCommand: null, startCommand: 'node main.js', workingDirectory: '.', expectedPort: 3000, planSource: 'rule-based',
    });
    for (let i = 0; i < 2; i++) {
      const r = await run(exec, 'it-ws-failed', 'node-install-fail', failing, 60_000);
      expect(r.outcome.state).toBe(ExecutionState.FAILED);
      expect(r.log).not.toMatch(REUSED);
    }
    await exec.releaseWorkspaces('it-ws-failed');
    expect(await docker.listWorkspaceVolumes({ sessionId: 'it-ws-failed' })).toEqual([]);
  }, 400_000);
});
