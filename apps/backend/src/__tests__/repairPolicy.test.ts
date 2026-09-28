import { describe, it, expect } from 'vitest';
import { FailureCode } from '@devlaunch/shared';
import { REPAIRABLE_FAILURES, repairPolicyFor } from '../services/failures/RepairPolicy.js';
import { APPROVED_IMAGES } from '../services/security/ImageAllowlist.js';

describe('what repair is allowed to do about a failure', () => {
  it('never spends a model call on a failure no plan can fix', () => {
    // Two retries for every failure spent model calls on a missing secret and an
    // outage, then arrived where it started. Each of these stops with a reason.
    //
    // OUT_OF_MEMORY used to be in this list and is not any more; see below. It was here
    // on the strength of "a container limit, changed by configuration rather than by a
    // plan", which is true and was the wrong conclusion: the configuration is ours.
    for (const code of [
      FailureCode.MISSING_ENV,
      FailureCode.NETWORK_FAILURE,
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

  it('keeps the runtime-version policy in step with the image allowlist', () => {
    // This test previously asserted the opposite, and said so: WRONG_RUNTIME_VERSION was
    // non-repairable *because* the allowlist carried one image per language, and it
    // promised that approving a second would make the failure repairable and that this
    // test would be what says so. Node 22 was then approved, for a repository importing
    // `node:sqlite`. The fact changed, so the policy changed, and the intent is restated
    // rather than the assertion flipped.
    //
    // What holds either way is the *relationship*: a rule can move `runtime.version`
    // exactly when there is somewhere to move it to.
    const perLanguage = new Map<string, number>();
    for (const image of Object.values(APPROVED_IMAGES)) {
      perLanguage.set(image.language, (perLanguage.get(image.language) ?? 0) + 1);
    }
    const somethingToChoose = [...perLanguage.values()].some((n) => n > 1);
    const policy = repairPolicyFor(FailureCode.WRONG_RUNTIME_VERSION);
    expect(policy.repairability).toBe(somethingToChoose ? 'DETERMINISTIC' : 'NON_REPAIRABLE');
  });

  it('treats a memory limit as DevLaunch\'s problem, and never a model\'s', () => {
    // This was NON_REPAIRABLE, with the reason "a container limit, changed by
    // configuration rather than by a plan". Every word true, and an odd thing to say
    // about configuration DevLaunch writes: a real Next.js dev build is killed by the
    // 1 GB default every time and was told its own project had failed. The premise
    // changed — a rule can raise our own number — so the policy changed with it, and
    // the intent is restated rather than the assertion flipped.
    //
    // What holds either way: a model is never asked. It cannot change a container's
    // HostConfig by writing a plan, so a call spent here buys nothing at all.
    const policy = repairPolicyFor(FailureCode.OUT_OF_MEMORY);
    expect(policy.repairability).toBe('DETERMINISTIC');
    expect(policy.aiCalls).toBe(0);
  });

  it('never asks a model to solve a runtime-version mismatch', () => {
    // Not a matter of degree. No plan a model writes can conjure an image that is not on
    // the allowlist, so asking it spends a call to be told what the allowlist says.
    expect(repairPolicyFor(FailureCode.WRONG_RUNTIME_VERSION).aiCalls).toBe(0);
  });

  it('derives the repairable list from the policy, so there is one truth', () => {
    expect(REPAIRABLE_FAILURES).toContain(FailureCode.START_COMMAND_FAILED);
    expect(REPAIRABLE_FAILURES).not.toContain(FailureCode.MISSING_ENV);
    expect(REPAIRABLE_FAILURES.every((c) => repairPolicyFor(c).repairability !== 'NON_REPAIRABLE')).toBe(true);
  });
});
