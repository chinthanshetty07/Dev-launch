import { describe, it, expect } from 'vitest';
import { poetryConstraint, pyprojectRequirements, SAFE_REQUIREMENT } from '../services/analysis/ServiceDiscovery.js';

describe('Poetry constraints as PEP 440', () => {
  it.each([
    // Poetry's own definitions: ^ keeps the leftmost non-zero component, ~ allows patches.
    ['^1.2.3', '>=1.2.3,<2.0.0'],
    ['^1.9', '>=1.9,<2.0'],
    ['^0.26', '>=0.26,<0.27'],
    ['^0.0.3', '>=0.0.3,<0.0.4'],
    ['^0', '>=0,<1'],
    ['~1.2.3', '>=1.2.3,<1.3.0'],
    ['~1.2', '>=1.2,<1.3'],
    ['~1', '>=1,<2'],
    ['>=1.2, <2', '>=1.2,<2'],
    ['~=1.4', '~=1.4'],
    ['1.2.3', '==1.2.3'],
    ['*', ''],
  ])('%s → %s', (poetry, pep440) => {
    expect(poetryConstraint(poetry)).toBe(pep440);
  });

  it('declines what PEP 440 cannot say', () => {
    expect(poetryConstraint('^1 || ^2')).toBeNull();
    expect(poetryConstraint('latest')).toBeNull();
  });
});

describe('the requirements a pyproject.toml declares', () => {
  it('keeps the ranges Poetry gives, extras included (nsidnev/fastapi-realworld-example-app)', () => {
    // By name alone, `pydantic = "^1.9"` installed pydantic 2, where BaseSettings has moved.
    const lines = pyprojectRequirements([
      '[tool.poetry.dependencies]',
      'python = "^3.9"',
      'fastapi = "^0.79.1"',
      'pydantic = { version = "^1.9", extras = ["email", "dotenv"] }',
      'asyncpg = "^0.26.0"',
      '',
      '[tool.poetry.dev-dependencies]',
      'pytest = "^7.1"',
      '',
      '[tool.poetry.group.dev.dependencies]',
      'mypy = "*"',
    ].join('\n'));
    expect(lines).toEqual(['fastapi>=0.79.1,<0.80.0', 'pydantic[email,dotenv]>=1.9,<2.0', 'asyncpg>=0.26.0,<0.27.0']);
  });

  it('keeps PEP 621 ranges, across lines, and leaves the dev groups out', () => {
    const lines = pyprojectRequirements([
      '[project]',
      'name = "app"',
      'dependencies = [',
      '  "fastapi>=0.110,<1",',
      '  "uvicorn[standard] >= 0.30",',
      ']',
      '[dependency-groups]',
      'dev = ["pytest", "httpx"]',
      '[project.optional-dependencies]',
      'docs = ["mkdocs"]',
    ].join('\n'));
    expect(lines).toEqual(['fastapi>=0.110,<1', 'uvicorn[standard]>=0.30']);
  });

  it('falls back to the bare name for what it cannot express, as before', () => {
    const lines = pyprojectRequirements([
      '[project]',
      'dependencies = ["tomli; python_version < \'3.11\'", "pkg @ https://example.invalid/pkg.whl"]',
      '[tool.poetry.dependencies]',
      'either = "^1 || ^2"',
      'local = { path = "../local" }',
      'maybe = { version = "^1", optional = true }',
    ].join('\n'));
    // `maybe` is optional — installed only when an extra asks — so it is left out.
    expect(lines).toEqual(['tomli', 'pkg', 'either', 'local']);
  });

  it('reads a string whose quotes nest, without losing the entry after it', () => {
    // Single quotes inside double: a tokenizer taking either quote as the end split the
    // first entry at `'3.11'` and swallowed `b>=2` whole.
    const lines = pyprojectRequirements('[project]\ndependencies = ["a; python_version < \'3.11\'", "b>=2"]\n');
    expect(lines).toEqual(['a', 'b>=2']);
  });

  it('never writes an option or a shell fragment into the file', () => {
    // A requirements file obeys `--index-url`, `-e` and `-r`. Nothing the repository
    // writes may reach it except as a name, extras and version clauses.
    const lines = pyprojectRequirements([
      '[project]',
      'dependencies = ["--index-url=http://evil.invalid", "-e git+https://x", "-r other.txt", "ok>=1; rm -rf /", "fine[a,b]==2"]',
      '[tool.poetry.dependencies]',
      'sneaky = "1.0 --extra-index-url http://evil.invalid"',
    ].join('\n'));
    expect(lines).toEqual(['ok', 'fine[a,b]==2', 'sneaky']);
    for (const line of lines) expect(line, line).toMatch(SAFE_REQUIREMENT);
  });

  it('holds every line to a shape that cannot start an option', () => {
    for (const bad of ['--index-url=x', '-e x', 'a b', 'a>=1 --pre', 'a;b', 'a @ http://x']) {
      expect(SAFE_REQUIREMENT.test(bad), bad).toBe(false);
    }
  });
});
