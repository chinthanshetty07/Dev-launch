import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ExecutionState, FailureCode, RunPlanSchema, type RunPlan } from '@devlaunch/shared';
import { DockerManager } from '../../services/docker/DockerManager.js';
import { ExecutionManager } from '../../services/execution/ExecutionManager.js';
import { SessionManager } from '../../services/session/SessionManager.js';
import { RepositoryAnalyzer } from '../../services/analysis/RepositoryAnalyzer.js';
import { RuleBasedPlanner } from '../../services/planning/RuleBasedPlanner.js';
import { CleanupManager } from '../../services/cleanup/CleanupManager.js';

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../fixtures');
const IMAGE = 'devlaunch/node:20';

const docker = new DockerManager();
const analyzer = new RepositoryAnalyzer();
const created: SessionManager[] = [];

function plan(overrides: Partial<RunPlan> = {}): RunPlan {
  return RunPlanSchema.parse({
    runtime: { language: 'node', version: '20' },
    packageManager: 'npm',
    installCommand: null,
    buildCommand: null,
    startCommand: 'node server.js',
    workingDirectory: '.',
    expectedPort: 3000,
    hostBinding: 'forced',
    planSource: 'rule-based',
    ...overrides,
  });
}

function newManager(livenessIntervalMs = 300): SessionManager {
  const mgr = new SessionManager(new ExecutionManager(docker), {
    analyzer,
    planner: new RuleBasedPlanner(analyzer),
    livenessIntervalMs,
  });
  created.push(mgr);
  return mgr;
}

async function until(
  sessions: SessionManager,
  id: string,
  states: ExecutionState[],
  timeoutMs = 60_000,
): Promise<ExecutionState> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = sessions.get(id);
    if (s && states.includes(s.state)) return s.state;
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${states.join('/')}; session is ${s?.state}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('a READY session that stops being ready', () => {
  beforeAll(async () => {
    await docker.ping();
    await docker.ensureImage(IMAGE);
  }, 300_000);

  afterAll(async () => {
    for (const mgr of created) await mgr.shutdown();
    await CleanupManager.sweepOrphans(docker);
  }, 120_000);

  it('notices that the application died after serving traffic', async () => {
    // Readiness is a measurement, not a promise. This fixture answers a real request
    // and then exits 3 of its own accord; before the liveness watch the session went
    // on reporting READY, with a URL that answered nothing, until the idle clock
    // expired half an hour later.
    const sessions = newManager();
    const s = await sessions.launch({
      sourceDir: `${FIXTURES}/node-dies-after-ready`,
      plan: plan(),
      image: IMAGE,
    });

    expect(await until(sessions, s.id, [ExecutionState.READY])).toBe(ExecutionState.READY);
    const url = s.url!;
    expect(url).toMatch(/^http:\/\/localhost:\d+\//);
    // It is genuinely serving before it dies, so the death cannot be confused with a
    // start-up failure.
    expect((await fetch(url)).status).toBe(200);

    await until(sessions, s.id, [ExecutionState.FAILED, ExecutionState.COMPLETED]);
    expect(s.state).toBe(ExecutionState.FAILED);
    expect(s.failure?.code).toBe(FailureCode.APPLICATION_EXITED);
    expect(s.failure?.exitCode).toBe(3);
    // The app's own last words, kept as evidence.
    expect(s.failure?.evidence).toMatch(/exiting on purpose/);
    // A dead URL must not still be advertised.
    expect(s.url).toBeUndefined();

    // And the container is actually released, rather than the session merely relabelled.
    const orphans = await docker.listManaged();
    expect(orphans.map((c) => c.Id)).not.toContain(s.handle?.container.id);
  }, 180_000);

  it('notices that the container was killed from outside', async () => {
    const sessions = newManager();
    const s = await sessions.launch({
      sourceDir: `${FIXTURES}/node-http-basic`,
      plan: plan(),
      image: IMAGE,
    });
    expect(await until(sessions, s.id, [ExecutionState.READY])).toBe(ExecutionState.READY);

    // SIGKILL to PID 1, which is the application: the process gets no chance to log
    // anything, so the exit code is the only evidence there is.
    await s.handle!.container.kill();

    await until(sessions, s.id, [ExecutionState.FAILED, ExecutionState.COMPLETED]);
    expect(s.state).toBe(ExecutionState.FAILED);
    expect(s.failure?.code).toBe(FailureCode.APPLICATION_EXITED);
    expect(s.failure?.message).toContain('SIGKILL');
  }, 180_000);

  it('keeps a ready application alive past the time-to-ready budget', async () => {
    // The budget stops the container when it elapses. That is right for a container
    // that never became ready, and wrong for one that did: it put a hard ceiling on
    // every session, well under the lifetime clock, with nothing to explain it.
    const exec = new ExecutionManager(docker);
    const handle = await exec.launch({
      sessionId: 'live-budget',
      plan: plan(),
      sourceDir: `${FIXTURES}/node-http-basic`,
      image: IMAGE,
      timeoutMs: 2_000,
    });
    try {
      const outcome = await handle.waitForReady(30_000);
      expect(outcome.state).toBe(ExecutionState.READY);
      handle.clearStartupBudget();

      // Comfortably past the budget it was launched with.
      await new Promise((r) => setTimeout(r, 6_000));

      const info = await docker.inspect(handle.container);
      expect(info.State.Running, 'a ready application must outlive the startup budget').toBe(true);
      expect((await fetch(outcome.url!)).status).toBe(200);
    } finally {
      await handle.cleanup();
    }
  }, 180_000);

  it('still stops a container that never becomes ready', async () => {
    // The other half of the same claim: lifting the budget on READY must not disarm it
    // for an application that never gets there.
    const exec = new ExecutionManager(docker);
    const handle = await exec.launch({
      sessionId: 'live-budget-enforced',
      plan: plan(),
      sourceDir: `${FIXTURES}/node-never-listens`,
      image: IMAGE,
      timeoutMs: 3_000,
    });
    try {
      const exit = await handle.exit;
      expect(exit.timedOut).toBe(true);
      const info = await docker.inspect(handle.container);
      expect(info.State.Running).toBe(false);
    } finally {
      await handle.cleanup();
    }
  }, 180_000);
});
