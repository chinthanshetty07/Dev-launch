import { describe, it, expect } from 'vitest';
import { FailureCode, type FailureDetail } from '@devlaunch/shared';
import { FailureClassifier } from '../services/failures/FailureClassifier.js';
import { SIGNATURES } from '../services/failures/signatures.js';

const classifier = new FailureClassifier();

const fallback: FailureDetail = {
  code: FailureCode.DEPENDENCY_INSTALL_FAILED,
  message: 'Dependency installation failed.',
};

const classify = (logs: string, phase: 'install' | 'build' | 'start' = 'install', exitCode = 1) =>
  classifier.classify({ logs, phase, exitCode, fallback });

describe('FailureClassifier — signatures', () => {
  it.each([
    ['JavaScript heap out of memory', 'FATAL ERROR: Reached heap limit\nJavaScript heap out of memory', FailureCode.OUT_OF_MEMORY],
    ['bare Killed line', 'installing...\nKilled', FailureCode.OUT_OF_MEMORY],
    ['disk full', 'npm ERR! ENOSPC: no space left on device', FailureCode.DEPENDENCY_INSTALL_FAILED],
    ['exec format error', '/app/bin/tool: Exec format error', FailureCode.ARCH_INCOMPATIBLE],
    ['no prebuilt binaries', 'sharp: no prebuilt binaries available for this platform', FailureCode.ARCH_INCOMPATIBLE],
    ['EBADPLATFORM', 'npm ERR! code EBADPLATFORM', FailureCode.ARCH_INCOMPATIBLE],
    ['peer conflict', 'npm ERR! ERESOLVE unable to resolve dependency tree', FailureCode.DEPENDENCY_INSTALL_FAILED],
    ['node-gyp', 'gyp ERR! build error', FailureCode.DEPENDENCY_INSTALL_FAILED],
    ['missing pypi package', 'ERROR: Could not find a version that satisfies the requirement foo', FailureCode.DEPENDENCY_INSTALL_FAILED],
    ['dns failure', 'npm ERR! getaddrinfo EAI_AGAIN registry.npmjs.org', FailureCode.NETWORK_FAILURE],
    ['tls failure', 'pip: SSL: CERTIFICATE_VERIFY_FAILED', FailureCode.NETWORK_FAILURE],
    ['bad engine', 'npm ERR! code EBADENGINE', FailureCode.WRONG_RUNTIME_VERSION],
    ['python version', 'ERROR: Package requires Python >=3.13', FailureCode.WRONG_RUNTIME_VERSION],
  ])('classifies %s', (_label, logs, expected) => {
    expect(classify(logs).code).toBe(expected);
  });

  it.each([
    ['postgres refused', 'Error: connect ECONNREFUSED 127.0.0.1:5432'],
    ['redis refused', 'Error: connect ECONNREFUSED 10.0.0.5:6379'],
    ['unresolvable db host', 'Error: getaddrinfo ENOTFOUND postgres'],
    ['django operational error', 'django.db.utils.OperationalError: could not connect to server'],
    ['mongo', 'MongoNetworkError: failed to connect'],
  ])('classifies %s as a missing database', (_label, logs) => {
    expect(classify(logs, 'start').code).toBe(FailureCode.DATABASE_REQUIRED);
  });

  it('prefers a database diagnosis over a generic network one', () => {
    // Both signatures could fire. Reporting NETWORK_FAILURE would send the user to
    // check connectivity rather than to the real answer: the project needs a database.
    const logs = 'getaddrinfo EAI_AGAIN something\nError: connect ECONNREFUSED 127.0.0.1:5432';
    expect(classify(logs, 'start').code).toBe(FailureCode.DATABASE_REQUIRED);
  });

  it.each([
    ['django secret key', 'ImproperlyConfigured: The SECRET_KEY setting must not be empty'],
    ['explicit message', 'Error: Missing required environment variable REQUIRED_TOKEN'],
    ['python KeyError', "KeyError: 'DATABASE_URL'"],
  ])('classifies %s as missing configuration', (_label, logs) => {
    expect(classify(logs, 'start').code).toBe(FailureCode.MISSING_ENV);
  });

  it.each([
    ['node', "Error: Cannot find module 'express'"],
    ['esm', 'ERR_MODULE_NOT_FOUND'],
    ['python', "ModuleNotFoundError: No module named 'flask'"],
  ])('classifies a missing module at start (%s)', (_label, logs) => {
    expect(classify(logs, 'start').code).toBe(FailureCode.START_COMMAND_FAILED);
  });

  it('classifies a missing start command', () => {
    const out = classify('/bin/sh: 1: flask: not found', 'start', 127);
    expect(out.code).toBe(FailureCode.START_COMMAND_FAILED);
    expect(out.remedy).toMatch(/\$HOME\/\.local\/bin/);
  });
});

describe('FailureClassifier — behaviour', () => {
  it('returns the evidence line, so a verdict can be checked rather than trusted', () => {
    const out = classify('line one\nnpm ERR! code EBADPLATFORM\nline three');
    expect(out.evidence).toContain('EBADPLATFORM');
    expect(out.confidence).toBe('high');
    expect(out.remedy).toBeTruthy();
  });

  it('takes the last matching line, since errors accumulate', () => {
    const out = classify("Cannot find module 'a'\nCannot find module 'b'", 'start');
    expect(out.evidence).toContain("'b'");
  });

  it('treats exit 137 with no output as the memory ceiling', () => {
    // The OOM killer gives the process no chance to explain itself.
    const out = classifier.classify({ logs: 'installing...', phase: 'install', exitCode: 137, fallback });
    expect(out.code).toBe(FailureCode.OUT_OF_MEMORY);
    expect(out.confidence).toBe('medium');
  });

  it('admits when it has no diagnosis instead of inventing one', () => {
    const out = classify('some entirely unremarkable output');
    expect(out.code).toBe(fallback.code);
    expect(out.confidence).toBe('low');
    expect(out.evidence).toBeUndefined();
  });

  it('respects the phase a signature applies to', () => {
    // A peer-dependency conflict cannot occur during start.
    const logs = 'npm ERR! ERESOLVE unable to resolve dependency tree';
    expect(classify(logs, 'install').confidence).toBe('high');
    expect(classify(logs, 'start').confidence).toBe('low');
  });

  it('accepts structured log entries as well as raw text', () => {
    const out = classifier.classify({
      logs: [{ seq: 0, ts: 1, stream: 'stderr', text: 'npm ERR! code EBADENGINE' }],
      phase: 'install',
      fallback,
    });
    expect(out.code).toBe(FailureCode.WRONG_RUNTIME_VERSION);
  });

  it('gives every signature a remedy', () => {
    // A classification with no suggested action is only half a diagnosis.
    for (const sig of SIGNATURES) {
      expect(sig.remedy.length, `${sig.id} needs a remedy`).toBeGreaterThan(20);
      expect(sig.patterns.length, `${sig.id} needs patterns`).toBeGreaterThan(0);
    }
  });

  it('summarises for display, flagging uncertainty', () => {
    expect(FailureClassifier.summarise(classify('nothing here'))).toMatch(/\(uncertain\)/);
    expect(FailureClassifier.summarise(classify('Killed'))).not.toMatch(/uncertain/);
  });
});
