import { describe, it, expect } from 'vitest';
import { RunPlanSchema, type RunPlan } from '@devlaunch/shared';
import { impossibleCommand, scriptRun } from '../services/planning/Feasibility.js';

const plan = (over: Partial<RunPlan> = {}): RunPlan =>
  RunPlanSchema.parse({
    runtime: { language: 'node', version: '20' },
    packageManager: 'npm',
    installCommand: 'npm install',
    buildCommand: null,
    startCommand: 'npm run dev',
    workingDirectory: '.',
    expectedPort: 3000,
    planSource: 'rule-based',
    ...over,
  });

/**
 * The validator asked two questions of every plan — is it well-formed, is it safe — and
 * never the third: is it possible. `Preeti-Dalawai6/dataforge` has a broken import of
 * its own, so the rule plan failed honestly; the model was then asked once and answered
 * `npm run serve`, a script in no package.json anywhere. DevLaunch built the container,
 * installed the tree and waited sixty seconds to be told `Missing script: "serve"`.
 */
describe('a plan that names something the repository does not have', () => {
  const scripts = ['start', 'dev'];

  it('catches an invented script before anything is built', () => {
    const problem = impossibleCommand(plan({ startCommand: 'npm run serve' }), scripts);
    expect(problem).toMatch(/no such script/);
    // And says what does exist, which is the part somebody can act on.
    expect(problem).toMatch(/dev, start/);
  });

  it('allows a script that is there', () => {
    expect(impossibleCommand(plan({ startCommand: 'npm run dev' }), scripts)).toBeNull();
  });

  it('checks the build and install commands too', () => {
    expect(impossibleCommand(plan({ buildCommand: 'npm run compile' }), scripts)).toMatch(/build command/);
    expect(impossibleCommand(plan({ installCommand: 'pnpm run bootstrap' }), scripts)).toMatch(/install command/);
  });

  it('says nothing when it has no manifest to contradict', () => {
    // A Python project, a repository whose manifest was not read, a service whose
    // scripts are unknown. Being quiet about what it cannot see is the difference
    // between a check and a guess.
    expect(impossibleCommand(plan({ startCommand: 'npm run serve' }), undefined)).toBeNull();
    expect(impossibleCommand(plan({ startCommand: 'npm run serve' }), [])).toBeNull();
  });

  it('leaves alone a command that runs no script at all', () => {
    // These are the common case and none of them can be wrong in this particular way.
    for (const command of ['node server.js', 'uvicorn app:app --port 8000', 'npm install']) {
      expect(impossibleCommand(plan({ startCommand: command }), scripts), command).toBeNull();
    }
  });
});

describe('scriptRun', () => {
  it('recognises the forms that run a script', () => {
    expect(scriptRun('npm run dev')).toBe('dev');
    expect(scriptRun('pnpm run dev -- --host 0.0.0.0')).toBe('dev');
    // yarn v1 needs no `run`, and the repositories that use it mostly omit it.
    expect(scriptRun('yarn dev')).toBe('dev');
    expect(scriptRun('yarn run dev')).toBe('dev');
  });

  it('does not mistake a package manager\'s own verb for a script', () => {
    // `npm start` runs `node server.js` with no `start` script at all, so calling it
    // impossible would refuse a plan that works.
    expect(scriptRun('npm install')).toBeNull();
    expect(scriptRun('yarn install --frozen-lockfile')).toBeNull();
    expect(scriptRun('yarn add express')).toBeNull();
    expect(scriptRun('npm ci')).toBeNull();
  });

  it('holds back on the three words that are both', () => {
    // `start`, `test` and `build` are ordinary script names *and* things a package
    // manager answers itself, and the word alone cannot say which. Treating them as
    // verbs is the conservative half: a missed check costs a minute, a wrong one
    // refuses a plan that would have run.
    expect(scriptRun('yarn start')).toBeNull();
    expect(scriptRun('yarn build')).toBeNull();
    // Spelled with `run`, the ambiguity is gone and so is the exemption.
    expect(scriptRun('yarn run build')).toBe('build');
  });

  it('ignores anything that is not a package manager', () => {
    expect(scriptRun('node server.js')).toBeNull();
    expect(scriptRun('python manage.py runserver')).toBeNull();
  });
});
