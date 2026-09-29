import { describe, it, expect } from 'vitest';
import { FailureCode } from '@devlaunch/shared';
import { detectOom, withMemoryEvidence } from '../services/failures/OomDetection.js';

describe('telling an out-of-memory kill from everything else', () => {
  it('believes Docker when it says the container was OOM-killed, even with exit 110', () => {
    // Measured: a child killed inside the container sets OOMKilled while the wrapper exits 110.
    expect(detectOom({ oomKilled: true, exitCode: 110, lines: ['Killed'] })).toEqual({
      kind: 'container',
      detectedBy: ['docker: OOMKilled', 'log: Killed'],
      evidence: 'Killed',
    });
  });

  it('does not call a Killed line memory when Docker says it was not', () => {
    // Something else sent SIGKILL — a timeout, a stop.
    expect(detectOom({ oomKilled: false, exitCode: 137, lines: ['Killed'] })).toBeNull();
  });

  it('falls back to the Killed line or exit 137 only when Docker cannot be asked', () => {
    expect(detectOom({ lines: ['npm install', 'Killed'] })?.detectedBy).toEqual(['log: Killed']);
    expect(detectOom({ exitCode: 137, lines: [] })?.detectedBy).toEqual(['exit code 137']);
  });

  it('recognises a Node heap OOM as its own kind', () => {
    const lines = ['<--- Last few GCs --->', 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory'];
    expect(detectOom({ oomKilled: false, exitCode: 134, lines })?.kind).toBe('node-heap');
    // Unless the container itself went too: then it is the container's limit.
    expect(detectOom({ oomKilled: true, exitCode: 137, lines })?.kind).toBe('container');
  });

  it('never treats the word memory as evidence', () => {
    for (const line of [
      'Error: Cannot find module memory-cache',
      'warning: this package uses too much memory in tests',
      'npm error code ERESOLVE',
      'Out of memory? No — ENOTFOUND registry.npmjs.org',
    ]) {
      expect(detectOom({ lines: [line] }), line).toBeNull();
    }
  });
});

describe('restating a failure with the memory evidence', () => {
  const coarse = { code: FailureCode.DEPENDENCY_INSTALL_FAILED, message: 'Dependency installation failed.', phase: 'install' as const };

  it('makes an install failure OUT_OF_MEMORY, with the limit and what detected it', () => {
    const out = withMemoryEvidence(coarse, { kind: 'container', detectedBy: ['docker: OOMKilled'] }, { limitMb: 1024, oomKilled: true, coarse });
    expect(out).toMatchObject({
      code: FailureCode.OUT_OF_MEMORY,
      phase: 'install',
      message: 'Dependency installation was killed for exceeding the 1024 MB container memory limit.',
      confidence: 'high',
      memory: { kind: 'container', limitMb: 1024, detectedBy: ['docker: OOMKilled'] },
    });
  });

  it('withdraws a text-only OUT_OF_MEMORY when Docker says there was no OOM, keeping the line', () => {
    const textual = { code: FailureCode.OUT_OF_MEMORY, message: 'killed', evidence: 'Killed', phase: 'install' as const };
    const out = withMemoryEvidence(textual, null, { limitMb: 1024, oomKilled: false, coarse });
    expect(out.code).toBe(FailureCode.DEPENDENCY_INSTALL_FAILED);
    expect(out.evidence).toBe('Killed');
  });

  it('leaves a text-only verdict alone when Docker could not be asked', () => {
    const textual = { code: FailureCode.OUT_OF_MEMORY, message: 'killed', phase: 'install' as const };
    expect(withMemoryEvidence(textual, null, { limitMb: 1024, coarse }).code).toBe(FailureCode.OUT_OF_MEMORY);
  });
});
