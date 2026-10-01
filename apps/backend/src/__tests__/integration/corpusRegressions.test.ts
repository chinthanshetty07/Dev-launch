import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ExecutionState, FailureCode, type RunPlan } from '@devlaunch/shared';
import { DockerManager } from '../../services/docker/DockerManager.js';
import { ExecutionManager } from '../../services/execution/ExecutionManager.js';
import { CleanupManager } from '../../services/cleanup/CleanupManager.js';
import { RepositoryAnalyzer } from '../../services/analysis/RepositoryAnalyzer.js';
import { RuleBasedPlanner } from '../../services/planning/RuleBasedPlanner.js';
import { imageForRuntime } from '../../services/security/ImageAllowlist.js';
import { LogManager } from '../../services/logs/LogManager.js';
import { cacheVolumeFor } from '../../services/docker/ContainerSecurity.js';

/**
 * One case per failure the real-world corpus found (scripts/corpus).
 *
 * Each fixture reproduces the mechanism of a real repository's failure, offline, and each
 * case drives it through the same path the repository took — analyse, plan by rule, run in
 * the sandbox, wait for readiness. A plan snapshot would prove the plan changed; this
 * proves the change is what makes the application answer.
 */
const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../fixtures');

const docker = new DockerManager();
const exec = new ExecutionManager(docker);
const planner = new RuleBasedPlanner(new RepositoryAnalyzer());

async function planFixture(name: string): Promise<RunPlan> {
  const outcome = await planner.planRepository(`${FIXTURES}/${name}`);
  if (!outcome.plan) throw new Error(`${name} did not plan: ${outcome.reason}`);
  return outcome.plan;
}

async function runFixture(name: string, plan: RunPlan, readinessMs = 90_000, logs?: LogManager) {
  const handle = await exec.launch({
    ...(logs ? { logs } : {}),
    sessionId: `corpus-${name}`,
    plan,
    sourceDir: `${FIXTURES}/${name}`,
    image: imageForRuntime(plan.runtime.language, plan.runtime.version),
    // As a session mounts it. Without one /cache is on the read-only root filesystem,
    // and corepack cannot fetch the package manager a repository pins.
    packageCacheVolume: cacheVolumeFor(`fixture:${name}`),
  });
  try {
    return await handle.waitForReady(readinessMs);
  } finally {
    await handle.cleanup();
  }
}

describe('failures the real-world corpus found', () => {
  beforeAll(async () => {
    await docker.ping();
  });

  afterAll(async () => {
    await CleanupManager.sweepOrphans(docker);
  });

  it('keeps a Create React App dev server running with no stdin (ahfarmer/calculator)', async () => {
    // react-scripts >= 3.4.1 closes its dev server when stdin ends, unless CI=true. A
    // container has no stdin, so the server printed "Starting the development server..."
    // and exited 0 — and the session reported COMPLETED, "the expected shape for a
    // script", about a plan that had just been built as a dev server on port 3000.
    const plan = await planFixture('node-cra-stdin');
    const outcome = await runFixture('node-cra-stdin', plan);
    expect(outcome.state, JSON.stringify(outcome.failure)).toBe(ExecutionState.READY);
  }, 300_000);

  it('passes binding flags to a pnpm script as options (sveltejs/realworld)', async () => {
    // pnpm forwards a literal `--` to the script, where npm strips it — measured in the
    // runner image for pnpm 9, 10 and 12. Vite's parser reads everything after `--` as
    // positional, so `pnpm run dev -- --host 0.0.0.0` served on loopback and the run
    // ended PORT_BOUND_TO_LOCALHOST against a plan that looked correct.
    const plan = await planFixture('node-pnpm-vite-args');
    expect(plan.packageManager).toBe('pnpm');
    const outcome = await runFixture('node-pnpm-vite-args', plan);
    expect(outcome.state, JSON.stringify(outcome.failure)).toBe(ExecutionState.READY);
  }, 300_000);

  it('serves an Angular project on @angular/build without a flag it rejects (angular-realworld)', async () => {
    // `--disable-host-check` belongs to @angular-devkit/build-angular. Every project
    // generated since Angular 18 serves through @angular/build, whose schema has never
    // declared it, and `ng serve` refused to start: `Unknown argument: disable-host-check`.
    const plan = await planFixture('node-angular-build');
    const outcome = await runFixture('node-angular-build', plan);
    expect(outcome.state, JSON.stringify(outcome.failure)).toBe(ExecutionState.READY);
  }, 300_000);

  it('explains a failed start by the start, not by what the install printed (fastify/demo, angular-realworld)', async () => {
    // The install succeeds while printing npm's EBADENGINE warnings and husky's `git
    // command not found`; the start then fails on `node: .env: not found`. The warnings
    // were reported as WRONG_RUNTIME_VERSION — and a repair spent moving to Node 22 —
    // and the husky line as the reason `ng serve` would not run.
    const plan = await planFixture('node-install-noise');
    // Past the configuration gate, as the corpus runs it: the variable is not the point.
    const outcome = await runFixture('node-install-noise', { ...plan, environmentVariables: plan.environmentVariables.filter((v) => v.value !== null) });
    expect(outcome.state).toBe(ExecutionState.FAILED);
    expect(outcome.failure?.code, JSON.stringify(outcome.failure)).toBe(FailureCode.MISSING_ENV);
    expect(outcome.failure?.evidence).toBe('node: .env: not found');
    expect(outcome.failure?.message).toMatch(/loads \.env with --env-file/);
  }, 300_000);

  it('quotes the start, not the install, when the start failed in words nothing recognises', async () => {
    // angular-realworld's `ng serve` refused a flag, which no signature knows. The generic
    // "not found" rule then matched husky's install-time `git command not found`, and the
    // report said the start command could not be run.
    const plan = await planFixture('node-install-noise');
    const exited = await runFixture('node-install-noise', { ...plan, startCommand: 'node bad-flag.js' });
    expect(exited.failure?.evidence, JSON.stringify(exited.failure)).toBe('Error: Unknown argument: disable-host-check');

    // And through the readiness path, where the process lives and never listens.
    const idle = await runFixture('node-install-noise', { ...plan, startCommand: 'node idle.js' }, 20_000);
    expect(idle.failure?.evidence ?? '', JSON.stringify(idle.failure)).not.toMatch(/git command not found/);
    expect(idle.failure?.code).not.toBe(FailureCode.START_COMMAND_FAILED);
  }, 300_000);

  it('installs a one-app workspace at its root, where workspace:* resolves (dan5py/turborepo-shadcn-ui)', async () => {
    // Planned from the package alone, the plan was `npm install` inside apps/web — no
    // lockfile and no packageManager there — and npm refuses `workspace:*` outright.
    const plan = await planFixture('node-workspace-one-app');
    expect(plan.installDirectory).toBe('.');
    const outcome = await runFixture('node-workspace-one-app', plan);
    expect(outcome.state, JSON.stringify(outcome.failure)).toBe(ExecutionState.READY);
  }, 300_000);

  it('sets the variable an application reads its bind address from (jellydn/fastify-starter)', async () => {
    // `host: process.env.SERVER_HOSTNAME ?? '127.0.0.1'` — the server can be told where to
    // bind, just not by HOST, the only name DevLaunch set.
    const plan = await planFixture('node-bind-env');
    const outcome = await runFixture('node-bind-env', plan, 30_000);
    expect(outcome.state, JSON.stringify(outcome.failure)).toBe(ExecutionState.READY);
  }, 300_000);

  it('serves a static site by rule (mdn/beginner-html-site-styled)', async () => {
    // It passed in the corpus only because a model planned it — two ways in two runs —
    // and with no key configured, DevLaunch's shipped default, it was UNSUPPORTED_PROJECT.
    const plan = await planFixture('static-site');
    expect(plan.planSource).toBe('rule-based');
    const outcome = await runFixture('static-site', plan, 30_000);
    expect(outcome.state, JSON.stringify(outcome.failure)).toBe(ExecutionState.READY);
  }, 300_000);

  it('answers the favicon request a static site never made with 204, and nothing else differently', async () => {
    // Every browser asks for /favicon.ico. The fixture has none, and http.server's 404
    // showed in the console of a page that worked. A missing *other* file is still a 404.
    const plan = await planFixture('static-site');
    const handle = await exec.launch({
      sessionId: 'corpus-static-favicon', plan, sourceDir: `${FIXTURES}/static-site`,
      image: imageForRuntime(plan.runtime.language, plan.runtime.version),
      packageCacheVolume: cacheVolumeFor('fixture:static-site'),
    });
    try {
      const outcome = await handle.waitForReady(30_000);
      expect(outcome.state, JSON.stringify(outcome.failure)).toBe(ExecutionState.READY);
      const base = outcome.url!.replace(/\/$/, '');
      expect((await fetch(`${base}/`)).status).toBe(200);
      const icon = await fetch(`${base}/favicon.ico`);
      expect(icon.status).toBe(204);
      expect(await icon.text()).toBe('');
      expect((await fetch(`${base}/favicon.ico?v=2`)).status).toBe(204);
      expect((await fetch(`${base}/not-here.png`)).status).toBe(404);
    } finally {
      await handle.cleanup();
    }
  }, 300_000);

  it('serves a favicon.ico the repository has, unchanged', async () => {
    // The 204 is for a site without one. A site with one gets its own file.
    const plan = await planFixture('static-site-favicon');
    const handle = await exec.launch({
      sessionId: 'corpus-static-own-favicon', plan, sourceDir: `${FIXTURES}/static-site-favicon`,
      image: imageForRuntime(plan.runtime.language, plan.runtime.version),
      packageCacheVolume: cacheVolumeFor('fixture:static-site-favicon'),
    });
    try {
      const outcome = await handle.waitForReady(30_000);
      expect(outcome.state, JSON.stringify(outcome.failure)).toBe(ExecutionState.READY);
      const icon = await fetch(`${outcome.url!.replace(/\/$/, '')}/favicon.ico`);
      expect(icon.status).toBe(200);
      expect(await icon.text()).toBe('not-really-an-icon\n');
    } finally {
      await handle.cleanup();
    }
  }, 300_000);

  it('names a runtime too new for the build tool, and does not retry on a newer one (ahfarmer/calculator)', async () => {
    // webpack 4's md4 hash under OpenSSL 3. It was START_COMMAND_FAILED at low confidence,
    // and a model was asked; the diagnosis is the runtime, and the only image that would
    // help is one DevLaunch does not have.
    const plan = await planFixture('node-openssl-legacy');
    const outcome = await runFixture('node-openssl-legacy', plan, 30_000);
    expect(outcome.failure?.code, JSON.stringify(outcome.failure)).toBe(FailureCode.WRONG_RUNTIME_VERSION);
    expect(outcome.failure?.confidence).toBe('high');
    expect(outcome.failure?.runtimeDirection).toBe('older');
    expect(outcome.failure?.remedy).toMatch(/NODE_OPTIONS=--openssl-legacy-provider/);
  }, 300_000);

  it('reports a planned dev server that exits 0 as stopped, not completed (ahfarmer/calculator)', async () => {
    // The CRA fixture without the CI=true that keeps it up: the shape the corpus met first.
    // It was COMPLETED; a server DevLaunch planned that stops by itself has failed to serve.
    const plan = await planFixture('node-cra-stdin');
    const withoutCi = { ...plan, environmentVariables: plan.environmentVariables.filter((v) => v.key !== 'CI') };
    const outcome = await runFixture('node-cra-stdin', withoutCi, 30_000);
    expect(outcome.state).toBe(ExecutionState.FAILED);
    expect(outcome.failure?.code, JSON.stringify(outcome.failure)).toBe(FailureCode.APPLICATION_EXITED);
    expect(outcome.failure?.message).toMatch(/finished successfully instead of serving/);
  }, 300_000);

  it('installs a Poetry project within the ranges it declares (nsidnev/fastapi-realworld-example-app)', async () => {
    // By name alone, `flask = "^2.3"` became Flask 3 — as `pydantic = "^1.9"` became
    // pydantic 2 — and code written for the major it pinned refused to start. The ranges
    // now reach pip through a file DevLaunch writes from pyproject.toml in the container.
    const plan = await planFixture('python-poetry-ranges');
    const logs = new LogManager();
    const outcome = await runFixture('python-poetry-ranges', plan, 180_000, logs);
    const log = logs.buffer.all().map((l) => l.text).join('\n');
    expect(outcome.state, `${JSON.stringify(outcome.failure)}\n${log.slice(-1500)}`).toBe(ExecutionState.READY);
    expect(log).toMatch(/Wrote \/workspace\/\.devlaunch\/requirements\.txt from pyproject\.toml: 1 requirements/);
    expect(log).toMatch(/Successfully installed .*flask-2\./i);
  }, 400_000);
});
