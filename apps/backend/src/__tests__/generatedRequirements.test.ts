import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { derivedRequirements } from '../services/execution/ExecutionManager.js';

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
