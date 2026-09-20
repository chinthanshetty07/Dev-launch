import { describe, it, expect } from 'vitest';
import { FailureCode } from '@devlaunch/shared';
import { REPAIRABLE_FAILURES, repairPolicyFor } from '../services/failures/RepairPolicy.js';

describe('what repair is allowed to do about a failure', () => {
  it('never spends a model call on a failure no plan can fix', () => {
    // Two retries for every failure spent model calls on a missing secret, an outage and
    // a memory ceiling, then arrived where it started. Each of these stops with a reason.
    for (const code of [
      FailureCode.MISSING_ENV,
      FailureCode.NETWORK_FAILURE,
      FailureCode.OUT_OF_MEMORY,
      FailureCode.ARCH_INCOMPATIBLE,
      FailureCode.DOCKER_SOCKET_REQUIRED,
      FailureCode.INVALID_AI_PLAN,
      FailureCode.PLAN_REJECTED_UNSAFE_COMMAND,
      FailureCode.APPLICATION_EXITED,
    ]) {
      const p = repairPolicyFor(code);
      expect(p.repairability, code).toBe('NON_REPAIRABLE');
      expect(p.aiCalls, code).toBe(0);
      expect(p.reason.length, code).toBeGreaterThan(10);
    }
  });

  it('gives a rule the first attempt where a rule can have evidence', () => {
    for (const code of [
      FailureCode.START_COMMAND_FAILED,
      FailureCode.PORT_NOT_LISTENING,
      FailureCode.PORT_BOUND_TO_LOCALHOST,
      FailureCode.READINESS_TIMEOUT,
      FailureCode.APPLICATION_UNHEALTHY,
    ]) {
      expect(repairPolicyFor(code).repairability, code).toBe('DETERMINISTIC');
    }
  });

  it('asks a model at most once per failure class', () => {
    for (const code of Object.values(FailureCode)) expect(repairPolicyFor(code).aiCalls).toBeLessThanOrEqual(1);
  });

  it('derives the repairable list from the policy, so there is one truth', () => {
    expect(REPAIRABLE_FAILURES).toContain(FailureCode.START_COMMAND_FAILED);
    expect(REPAIRABLE_FAILURES).not.toContain(FailureCode.MISSING_ENV);
    expect(REPAIRABLE_FAILURES.every((c) => repairPolicyFor(c).repairability !== 'NON_REPAIRABLE')).toBe(true);
  });
});
