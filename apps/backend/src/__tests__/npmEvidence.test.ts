import { describe, it, expect } from 'vitest';
import { FailureCode } from '@devlaunch/shared';
import { FailureClassifier } from '../services/failures/FailureClassifier.js';

/**
 * npm 7+ writes `npm error` where npm 6 wrote `npm ERR!`, and only the old spelling of its
 * boilerplate was skipped — so a failed install was explained by "A complete log of this run
 * can be found in: …" (`RefugioDiaz1/fullstack-docker-react-node-postgres`).
 */
describe('a failed npm install', () => {
  it('is explained by what failed, not by npm signing off', () => {
    // Captured from the runner image: `npm install` in a folder with no package.json.
    const out = [
      'npm error code ENOENT',
      'npm error syscall open',
      'npm error path /workspace/server/package.json',
      'npm error errno -2',
      "npm error enoent Could not read package.json: Error: ENOENT: no such file or directory, open '/workspace/server/package.json'",
      'npm error enoent This is related to npm not being able to find a file.',
      'npm error enoent',
      'npm error A complete log of this run can be found in: /cache/npm/_logs/2026-10-01T13_41_10_324Z-debug-0.log',
    ].join('\n');
    const verdict = new FailureClassifier().classify({
      logs: out, exitCode: 110, phase: 'install',
      fallback: { code: FailureCode.DEPENDENCY_INSTALL_FAILED, message: 'Dependency installation failed.', phase: 'install' },
    });
    expect(verdict.evidence).toMatch(/^npm error enoent Could not read package\.json/);
  });
});
