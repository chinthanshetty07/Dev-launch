import { describe, it, expect } from 'vitest';
import { RunPlanSchema } from '@devlaunch/shared';
import { BuildSandbox, buildCapProblem, buildOptions, builtImageTag } from '../services/docker/BuildSandbox.js';
import { buildRepoImageHostConfig } from '../services/docker/ContainerSecurity.js';
import { RunPlanValidator } from '../services/planning/RunPlanValidator.js';
import { dockerProjectPlan } from '../services/docker/RepoDockerRunner.js';
import { SessionManager } from '../services/session/SessionManager.js';
import type { ExecutionManager } from '../services/execution/ExecutionManager.js';
import { config } from '../config/index.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('the build sandbox', () => {
  const opts = buildOptions({ sessionId: 'abc-session', service: 'api', contextDir: '/r/api', dockerfile: '/r/api/Dockerfile' }, 2048, 2);

  it('runs every build step on DevLaunch\'s network, under its limits', () => {
    // Measured: on Docker's default network a RUN step reached the home router, the
    // metadata address and the VM; on devlaunch-net all three were dropped.
    expect(opts.networkmode).toBe(config.docker.networkName);
    expect(opts.version).toBe('1');
    expect(opts.memory).toBe(2048 * 1024 * 1024);
    expect(opts.memswap).toBe(opts.memory);
    expect(opts.cpuquota).toBe(200_000);
    expect(opts.forcerm).toBe(true);
  });

  it('labels and names what it builds as this run\'s, under DevLaunch\'s own name only', () => {
    expect(opts.t).toBe(builtImageTag('abc-session', 'api'));
    expect(String(opts.t)).toMatch(/^devlaunch-built\//);
    expect(opts.labels).toMatchObject({ [config.docker.managedLabel]: 'true', [config.docker.sessionLabel]: 'abc-session' });
  });

  it('runs every build under the VM cgroup that caps its processes (verifier D-2)', () => {
    // Measured: a RUN starting 3,000 processes started them all without it, and stopped
    // at 2,048 with "can't fork" under it.
    expect(opts.cgroupparent).toBe(`/${config.docker.buildCgroup}`);
  });

  it('carries a Dockerfile from outside its context under a fixed name', () => {
    const out = buildOptions({ sessionId: 's', service: 'a', contextDir: '/r/api', dockerfile: '/r/docker/api.Dockerfile' }, 1024, 1);
    expect(out.dockerfile).toBe('.devlaunch.Dockerfile');
  });
});

describe('the build process cap must be there before anything is built', () => {
  const docker = { listNetworks: async () => [{ Name: config.docker.networkName }] };
  const sandbox = (pidsMax: string | null | Error) =>
    new BuildSandbox(docker as never, { memoryMb: 1024, cpus: 1 }, async () => {
      if (pidsMax instanceof Error) throw pidsMax;
      return pidsMax;
    });

  it('builds when the cgroup carries a number', async () => {
    expect(await sandbox('2048\n').ready()).toBeNull();
  });

  it.each([
    // Docker creates a missing parent cgroup itself, with no limit: "max".
    ['no limit on the cgroup', 'max'],
    ['no cgroup at all', null],
    ['a check that could not run', new Error('no such image')],
    ['a value that is not a number', 'garbage'],
  ])('refuses with %s, saying how to fix it', async (_label, value) => {
    const problem = await sandbox(value as string | null | Error).ready();
    expect(problem).toMatch(/no process limit for builds/);
    expect(problem).toMatch(/\.\/devlaunch install/);
  });

  it('a build refused for it runs nothing', async () => {
    const r = await sandbox('max').build({
      sessionId: 's', service: 'a', contextDir: '/nope', dockerfile: '/nope/Dockerfile', timeoutMs: 1000, onLine: () => undefined,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^Not building: .*no process limit/);
  });

  it('reads 0 as no limit worth trusting', () => {
    expect(buildCapProblem('0')).not.toBeNull();
  });
});

describe('removing what a run built', () => {
  it('removes only images DevLaunch built, never anyone else\'s', async () => {
    const removed: string[] = [];
    const docker = { getImage: (name: string) => ({ remove: async () => { removed.push(name); } }) };
    const sb = new BuildSandbox(docker as never);
    await sb.remove('postgres:16');
    await sb.remove('stockwatch:test');
    await sb.remove('devlaunch-built/abc-api:latest');
    expect(removed).toEqual(['devlaunch-built/abc-api:latest']);
  });
});

describe('the balanced profile', () => {
  const hc = buildRepoImageHostConfig({ memoryMb: 1024, networkName: 'devlaunch-net' });
  it('adds nothing and takes away what nothing ordinary needs', () => {
    expect(hc.Privileged).toBe(false);
    expect(hc.CapAdd).toEqual([]);
    expect(hc.CapDrop).toEqual(expect.arrayContaining(['NET_RAW', 'MKNOD']));
    expect(hc.SecurityOpt).toContain('no-new-privileges');
    expect(hc.Binds).toBeUndefined();
    expect(hc.Devices).toEqual([]);
    expect(hc.PidMode).toBe('');
    expect(hc.NetworkMode).toBe('devlaunch-net');
    expect(hc.Memory).toBe(1024 * 1024 * 1024);
    expect(hc.MemorySwap).toBe(hc.Memory);
    expect(hc.PidsLimit).toBeGreaterThan(0);
  });
  it('lets the image keep its own user and writable disk, as the user chose', () => {
    expect(hc.ReadonlyRootfs).toBe(false);
  });
});

describe('who may produce a plan that runs an image', () => {
  const v = new RunPlanValidator();
  const dockerPlan = (over: Record<string, unknown> = {}) => ({
    runtime: { language: 'container', version: 'Dockerfile' }, packageManager: 'none',
    installCommand: null, buildCommand: null, startCommand: "(the image's own command)",
    workingDirectory: '.', expectedPort: 8080, planSource: 'repo-docker',
    docker: { source: 'dockerfile', file: 'Dockerfile', alias: 'app', build: { context: '.', dockerfile: 'Dockerfile' } },
    ...over,
  });

  it('accepts DevLaunch\'s own reader of the repository\'s setup', () => {
    expect(v.validate({ plan: dockerPlan() as never }).docker?.alias).toBe('app');
  });

  it('refuses a model plan that names an image', () => {
    expect(() => v.validate({ plan: dockerPlan({ planSource: 'ai-fallback' }) as never })).toThrow(/must come from the repository/);
    expect(() => v.validate({ plan: { ...dockerPlan(), docker: undefined } as never })).toThrow(/must come from the repository/);
  });

  it('refuses a malformed image, a path outside the repository, and a code-loading variable', () => {
    expect(() => v.validate({ plan: dockerPlan({ docker: { source: 'compose', file: 'compose.yaml', alias: 'a', image: '--privileged' } }) as never })).toThrow(/not an image reference/);
    expect(() => v.validate({ plan: dockerPlan({ docker: { source: 'compose', file: 'c', alias: 'a', build: { context: '../..', dockerfile: 'Dockerfile' } } }) as never })).toThrow();
    expect(() => v.validate({ plan: dockerPlan({ environmentVariables: [{ key: 'LD_PRELOAD', value: '/x.so', required: false }] }) as never })).toThrow();
  });
});

describe('the plan a setup becomes', () => {
  it('runs databases and workers as checked-by-staying-up, and gives the page its port', () => {
    const p = dockerProjectPlan({
      source: 'compose', file: 'compose.yaml', warnings: [],
      services: [
        { name: 'db', image: 'postgres:16', ports: [5432], environment: {}, dependsOn: [], dataPaths: ['/var/lib/postgresql/data'], role: 'database' },
        { name: 'My_API', build: { context: 'api', dockerfile: 'api/Dockerfile', args: {} }, ports: [8080], environment: { X: '1' }, dependsOn: ['db'], dataPaths: [], role: 'web' },
      ],
    });
    expect(p.planSource).toBe('repo-docker');
    expect(p.services.map((s) => [s.name, s.role, s.expectedPort])).toEqual([['db', 'worker', null], ['my-api', 'web', 8080]]);
    // Other services reach it by the name the compose file gave it.
    expect(p.services[1]!.docker?.alias).toBe('My_API');
    expect(p.services[0]!.docker?.database).toBe(true);
    expect(RunPlanSchema.parse(p.services[1]).environmentVariables).toEqual([{ key: 'X', value: '1', required: false }]);
  });
});

describe('a repository DevLaunch can run its own way', () => {
  it('never takes the Docker path, even when it has a Dockerfile', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'devlaunch-both-'));
    writeFileSync(join(dir, 'Dockerfile'), 'FROM node:20\nEXPOSE 3000\n');
    let launched = '';
    const exec = {
      async launch(o: { plan: { planSource: string } }) {
        launched = o.plan.planSource;
        return { logs: undefined, waitForReady: async () => ({ state: 'READY', hostPort: '1', url: 'http://localhost:1/', readiness: { ready: true } }), clearStartupBudget: () => undefined, cleanup: async () => ({ errors: [] }) };
      },
      async launchImage() { throw new Error('the Docker path must not run'); },
    } as unknown as ExecutionManager;
    const plan = RunPlanSchema.parse({ runtime: { language: 'node', version: '20' }, packageManager: 'npm', installCommand: null, buildCommand: null, startCommand: 'node server.js', workingDirectory: '.', expectedPort: 3000, planSource: 'rule-based' });
    const m = new SessionManager(exec, {
      analyzer: { analyze: async () => ({ envExample: [], warnings: [] }) } as never,
      planner: { planRepository: async () => ({ plan, detected: 'node', warnings: [] }) } as never,
    });
    const s = await m.launch({ sourceDir: dir });
    for (let i = 0; i < 200 && s.state !== 'READY' && s.state !== 'FAILED'; i++) await new Promise((r) => setTimeout(r, 10));
    expect(launched).toBe('rule-based');
    expect(s.project).toBeUndefined();
    await m.shutdown();
  });
});

describe('a repository DevLaunch can run only part of its own way', () => {
  it('says which compose services the run does not start', async () => {
    // dockersamples/example-voting-app: DevLaunch runs `vote`; `result` and `worker` never
    // ran, and the run was READY with nothing on screen saying so.
    const dir = mkdtempSync(join(tmpdir(), 'devlaunch-vote-'));
    writeFileSync(join(dir, 'docker-compose.yml'), [
      'services:',
      '  vote: { build: ./vote, ports: ["8080:80"] }',
      '  result: { build: ./result, ports: ["8081:80"] }',
      '  worker: { build: ./worker }',
      '  redis: { image: redis:alpine }',
      '  db: { image: postgres:15-alpine }',
    ].join('\n'));
    const exec = {
      async launch(o: { logs?: unknown }) {
        return { logs: o.logs, waitForReady: async () => ({ state: 'READY', hostPort: '1', url: 'http://localhost:1/', readiness: { ready: true } }), clearStartupBudget: () => undefined, cleanup: async () => ({ errors: [] }) };
      },
    } as unknown as ExecutionManager;
    const plan = RunPlanSchema.parse({ runtime: { language: 'python', version: '3.12' }, packageManager: 'pip', installCommand: null, buildCommand: null, startCommand: 'flask run', workingDirectory: 'vote', expectedPort: 5000, planSource: 'rule-based' });
    const m = new SessionManager(exec, {
      analyzer: { analyze: async () => ({ envExample: [], warnings: [] }) } as never,
      planner: { planRepository: async () => ({ plan, detected: 'flask', warnings: [] }) } as never,
    });
    const s = await m.launch({ sourceDir: dir });
    for (let i = 0; i < 200 && !s.planWarnings?.some((w) => /also declares/.test(w)); i++) await new Promise((r) => setTimeout(r, 10));
    const warning = s.planWarnings?.find((w) => /also declares/.test(w));
    expect(warning).toMatch(/also declares result, worker, which this run does not start/);
    expect(warning).not.toMatch(/redis|db\b/);
    await m.shutdown();
  });
});
