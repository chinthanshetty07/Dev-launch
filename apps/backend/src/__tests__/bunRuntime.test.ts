import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ExecutionState, FailureCode, type PackageJsonSummary } from '@devlaunch/shared';
import { SessionManager } from '../services/session/SessionManager.js';
import type { ExecutionManager } from '../services/execution/ExecutionManager.js';
import type { AIPlanner } from '../services/ai/AIPlanner.js';
import { RepositoryAnalyzer } from '../services/analysis/RepositoryAnalyzer.js';
import { RuleBasedPlanner, runsBun } from '../services/planning/RuleBasedPlanner.js';

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../fixtures');
const analyzer = new RepositoryAnalyzer();
const planner = new RuleBasedPlanner(analyzer);

const managers: SessionManager[] = [];
afterEach(async () => {
  for (const m of managers.splice(0)) await m.shutdown();
});

function node(scripts: Record<string, string>, deps: Record<string, string> = {}): PackageJsonSummary {
  return { scripts, dependencies: deps, devDependencies: {} };
}

describe('a script that runs Bun', () => {
  it('is recognised by the command, not by the word', () => {
    for (const body of ['bun server.ts', 'bun --watch server/index.ts', 'bunx --bun vite', 'tsc && bun run build']) {
      expect(runsBun(body), body).toBe(true);
    }
    for (const body of ['vite', 'node bun.js', 'node ./bundle.js', 'echo bundler']) {
      expect(runsBun(body), body).toBe(false);
    }
  });

  it('declines a project whose every candidate needs Bun, saying so', () => {
    const outcome = planner.plan({
      root: '/r', fileCount: 1, sizeBytes: 1, hasDockerfile: false, tsconfig: false,
      lockfiles: ['bun.lockb'], frameworkConfigs: [], envExample: [], warnings: [],
      packageJson: node({ dev: 'bunx --bun vite' }, { vite: '^5' }),
    });
    expect(outcome.plan).toBeNull();
    expect(outcome.unrunnable).toBe(true);
    expect(outcome.reason).toMatch(/`dev` script runs `bunx --bun vite`, which needs the Bun runtime/);
    expect(outcome.remedy).toMatch(/approved Bun image/);
  });

  it('starts another candidate when one does not need Bun', () => {
    const outcome = planner.plan({
      root: '/r', fileCount: 1, sizeBytes: 1, hasDockerfile: false, tsconfig: false,
      lockfiles: [], frameworkConfigs: [], envExample: [], warnings: [],
      packageJson: node({ dev: 'bun --watch server.js', start: 'node server.js' }),
    });
    expect(outcome.plan?.startCommand).toBe('npm run start');
    expect(outcome.warnings.join(' ')).toMatch(/`dev` script runs Bun/);
  });

  it('fails a Bun-only repository at once, by name, without asking a model (bun-hono-app)', async () => {
    // It was planned as `npm run dev`, died on `sh: 1: bun: not found`, and a model was
    // asked to repair a runtime that is not there.
    let asked = 0;
    const aiPlanner = { plan: async () => { asked++; throw new Error('should not be asked'); } } as unknown as AIPlanner;
    const mgr = new SessionManager({} as ExecutionManager, { analyzer, planner, aiPlanner });
    managers.push(mgr);

    const s = await mgr.launch({ sourceDir: `${FIXTURES}/node-bun-runtime` });
    for (let i = 0; i < 100 && mgr.get(s.id)!.state !== ExecutionState.FAILED; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const session = mgr.get(s.id)!;
    expect(session.state).toBe(ExecutionState.FAILED);
    expect(session.failure?.code).toBe(FailureCode.UNSUPPORTED_PROJECT);
    expect(session.failure?.message).toMatch(/needs the Bun runtime/);
    expect(session.failure?.remedy).toMatch(/Run it with Bun directly/);
    expect(asked).toBe(0);
  });
});
