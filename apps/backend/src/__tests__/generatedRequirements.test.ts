import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunPlanSchema } from '@devlaunch/shared';
import { ExecutionManager, derivedRequirements } from '../services/execution/ExecutionManager.js';
import type { DockerManager } from '../services/docker/DockerManager.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const POETRY = '[tool.poetry.dependencies]\npython = "^3.9"\nflask = "^2.3"\n';

describe('the requirements file DevLaunch writes', () => {
  it('is derived from the pyproject.toml in the directory the plan runs in', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devlaunch-genreq-'));
    dirs.push(root);
    await mkdir(join(root, 'backend'));
    await writeFile(join(root, 'backend', 'pyproject.toml'), POETRY);
    await writeFile(join(root, 'pyproject.toml'), '[tool.poetry.dependencies]\ndjango = "^4"\n');
    expect(await derivedRequirements(root, 'backend')).toEqual(['flask>=2.3,<3.0']);
    expect(await derivedRequirements(root, '.')).toEqual(['django>=4,<5']);
  });

  it('is empty when there is no pyproject.toml to derive it from', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devlaunch-genreq-'));
    dirs.push(root);
    expect(await derivedRequirements(root, '.')).toEqual([]);
  });

  it('never reads outside the source directory, whatever the plan says', async () => {
    // The working directory is validated long before this; this is the second layer, and
    // the only thing between a plan and a read of a file the repository does not own.
    const parent = await mkdtemp(join(tmpdir(), 'devlaunch-genreq-'));
    dirs.push(parent);
    await mkdir(join(parent, 'repo'));
    await mkdir(join(parent, 'elsewhere'));
    await writeFile(join(parent, 'elsewhere', 'pyproject.toml'), POETRY);
    expect(await derivedRequirements(join(parent, 'repo'), '../elsewhere')).toEqual([]);
    expect(await derivedRequirements(join(parent, 'repo'), join(parent, 'elsewhere'))).toEqual([]);
  });
});

describe('when the requirements file is written into the container', () => {
  /** What a launch copies in for a plan with these commands, against a repository with a pyproject. */
  async function written(commands: { installCommand?: string | null; buildCommand?: string | null; startCommand?: string }) {
    const root = await mkdtemp(join(tmpdir(), 'devlaunch-genreq-'));
    dirs.push(root);
    await writeFile(join(root, 'pyproject.toml'), POETRY);
    const files: { name: string; body: string; dir: string }[] = [];
    const docker = { installFile: async (_c: unknown, name: string, body: string, dir: string) => { files.push({ name, body, dir }); } };
    const plan = RunPlanSchema.parse({
      runtime: { language: 'python', version: '3.12' }, packageManager: 'pip',
      installCommand: null, buildCommand: null, startCommand: 'uvicorn app.main:app --host 0.0.0.0 --port 8000',
      workingDirectory: '.', expectedPort: 8000, planSource: 'ai-fallback', ...commands,
    });
    const exec = new ExecutionManager(docker as unknown as DockerManager);
    await (exec as unknown as { installGeneratedRequirements(c: unknown, o: unknown): Promise<unknown> })
      .installGeneratedRequirements({}, { plan, sourceDir: root });
    return files;
  }
  const RUN = 'pip install -r /workspace/.devlaunch/requirements.txt';

  it('is written when the install step names it', async () => {
    expect(await written({ installCommand: RUN })).toEqual([
      { name: 'requirements.txt', body: 'flask>=2.3,<3.0\n', dir: '/workspace/.devlaunch' },
    ]);
  });

  it('is written when the build step names it (nsidnev/fastapi-realworld-example-app)', async () => {
    // A model's rewrite installed a pinned asyncpg first and moved this into the build
    // step; the file was not there and the run died on `Could not open requirements file`.
    const files = await written({ installCommand: 'pip install asyncpg==0.29.0', buildCommand: RUN });
    expect(files.map((f) => f.body)).toEqual(['flask>=2.3,<3.0\n']);
  });

  it('is written when the start step names it', async () => {
    const files = await written({ startCommand: `${RUN} && uvicorn app.main:app --host 0.0.0.0 --port 8000` });
    expect(files).toHaveLength(1);
  });

  it('is not written for a plan that never names it', async () => {
    expect(await written({ installCommand: 'pip install -r requirements.txt' })).toEqual([]);
  });
});
