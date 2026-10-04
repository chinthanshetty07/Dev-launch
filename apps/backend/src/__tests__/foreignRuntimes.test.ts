import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecutionState, FailureCode } from '@devlaunch/shared';
import { RepositoryAnalyzer } from '../services/analysis/RepositoryAnalyzer.js';
import { RuleBasedPlanner } from '../services/planning/RuleBasedPlanner.js';
import { SessionManager } from '../services/session/SessionManager.js';
import { foreignRuntimes } from '../services/analysis/ForeignRuntimes.js';
import type { ExecutionManager } from '../services/execution/ExecutionManager.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function repo(files: Record<string, string>) {
  const d = await mkdtemp(join(tmpdir(), 'devlaunch-foreign-'));
  dirs.push(d);
  for (const [p, body] of Object.entries(files)) await writeFile(join(d, p), body);
  return d;
}
const analyzer = new RepositoryAnalyzer();

describe('a repository in a runtime DevLaunch has no image for', () => {
  it('is recognised by its manifest', () => {
    expect(foreignRuntimes(['README.md', 'pom.xml', 'go.mod', 'App.csproj']).map((f) => f.runtime)).toEqual(['Java (Maven)', 'Go', '.NET']);
    expect(foreignRuntimes(['package.json', 'requirements.txt'])).toEqual([]);
  });

  it('is declined by rule, naming what it needs', async () => {
    const d = await repo({ 'pom.xml': '<project/>', 'README.md': '# a spring app' });
    const out = await new RuleBasedPlanner(analyzer).planRepository(d);
    expect(out).toMatchObject({ plan: null, unrunnable: true });
    expect(out.reason).toMatch(/This is a Java \(Maven\) \(pom\.xml\) project\. DevLaunch runs Node 20, Node 22 and Python 3\.12/);
  });

  it('does not stop a Node application that also has one', async () => {
    const d = await repo({
      'go.mod': 'module x',
      'package.json': JSON.stringify({ name: 'a', scripts: { start: 'node server.js' }, dependencies: { express: '^4' } }),
      'server.js': "require('express')().listen(process.env.PORT || 3000);",
    });
    const out = await new RuleBasedPlanner(analyzer).planRepository(d);
    expect(out.plan).not.toBeNull();
  });

  it('is not claimed when there is JavaScript too, even JavaScript no rule can plan', async () => {
    // package.json with no start script: the usual "no rule matched" path, not a Go project.
    const d = await repo({ 'go.mod': 'module x', 'package.json': JSON.stringify({ name: 'a', scripts: { test: 'jest' } }) });
    const out = await new RuleBasedPlanner(analyzer).planRepository(d);
    expect(out.unrunnable).toBeFalsy();
    expect(out.reason ?? '').not.toMatch(/This is a Go/);
  });

  it('never reaches the model', async () => {
    const d = await repo({ 'Cargo.toml': '[package]\nname = "x"' });
    const asked: number[] = [];
    const m = new SessionManager({} as ExecutionManager, {
      analyzer, planner: new RuleBasedPlanner(analyzer),
      aiPlanner: { plan: async () => { asked.push(1); throw new Error('must not be asked'); } } as never,
    });
    const s = await m.launch({ sourceDir: d });
    for (let i = 0; i < 200 && s.state !== ExecutionState.FAILED; i++) await new Promise((r) => setTimeout(r, 10));
    await m.shutdown();
    expect(s.failure).toMatchObject({ code: FailureCode.UNSUPPORTED_PROJECT });
    expect(s.failure?.message).toMatch(/Rust \(Cargo\.toml\)/);
    expect(asked).toEqual([]);
  });
});
