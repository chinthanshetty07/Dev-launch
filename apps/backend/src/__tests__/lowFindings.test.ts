import { describe, it, expect } from 'vitest';
import { FailureCode, describeFailure } from '@devlaunch/shared';
import { failureOf } from '../services/session/SessionManager.js';
import { validateEnvVarKey } from '../services/security/CommandValidator.js';

describe('a thrown error, as a failure (A-17)', () => {
  it('keeps DevLaunch\'s own codes', () => {
    const err = Object.assign(new Error('refused'), { code: FailureCode.PLAN_REJECTED_UNSAFE_COMMAND });
    expect(failureOf(err).code).toBe(FailureCode.PLAN_REJECTED_UNSAFE_COMMAND);
  });

  it('never blames the repository for this machine\'s trouble', () => {
    const docker = failureOf(Object.assign(new Error('connect ECONNREFUSED /Users/x/.colima/default/docker.sock'), { code: 'ECONNREFUSED' }));
    expect(docker.code).toBe(FailureCode.UNKNOWN_RUNTIME_ERROR);
    expect(docker.remedy).toMatch(/Colima/);
    // It used to be the code itself, which the taxonomy did not know and filed under
    // "this repository is not supported".
    expect(describeFailure(docker).suggestedAction).not.toMatch(/not supported/i);
    const git = failureOf(Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }));
    expect(git.code).toBe(FailureCode.UNKNOWN_RUNTIME_ERROR);
    expect(git.remedy).toMatch(/this machine, not in the repository/);
  });
});

describe('variables that load code by name (A-20)', () => {
  it.each(['PYTHONWARNINGS', 'PYTHONUSERBASE', 'PYTHONBREAKPOINT', 'PIP_INDEX_URL', 'YARN_YARN_PATH', 'YARN_RC_FILENAME', 'COREPACK_NPM_REGISTRY'])(
    'refuses %s',
    (key) => {
      expect(() => validateEnvVarKey(key)).toThrow();
    },
  );

  it('still allows ordinary configuration', () => {
    for (const key of ['PYTHONUNBUFFERED', 'PORT', 'DATABASE_URL', 'PIPELINE_NAME']) expect(validateEnvVarKey(key)).toBe(key);
  });
});

import { FailureClassifier } from '../services/failures/FailureClassifier.js';
import { RepositoryAnalyzer } from '../services/analysis/RepositoryAnalyzer.js';
import { fileURLToPath } from 'node:url';
import { dirname as dn, resolve as rs } from 'node:path';

const FIXTURES = rs(dn(fileURLToPath(import.meta.url)), '../../../../fixtures');
const classify = (logs: string, phase: 'install' | 'start' = 'install') =>
  new FailureClassifier().classify({ logs, phase, fallback: { code: FailureCode.DEPENDENCY_INSTALL_FAILED, message: 'Dependency installation failed.' } });

describe('a network failure during install, told apart from a dependency that cannot exist', () => {
  it('blames the network when a registry everyone uses does not resolve', () => {
    const v = classify('npm error request to https://registry.npmjs.org/express failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org');
    expect(v.code).toBe(FailureCode.NETWORK_FAILURE);
  });

  it('names the host when a dependency is fetched from one that does not exist', () => {
    const v = classify('npm error network request to https://registry.devlaunch-test.invalid/x.tgz failed, reason: getaddrinfo ENOTFOUND registry.devlaunch-test.invalid');
    expect(v.code).toBe(FailureCode.DEPENDENCY_INSTALL_FAILED);
    expect(v.message).toMatch(/registry\.devlaunch-test\.invalid, which has no address/);
  });
});

describe('a manifest no package manager can read', () => {
  it('is recorded by the analyzer with the parser\'s words', async () => {
    const meta = await new RepositoryAnalyzer().analyze(`${FIXTURES}/node-bad-manifest`);
    expect(meta.invalidManifest?.file).toBe('package.json');
    expect(meta.invalidManifest?.error).toMatch(/JSON/);
  });

  it('is recognised in npm\'s output too', () => {
    expect(classify('npm error code EJSONPARSE\nnpm error JSON.parse Invalid package.json').code).toBe(FailureCode.INVALID_MANIFEST);
  });
});
