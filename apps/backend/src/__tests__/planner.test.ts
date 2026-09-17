import { describe, it, expect } from 'vitest';
import type { RepositoryMetadata } from '@devlaunch/shared';
import { RuleBasedPlanner } from '../services/planning/RuleBasedPlanner.js';
import { RunPlanValidator } from '../services/planning/RunPlanValidator.js';
import { NODE_FRAMEWORKS } from '../services/planning/frameworks.js';

const planner = new RuleBasedPlanner();
const validator = new RunPlanValidator();

function meta(over: Partial<RepositoryMetadata> = {}): RepositoryMetadata {
  return {
    root: '/repo',
    fileCount: 10,
    sizeBytes: 1000,
    hasDockerfile: false,
    tsconfig: false,
    lockfiles: [],
    frameworkConfigs: [],
    envExample: [],
    warnings: [],
    ...over,
  };
}

function node(
  deps: Record<string, string>,
  scripts: Record<string, string>,
  over: Partial<RepositoryMetadata> = {},
): RepositoryMetadata {
  return meta({
    packageJson: { scripts, dependencies: deps, devDependencies: {} },
    ...over,
  });
}

describe('RuleBasedPlanner — Node frameworks', () => {
  it.each([
    ['next',       { next: '14' },                 { dev: 'next dev' },        3000, '-H 0.0.0.0 -p 3000'],
    ['nuxt',       { nuxt: '3' },                  { dev: 'nuxt dev' },        3000, '--host 0.0.0.0 --port 3000'],
    ['sveltekit',  { '@sveltejs/kit': '2' },       { dev: 'vite dev' },        5173, '--host 0.0.0.0 --port 5173'],
    ['astro',      { astro: '4' },                 { dev: 'astro dev' },       4321, '--host 0.0.0.0 --port 4321'],
    ['gatsby',     { gatsby: '5' },                { develop: 'gatsby develop' }, 8000, '-H 0.0.0.0 -p 8000'],
    ['docusaurus', { '@docusaurus/core': '3' },    { start: 'docusaurus start' }, 3000, '--host 0.0.0.0 --port 3000'],
    ['vue-cli',    { '@vue/cli-service': '5' },    { serve: 'vue-cli-service serve' }, 8080, '--host 0.0.0.0 --port 8080'],
    ['vite',       { vite: '5' },                  { dev: 'vite' },            5173, '--host 0.0.0.0 --port 5173'],
    ['parcel',     { parcel: '2' },                { dev: 'parcel' },          1234, '--host 0.0.0.0 --port 1234'],
  ])('plans %s on port %s with host binding forced', (id, deps, scripts, port, args) => {
    const out = planner.plan(node(deps as Record<string, string>, scripts as Record<string, string>));
    expect(out.detected).toBe(id);
    expect(out.plan?.expectedPort).toBe(port);
    expect(out.plan?.startCommand).toContain(args);
    expect(out.plan?.hostBinding).toBe('forced');
    // Whatever the planner composes must survive the security gate.
    expect(() => validator.validate({ plan: out.plan })).not.toThrow();
  });

  it('identifies meta-frameworks ahead of the build tool they are built on', () => {
    // Every one of these also has vite in its dependency tree. Matching vite first
    // would produce a plan with the wrong port and the wrong dev server.
    for (const [dep, expected, port] of [
      ['@sveltejs/kit', 'sveltekit', 5173],
      ['astro', 'astro', 4321],
      ['nuxt', 'nuxt', 3000],
    ] as const) {
      const out = planner.plan(node({ [dep]: '1', vite: '5' }, { dev: 'x' }));
      expect(out.detected).toBe(expected);
      expect(out.plan?.expectedPort).toBe(port);
    }
  });

  it('passes host and port through the package manager with --', () => {
    const out = planner.plan(node({ vite: '5' }, { dev: 'vite' }));
    // Without `--` the flags are consumed by npm instead of reaching the dev server.
    expect(out.plan?.startCommand).toBe('npm run dev -- --host 0.0.0.0 --port 5173');
  });

  it('adds --disable-host-check for Angular', () => {
    // Angular rejects requests whose Host header it does not recognise, which is every
    // request arriving through a Docker port mapping.
    const out = planner.plan(node({ '@angular/cli': '17' }, { start: 'ng serve' }));
    expect(out.detected).toBe('angular');
    expect(out.plan?.startCommand).toContain('--disable-host-check');
  });

  it('detects Angular from angular.json even without the dependency listed', () => {
    const out = planner.plan(meta({
      packageJson: { scripts: { start: 'ng serve' }, dependencies: {}, devDependencies: {} },
      frameworkConfigs: ['angular.json'],
    }));
    expect(out.detected).toBe('angular');
  });

  it('binds CRA through the environment and suppresses its browser launch', () => {
    const out = planner.plan(node({ 'react-scripts': '5' }, { start: 'react-scripts start' }));
    expect(out.detected).toBe('cra');
    expect(out.plan?.startCommand).toBe('npm run start');
    const env = Object.fromEntries(out.plan!.environmentVariables.map((v) => [v.key, v.value]));
    expect(env.HOST).toBe('0.0.0.0');
    expect(env.PORT).toBe('3000');
    expect(env.BROWSER).toBe('none');
  });

  it('marks Fastify as unverified, since it binds loopback in code', () => {
    // Being honest here matters: claiming "forced" would make readiness report a
    // confusing timeout instead of PORT_BOUND_TO_LOCALHOST.
    const out = planner.plan(node({ fastify: '4' }, { start: 'node server.js' }));
    expect(out.detected).toBe('fastify');
    expect(out.plan?.hostBinding).toBe('unknown');
    expect(out.warnings.join(' ')).toMatch(/binds 127\.0\.0\.1/);
  });

  it.each([
    ['express', { express: '4' }, 'express'],
    ['koa', { koa: '2' }, 'koa'],
    ['nest', { '@nestjs/core': '10' }, 'nest'],
  ])('plans the %s server through PORT/HOST', (_label, deps, id) => {
    const out = planner.plan(node(deps as Record<string, string>, { start: 'node index.js' }));
    expect(out.detected).toBe(id);
    expect(out.plan?.environmentVariables.find((v) => v.key === 'PORT')?.value).toBe('3000');
  });

  it('falls back to a generic Node plan when no framework matches', () => {
    // A plain script is still deterministically runnable; sending it to the AI would
    // be wasted cost. Host binding is honestly reported as unknown.
    const out = planner.plan(node({ lodash: '4' }, { start: 'node index.js' }));
    expect(out.detected).toBe('node');
    expect(out.plan?.startCommand).toBe('npm run start');
    expect(out.plan?.hostBinding).toBe('unknown');
  });

  it.each([
    [['pnpm-lock.yaml'], 'pnpm', 'pnpm install'],
    [['yarn.lock'], 'yarn', 'yarn install'],
    [['package-lock.json'], 'npm', 'npm install --no-audit --no-fund'],
    [[], 'npm', 'npm install --no-audit --no-fund'],
  ])('derives the package manager from %s', (lockfiles, pm, install) => {
    const out = planner.plan(node({ vite: '5' }, { dev: 'vite' }, { lockfiles: lockfiles as string[] }));
    expect(out.plan?.packageManager).toBe(pm);
    expect(out.plan?.installCommand).toBe(install);
    expect(out.plan?.startCommand.startsWith(pm as string)).toBe(true);
  });

  it('gives up when the framework is present but its scripts are not', () => {
    const out = planner.plan(node({ vite: '5' }, { lint: 'eslint .' }));
    expect(out.plan).toBeNull();
    expect(out.warnings.join(' ')).toMatch(/expected scripts/);
  });

  it('warns when the repository demands a Node version we cannot supply', () => {
    const out = planner.plan(meta({
      packageJson: {
        scripts: { dev: 'vite' },
        dependencies: { vite: '5' },
        devDependencies: {},
        engineNode: '>=22',
      },
    }));
    expect(out.warnings.join(' ')).toMatch(/only 20 is available/);
  });

  it('covers every framework in the table', () => {
    // A framework added to the table without a working detector path is worse than
    // one that was never added.
    for (const fw of NODE_FRAMEWORKS) {
      const scripts = Object.fromEntries(fw.scripts.map((s) => [s, 'x']));
      const out = planner.plan(node({ [fw.dep]: '1' }, scripts));
      expect(out.detected, `${fw.id} should be detected`).toBe(fw.id);
      expect(out.plan, `${fw.id} should produce a plan`).not.toBeNull();
      expect(() => validator.validate({ plan: out.plan })).not.toThrow();
    }
  });
});

describe('RuleBasedPlanner — Python frameworks', () => {
  const py = (over: Partial<RepositoryMetadata['python']> = {}, rest: Partial<RepositoryMetadata> = {}) =>
    meta({
      python: {
        requirements: [],
        hasPyproject: false,
        hasPipfile: false,
        hasManagePy: false,
        entryCandidates: [],
        ...over,
      },
      ...rest,
    });

  it('plans Django from manage.py, binding 0.0.0.0', () => {
    const out = planner.plan(py({ hasManagePy: true, requirements: ['Django==5.0'] }));
    expect(out.detected).toBe('django');
    expect(out.plan?.startCommand).toBe('python manage.py runserver 0.0.0.0:8000');
    expect(out.plan?.installCommand).toBe('pip install -r requirements.txt');
  });

  it('plans Flask through FLASK_APP, which works across Flask versions', () => {
    const out = planner.plan(py({
      requirements: ['Flask==3.0.3'],
      entryCandidates: [{ file: 'app.py', framework: 'flask', appVariable: 'app' }],
    }));
    expect(out.detected).toBe('flask');
    expect(out.plan?.startCommand).toBe('flask run --host=0.0.0.0 --port=5000');
    expect(out.plan?.environmentVariables.find((v) => v.key === 'FLASK_APP')?.value).toBe('app');
  });

  it('plans FastAPI via uvicorn with the real app variable', () => {
    const out = planner.plan(py({
      requirements: ['fastapi==0.111.0', 'uvicorn==0.30.0'],
      entryCandidates: [{ file: 'main.py', framework: 'fastapi', appVariable: 'api' }],
    }));
    expect(out.detected).toBe('fastapi');
    expect(out.plan?.startCommand).toBe('uvicorn main:api --host 0.0.0.0 --port 8000');
  });

  it('plans Streamlit headless, so it does not block on its email prompt', () => {
    // Without --server.headless Streamlit waits for input on first run and readiness
    // reports a timeout that says nothing about the real cause.
    const out = planner.plan(py({
      requirements: ['streamlit==1.37.0'],
      entryCandidates: [{ file: 'app.py', framework: null }],
    }));
    expect(out.detected).toBe('streamlit');
    expect(out.plan?.startCommand).toContain('--server.headless true');
    expect(out.plan?.startCommand).toContain('--server.address 0.0.0.0');
    expect(out.plan?.expectedPort).toBe(8501);
  });

  it('plans Gradio through its server environment variables', () => {
    const out = planner.plan(py({
      requirements: ['gradio==4.40.0'],
      entryCandidates: [{ file: 'app.py', framework: null }],
    }));
    expect(out.detected).toBe('gradio');
    const env = Object.fromEntries(out.plan!.environmentVariables.map((v) => [v.key, v.value]));
    expect(env.GRADIO_SERVER_NAME).toBe('0.0.0.0');
    expect(out.plan?.expectedPort).toBe(7860);
  });

  it('prefers manage.py over anything requirements.txt merely mentions', () => {
    const out = planner.plan(py({
      hasManagePy: true,
      requirements: ['Django==5.0', 'flask==3.0'],
    }));
    expect(out.detected).toBe('django');
  });

  it('installs from pyproject.toml when there is no requirements.txt', () => {
    const out = planner.plan(py({
      hasPyproject: true,
      entryCandidates: [{ file: 'main.py', framework: 'fastapi', appVariable: 'app' }],
    }));
    expect(out.plan?.installCommand).toBe('pip install .');
  });

  it('declines a Pipfile-only project rather than guessing', () => {
    const out = planner.plan(py({ hasPipfile: true, hasManagePy: true }));
    expect(out.plan).toBeNull();
    expect(out.warnings.join(' ')).toMatch(/Pipfile-only/);
  });

  it('carries required environment variables into the plan', () => {
    const out = planner.plan(py(
      { hasManagePy: true, requirements: ['Django==5.0'] },
      { envExample: [{ key: 'SECRET_KEY', hasDefault: false }, { key: 'DEBUG', hasDefault: true }] },
    ));
    const required = out.plan!.environmentVariables.filter((v) => v.required).map((v) => v.key);
    expect(required).toEqual(['SECRET_KEY']);
  });
});

describe('RuleBasedPlanner — unrecognised', () => {
  it('returns no plan for an empty repository', () => {
    const out = planner.plan(meta());
    expect(out.plan).toBeNull();
    expect(out.reason).toMatch(/No package.json/);
  });

  it('returns no plan when package.json has no runnable script', () => {
    const out = planner.plan(node({}, { lint: 'eslint .' }));
    expect(out.plan).toBeNull();
    expect(out.reason).toMatch(/no recognised framework or start script/);
  });
});
