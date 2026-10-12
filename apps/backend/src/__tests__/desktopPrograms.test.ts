import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecutionState, FailureCode, RunPlanSchema, type RunPlan } from '@devlaunch/shared';
import { RepositoryAnalyzer } from '../services/analysis/RepositoryAnalyzer.js';
import { RuleBasedPlanner } from '../services/planning/RuleBasedPlanner.js';
import { servesFilesInstead } from '../services/planning/Feasibility.js';
import { SessionManager, desktopProgram } from '../services/session/SessionManager.js';
import type { ExecutionManager, LaunchHandle, ReadyOutcome } from '../services/execution/ExecutionManager.js';
import { LogManager } from '../services/logs/LogManager.js';

/**
 * `alanjohnks/Snake-game`: a turtle game. It draws in a window on the computer's own screen,
 * so in a container it crashed ("libtk8.6.so: cannot open shared object file"); a model's
 * repair then served its folder with `python3 -m http.server`, and the run was READY — a
 * directory listing, reported as the game working.
 */
const scratch: string[] = [];
afterAll(async () => {
  await Promise.all(scratch.map((d) => rm(d, { recursive: true, force: true })));
});
async function repo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'devlaunch-desktop-'));
  scratch.push(root);
  for (const [p, body] of Object.entries(files)) await writeFile(join(root, p), body);
  return root;
}
const analyzer = new RepositoryAnalyzer();

// The game's shape: main.py imports turtle, and its own snake.py and food.py.
const snake = {
  'main.py': 'from turtle import Screen\nfrom snake import Snake\nscreen = Screen()\n',
  'snake.py': 'from turtle import Turtle\nclass Snake:\n    pass\n',
};

describe('a desktop program', () => {
  it('is named as one before anything runs, with what to do instead', async () => {
    const failure = desktopProgram(await analyzer.analyze(await repo(snake)));
    expect(failure?.code).toBe(FailureCode.UNSUPPORTED_PROJECT);
    expect(failure?.message).toMatch(/desktop program: main\.py uses turtle, which opens a window on your own screen/);
    expect(failure?.remedy).toMatch(/python main\.py/);
  });

  it('is not a web app that also has a little tkinter or pygame in it', async () => {
    const flask = await repo({ ...snake, 'app.py': 'from flask import Flask\napp = Flask(__name__)\n' });
    expect(desktopProgram(await analyzer.analyze(flask))).toBeNull();
    const node = await repo({ ...snake, 'package.json': JSON.stringify({ name: 'x', scripts: { start: 'node server.js' } }) });
    expect(desktopProgram(await analyzer.analyze(node))).toBeNull();
    expect(desktopProgram(await analyzer.analyze(await repo({ 'main.py': 'import requests\nprint(1)\n' })))).toBeNull();
  });

  it('fails the run at analysis: nothing is started, and nothing is served in its place', async () => {
    let launched = 0;
    const exec = { launch: async () => { launched++; throw new Error('not reached'); } } as unknown as ExecutionManager;
    const mgr = new SessionManager(exec, { analyzer, planner: new RuleBasedPlanner(analyzer) });
    const s = await mgr.launch({ sourceDir: await repo(snake) });
    for (let i = 0; i < 200 && s.state !== ExecutionState.FAILED; i++) await new Promise((r) => setTimeout(r, 10));
    expect(s.state).toBe(ExecutionState.FAILED);
    expect(s.failure?.code).toBe(FailureCode.UNSUPPORTED_PROJECT);
    // Said as what it is, not as a project nothing could plan.
    expect(s.failure?.message).toMatch(/desktop program/);
    expect(launched).toBe(0);
    await mgr.shutdown();
  });
});

describe('a repair that serves the files instead of running the project', () => {
  it('is told apart from one that runs it', () => {
    expect(servesFilesInstead('python3 main.py', 'python3 -m http.server 8000')).toBe(true);
    expect(servesFilesInstead('node server.js', 'npx serve -l 3000')).toBe(true);
    expect(servesFilesInstead('npm run dev', 'npx http-server -p 8080')).toBe(true);
    // Already a file server: a port change is still a repair.
    expect(servesFilesInstead('python3 -m http.server 8000', 'python3 -m http.server 8080')).toBe(false);
    expect(servesFilesInstead('python3 main.py', 'python3 app.py')).toBe(false);
    expect(servesFilesInstead('npm run start', 'npm run serve')).toBe(false);
  });

  it('is not used: the run fails with its own diagnosis, never READY on a directory listing', async () => {
    const plan = (start: string): RunPlan =>
      RunPlanSchema.parse({ runtime: { language: 'python', version: '3.12' }, packageManager: 'pip', installCommand: null, buildCommand: null, startCommand: start, workingDirectory: '.', expectedPort: 8000, planSource: 'ai-fallback' });
    const started: string[] = [];
    const exec = {
      async launch(o: { logs?: LogManager; plan: RunPlan }) {
        started.push(o.plan.startCommand);
        const logs = o.logs ?? new LogManager();
        logs.buffer.push('stderr', 'ImportError: libtk8.6.so: cannot open shared object file: No such file or directory');
        return {
          logs,
          waitForReady: async (): Promise<ReadyOutcome> =>
            o.plan.startCommand.includes('http.server')
              ? { state: ExecutionState.READY, hostPort: '1', url: 'http://localhost:1/', readiness: { ready: true, attempts: 1, elapsedMs: 1, status: 200 } }
              : { state: ExecutionState.FAILED, hostPort: null, readiness: { ready: false, attempts: 1, elapsedMs: 1 }, failure: { code: FailureCode.START_COMMAND_FAILED, message: 'Start command exited with code 1.', phase: 'start' } },
          clearStartupBudget: () => {},
          cleanup: async () => ({ errors: [] }),
        } as unknown as LaunchHandle;
      },
    } as unknown as ExecutionManager;
    const aiRepair = { repair: async () => ({ plan: plan('python3 -m http.server 8000'), attempt: 1, note: 'serve the files' }) };
    // Through analysis, as a real run is: repair reads what the scan found.
    const planner = { planRepository: async () => ({ plan: plan('python3 main.py'), detected: 'ai-fallback', warnings: [] }) };
    const mgr = new SessionManager(exec, { analyzer, planner: planner as never, aiRepair: aiRepair as never, aiAvailable: () => true });
    const dir = await repo({ 'main.py': 'print(1)\n' });
    const s = await mgr.launch({ sourceDir: dir });
    for (let i = 0; i < 300 && s.state !== ExecutionState.FAILED && s.state !== ExecutionState.READY; i++) await new Promise((r) => setTimeout(r, 10));
    expect(s.state).toBe(ExecutionState.FAILED);
    expect(started).toEqual(['python3 main.py']);
    expect(s.logs.buffer.all().map((l) => l.text).join('\n')).toMatch(/would serve the project's files instead of running it/);
    await mgr.shutdown();
  });
});
