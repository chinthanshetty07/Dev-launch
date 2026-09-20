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
