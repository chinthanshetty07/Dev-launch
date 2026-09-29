import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RepositoryAnalyzer } from '../services/analysis/RepositoryAnalyzer.js';
import { RuleBasedPlanner } from '../services/planning/RuleBasedPlanner.js';

/**
 * A Flask application built by a factory in a package — the official tutorial's layout,
 * and `JayBhatt2021/improved-flask-tutorial-app`'s.
 *
 * No `app.py` exists anywhere, so no rule planned it and every run went to a model, which
 * chose gunicorn, then waitress, then gunicorn again without installing it. The package's
 * `__init__.py` is the entry point, and `flaskr:create_app` is what Flask should run.
 */
const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../fixtures');
const analyzer = new RepositoryAnalyzer();
const planner = new RuleBasedPlanner(analyzer);

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
/** A repository with a pyproject depending on flask and `pkg/__init__.py` as given. */
async function repo(init: string, extra: Record<string, string> = {}): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'devlaunch-flask-factory-'));
  dirs.push(d);
  await writeFile(join(d, 'pyproject.toml'), '[project]\nname = "pkg"\nversion = "1"\ndependencies = ["flask"]\n');
  await mkdir(join(d, 'pkg'));
  await writeFile(join(d, 'pkg', '__init__.py'), init);
  for (const [name, body] of Object.entries(extra)) await writeFile(join(d, name), body);
  return d;
}

describe('a Flask application factory inside a package', () => {
  it('is found in __init__.py, under the package name, with its factory', async () => {
    const meta = await analyzer.analyze(`${FIXTURES}/python-flask-factory`);
    expect(meta.python?.entryCandidates).toContainEqual(
      expect.objectContaining({ file: 'flaskr/__init__.py', module: 'flaskr', framework: 'flask', appFactory: 'create_app' }),
    );
  });

  it('does not report the app built inside the factory as a module-level app', async () => {
    // `app = Flask(__name__)` indented inside create_app is a local. Reported as the app
    // object, it made the plan `FLASK_APP=flaskr` and left the factory to discovery.
    const meta = await analyzer.analyze(`${FIXTURES}/python-flask-factory`);
    const entry = meta.python?.entryCandidates.find((e) => e.file === 'flaskr/__init__.py');
    expect(entry?.appVariable).toBeUndefined();
  });

  it('is planned by rule, naming the factory', async () => {
    const out = await planner.planRepository(`${FIXTURES}/python-flask-factory`);
    expect(out.detected).toBe('flask');
    expect(out.plan).toMatchObject({
      planSource: 'rule-based',
      startCommand: 'flask run --host=0.0.0.0 --port=5000',
      workingDirectory: '.',
    });
    expect(out.plan?.environmentVariables).toContainEqual(
      expect.objectContaining({ key: 'FLASK_APP', value: 'flaskr:create_app' }),
    );
  });

  it('names only the package when the app is built at module level', async () => {
    const d = await repo('from flask import Flask\n\napp = Flask(__name__)\n');
    const out = await planner.planRepository(d);
    expect(out.plan?.environmentVariables).toContainEqual(expect.objectContaining({ key: 'FLASK_APP', value: 'pkg' }));
  });

  it('names only the package when it has a module-level app and a factory', async () => {
    // Flask itself takes the module-level `app` first; naming the factory would build a
    // second application the author did not start.
    const d = await repo('from flask import Flask\n\napp = Flask(__name__)\n\ndef create_app():\n    return app\n');
    const out = await planner.planRepository(d);
    expect(out.plan?.environmentVariables).toContainEqual(expect.objectContaining({ key: 'FLASK_APP', value: 'pkg' }));
  });

  it('accepts make_app, and a factory whose arguments all have defaults', async () => {
    const d = await repo('from flask import Flask\n\ndef make_app(config=None, *, debug=False):\n    return Flask(__name__)\n');
    const out = await planner.planRepository(d);
    expect(out.plan?.environmentVariables).toContainEqual(expect.objectContaining({ key: 'FLASK_APP', value: 'pkg:make_app' }));
  });

  it('does not treat a factory that needs an argument as runnable', async () => {
    // Nothing here knows what `config` should be, and Flask cannot call it either.
    const d = await repo('from flask import Flask\n\ndef create_app(config):\n    return Flask(__name__)\n');
    const meta = await analyzer.analyze(d);
    expect(meta.python?.entryCandidates.some((e) => e.file === 'pkg/__init__.py')).toBe(false);
  });

  it('does not treat an __init__.py that only imports flask as the application', async () => {
    // A package of blueprints imports flask too; it is not an entry point.
    const d = await repo('from flask import Blueprint\n\nbp = Blueprint("x", __name__)\n');
    const meta = await analyzer.analyze(d);
    expect(meta.python?.entryCandidates.some((e) => e.file === 'pkg/__init__.py')).toBe(false);
  });

  it('prefers a conventional entry file in the package over its __init__.py', async () => {
    const d = await repo('from flask import Flask\n\ndef create_app():\n    return Flask(__name__)\n');
    await writeFile(join(d, 'pkg', 'app.py'), 'from flask import Flask\n\napp = Flask(__name__)\n');
    const out = await planner.planRepository(d);
    expect(out.plan?.environmentVariables).toContainEqual(expect.objectContaining({ key: 'FLASK_APP', value: 'pkg.app' }));
  });
});
