import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FailureCode, type FailureDetail, type RepairRecord } from '@devlaunch/shared';
import { RetryPanel, stillRunning } from './RetryPanel';

function text(failure: FailureDetail, repairs?: RepairRecord[]): string {
  return renderToStaticMarkup(<RetryPanel failure={failure} repairs={repairs} />)
    .replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim();
}

const oom: FailureDetail = {
  code: FailureCode.OUT_OF_MEMORY, phase: 'install',
  message: 'Dependency installation was killed for exceeding the 1024 MB container memory limit.',
  memory: { kind: 'container', limitMb: 1024, detectedBy: ['docker: OOMKilled'] },
};
const raised: RepairRecord = {
  source: 'deterministic', type: 'MEMORY_LIMIT_RAISED', failureCode: FailureCode.OUT_OF_MEMORY,
  before: { memoryMb: 1024 }, after: { memoryMb: 2048 }, evidence: [], confidence: 'high',
};

describe('a run that is trying again', () => {
  it('says it is retrying, with how much memory, in plain words', () => {
    // wrrnlim/nextjs-docker-postgres-template: the red OUT_OF_MEMORY panel stood on screen
    // while the 2048 MB retry ran, and the run was stopped as though it had failed.
    const t = text(oom, [raised]);
    expect(t).toMatch(/retrying/);
    expect(t).toMatch(/ran out of memory at 1024 MB\. Trying again with 2048 MB/);
    expect(t).not.toMatch(/OUT_OF_MEMORY/);
  });

  it('names the service in a project', () => {
    expect(text(oom, [{ ...raised, service: 'api' }])).toMatch(/The last try \(api\) ran out of memory/);
  });

  it('describes any other fix as a fix, with what went wrong', () => {
    const t = text(
      { code: FailureCode.PORT_NOT_LISTENING, message: 'Nothing is listening on port 3000.', phase: 'start' },
      [{ ...raised, type: 'PORT_CORRECTION', failureCode: FailureCode.PORT_NOT_LISTENING, before: {}, after: {} }],
    );
    expect(t).toMatch(/failed: Nothing is listening on port 3000\. Trying again with a fix/);
  });

  it('says it is working out a fix before one is chosen', () => {
    expect(text({ ...oom, memory: undefined }, [])).toMatch(/Working out a fix/);
  });
});

describe('when the retry panel shows instead of the failure panel', () => {
  it('while the run is still going', () => {
    for (const state of ['CLONING', 'STARTING', 'WAITING_FOR_READY', 'REPAIRING', 'BUILDING']) {
      expect(stillRunning(state), state).toBe(true);
    }
  });

  it('never once it has ended, or while it waits for an answer', () => {
    for (const state of ['READY', 'PARTIALLY_READY', 'FAILED', 'CANCELLED', 'COMPLETED', 'AWAITING_INPUT', undefined]) {
      expect(stillRunning(state), String(state)).toBe(false);
    }
  });
});
