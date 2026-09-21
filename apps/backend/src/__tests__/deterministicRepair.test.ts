import { describe, it, expect } from 'vitest';
import { FailureCode, RunPlanSchema, type RepositoryMetadata, type RunPlan } from '@devlaunch/shared';
import { tryDeterministicRepair } from '../services/planning/DeterministicRepair.js';

const plan = (over: Partial<RunPlan> = {}): RunPlan =>
  RunPlanSchema.parse({
    runtime: { language: 'node', version: '20' },
    packageManager: 'npm',
    installCommand: 'npm install',
    buildCommand: null,
    startCommand: 'npm run start',
    workingDirectory: '.',
    expectedPort: 3000,
    planSource: 'rule-based',
    ...over,
  });

const meta = (scripts: Record<string, string> = {}): RepositoryMetadata =>
  ({ warnings: [], envExample: [], lockfiles: [], frameworkConfigs: [],
     packageJson: { scripts, dependencies: {}, devDependencies: {} } }) as unknown as RepositoryMetadata;

const pyMeta = (dependencies: string[]): RepositoryMetadata =>
  ({ warnings: [], envExample: [], lockfiles: [], frameworkConfigs: [],
     python: { requirements: [], hasPyproject: true, hasPipfile: false, hasManagePy: false,
               entryCandidates: [], dependencies, packageable: false } }) as unknown as RepositoryMetadata;

const attempt = (over: {
  plan?: RunPlan; code: FailureCode; message?: string; evidence?: string; exitCode?: number;
  logs?: string; metadata?: RepositoryMetadata; previous?: RunPlan[];
}) =>
  tryDeterministicRepair({
    plan: over.plan ?? plan(),
    failure: { code: over.code, message: over.message ?? 'failed', evidence: over.evidence, exitCode: over.exitCode },
    metadata: over.metadata ?? meta(),
    logs: over.logs ?? '',
    previousAttempts: over.previous ?? [],
  });

describe('repairs a rule can make from evidence', () => {
  it('swaps a missing start script for the one the manifest has', () => {
    // Not a hypothesis: the manifest says dev exists and start does not.
    const out = attempt({
      code: FailureCode.START_COMMAND_FAILED,
      evidence: 'npm ERR! Missing script: "start"',
      metadata: meta({ dev: 'vite' }),
    });
    expect(out?.plan.startCommand).toBe('npm run dev');
    expect(out?.record.type).toBe('START_COMMAND_CORRECTION');
    expect(out?.record.source).toBe('deterministic');
    expect(out?.record.evidence[0]).toMatch(/scripts\.start absent; scripts\.dev exists/);
  });

  it('runs a Python console script as a module when it is not on PATH', () => {
    const out = attempt({
      plan: plan({ runtime: { language: 'python', version: '3.12' }, packageManager: 'pip', installCommand: 'pip install -r requirements.txt', startCommand: 'uvicorn main:app --host 0.0.0.0 --port 8000', expectedPort: 8000 }),
      code: FailureCode.START_COMMAND_FAILED,
      logs: 'sh: 1: uvicorn: not found',
    });
    expect(out?.plan.startCommand).toBe('python -m uvicorn main:app --host 0.0.0.0 --port 8000');
  });

  it('moves the expected port to the one the application says it opened', () => {
    // In the log verbatim: it listened on 8080 while the plan watched 8000.
    const out = attempt({
      plan: plan({ expectedPort: 8000 }),
      code: FailureCode.PORT_NOT_LISTENING,
      logs: 'INFO:     Uvicorn running on http://0.0.0.0:8080 (Press CTRL+C to quit)',
    });
    expect(out?.plan.expectedPort).toBe(8080);
    expect(out?.plan.environmentVariables).toContainEqual({ key: 'PORT', value: '8080', required: false });
    expect(out?.record.type).toBe('PORT_CORRECTION');
  });

  it('forces the bind address off loopback', () => {
    const out = attempt({
      plan: plan({ startCommand: 'npm run dev -- --host 127.0.0.1' }),
      code: FailureCode.PORT_BOUND_TO_LOCALHOST,
      message: 'The application is listening on 127.0.0.1:3000, which is reachable only from inside the container.',
    });
    expect(out?.plan.startCommand).toBe('npm run dev -- --host 0.0.0.0');
    expect(out?.plan.environmentVariables).toContainEqual({ key: 'HOST', value: '0.0.0.0', required: false });
  });

  it('points a 404ing FastAPI health check at /docs', () => {
    const out = attempt({
      plan: plan({ runtime: { language: 'python', version: '3.12' }, packageManager: 'pip', installCommand: null, startCommand: 'uvicorn main:app --host 0.0.0.0 --port 8000', expectedPort: 8000 }),
      code: FailureCode.APPLICATION_UNHEALTHY,
      logs: 'INFO:     172.31.250.1:55128 - "GET / HTTP/1.1" 404 Not Found',
    });
    expect(out?.plan.healthCheck.path).toBe('/docs');
    expect(out?.record.confidence).toBe('medium');
  });

  it('proposes nothing without evidence', () => {
    // The property that makes this safe to run first: it cannot invent.
    expect(attempt({ code: FailureCode.START_COMMAND_FAILED, metadata: meta({ dev: 'vite' }) })).toBeNull();
    expect(attempt({ code: FailureCode.PORT_NOT_LISTENING, logs: 'nothing useful here' })).toBeNull();
    expect(attempt({ code: FailureCode.MISSING_ENV, evidence: 'Missing script: "start"', metadata: meta({ dev: 'x' }) })).toBeNull();
  });

  it('never proposes a plan that was already tried', () => {
    const tried = plan({ startCommand: 'npm run dev' });
    const out = attempt({
      code: FailureCode.START_COMMAND_FAILED,
      evidence: 'Missing script: "start"',
      metadata: meta({ dev: 'vite' }),
      previous: [tried],
    });
    expect(out).toBeNull();
  });

  it('ignores a port the log names that no dev server could use', () => {
    const out = attempt({ plan: plan({ expectedPort: 3000 }), code: FailureCode.PORT_NOT_LISTENING, logs: 'Listening on port 80' });
    expect(out).toBeNull();
  });
});

describe('when pip is asked to build something that is not a package', () => {
  const REFUSAL = "error: Multiple top-level packages discovered in a flat-layout: ['app', 'certs', 'resources'].";

  it('installs the declared dependencies instead, with no model call', () => {
    const out = attempt({
      plan: plan({ runtime: { language: 'python', version: '3.12' }, packageManager: 'pip', installCommand: 'pip install .', startCommand: 'uvicorn main:app --host 0.0.0.0 --port 8000', expectedPort: 8000 }),
      code: FailureCode.DEPENDENCY_INSTALL_FAILED,
      logs: REFUSAL,
      metadata: pyMeta(['fastapi', 'uvicorn']),
    });
    expect(out?.plan.installCommand).toBe('pip install fastapi uvicorn');
    expect(out?.record.source).toBe('deterministic');
    expect(out?.record.evidence[0]).toMatch(/Multiple top-level packages/);
  });

  it('proposes nothing when the project declares no dependencies to install', () => {
    const out = attempt({
      plan: plan({ runtime: { language: 'python', version: '3.12' }, packageManager: 'pip', installCommand: 'pip install .', startCommand: 'uvicorn main:app --host 0.0.0.0 --port 8000', expectedPort: 8000 }),
      code: FailureCode.DEPENDENCY_INSTALL_FAILED,
      logs: REFUSAL,
      metadata: pyMeta([]),
    });
    expect(out).toBeNull();
  });
});

describe('the socket table as evidence', () => {
  const socketFailure = (over: Partial<RunPlan> = {}) =>
    tryDeterministicRepair({
      plan: plan({ expectedPort: 3000, startCommand: 'npm run dev', ...over }),
      failure: {
        code: FailureCode.PORT_NOT_LISTENING,
        message: 'Nothing is listening on port 3000.',
        observedSocket: { address: '0.0.0.0', port: 8017, loopbackOnly: false },
      },
      metadata: meta(),
      logs: '',
      previousAttempts: [],
    });

  it('corrects the port to the one the kernel says is open', () => {
    // Not a log line's claim: /proc/net/tcp inside the container. One real repository
    // prints `I am running at localhost:8017/`, which no listening pattern matched and
    // which a model was asked to interpret — twice, wrongly.
    const out = socketFailure();
    expect(out?.plan.expectedPort).toBe(8017);
    expect(out?.record.type).toBe('PORT_CORRECTION');
    expect(out?.record.evidence.join(' ')).toMatch(/socket table/);
  });

  it('fixes the bind address in the same attempt when the socket is loopback', () => {
    // Correcting the port and leaving the loopback bind spends the second of two
    // attempts rediscovering a problem this one already had the evidence for.
    const out = tryDeterministicRepair({
      plan: plan({ expectedPort: 3000 }),
      failure: {
        code: FailureCode.PORT_BOUND_TO_LOCALHOST,
        message: 'listening on 127.0.0.1:8017',
        observedSocket: { address: '127.0.0.1', port: 8017, loopbackOnly: true },
      },
      metadata: meta(),
      logs: '',
      previousAttempts: [],
    });
    expect(out?.plan.expectedPort).toBe(8017);
    expect(out?.plan.environmentVariables.find((v) => v.key === 'HOST')?.value).toBe('0.0.0.0');
    expect(out?.plan.hostBinding).toBe('forced');
  });

  it('rewrites a port that appears as a flag rather than only the expectation', () => {
    // Changing what DevLaunch watches without changing what the application is told to
    // open moves the number in one place only.
    const out = socketFailure({ startCommand: 'npm run dev -- --host 0.0.0.0 --port 3000' });
    expect(out?.plan.startCommand).toContain('--port 8017');
  });

  it('proposes nothing when the observed socket is the port already expected', () => {
    const out = tryDeterministicRepair({
      plan: plan({ expectedPort: 8017 }),
      failure: {
        code: FailureCode.PORT_NOT_LISTENING,
        message: 'x',
        observedSocket: { address: '0.0.0.0', port: 8017, loopbackOnly: false },
      },
      metadata: meta(),
      logs: '',
      previousAttempts: [],
    });
    expect(out).toBeNull();
  });

  it('reads a bare host:port out of a log when there is no socket to read', () => {
    // `running at localhost:8017/` — the pattern required `http://` before the host, so
    // nothing matched it at all.
    const out = attempt({
      code: FailureCode.PORT_NOT_LISTENING,
      logs: 'Hello, I am running at localhost:8017/',
    });
    expect(out?.plan.expectedPort).toBe(8017);
  });
});

describe('psycopg2, which names its own remedy', () => {
  const pyReq = (requirements: string[]): RepositoryMetadata =>
    ({ warnings: [], envExample: [], lockfiles: [], frameworkConfigs: [],
       python: { requirements, hasPyproject: false, hasPipfile: false, hasManagePy: false,
                 entryCandidates: [] } }) as unknown as RepositoryMetadata;

  it('substitutes the prebuilt wheel its own error recommends', () => {
    const out = attempt({
      plan: plan({ installCommand: 'pip install -r requirements.txt' }),
      code: FailureCode.DEPENDENCY_INSTALL_FAILED,
      logs: 'Error: pg_config executable not found.',
      metadata: pyReq(['streamlit==1.28.0', 'psycopg2==2.9.5', 'pandas']),
    });
    expect(out?.plan.installCommand).toBe('pip install streamlit==1.28.0 psycopg2-binary pandas');
  });

  it('does not carry a pin across a substituted distribution', () => {
    // psycopg2's versions are not psycopg2-binary's to assume.
    const out = attempt({
      plan: plan({ installCommand: 'pip install -r requirements.txt' }),
      code: FailureCode.DEPENDENCY_INSTALL_FAILED,
      logs: 'pg_config executable not found',
      metadata: pyReq(['psycopg2==2.9.5']),
    });
    expect(out?.plan.installCommand).toBe('pip install psycopg2-binary');
  });

  it('refuses rather than approximate a requirements file it cannot reproduce', () => {
    // A VCS reference or an environment marker cannot be written as an argument, and
    // dropping one silently would install a different set than the repository asked for.
    const out = attempt({
      plan: plan({ installCommand: 'pip install -r requirements.txt' }),
      code: FailureCode.DEPENDENCY_INSTALL_FAILED,
      logs: 'pg_config executable not found',
      metadata: pyReq(['psycopg2', 'git+https://github.com/x/y.git']),
    });
    expect(out).toBeNull();
  });

  it('does nothing without the error that justifies it', () => {
    const out = attempt({
      plan: plan({ installCommand: 'pip install -r requirements.txt' }),
      code: FailureCode.DEPENDENCY_INSTALL_FAILED,
      logs: 'some other install failure',
      metadata: pyReq(['psycopg2']),
    });
    expect(out).toBeNull();
  });
});

describe('rewriting a requirements file as arguments', () => {
  it('keeps an exact pin, which the allowlist permits', async () => {
    const { requirementsAsArguments } = await import('../services/planning/DeterministicRepair.js');
    expect(requirementsAsArguments(['flask==3.0.0', 'requests'], {})).toEqual([
      'flask==3.0.0',
      'requests',
    ]);
  });

  it('drops a range, which the allowlist cannot express', async () => {
    // `>` is not a permitted character, so `fastapi>=0.115` cannot be an argument at all.
    const { requirementsAsArguments } = await import('../services/planning/DeterministicRepair.js');
    expect(requirementsAsArguments(['fastapi>=0.115'], {})).toEqual(['fastapi']);
  });

  it('refuses an extras marker rather than silently install without it', async () => {
    const { requirementsAsArguments } = await import('../services/planning/DeterministicRepair.js');
    expect(requirementsAsArguments(['uvicorn[standard]'], {})).toBeNull();
  });

  it('ignores comments and blank lines', async () => {
    const { requirementsAsArguments } = await import('../services/planning/DeterministicRepair.js');
    expect(requirementsAsArguments(['flask  # the web bit', '', 'requests'], {})).toEqual([
      'flask',
      'requests',
    ]);
  });

  it('refuses a nested requirements file or an editable install', async () => {
    const { requirementsAsArguments } = await import('../services/planning/DeterministicRepair.js');
    expect(requirementsAsArguments(['-r base.txt', 'flask'], {})).toBeNull();
    expect(requirementsAsArguments(['-e .'], {})).toBeNull();
  });
});

describe('a pin with no wheel for this interpreter', () => {
  const pyReq2 = (requirements: string[]): RepositoryMetadata =>
    ({ warnings: [], envExample: [], lockfiles: [], frameworkConfigs: [],
       python: { requirements, hasPyproject: false, hasPipfile: false, hasManagePy: false,
                 entryCandidates: [] } }) as unknown as RepositoryMetadata;

  it('unpins the one package pip had to build from source', () => {
    // psycopg2-binary==2.9.5 predates Python 3.12, so no wheel matches, pip falls back
    // to the source distribution, and the pg_config error appears for a package that is
    // already the prebuilt one. Substituting the name achieves nothing; the pin is the
    // cause.
    const out = attempt({
      plan: plan({ installCommand: 'pip install -r requirements.txt' }),
      code: FailureCode.DEPENDENCY_INSTALL_FAILED,
      logs: 'writing psycopg2_binary.egg-info/PKG-INFO\nError: pg_config executable not found.',
      metadata: pyReq2(['psycopg2-binary==2.9.5', 'fastapi==0.87.0']),
    });
    expect(out?.plan.installCommand).toBe('pip install psycopg2-binary fastapi==0.87.0');
    expect(out?.record.evidence.join(' ')).toMatch(/no wheel for this interpreter/);
  });

  it('leaves every other pin alone', () => {
    // Unpinning the whole file to fix one package changes what the repository asked for
    // everywhere, and would be a different set of packages than the one that failed.
    const out = attempt({
      plan: plan({ installCommand: 'pip install -r requirements.txt' }),
      code: FailureCode.DEPENDENCY_INSTALL_FAILED,
      logs: 'Could not build wheels for psycopg2-binary\npg_config executable not found',
      metadata: pyReq2(['psycopg2-binary==2.9.5', 'SQLAlchemy==1.4.41']),
    });
    expect(out?.plan.installCommand).toContain('SQLAlchemy==1.4.41');
  });

  it('does nothing when pip names no package it can find in the requirements', () => {
    // A name read out of a log that is not in this repository's requirements is not
    // evidence about this repository.
    const out = attempt({
      plan: plan({ installCommand: 'pip install -r requirements.txt' }),
      code: FailureCode.DEPENDENCY_INSTALL_FAILED,
      logs: 'Could not build wheels for something-else\npg_config executable not found',
      metadata: pyReq2(['psycopg2-binary==2.9.5']),
    });
    // The substitution rule has nothing to change either, so there is no repair at all.
    expect(out).toBeNull();
  });

  it('still substitutes psycopg2 for the wheel its error recommends', () => {
    const out = attempt({
      plan: plan({ installCommand: 'pip install -r requirements.txt' }),
      code: FailureCode.DEPENDENCY_INSTALL_FAILED,
      logs: 'pg_config executable not found',
      metadata: pyReq2(['psycopg2==2.9.9', 'fastapi']),
    });
    expect(out?.plan.installCommand).toBe('pip install psycopg2-binary fastapi');
  });
});
