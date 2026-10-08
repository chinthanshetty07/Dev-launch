import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pythonImageVersion, pythonVersionFloor } from '../services/analysis/pythonVersion.js';
import { RepositoryAnalyzer } from '../services/analysis/RepositoryAnalyzer.js';
import { RuleBasedPlanner } from '../services/planning/RuleBasedPlanner.js';
import { imageForRuntime } from '../services/security/ImageAllowlist.js';

/**
 * The Python a project says it needs. From `robstermarinho/django-react-docker-stack`:
 * it states 3.13, ran on 3.12, and pip skipped every requirement ("Ignoring django:
 * markers 'python_version >= "3.13"' don't match your environment") — `No module named
 * 'django'`, with nothing a repair could do.
 */
const EXPORTED = [
  'asgiref==3.9.1 ; python_version >= "3.13"',
  'django==5.2.5 ; python_version >= "3.13"',
  'djangorestframework==3.16.1 ; python_version >= "3.13"',
  'psycopg2-binary==2.9.10 ; python_version >= "3.13"',
].join('\n');

describe('the Python version a project asks for', () => {
  it('reads it from each place projects state it', () => {
    expect(pythonVersionFloor({ pyproject: '[project]\nrequires-python = ">=3.13"\n' })?.version).toBe('3.13');
    expect(pythonVersionFloor({ pyproject: '[tool.poetry.dependencies]\npython = "^3.13"\ndjango = "^5"\n' })?.version).toBe('3.13');
    expect(pythonVersionFloor({ pythonVersionFile: '3.13.1\n' })?.version).toBe('3.13');
    expect(pythonVersionFloor({ runtimeTxt: 'python-3.13.0' })?.version).toBe('3.13');
    expect(pythonVersionFloor({ requirementsTxt: EXPORTED })?.evidence).toMatch(/every line of requirements.txt/);
    expect(pythonVersionFloor({ dockerfile: 'FROM python:3.13-slim-bookworm\nRUN pip install x\n' })?.version).toBe('3.13');
  });

  it('takes the highest floor when several are stated', () => {
    expect(pythonVersionFloor({ pyproject: 'requires-python = ">=3.10"\n', dockerfile: 'FROM python:3.13-slim\n' })?.version).toBe('3.13');
  });

  it('does not read one backport\'s marker, or a ceiling, as the project\'s floor', () => {
    expect(pythonVersionFloor({ requirementsTxt: 'django==5\nrequests==2\ntomli==2 ; python_version < "3.11"\nexceptiongroup ; python_version >= "3.11"\n' })).toBeUndefined();
    expect(pythonVersionFloor({ pyproject: 'requires-python = "<3.12"\n' })).toBeUndefined();
  });

  it('picks the lowest image that meets it, and the default otherwise', () => {
    expect(pythonImageVersion({ version: '3.13', evidence: '' }, ['3.12', '3.13'], '3.12')).toBe('3.13');
    expect(pythonImageVersion({ version: '3.10', evidence: '' }, ['3.12', '3.13'], '3.12')).toBe('3.12');
    expect(pythonImageVersion(undefined, ['3.12', '3.13'], '3.12')).toBe('3.12');
    expect(pythonImageVersion({ version: '3.14', evidence: '' }, ['3.12', '3.13'], '3.12')).toBe('3.12');
  });
});

describe('planning a project that needs 3.13', () => {
  it('runs it on the approved 3.13 image, saying why', async () => {
    const root = mkdtempSync(join(tmpdir(), 'devlaunch-py313-'));
    mkdirSync(join(root, 'core'));
    writeFileSync(join(root, 'manage.py'), 'import os\nos.environ.setdefault("DJANGO_SETTINGS_MODULE", "core.settings")\n');
    writeFileSync(join(root, 'core', 'settings.py'), 'SECRET_KEY = "x"\n');
    writeFileSync(join(root, 'requirements.txt'), EXPORTED);
    writeFileSync(join(root, 'pyproject.toml'), '[project]\nname = "x"\nrequires-python = ">=3.13"\n');
    const outcome = await new RuleBasedPlanner(new RepositoryAnalyzer()).planRepository(root);
    expect(outcome.plan?.runtime).toEqual({ language: 'python', version: '3.13' });
    expect(imageForRuntime('python', '3.13')).toBe('devlaunch/python:3.13');
    expect(outcome.warnings.join('\n')).toMatch(/Running Python 3\.13 rather than 3\.12/);
  });
});
