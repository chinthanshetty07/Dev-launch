import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ExecutionState } from '@devlaunch/shared';
import { DockerManager } from '../../services/docker/DockerManager.js';
import { ExecutionManager } from '../../services/execution/ExecutionManager.js';
import { CleanupManager } from '../../services/cleanup/CleanupManager.js';
import { RepositoryAnalyzer } from '../../services/analysis/RepositoryAnalyzer.js';
import { RuleBasedPlanner } from '../../services/planning/RuleBasedPlanner.js';
import { RunPlanValidator } from '../../services/planning/RunPlanValidator.js';
import { imageForRuntime } from '../../services/security/ImageAllowlist.js';

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../fixtures');

const docker = new DockerManager();
const exec = new ExecutionManager(docker);
const analyzer = new RepositoryAnalyzer();
const planner = new RuleBasedPlanner(analyzer);
const validator = new RunPlanValidator();

describe('Phase 6 — planning real fixtures', () => {
  beforeAll(async () => {
    await docker.ping();
    await docker.ensureImage('devlaunch/node:20');
    await docker.ensureImage('devlaunch/python:3.12');
  }, 300_000);

  afterAll(async () => {
    await CleanupManager.sweepOrphans(docker);
  });

  it('plans the Vite fixture deterministically', async () => {
    const out = await planner.planRepository(`${FIXTURES}/node-vite-app`);
    expect(out.detected).toBe('vite');
    expect(out.plan?.planSource).toBe('rule-based');
    expect(out.plan?.startCommand).toBe('npm run dev -- --host 0.0.0.0 --port 5173');
    expect(out.plan?.expectedPort).toBe(5173);
    expect(() => validator.validate({ plan: out.plan })).not.toThrow();
  });

  it('plans the Flask fixture, including its required variables', async () => {
    const out = await planner.planRepository(`${FIXTURES}/python-flask-basic`);
    expect(out.detected).toBe('flask');
    expect(out.plan?.runtime.language).toBe('python');
    expect(out.plan?.installCommand).toBe('pip install -r requirements.txt');
    const required = out.plan!.environmentVariables.filter((v) => v.required).map((v) => v.key);
    expect(required).toEqual(['SECRET_KEY', 'DATABASE_URL']);
  });

  it('plans the Django fixture from manage.py', async () => {
    const out = await planner.planRepository(`${FIXTURES}/python-django-basic`);
    expect(out.detected).toBe('django');
    expect(out.plan?.startCommand).toBe('python manage.py runserver 0.0.0.0:8000');
  });

  it('resolves a monorepo to its single runnable package', async () => {
    // packages/util has only a build script, so apps/web is the unambiguous target.
    const out = await planner.planRepository(`${FIXTURES}/node-monorepo`);
    expect(out.detected).toBe('vite');
    expect(out.plan?.workingDirectory).toBe('apps/web');
    expect(out.choices).toBeUndefined();
  });

  it('hands a multi-package monorepo back to the user instead of guessing', async () => {
    const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = await mkdtemp(join(tmpdir(), 'devlaunch-mono-'));
    await writeFile(join(root, 'package.json'), JSON.stringify({ workspaces: ['apps/*'] }));
    for (const name of ['web', 'admin']) {
      await mkdir(join(root, 'apps', name), { recursive: true });
      await writeFile(
        join(root, 'apps', name, 'package.json'),
        JSON.stringify({ name, scripts: { dev: 'vite' }, dependencies: { vite: '5' } }),
      );
    }

    const out = await planner.planRepository(root);
    expect(out.plan).toBeNull();
    expect(out.choices?.map((c) => c.dir).sort()).toEqual(['apps/admin', 'apps/web']);
    expect(out.reason).toMatch(/monorepo with 2 runnable packages/);
  });

  it('runs a Node fixture end to end from nothing but a plan', async () => {
    // The whole chain: analyse, plan deterministically, validate, run, verify ready.
    const out = await planner.planRepository(`${FIXTURES}/node-http-basic`);
    expect(out.detected).toBe('node');
    expect(out.plan).not.toBeNull();

    const image = imageForRuntime(out.plan!.runtime.language, out.plan!.runtime.version);
    const handle = await exec.launch({
      sessionId: 'plan-node-e2e',
      plan: out.plan!,
      sourceDir: `${FIXTURES}/node-http-basic`,
      image,
    });
    try {
      const ready = await handle.waitForReady(60_000);
      expect(ready.state).toBe(ExecutionState.READY);
      const res = await fetch(ready.url!);
      expect(res.status).toBe(200);
    } finally {
      await handle.cleanup();
    }
  }, 300_000);

  it('runs a Python fixture end to end, installing its dependencies', async () => {
    const out = await planner.planRepository(`${FIXTURES}/python-flask-basic`);
    const image = imageForRuntime(out.plan!.runtime.language, out.plan!.runtime.version);

    const handle = await exec.launch({
      sessionId: 'plan-python-e2e',
      plan: out.plan!,
      sourceDir: `${FIXTURES}/python-flask-basic`,
      image,
    });
    try {
      // pip install reaches the network, which the egress policy deliberately allows.
      const ready = await handle.waitForReady(180_000);
      expect(ready.state, JSON.stringify(ready.failure)).toBe(ExecutionState.READY);
      const res = await fetch(ready.url!);
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({ fixture: 'python-flask-basic' });
    } finally {
      await handle.cleanup();
    }
  }, 600_000);
});
