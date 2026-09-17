import type { FailureDetail, RepositoryMetadata, RunPlan } from '@devlaunch/shared';

export interface PlanRequest {
  /** Repository description. Everything here originates from untrusted repository text. */
  metadata: RepositoryMetadata;
  /** Why the rule-based planner declined, so the model is not asked to redo that work. */
  ruleBasedReason: string;
}

export interface RepairRequest {
  plan: RunPlan;
  failure: FailureDetail;
  /** Tail of the log, already bounded. */
  logs: string;
  metadata: RepositoryMetadata;
  /** Plans already tried, so an attempt cannot be repeated verbatim. */
  previousAttempts: RunPlan[];
}

/**
 * Where a model is allowed to participate.
 *
 * Two entry points, both narrow by design:
 *
 * - `generateRunPlan` runs **only** when the rule-based planner declines. With 22
 *   deterministic detectors that is the uncommon case, which is the point.
 * - `diagnoseFailure` proposes a bounded correction from failure context.
 *
 * Output is a structured Run Plan that passes the **same** RunPlanValidator as a
 * rule-based one, and executes in the same sandbox. A model never decides whether
 * something worked; the verifier does.
 *
 * Repair may modify only the fields in REPAIRABLE_FIELDS. It may never edit repository
 * files. See docs/planning-strategy.md — "AI repair blast radius".
 */
export interface AIProvider {
  readonly name: string;
  generateRunPlan(request: PlanRequest): Promise<unknown>;
  diagnoseFailure(request: RepairRequest): Promise<unknown>;
}

/** The only plan fields a repair attempt may change. */
export const REPAIRABLE_FIELDS = Object.freeze([
  'installCommand',
  'buildCommand',
  'startCommand',
  'expectedPort',
  'environmentVariables',
  'runtime',
  'healthCheck',
] as const);

export const MAX_REPAIR_ATTEMPTS = 2;

/**
 * Default provider: refuses.
 *
 * v1.0 ships with no AI, and an absent provider must fail loudly rather than silently
 * degrade. Phase 8 substitutes a real implementation without touching anything else.
 */
export class UnavailableAIProvider implements AIProvider {
  readonly name = 'unavailable';

  async generateRunPlan(): Promise<never> {
    throw new Error(
      'No AI provider is configured. DevLaunch v1 plans deterministically; ' +
        'repositories that match no known pattern are reported as UNSUPPORTED_PROJECT.',
    );
  }

  async diagnoseFailure(): Promise<never> {
    throw new Error('No AI provider is configured, so automated repair is unavailable.');
  }
}
