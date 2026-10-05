import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FailureCode, RunPlanSchema, type FailureDetail, type RunPlan } from '@devlaunch/shared';
import { discoverServices, requiredEnvReads } from '../services/analysis/ServiceDiscovery.js';
import { parseEnvExample } from '../services/analysis/parseEnvExample.js';
import { missingEntryFile } from '../services/planning/Feasibility.js';
import { healthPathFor } from '../services/planning/RuleBasedPlanner.js';
import {
  projectWithExampleDefaults,
  withExampleDefaults,
} from '../services/planning/RequiredConfiguration.js';
import { FailureClassifier } from '../services/failures/FailureClassifier.js';
import type { RepositoryMetadata, ProjectPlan, ServiceCandidate } from '@devlaunch/shared';

/**
 * `techiescamp/kubernetes-ai-projects`: the application is `ai-agent/agent-interface`
 * (Next.js) and `ai-agent/agent-backend` (FastAPI, psycopg 3), nothing runs at the root.
 * DevLaunch looked one level down, found nothing, asked the model, ran `node index.js`
 * in a repository with no index.js and called it a missing dependency.
 */

const scratch: string[] = [];
afterAll(async () => {
  await Promise.all(scratch.map((d) => rm(d, { recursive: true, force: true }).catch(() => undefined)));
});

async function repo(files: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'devlaunch-wrap-'));
  scratch.push(root);
  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, typeof contents === 'string' ? contents : JSON.stringify(contents));
  }
  return root;
}

const web = { name: 'frontend', scripts: { dev: 'next dev' }, dependencies: { next: '16', react: '19' } };
const api = 'fastapi==0.116.1\nuvicorn[standard]==0.35.0\npsycopg[binary]==3.2.3\n';

describe('an application kept inside one folder', () => {
  it('is found when nothing at the root or one level down runs', async () => {
    const root = await repo({
      'ai-agent/agent-interface/package.json': web,
      'ai-agent/agent-backend/requirements.txt': api,
      'agent-sandbox/python-sdk/sandbox.py': 'print(1)\n',
      'README.md': '# k8s ai\n',
    });
    const { services, backing } = await discoverServices(root);
    expect(services.map((s) => `${s.role}:${s.dir}`)).toEqual([
      'web:ai-agent/agent-interface',
      'api:ai-agent/agent-backend',
    ]);
    // psycopg 3 installs under its own name, and needs a Postgres as much as psycopg2.
    expect(backing.map((b) => b.kind)).toEqual(['postgres']);
  });

  it('is not looked for when the root is itself the application', async () => {
    const root = await repo({
      'package.json': { name: 'solo', scripts: { start: 'node server.js' }, dependencies: { express: '4' } },
      'ai-agent/agent-interface/package.json': web,
      'ai-agent/agent-backend/requirements.txt': api,
    });
    const { candidates } = await discoverServices(root);
    expect(candidates.map((c) => c.dir)).toEqual(['.']);
  });

  it('is not looked for when a top-level folder already runs', async () => {
    const root = await repo({
      'frontend/package.json': web,
      'tools/admin/package.json': { name: 'admin', scripts: { start: 'node a.js' }, dependencies: { express: '4' } },
    });
    const { candidates } = await discoverServices(root);
    expect(candidates.map((c) => c.dir)).toEqual(['frontend']);
  });

  it('is not invented out of two separate projects', async () => {
    // A collection of tutorials: running both as one application is an app nobody wrote.
    const root = await repo({
      'project-one/frontend/package.json': web,
      'project-two/backend/requirements.txt': api,
    });
    const { candidates } = await discoverServices(root);
    expect(candidates).toEqual([]);
  });

  it('is never taken from a folder of examples', async () => {
    const root = await repo({ 'examples/basic/package.json': web });
    const { candidates } = await discoverServices(root);
    expect(candidates).toEqual([]);
  });
});

const plan = (over: Partial<RunPlan> = {}): RunPlan =>
  RunPlanSchema.parse({
    runtime: { language: 'node', version: '20' },
    packageManager: 'npm',
    installCommand: null,
    buildCommand: null,
    startCommand: 'node index.js',
    workingDirectory: '.',
    expectedPort: 3000,
    planSource: 'ai-fallback',
    ...over,
  });

describe('a start command that runs a file the repository does not have', () => {
  it('is refused before a container exists', async () => {
    const root = await repo({ 'README.md': '# nothing to run here\n' });
    expect(await missingEntryFile(plan(), root)).toBe(
      'The start command runs `index.js`, and the repository has no such file.',
    );
  });

  it('is judged inside the directory the plan runs in', async () => {
    const root = await repo({ 'api/server.py': 'print(1)\n' });
    const py = (start: string) => plan({ startCommand: start, workingDirectory: 'api' });
    expect(await missingEntryFile(py('python server.py'), root)).toBeNull();
    expect(await missingEntryFile(py('python app.py'), root)).toMatch(/`api\/` has no such file/);
  });

  it('is left alone when a build could still write the file', async () => {
    const root = await repo({ 'src/index.ts': '' });
    expect(await missingEntryFile(plan({ buildCommand: 'npm run build' }), root)).toBeNull();
    expect(await missingEntryFile(plan({ startCommand: 'node dist/index.js' }), root)).toBeNull();
  });

  it('is a question asked of a model plan only', async () => {
    // A rule names an entry because it found one; a caller's own plan is theirs.
    const root = await repo({ 'README.md': '' });
    expect(await missingEntryFile(plan({ planSource: 'rule-based' }), root)).toBeNull();
  });

  it('is left alone when the command is not plainly a runner and a file', async () => {
    const root = await repo({ 'README.md': '' });
    for (const start of ['npm start', 'python -m app', 'node --require x.js app.js', 'node /abs/app.js', 'uvicorn main:app']) {
      expect(await missingEntryFile(plan({ startCommand: start }), root), start).toBeNull();
    }
  });
});

describe('an entry file Node cannot find', () => {
  const classifier = new FailureClassifier();
  const fallback: FailureDetail = { code: FailureCode.START_COMMAND_FAILED, message: 'exited', confidence: 'low' };
  const classify = (logs: string) => classifier.classify({ logs, phase: 'start', fallback });

  it('is named as the start command running a missing file, not a missing dependency', () => {
    const verdict = classify(
      [
        "Error: Cannot find module '/workspace/index.js'",
        '    at Module._resolveFilename (node:internal/modules/cjs/loader:1207:15)',
        '  code: \'MODULE_NOT_FOUND\',',
        '  requireStack: []',
        '}',
      ].join('\n'),
    );
    expect(verdict.code).toBe(FailureCode.START_COMMAND_FAILED);
    expect(verdict.message).toBe('The start command runs `index.js`, and there is no such file.');
  });

  it('stays a missing module when something required it', () => {
    const verdict = classify(
      [
        "Error: Cannot find module '/workspace/config'",
        "  requireStack: [ '/workspace/server.js' ]",
      ].join('\n'),
    );
    expect(verdict.message).toMatch(/^A module the application imports is missing/);
  });
});

describe('which route says the service is up', () => {
  const meta = (paths: string[]) =>
    ({ httpRoutes: paths.map((path) => ({ method: 'GET', path, source: 'main.py' })) }) as unknown as RepositoryMetadata;

  it('is a liveness route rather than one that checks everything the service depends on', () => {
    // `/readyz` here calls the Kubernetes API: 503 forever outside a cluster.
    expect(healthPathFor(meta(['/api/health', '/healthz', '/readyz', '/api/history']))).toBe('/healthz');
    // Even when a route doing real work is shorter.
    expect(healthPathFor(meta(['/api/health', '/items']))).toBe('/api/health');
  });

  it('avoids a readiness route even with no liveness route beside it', () => {
    expect(healthPathFor(meta(['/readyz', '/api/items']))).toBe('/api/items');
    expect(healthPathFor(meta(['/readyz']))).toBe('/readyz');
  });
});

describe('the values an example file ships', () => {
  it('are read the way dotenv reads them', () => {
    const vars = parseEnvExample(
      'AWS_REGION=us-east-1\nQUOTED="a b"\nNOTE=x # trailing\nEMPTY=\nKEY=your-key-here\n',
    );
    expect(vars).toEqual([
      { key: 'AWS_REGION', hasDefault: true, value: 'us-east-1' },
      { key: 'QUOTED', hasDefault: true, value: 'a b' },
      { key: 'NOTE', hasDefault: true, value: 'x' },
      { key: 'EMPTY', hasDefault: false },
      { key: 'KEY', hasDefault: false },
    ]);
  });

  it('reach only a variable the code cannot start without', async () => {
    // Every example value copied broke `remix-run/indie-stack` (3 failures in 5 runs,
    // against 4 passes in 4 without): its code reads them softly and has its own defaults.
    const root = await repo({
      'app/infra/bedrock.py': 'AWS_REGION = os.environ["AWS_REGION"]\nLEVEL = os.environ.get("LOG_LEVEL", "INFO")\n',
      'server.js': 'const s = process.env.SESSION_SECRET;\n',
    });
    const required = await requiredEnvReads(root);
    expect([...required]).toEqual(['AWS_REGION']);
    const out = withExampleDefaults(
      plan(),
      [
        { key: 'AWS_REGION', hasDefault: true, value: 'us-east-1' },
        { key: 'LOG_LEVEL', hasDefault: true, value: 'DEBUG' },
        { key: 'SESSION_SECRET', hasDefault: true, value: 'super-duper-s3cret' },
      ],
      new Set(),
      required,
    );
    expect(out.environmentVariables.map((v) => v.key)).toEqual(['AWS_REGION']);
  });

  it('reach the plan as its lowest layer', () => {
    const everything = new Set(['AWS_REGION', 'MODEL', 'DATABASE_URL', 'PORT', 'API_URL', 'NODE_OPTIONS', 'LOG_LEVEL', 'DATABASE_URL_SQLITE', 'MONGO_URI_TESTS', 'APP_DB_URL']);
    const out = withExampleDefaults(
      plan({ environmentVariables: [{ key: 'MODEL', value: 'mine', required: false }] }),
      [
        { key: 'AWS_REGION', hasDefault: true, value: 'us-east-1' },
        { key: 'MODEL', hasDefault: true, value: 'theirs' }, // the plan's own wins
        { key: 'DATABASE_URL', hasDefault: true, value: 'postgres://db/x' }, // DevLaunch supplies it
        { key: 'PORT', hasDefault: true, value: '5000' },
        { key: 'API_URL', hasDefault: true, value: 'http://localhost:8000' }, // this container, in a container
        { key: 'NODE_OPTIONS', hasDefault: true, value: '--max-old-space-size=4096' }, // the validator's to refuse
        { key: 'LOG_LEVEL', hasDefault: true }, // documented optional, no value
        // A database address, provisioned or not, is never an example's to set:
        // `remix-run/indie-stack` failed with its SQLite file URL copied in.
        { key: 'DATABASE_URL_SQLITE', hasDefault: true, value: 'file:./data.db?connection_limit=1' },
        { key: 'MONGO_URI_TESTS', hasDefault: true, value: 'x' },
        { key: 'APP_DB_URL', hasDefault: true, value: 'x' },
      ],
      new Set(['DATABASE_URL']),
      everything,
    );
    expect(
      withExampleDefaults(plan(), [{ key: 'DATABASE_URL', hasDefault: true, value: 'file:./data.db' }], new Set(), everything).environmentVariables,
      'not provisioned, and still not copied',
    ).toEqual([]);
    expect(out.environmentVariables).toEqual([
      { key: 'MODEL', value: 'mine', required: false },
      { key: 'AWS_REGION', value: 'us-east-1', required: false },
    ]);
  });

  it('reach each service from its own file, never a database address DevLaunch provisions', () => {
    const project = {
      planSource: 'rule-based',
      services: [
        { ...plan({ workingDirectory: 'ai-agent/agent-backend' }), name: 'agent-backend', role: 'api' },
      ],
    } as unknown as ProjectPlan;
    const candidates = [
      {
        name: 'agent-backend', dir: 'ai-agent/agent-backend', role: 'api', language: 'python', scripts: [], evidence: 't',
        envExample: [
          { key: 'AWS_REGION', hasDefault: true, value: 'us-east-1' },
          { key: 'DATABASE_URL', hasDefault: true, value: 'postgres://example/db' },
        ],
      },
    ] as ServiceCandidate[];
    const out = projectWithExampleDefaults(project, candidates, [
      { kind: 'postgres', evidence: 'psycopg', urlEnvKeys: ['DATABASE_URL'], neededBy: ['agent-backend'] },
    ], new Map([['ai-agent/agent-backend', new Set(['AWS_REGION', 'DATABASE_URL'])]]));
    expect(out.services[0]!.environmentVariables.map((v) => v.key)).toEqual(['AWS_REGION']);
  });
});
