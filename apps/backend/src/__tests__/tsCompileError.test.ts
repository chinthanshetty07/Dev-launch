import { describe, it, expect } from 'vitest';
import { FailureCode, RunPlanSchema, type RepositoryMetadata } from '@devlaunch/shared';
import { FailureClassifier } from '../services/failures/FailureClassifier.js';
import { tryDeterministicRepair } from '../services/planning/DeterministicRepair.js';

/** What ts-node printed for niksbanna/mern-boilerplate's server, trimmed. */
const MERN = [
  '[server] /workspace/server/node_modules/ts-node/src/index.ts:859',
  '[server]     return new TSError(diagnosticText, diagnosticCodes, diagnostics);',
  '[server] TSError: ⨯ Unable to compile TypeScript:',
  '[server] src/utils/jwt.ts(6,14): error TS2769: No overload matches this call.',
  "[server]   Overload 1 of 5, '(payload: string | object | Buffer<ArrayBufferLike>, secretOrPrivateKey: null, ...)', gave the following error.",
  "[server]     Argument of type 'string' is not assignable to parameter of type 'null'.",
  '[server] src/utils/jwt.ts(12,14): error TS2769: No overload matches this call.',
  "[server]   Overload 3 of 5, '(payload: string | object | Buffer<ArrayBufferLike>, secretOrPrivateKey: Secret, callback: SignCallback): void', gave the following error.",
  "[server]     Object literal may only specify known properties, and 'expiresIn' does not exist in type 'SignCallback'.",
  '[server]     at createTSError (/workspace/server/node_modules/ts-node/src/index.ts:859:12)',
];
const fallback = { code: FailureCode.PORT_NOT_LISTENING, message: 'Nothing is listening on port 5000.', phase: 'start' as const };

describe('a TypeScript server that does not compile', () => {
  it('is reported as that, quoting the error line, not as a port nobody opened', () => {
    // It was PORT_NOT_LISTENING, uncertain, with "Overload 3 of 5 ..." as its evidence.
    const verdict = new FailureClassifier().classify({ logs: MERN.join('\n'), exitCode: 0, phase: 'start', fallback });
    expect(verdict.code).toBe(FailureCode.START_COMMAND_FAILED);
    expect(verdict.confidence).toBe('high');
    expect(verdict.message).toMatch(/^The TypeScript code does not compile: .*src\/utils\/jwt\.ts\(12,14\): error TS2769/);
    expect(verdict.remedy).toMatch(/TS_NODE_TRANSPILE_ONLY/);
  });

  it('is not claimed for type errors in a build step, which turning ts-node off would not help', () => {
    const verdict = new FailureClassifier().classify({ logs: 'src/a.ts(1,1): error TS2322: x', exitCode: 2, phase: 'build', fallback: { ...fallback, phase: 'build' } });
    expect(verdict.message).not.toMatch(/does not compile/);
  });
});

describe('the retry with type checking off', () => {
  const plan = RunPlanSchema.parse({
    runtime: { language: 'node', version: '20' }, packageManager: 'npm', installCommand: 'npm install',
    buildCommand: null, startCommand: 'npm run dev', workingDirectory: '.', expectedPort: 5000, planSource: 'rule-based',
  });
  const meta = { warnings: [], envExample: [], lockfiles: [], frameworkConfigs: [] } as unknown as RepositoryMetadata;
  const repair = (logs: string, p = plan, code: FailureCode = FailureCode.START_COMMAND_FAILED) =>
    tryDeterministicRepair({ plan: p, failure: { code, message: 'x', phase: 'start' }, metadata: meta, logs, previousAttempts: [] });

  it('sets TS_NODE_TRANSPILE_ONLY on ts-node’s own refusal, and says why', () => {
    const out = repair(MERN.join('\n'));
    expect(out?.plan.environmentVariables).toContainEqual({ key: 'TS_NODE_TRANSPILE_ONLY', value: 'true', required: false });
    expect(out?.record.evidence.join(' ')).toMatch(/src\/utils\/jwt\.ts\(6,14\): error TS2769/);
    expect(out?.plan.startCommand).toBe(plan.startCommand);
  });

  it('also when the failure was read as a port nobody opened (nodemon keeps the container up)', () => {
    expect(repair(MERN.join('\n'), plan, FailureCode.PORT_NOT_LISTENING)).not.toBeNull();
  });

  it('only once', () => {
    const already = { ...plan, environmentVariables: [{ key: 'TS_NODE_TRANSPILE_ONLY', value: 'true', required: false }] };
    expect(repair(MERN.join('\n'), already)).toBeNull();
  });

  it('never for a crash that is not a type check', () => {
    expect(repair("TypeError: Cannot read properties of undefined (reading 'x')\n    at server.ts:4:2")).toBeNull();
  });
});
