import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ProjectPlanner } from '../services/planning/ProjectPlanner.js';
import { RepositoryAnalyzer } from '../services/analysis/RepositoryAnalyzer.js';
import { RuleBasedPlanner } from '../services/planning/RuleBasedPlanner.js';
import { discoverServices } from '../services/analysis/ServiceDiscovery.js';

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
