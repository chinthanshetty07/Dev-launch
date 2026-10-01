import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecutionState, FailureCode, RunPlanSchema } from '@devlaunch/shared';
import { FileHints, InMemoryHints, MAX_HINTS, memoryHintKey } from '../services/execution/MemoryHints.js';
import { SessionManager } from '../services/session/SessionManager.js';
import type { ExecutionManager, LaunchHandle, ReadyOutcome } from '../services/execution/ExecutionManager.js';
import { LogManager } from '../services/logs/LogManager.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const tmp = async () => {
  const d = await mkdtemp(join(tmpdir(), 'devlaunch-hints-'));
  dirs.push(d);
  return d;
};

describe('the key a repository is remembered by', () => {
  it('is the same however the URL was pasted', () => {
    const k = memoryHintKey('https://github.com/wrrnlim/nextjs-docker-postgres-template');
    for (const v of ['https://github.com/wrrnlim/nextjs-docker-postgres-template.git', 'https://github.com/Wrrnlim/NextJS-Docker-Postgres-Template/', 'github.com/wrrnlim/nextjs-docker-postgres-template?tab=readme']) {
      expect(memoryHintKey(v), v).toBe(k);
    }
  });
  it('separates the services of one repository', () => {
    expect(memoryHintKey('github.com/a/b', 'api')).not.toBe(memoryHintKey('github.com/a/b', 'web'));
  });
});

describe('the hint file', () => {
  it('keeps what it is told across processes, readable only by its owner', async () => {
    const file = join(await tmp(), 'state', 'memory-hints.json');
    await new FileHints(file).remember('github.com/a/b#app', 2048);
    expect(await new FileHints(file).get('github.com/a/b#app')).toBe(2048);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('starts empty from a missing or damaged file, rather than failing a run', async () => {
    const d = await tmp();
    expect(await new FileHints(join(d, 'none.json')).get('x')).toBeUndefined();
    await writeFile(join(d, 'bad.json'), '{ not json');
    expect(await new FileHints(join(d, 'bad.json')).get('x')).toBeUndefined();
  });

  it(`keeps at most ${MAX_HINTS} repositories, the most recent`, async () => {
    const file = join(await tmp(), 'memory-hints.json');
    const hints = new FileHints(file);
    for (let i = 0; i <= MAX_HINTS; i++) await hints.remember(`repo-${i}#app`, 2048);
    const saved = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(saved)).toHaveLength(MAX_HINTS);
    expect(saved[`repo-${MAX_HINTS}#app`]).toBeDefined();
  }, 60_000);
});

/** One service whose install fits at or above `fitsAt` MB, and is OOM-killed below it. */
function single(fitsAt: number) {
  const launches: number[] = [];
  const exec = {
    docker: { hostMemoryBytes: async () => 5910 * 1024 * 1024 },
    async launch(o: { logs?: LogManager; memoryMb?: number }) {
      const mb = o.memoryMb ?? 0;
      launches.push(mb);
      const logs = o.logs ?? new LogManager();
      const fits = mb >= fitsAt;
      return {
        container: { id: `c${launches.length}` }, logs,
        waitForReady: async (): Promise<ReadyOutcome> => fits
          ? { state: ExecutionState.READY, hostPort: '1', url: 'http://localhost:1', readiness: { ready: true, attempts: 1, elapsedMs: 1 } as ReadyOutcome['readiness'] }
          : {
              state: ExecutionState.FAILED, hostPort: null, readiness: { ready: false, attempts: 0, elapsedMs: 0 } as ReadyOutcome['readiness'],
              failure: { code: FailureCode.OUT_OF_MEMORY, message: 'killed', phase: 'install', memory: { kind: 'container', limitMb: mb, detectedBy: ['docker: OOMKilled'] } },
            },
        clearStartupBudget: () => undefined,
        cleanup: async () => ({ errors: [] }),
      } as unknown as LaunchHandle;
    },
  } as unknown as ExecutionManager;
  return { exec, launches };
}
const planner = {
  planRepository: async () => ({
    plan: RunPlanSchema.parse({
      runtime: { language: 'node', version: '20' }, packageManager: 'npm', installCommand: 'npm ci',
      buildCommand: null, startCommand: 'npm run dev', workingDirectory: '.', expectedPort: 3000, planSource: 'rule-based',
    }),
    detected: 'next', warnings: [],
  }),
};
const analyzer = { analyze: async () => ({ warnings: [], envExample: [], lockfiles: [], frameworkConfigs: [] }) };

async function runOnce(hints: InMemoryHints, fitsAt: number) {
  const { exec, launches } = single(fitsAt);
  const m = new SessionManager(exec, { analyzer: analyzer as never, planner: planner as never, memoryHints: hints });
  const s = await m.launch({ sourceDir: '/tmp/wrrnlim', image: 'devlaunch/node:20' });
  for (let i = 0; i < 300 && !([ExecutionState.READY, ExecutionState.FAILED] as ExecutionState[]).includes(s.state); i++) await new Promise((r) => setTimeout(r, 20));
  const log = s.logs.buffer.all().map((l) => l.text).join('\n');
  const state = s.state; // read before shutdown, which cancels a session still running
  await m.shutdown();
  await new Promise((r) => setTimeout(r, 20)); // the hint is saved after the attempt closes
  return { state, launches, log };
}

describe('a repository that needed more memory last time', () => {
  it('starts the next run there, and says why (wrrnlim/nextjs-docker-postgres-template)', async () => {
    // Every run was killed at 1024 MB first, then needed 2048: the first try was wasted.
    const hints = new InMemoryHints();
    const first = await runOnce(hints, 2048);
    expect(first.launches).toEqual([1024, 2048]);
    expect(await hints.get(memoryHintKey('/tmp/wrrnlim'))).toBe(2048);

    const second = await runOnce(hints, 2048);
    expect(second.state).toBe(ExecutionState.READY);
    expect(second.launches).toEqual([2048]);
    expect(second.log).toMatch(/Starting with 2048 MB instead of 1024 MB: the last run of this repository needed it/);
  });

  it('remembers nothing when the usual limit was enough', async () => {
    const hints = new InMemoryHints();
    await runOnce(hints, 512);
    expect(hints.hints.size).toBe(0);
  });

  it('remembers nothing from a run that never got past its install', async () => {
    const hints = new InMemoryHints();
    const r = await runOnce(hints, 100_000);
    expect(r.state).toBe(ExecutionState.FAILED);
    expect(hints.hints.size).toBe(0);
  });

  it('never starts above the ceiling, whatever was saved', async () => {
    const hints = new InMemoryHints();
    await hints.remember(memoryHintKey('/tmp/wrrnlim'), 64_000);
    const r = await runOnce(hints, 2048);
    expect(r.launches[0]).toBe(4096);
  });
});
