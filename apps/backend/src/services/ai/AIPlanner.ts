import { FailureCode, type RepositoryMetadata, type RunPlan } from '@devlaunch/shared';
import { SecurityRejection } from '../security/ImageAllowlist.js';
import { RunPlanValidator } from '../planning/RunPlanValidator.js';
import { imageForRuntime } from '../security/ImageAllowlist.js';
import type { AIProvider } from './AIProvider.js';

export interface AIPlanResult {
  plan: RunPlan;
  /** The model's own account of what it inferred. Displayed, never acted on. */
  note?: string;
}

/**
 * The AI fallback planner.
 *
 * Runs only when the rule-based planner declines. Its output is not trusted any further
 * than a rule-based plan is: it passes the same RunPlanValidator and executes in the
 * same sandbox. What differs is that it is *more likely* to be wrong, so the fields the
 * model does not get to choose are pinned here rather than accepted from the response.
 */
export class AIPlanner {
  private readonly validator = new RunPlanValidator();

  constructor(private readonly provider: AIProvider) {}

  async plan(metadata: RepositoryMetadata, ruleBasedReason: string): Promise<AIPlanResult> {
    const raw = await this.provider.generateRunPlan({ metadata, ruleBasedReason });
    return this.normalise(raw);
  }

  /**
   * Turn a model response into a Run Plan, pinning everything it may not decide.
   *
   * `planSource` is forced so a model cannot present itself as rule-based, and
   * `hostBinding` is forced to "unknown" because an inferred plan has not been verified
   * to bind 0.0.0.0 — claiming otherwise would turn a precise PORT_BOUND_TO_LOCALHOST
   * diagnosis into a confusing timeout.
   */
  private normalise(raw: unknown): AIPlanResult {
    if (typeof raw !== 'object' || raw === null) {
      throw new SecurityRejection(
        FailureCode.INVALID_AI_PLAN,
        'AI response was not a JSON object.',
      );
    }
    const r = raw as Record<string, unknown>;
    const runtime = (r.runtime ?? {}) as { language?: unknown; version?: unknown };

    const candidate = {
      runtime: { language: runtime.language, version: runtime.version },
      packageManager: r.packageManager,
      installCommand: r.installCommand ?? null,
      buildCommand: r.buildCommand ?? null,
      startCommand: r.startCommand,
      workingDirectory: r.workingDirectory ?? '.',
      expectedPort: r.expectedPort ?? null,
      environmentVariables: Array.isArray(r.environmentVariables) ? r.environmentVariables : [],
      healthCheck: { path: '/', method: 'GET', expectedStatusCodes: [200, 204, 302, 304] },
      // Pinned, never taken from the response.
      hostBinding: 'unknown',
      planSource: 'ai-fallback',
    };

    let plan: RunPlan;
    try {
      plan = this.validator.validate({ plan: candidate });
    } catch (err) {
      // Both a schema failure and an allowlist rejection mean the same thing to the
      // caller: this output is not executable.
      throw new SecurityRejection(
        err instanceof SecurityRejection ? err.code : FailureCode.INVALID_AI_PLAN,
        `AI plan rejected: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // A plan naming a runtime we have no image for is unusable however well-formed.
    imageForRuntime(plan.runtime.language, plan.runtime.version);

    return {
      plan,
      note: typeof r.confidenceNote === 'string' ? r.confidenceNote.slice(0, 300) : undefined,
    };
  }
}
