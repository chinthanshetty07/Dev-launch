import { describe, it, expect } from 'vitest';
import { FailureCode } from './failures.js';
import { FAILURE_TAXONOMY, describeFailure } from './taxonomy.js';

describe('the failure taxonomy', () => {
  it('gives every failure code a category, retryability and a next step', () => {
    for (const code of Object.values(FailureCode)) {
      const t = FAILURE_TAXONOMY[code];
      expect(t, code).toBeDefined();
      expect(t.category, code).toMatch(/_ERROR$|^UNSUPPORTED_PROJECT$/);
      expect(t.suggestedAction.length, code).toBeGreaterThan(20);
    }
  });

  it('prefers the failure’s own remedy over the generic next step', () => {
    const d = describeFailure({ code: FailureCode.OUT_OF_MEMORY, message: 'killed', remedy: 'Give the VM 8 GB.', phase: 'install' });
    expect(d).toMatchObject({ category: 'OOM_ERROR', recoverable: true, suggestedAction: 'Give the VM 8 GB.', phase: 'install' });
    expect(describeFailure({ code: FailureCode.MISSING_ENV, message: 'x' }).suggestedAction).toMatch(/Supply the variables/);
  });

  it('puts the user’s configuration, the repository and the machine in different categories', () => {
    expect(FAILURE_TAXONOMY.MISSING_ENV.category).toBe('USER_CONFIGURATION_ERROR');
    expect(FAILURE_TAXONOMY.BROKEN_IMPORT.category).toBe('STARTUP_ERROR');
    expect(FAILURE_TAXONOMY.OUT_OF_MEMORY.category).toBe('OOM_ERROR');
    expect(FAILURE_TAXONOMY.PLAN_REJECTED_UNSAFE_COMMAND.category).toBe('SECURITY_ERROR');
  });
});

describe('a network failure', () => {
  it('is a network error, not a git error, and its advice fits a package download', () => {
    // Seen on a fresh-copy run: `EAI_AGAIN registry.yarnpkg.com` during install was filed
    // under GIT_ERROR and told to check the repository URL.
    const d = describeFailure({ code: FailureCode.NETWORK_FAILURE, message: 'getaddrinfo EAI_AGAIN registry.yarnpkg.com' });
    expect(d.category).toBe('NETWORK_ERROR');
    expect(d.retryable).toBe(true);
    expect(d.suggestedAction).toMatch(/downloading packages/);
  });
});
