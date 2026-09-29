import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { RepositoryAnalyzer, readSubmodulePaths } from '../services/analysis/RepositoryAnalyzer.js';
import { RuleBasedPlanner } from '../services/planning/RuleBasedPlanner.js';
import { ProjectPlanner } from '../services/planning/ProjectPlanner.js';

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../fixtures');
const analyzer = new RepositoryAnalyzer();
const planner = new RuleBasedPlanner(analyzer);
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function repo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'devlaunch-submodule-'));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) {
    await mkdir(join(dir, name, '..'), { recursive: true });
    await writeFile(join(dir, name), body);
  }
  return dir;
}

const GITMODULES = [
  '[submodule "realworld"]',
  '\tpath = realworld',
  '\turl = https://github.com/gothinkster/realworld.git',
  '[submodule "vendor/theme"]',
  '  path = vendor/theme',
  '  url = https://example.invalid/theme.git',
].join('\n');

describe('a repository that uses git submodules', () => {
  it('reads every path .gitmodules declares, in order', async () => {
    const dir = await repo({ '.gitmodules': GITMODULES });
    expect(await readSubmodulePaths(dir)).toEqual(['realworld', 'vendor/theme']);
  });

  it('warns before the run, naming them, on the single-service path (angular-realworld)', async () => {
    // `realworld/` is a submodule, cloned empty; the bundler then could not resolve
    // realworld/assets/theme/styles.css and the run was reported as PORT_NOT_LISTENING.
    const outcome = await planner.planRepository(`${FIXTURES}/node-submodule`);
    expect(outcome.plan).not.toBeNull();
    expect(outcome.warnings).toContain(
      'This repository uses git submodules (realworld/). DevLaunch clones without them, so that ' +
        'directory is empty here — anything the application imports, bundles or serves from it will be missing.',
    );
  });

  it('warns on the project path too, once', async () => {
    const dir = await repo({
      '.gitmodules': GITMODULES,
      'frontend/package.json': JSON.stringify({ scripts: { dev: 'vite' }, devDependencies: { vite: '^5' } }),
      'backend/package.json': JSON.stringify({ scripts: { start: 'node server.js' }, dependencies: { express: '^4' } }),
      'backend/server.js': 'require("express")().listen(process.env.PORT)',
    });
    const meta = await analyzer.analyze(dir);
    const project = await new ProjectPlanner(analyzer, planner).planProject(dir, meta);
    expect(project.plan).not.toBeNull();
    expect(project.warnings.filter((w) => w.includes('git submodules (realworld/, vendor/theme/)'))).toHaveLength(1);
  });

  it('says nothing for a repository without them, or for a subdirectory analysed alone', async () => {
    const plain = await repo({ 'package.json': JSON.stringify({ scripts: { start: 'node s.js' } }) });
    expect((await analyzer.analyze(plain)).submodules).toBeUndefined();

    const dir = await repo({ '.gitmodules': GITMODULES, 'web/package.json': '{}' });
    const sub = await analyzer.analyze(dir, 'web');
    expect(sub.submodules).toBeUndefined();
    expect(sub.warnings.join(' ')).not.toMatch(/submodule/);
  });
});
