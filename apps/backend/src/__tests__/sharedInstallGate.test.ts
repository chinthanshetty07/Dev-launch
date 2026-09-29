import { describe, it, expect } from 'vitest';
import { ProjectPlanSchema, RunPlanSchema, type ServiceRunPlan } from '@devlaunch/shared';
import { ProjectExecutor } from '../services/execution/ProjectExecutor.js';
import type { ExecutionManager } from '../services/execution/ExecutionManager.js';
import { LogManager } from '../services/logs/LogManager.js';
import { Sentinel } from '@devlaunch/shared';
import { dockerFramedInto } from './helpers/dockerFramed.js';

/**
 * The gate at the call site, not the waiting primitive.
 *
 * `waitForInstall` has its own tests. What none of them touch is whether the launch
 * loop ever calls it, for which services, and whether a non-workspace project is left
 * alone — all of which survived deletion.
 */

const service = (name: string, role: 'api' | 'web'): ServiceRunPlan => ({
  ...RunPlanSchema.parse({
    runtime: { language: 'node', version: '20' },
    packageManager: 'pnpm',
    installCommand: 'pnpm install',
    buildCommand: null,
    startCommand: 'pnpm dev',
    workingDirectory: name,
    expectedPort: 3000,
    planSource: 'rule-based',
  }),
  name,
  role,
});

/**
 * Records launch order and lets a test decide when each service finishes installing.
 *
 * `announce` writes the real INSTALL_OK sentinel into that service's own LogManager,
 * which is the only thing the gate listens to.
 */
function execDouble() {
  const launched: string[] = [];
  const streams = new Map<string, LogManager>();
  const exec = {
    // The launch path asks the network which aliases are already claimed, so another
    // project's service of the same name cannot steal traffic. Nothing here needs a
    // real network; an empty claim is the ordinary case.
    docker: {
      networkExists: async () => false,
      claimedAliases: async () => new Set<string>(),
    },
    async launch(o: { plan: { name?: string }; logs: LogManager }) {
      const name = o.plan.name ?? 'unnamed';
      launched.push(name);
      streams.set(name, o.logs);
      return {
        logs: o.logs,
        liveness: async () => ({ kind: 'running' as const }),
        waitForReady: async () => ({ state: 'READY', hostPort: '3000', readiness: { ready: true, attempts: 1, elapsedMs: 1 } }),
        clearStartupBudget: () => undefined,
        cleanup: async () => ({ errors: [] }),
      };
    },
  } as unknown as ExecutionManager;
  return {
    launched,
    exec,
    announce(name: string) {
      const logs = streams.get(name);
      // Through the real ingestion path. `logs.write` would put the text in the buffer
      // and never emit it on the 'sentinel' channel the gate actually listens to.
      if (logs) dockerFramedInto(logs, [Sentinel.INSTALL_OK]);
    },
  };
}

const project = (sharedInstall: boolean) =>
  ProjectPlanSchema.parse({
    services: [service('api', 'api'), service('web', 'web')],
    planSource: 'rule-based',
    ...(sharedInstall ? { sharedInstall: true } : {}),
  });

function launch(d: ReturnType<typeof execDouble>, shared: boolean) {
  return new ProjectExecutor(d.exec).launch({
    sessionId: 'gate-test',
    project: project(shared),
    sourceDir: '/tmp/repo',
    logs: new LogManager(),
  } as never);
}

/** True once `name` has been launched, polled rather than awaited. */
const started = (d: { launched: string[] }, name: string) => d.launched.includes(name);

async function settle(ms = 120): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe('one workspace install at a time', () => {
  it('does not start the second service until the first says it installed', async () => {
    const d = execDouble();
    const run = launch(d, true);
    await settle();

    // The decisive observation: api is up, web is not, and nothing but the missing
    // sentinel is holding it.
    expect(started(d, 'api')).toBe(true);
    expect(started(d, 'web'), 'web must wait for api to finish installing').toBe(false);

    d.announce('api');
    await settle();
    expect(started(d, 'web')).toBe(true);
    await run;
  });

  it('starts both at once when the project does not share an install', async () => {
    // Sequencing costs wall-clock. A repository whose services install different trees
    // must not pay it.
    const d = execDouble();
    const run = launch(d, false);
    await settle();

    expect(d.launched).toEqual(['api', 'web']);
    await run;
  });

  it('does not make the last service wait for nobody', async () => {
    // Nothing is queued behind the final service, so waiting for its install would add
    // the full timeout to every workspace run for no benefit at all.
    const d = execDouble();
    const run = launch(d, true);
    await settle();
    d.announce('api');
    await settle();
    expect(started(d, 'web')).toBe(true);

    // web never announces, and the run still completes without burning the budget.
    const finished = await Promise.race([run.then(() => 'done'), settle(500).then(() => 'hung')]);
    expect(finished, 'the last service must not be waited on').toBe('done');
  });
});
