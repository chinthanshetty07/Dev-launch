import { describe, it, expect } from 'vitest';
import { ExecutionState, FailureCode, RunPlanSchema, Sentinel } from '@devlaunch/shared';
import { SessionManager } from '../services/session/SessionManager.js';
import type { ExecutionManager, LaunchHandle, ReadyOutcome } from '../services/execution/ExecutionManager.js';
import { LogManager } from '../services/logs/LogManager.js';
import { dockerFramedInto } from './helpers/dockerFramed.js';
import { InMemoryHints } from '../services/execution/MemoryHints.js';

/**
 * A shared workspace install killed for memory — `horusyeung/nextjs-nestjs-fullstack-starter`.
 *
 * Both services install the same workspace, so they install one at a time. The first
 * install was OOM-killed at 1024 MB; the gate saw only that its container had stopped and
 * released the second service, which ran the same tree at the same limit and died the same
 * way. The first was then raised, alone, and the second never got a turn.
 *
 * Driven through the real session manager and the real project executor; only the
 * containers are fake. The install finishing is signalled the way a container signals it —
 * a sentinel through the framed stream — not by hand.
 */

const VM_5910 = 5910 * 1024 * 1024;
const ready = (name: string): ReadyOutcome => ({
  state: ExecutionState.READY, hostPort: '1', url: `http://localhost/${name}`,
  readiness: { ready: true, attempts: 1, elapsedMs: 1 } as ReadyOutcome['readiness'],
});

/** A container for `name` at `memoryMb`: its install fits at or above `fitsAt`, or is OOM-killed. */
function containers(fitsAt: number | null) {
  const launches: { name: string; memoryMb?: number }[] = [];
  /** The workspace each launch asked for, in launch order. */
  const keys: (string | undefined)[] = [];
  const exec = {
    docker: {
      networkExists: async () => false,
      claimedAliases: async () => new Set<string>(),
      hostMemoryBytes: async () => VM_5910,
    },
    async launch(o: { plan: { name?: string }; logs?: LogManager; memoryMb?: number; workspaceKey?: string }) {
      const name = o.plan.name ?? 'single';
      launches.push({ name, memoryMb: o.memoryMb });
      keys.push(o.workspaceKey);
      const logs = o.logs ?? new LogManager();
      const fits = fitsAt !== null && (o.memoryMb ?? 0) >= fitsAt;
      // What a real container does, measured: when yarn is OOM-killed the wrapper survives,
      // prints the shell's `Killed`, prints its install-failed marker, and only then exits
      // 110 — with Docker's OOMKilled set. The first version of this fake died without the
      // marker, which is not what happens, and the gate passed against it while releasing
      // the next service in the live run.
      const startedAt = Date.now();
      setTimeout(
        () => dockerFramedInto(logs, fits ? [Sentinel.INSTALL_BEGIN, Sentinel.INSTALL_OK] : [Sentinel.INSTALL_BEGIN, 'Killed', Sentinel.INSTALL_FAIL]),
        10,
      );
      return {
        container: { id: `${name}-${launches.length}` },
        logs,
        liveness: async () =>
          fits || Date.now() - startedAt < 150 ? { kind: 'running' } : { kind: 'exited', exitCode: 110, oomKilled: true },
        waitForReady: async (): Promise<ReadyOutcome> =>
          fits
            ? ready(name)
            : {
                state: ExecutionState.FAILED, hostPort: null, readiness: { ready: false, attempts: 0, elapsedMs: 0 } as ReadyOutcome['readiness'],
                failure: {
                  code: FailureCode.OUT_OF_MEMORY, message: 'killed', phase: 'install',
                  memory: { kind: 'container', limitMb: o.memoryMb ?? 0, detectedBy: ['docker: OOMKilled'] },
                },
              },
        clearStartupBudget: () => undefined,
        cleanup: async () => ({ errors: [] }),
      } as unknown as LaunchHandle;
    },
  } as unknown as ExecutionManager;
  return { exec, launches, keys };
}

const svc = (name: string, role: string, port: number) =>
  ({
    ...RunPlanSchema.parse({
      runtime: { language: 'node', version: '20' }, packageManager: 'yarn',
      installCommand: 'yarn install --immutable', installDirectory: '.', buildCommand: null,
      startCommand: 'npm run dev', workingDirectory: name, expectedPort: port, planSource: 'rule-based',
    }),
    name, role,
  }) as never;

function manager(exec: ExecutionManager, sharedInstall = true, memoryHints?: InMemoryHints) {
  return new SessionManager(exec, {
    ...(memoryHints ? { memoryHints } : {}),
    analyzer: {
      analyze: async () => ({
        warnings: [], envExample: [], lockfiles: [], frameworkConfigs: [],
        services: [
          { name: 'api', dir: 'packages/api', role: 'api', language: 'node', scripts: ['start:dev'], evidence: 'x' },
          { name: 'web', dir: 'apps/web', role: 'web', language: 'node', scripts: ['dev'], evidence: 'x' },
        ],
      }),
    } as never,
    planner: { planRepository: async () => ({ plan: null, detected: null, warnings: [] }) } as never,
    projectPlanner: {
      planProject: async () => ({
        plan: { services: [svc('api', 'api', 3000), svc('web', 'web', 3001)], planSource: 'rule-based', sharedInstall },
        skipped: [], warnings: [],
      }),
    } as never,
  });
}

async function settle(m: SessionManager, id: string) {
  const s = m.get(id)!;
  for (let i = 0; i < 400 && !([ExecutionState.READY, ExecutionState.FAILED, ExecutionState.PARTIALLY_READY] as ExecutionState[]).includes(s.state); i++) {
    await new Promise((r) => setTimeout(r, 25));
  }
  return { state: s.state, failure: s.failure, log: s.logs.buffer.all().map((l) => l.text).join('\n'), repairs: s.repairs ?? [] };
}

describe('a shared workspace install that runs out of memory', () => {
  it('raises the install in place, and starts the next service with what worked', async () => {
    const { exec, launches } = containers(2048);
    const m = manager(exec);
    const s = await m.launch({ sourceDir: '/tmp/repo' });
    const out = await settle(m, s.id);
    const session = m.get(s.id)!;
    await m.shutdown();

    expect(out.state, out.log.slice(-2000)).toBe(ExecutionState.READY);
    // api: killed at 1024, raised to 2048 in place. web: never started at 1024 to die the
    // same way — it began at the limit the shared install was shown to need.
    expect(launches).toEqual([
      { name: 'api', memoryMb: 1024 },
      { name: 'api', memoryMb: 2048 },
      { name: 'web', memoryMb: 2048 },
    ]);
    expect(out.repairs.map((r) => `${r.service}:${r.type}`)).toEqual(['api:MEMORY_LIMIT_RAISED']);
    expect(out.log).toMatch(/\[install\] api: Increasing memory: 1024 MB → 2048 MB/);
    // Still named after the containers are gone: the summary reads the project plan.
    // After shutdown the containers are gone and `run` with them.
    expect(m.installSummaries(session).map((i) => [i.service, i.packageManager, i.attempts, i.result])).toEqual([
      ['api', 'yarn', 2, 'success'],
      ['web', 'yarn', 1, 'success'],
    ]);
  });

  it('does not start the next service into a limit already shown to be too small', async () => {
    const { exec, launches } = containers(null);
    const m = manager(exec);
    const s = await m.launch({ sourceDir: '/tmp/repo' });
    const out = await settle(m, s.id);
    await m.shutdown();

    // api climbs the whole ladder; web, which installs the same tree, is never started.
    expect(launches).toEqual([
      { name: 'api', memoryMb: 1024 },
      { name: 'api', memoryMb: 2048 },
      { name: 'api', memoryMb: 4096 },
    ]);
    expect(out.state).toBe(ExecutionState.FAILED);
    expect(out.log).toMatch(/Not starting web: it installs the same workspace api could not install within 4096 MB/);
    expect(out.failure).toMatchObject({
      code: FailureCode.OUT_OF_MEMORY,
      memory: { limitMb: 4096, maximumMb: 4096, attempts: 3, retryable: false },
    });
  });
});


describe("the workspace a project's services keep", () => {
  it('is one between services that install the same workspace, so the second does not install it again', async () => {
    // ejazahm3d/fullstack-turborepo-starter: api installed the tree in 54 s, then web
    // installed the same tree again in 68 s.
    const { exec, keys } = containers(1024);
    const m = manager(exec, true);
    const s = await m.launch({ sourceDir: '/tmp/repo' });
    await settle(m, s.id);
    await m.shutdown();
    expect(keys).toEqual([`${s.id}:shared`, `${s.id}:shared`]);
  });

  it('is kept when a service is restarted', async () => {
    // api is killed for memory at 1024 MB and restarted at 2048: the restart must land in
    // the same workspace, or it cannot use anything already there.
    const { exec, keys, launches } = containers(2048);
    const m = manager(exec, true);
    const s = await m.launch({ sourceDir: '/tmp/repo' });
    await settle(m, s.id);
    await m.shutdown();
    expect(launches.map((l) => l.name)).toEqual(['api', 'api', 'web']);
    expect(keys).toEqual([`${s.id}:shared`, `${s.id}:shared`, `${s.id}:shared`]);
  });

  it('is one per service when they install separately', async () => {
    const { exec, keys } = containers(1024);
    const m = manager(exec, false);
    const s = await m.launch({ sourceDir: '/tmp/repo' });
    await settle(m, s.id);
    await m.shutdown();
    expect([...keys].sort()).toEqual([`${s.id}:api`, `${s.id}:web`]);
  });
});

describe('a project that needed more memory last time', () => {
  it('starts each service where its last run needed', async () => {
    const hints = new InMemoryHints();
    const first = containers(2048);
    const m1 = manager(first.exec, true, hints);
    const s1 = await m1.launch({ sourceDir: '/tmp/repo' });
    await settle(m1, s1.id);
    await m1.shutdown();
    await new Promise((r) => setTimeout(r, 20));
    expect(first.launches.map((l) => l.memoryMb)).toEqual([1024, 2048, 2048]);

    const second = containers(2048);
    const m2 = manager(second.exec, true, hints);
    const s2 = await m2.launch({ sourceDir: '/tmp/repo' });
    const out = await settle(m2, s2.id);
    await m2.shutdown();
    expect(out.state).toBe(ExecutionState.READY);
    // No try wasted at 1024 MB.
    expect(second.launches).toEqual([
      { name: 'api', memoryMb: 2048 },
      { name: 'web', memoryMb: 2048 },
    ]);
    expect(out.log).toMatch(/\[install\] api: Starting with 2048 MB instead of 1024 MB/);
  });
});
