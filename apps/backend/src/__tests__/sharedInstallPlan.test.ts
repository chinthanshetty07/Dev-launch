import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ProjectPlanner } from '../services/planning/ProjectPlanner.js';
import { RepositoryAnalyzer } from '../services/analysis/RepositoryAnalyzer.js';
import { RuleBasedPlanner } from '../services/planning/RuleBasedPlanner.js';
import { discoverServices } from '../services/analysis/ServiceDiscovery.js';
import { sharesInstall } from '../services/execution/SharedInstall.js';

/**
 * A workspace is planned as one install, and the plan says so.
 *
 * Nothing here stubs the planner: `planProject` had no direct test at all, and the
 * `sharedInstall` flag it sets survived deletion because every existing test supplied
 * its own project plan from a double.
 */

const scratch: string[] = [];
afterAll(async () => {
  await Promise.all(scratch.map((d) => rm(d, { recursive: true, force: true }).catch(() => undefined)));
});

async function repo(files: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'devlaunch-shared-'));
  scratch.push(root);
  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, typeof contents === 'string' ? contents : JSON.stringify(contents));
  }
  return root;
}

const analyzer = new RepositoryAnalyzer();
const planner = new ProjectPlanner(analyzer, new RuleBasedPlanner());

async function planOf(root: string) {
  const meta = await analyzer.analyze(root);
  const { services } = await discoverServices(root);
  return planner.planProject(root, { ...meta, services });
}

/** A two-package pnpm workspace: the shape that forces one root install. */
const workspaceFiles = {
  'package.json': { name: 'root', private: true, workspaces: ['packages/*'] },
  'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
  'pnpm-lock.yaml': 'lockfileVersion: 6.0\n',
  'packages/api/package.json': {
    name: 'api',
    scripts: { start: 'node server.js' },
    dependencies: { express: '4' },
  },
  'packages/api/server.js': "const express = require('express');\n",
  'packages/web/package.json': {
    name: 'web',
    scripts: { dev: 'vite' },
    dependencies: { react: '18', vite: '5' },
  },
  'packages/web/src/main.jsx': "import React from 'react';\n",
};

describe('a workspace plans one install', () => {
  it('marks the project as sharing a single install', async () => {
    // The flag is the whole mechanism: without it the services install concurrently,
    // and two pnpm processes writing the same store is how this broke in the first
    // place.
    const out = await planOf(await repo(workspaceFiles));
    expect(out.plan, out.reason ?? 'no plan').not.toBeNull();
    expect(out.plan?.sharedInstall).toBe(true);
  });

  it('points every service at the same root install command', async () => {
    const out = await planOf(await repo(workspaceFiles));
    const services = out.plan?.services ?? [];
    expect(services.length).toBeGreaterThan(1);
    for (const s of services) {
      expect(s.installDirectory, s.name).toBe('.');
      expect(s.installCommand, s.name).toMatch(/pnpm/);
      // The manager with it: a plan naming npm beside a pnpm install contradicts itself in
      // every summary that reads it — horusyeung's showed "npm" for a `yarn install`.
      expect(s.packageManager, s.name).toBe('pnpm');
    }
    // One command, not one per package.
    expect(new Set(services.map((s) => s.installCommand)).size).toBe(1);
  });

  it('says in plain words that it will install once', async () => {
    const out = await planOf(await repo(workspaceFiles));
    expect(out.warnings.join('\n')).toMatch(/installing once at the repository root/i);
  });

  it('leaves an ordinary multi-service repository installing per service', async () => {
    // The flag must not be set by default: sequencing installs costs wall-clock, and a
    // repository whose services have independent dependency trees has no reason to pay
    // it.
    const out = await planOf(
      await repo({
        'backend/package.json': {
          name: 'api',
          scripts: { start: 'node server.js' },
          dependencies: { express: '4' },
        },
        'backend/server.js': "const express = require('express');\n",
        'frontend/package.json': {
          name: 'web',
          scripts: { dev: 'vite' },
          dependencies: { react: '18', vite: '5' },
        },
        'frontend/src/main.jsx': "import React from 'react';\n",
      }),
    );
    expect(out.plan, out.reason ?? 'no plan').not.toBeNull();
    expect(out.plan?.sharedInstall).toBeUndefined();
    for (const s of out.plan?.services ?? []) {
      expect(s.installDirectory, s.name).not.toBe('.');
    }
  });
});

describe('a Python service beside a Node workspace (fastapi/full-stack-fastapi-template)', () => {
  // npm workspaces for frontend/ and packages/*, and a Python backend outside them. The
  // backend was given the workspace's `npm install` and died on `npm: not found`.
  const files = {
    'package.json': { name: 'template', private: true, workspaces: ['frontend', 'packages/*'] },
    'package-lock.json': '{"lockfileVersion": 3}',
    'frontend/package.json': { name: 'frontend', scripts: { dev: 'vite' }, dependencies: { react: '19', vite: '7' } },
    'frontend/src/main.tsx': "import React from 'react';\n",
    'backend/pyproject.toml': '[project]\nname = "app"\nrequires-python = ">=3.14,<4.0"\ndependencies = ["fastapi[standard]<1.0.0,>=0.114.2", "sqlmodel<1.0.0,>=0.0.21"]\n',
    'backend/app/main.py': 'from fastapi import FastAPI\napp = FastAPI()\n',
  };

  it('installs the Node services from the workspace root, and the Python one its own way', async () => {
    const out = await planOf(await repo(files));
    const backend = out.plan!.services.find((s) => s.runtime.language === 'python')!;
    const frontend = out.plan!.services.find((s) => s.runtime.language === 'node')!;
    expect(frontend.installCommand).toMatch(/^npm (?:ci|install)/);
    expect(frontend.installDirectory).toBe('.');
    expect(backend.installCommand ?? '').not.toMatch(/npm/);
    expect(backend.installDirectory ?? null).not.toBe('.');
    // And on the Python it asks for.
    expect(backend.runtime.version).toBe('3.14');
  });

  it('shares one install and one copy of the files among the Node services only', () => {
    const node = { runtime: { language: 'node' as const, version: '20' } };
    const python = { runtime: { language: 'python' as const, version: '3.14' } };
    expect(sharesInstall({ sharedInstall: true }, node)).toBe(true);
    expect(sharesInstall({ sharedInstall: true }, python)).toBe(false);
    expect(sharesInstall({}, node)).toBe(false);
  });
});

describe('a FastAPI app, run as `fastapi dev` runs it', () => {
  // `app.frontend("/", directory=...)` insists the built frontend exists unless FASTAPI_ENV
  // is "development", which `fastapi dev` sets. Started with plain uvicorn, the template's
  // API stopped on "Frontend directory ... does not exist".
  it('sets FASTAPI_ENV=development', async () => {
    const root = await repo({
      'pyproject.toml': '[project]\nname = "app"\ndependencies = ["fastapi[standard]"]\n',
      'app/main.py': 'from fastapi import FastAPI\napp = FastAPI()\n',
    });
    const meta = await analyzer.analyze(root);
    const plan = new RuleBasedPlanner(analyzer).plan(meta).plan!;
    expect(plan.startCommand).toMatch(/^uvicorn /);
    expect(plan.environmentVariables).toContainEqual({ key: 'FASTAPI_ENV', value: 'development', required: false });
  });
});

describe('a FastAPI app with Alembic migrations', () => {
  // The template's prestart step runs `alembic upgrade head`; skipped, every query failed on
  // `relation "user" does not exist`. Run before start, as Django's `migrate` is.
  const files = {
    'pyproject.toml': '[project]\nname = "app"\ndependencies = ["fastapi[standard]", "alembic>=1.19"]\n',
    'app/main.py': 'from fastapi import FastAPI\napp = FastAPI()\n',
    'alembic.ini': '[alembic]\nscript_location = app/alembic\n',
  };

  it('runs its migrations before it starts, and asks /docs whether it is up', async () => {
    const root = await repo(files);
    const plan = new RuleBasedPlanner(analyzer).plan(await analyzer.analyze(root)).plan!;
    expect(plan.buildCommand).toBe('python -m alembic upgrade head');
    expect(plan.healthCheck.path).toBe('/docs');
  });

  it('runs nothing without alembic.ini, or without Alembic in its dependencies', async () => {
    const { 'alembic.ini': _ini, ...withoutIni } = files;
    const noIni = await repo(withoutIni);
    expect(new RuleBasedPlanner(analyzer).plan(await analyzer.analyze(noIni)).plan!.buildCommand).toBeNull();
    const noDep = await repo({ ...files, 'pyproject.toml': '[project]\nname = "app"\ndependencies = ["fastapi[standard]"]\n' });
    expect(new RuleBasedPlanner(analyzer).plan(await analyzer.analyze(noDep)).plan!.buildCommand).toBeNull();
  });
});
