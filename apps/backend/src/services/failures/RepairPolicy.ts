import { FailureCode, type Repairability } from '@devlaunch/shared';

/**
 * Which failures are worth repairing, and how.
 *
 * Two retries for every failure was the wrong shape twice over: it spent model calls on
 * failures no plan change can fix, and it gave the model the first attempt at failures a
 * rule could have settled without one. The policy is decided from the failure class
 * before anything is tried, so a session that cannot be repaired says so at once and a
 * session that can is repaired by the cheapest thing that works.
 *
 * `aiCalls` is a budget for *this failure class*, on top of the session-wide attempt
 * ceiling. Zero means a model is never asked; one means it is asked once, after any
 * deterministic attempt has been tried and failed.
 */
export interface RepairPolicy {
  repairability: Repairability;
  aiCalls: number;
  /** Why, in words a person can act on. */
  reason: string;
}

const POLICIES: Readonly<Record<FailureCode, RepairPolicy>> = Object.freeze({
  // --- a person, not a plan, is what is missing ---------------------------------
  [FailureCode.MISSING_ENV]: none('a secret has to come from a person; a model inventing one is worse than asking'),
  [FailureCode.DATABASE_REQUIRED]: none('DevLaunch provisions the databases it knows; one it still cannot reach is not a plan problem'),
  [FailureCode.UNSUPPORTED_PROJECT]: none('nothing to repair: no plan was produced to repair'),

  // --- the environment, not the repository ---------------------------------------
  [FailureCode.NETWORK_FAILURE]: none('a registry or network outage; retrying the same download with a different plan changes nothing'),
  [FailureCode.OUT_OF_MEMORY]: none('a container limit, changed by configuration rather than by a plan'),
  [FailureCode.ARCH_INCOMPATIBLE]: none('an x86-only dependency cannot be rewritten by any plan'),
  [FailureCode.DOCKER_SOCKET_REQUIRED]: none('the sandbox withholds the daemon on purpose; no configuration hands it over'),
  [FailureCode.REPOSITORY_TOO_LARGE]: none('the intake cap is a limit, not a symptom'),
  [FailureCode.CONTAINER_CREATE_FAILED]: none('the runtime failed before the plan ran'),

  // --- already decided ----------------------------------------------------------
  [FailureCode.INVALID_AI_PLAN]: none('the model has already produced an unusable plan; asking again is how it thrashes'),
  [FailureCode.PLAN_REJECTED_UNSAFE_COMMAND]: none('a plan the allowlist refused is not retried with a model that wrote it'),
  [FailureCode.APPLICATION_EXITED]: none('it ran, then stopped: the command was right and the answer is in the log tail'),

  // --- a different plan could plausibly fix it ---------------------------------
  [FailureCode.START_COMMAND_FAILED]: rules(1, 'the command or entry point may be wrong; scripts and entry files say which'),
  [FailureCode.PORT_NOT_LISTENING]: rules(1, 'the port may be wrong; the log often names the one it did open'),
  [FailureCode.PORT_BOUND_TO_LOCALHOST]: rules(1, 'the bind address is wrong and the fix is known'),
  [FailureCode.READINESS_TIMEOUT]: rules(1, 'the port is open; the health path or a slow start may be the problem'),
  [FailureCode.APPLICATION_UNHEALTHY]: rules(1, 'it answers, wrongly; the status and body say how'),
  [FailureCode.DEPENDENCY_INSTALL_FAILED]: rules(1, 'the install command or manager may be wrong for this manifest'),
  [FailureCode.BUILD_FAILED]: rules(1, 'the build command may be wrong; the last errors say what'),
  [FailureCode.WRONG_RUNTIME_VERSION]: rules(1, 'the manifest may name a version an approved image can satisfy'),
  [FailureCode.PROCESS_TIMEOUT]: rules(1, 'something hung; whether install, start or readiness decides the fix'),

  // --- unknown: one bounded diagnosis, and stop rather than thrash ---------------
  [FailureCode.UNKNOWN_RUNTIME_ERROR]: { repairability: 'AI_ONLY', aiCalls: 1, reason: 'unclassified; one bounded diagnosis, then stop' },
});

function none(reason: string): RepairPolicy {
  return { repairability: 'NON_REPAIRABLE', aiCalls: 0, reason };
}
function rules(aiCalls: number, reason: string): RepairPolicy {
  return { repairability: 'DETERMINISTIC', aiCalls, reason };
}

export function repairPolicyFor(code: FailureCode): RepairPolicy {
  return POLICIES[code] ?? POLICIES[FailureCode.UNKNOWN_RUNTIME_ERROR];
}

/** The failure classes any repair may be attempted for. Derived, so there is one truth. */
export const REPAIRABLE_FAILURES: readonly FailureCode[] = Object.freeze(
  (Object.keys(POLICIES) as FailureCode[]).filter((c) => POLICIES[c].repairability !== 'NON_REPAIRABLE'),
);
