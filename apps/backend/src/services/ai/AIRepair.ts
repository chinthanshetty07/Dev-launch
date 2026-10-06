import { FailureCode, type FailureDetail, type RepositoryMetadata, type RunPlan } from '@devlaunch/shared';
import { SecurityRejection } from '../security/ImageAllowlist.js';
import { RunPlanValidator } from '../planning/RunPlanValidator.js';
import { MAX_REPAIR_ATTEMPTS, type AIProvider } from './AIProvider.js';
import { REDACTED } from './prompts.js';

export interface RepairResult {
  plan: RunPlan;
  attempt: number;
  note?: string;
}

/** Identity of the mutable surface, used to reject an attempt that changes nothing. */
function signature(plan: RunPlan): string {
  return JSON.stringify([
    plan.installCommand,
    plan.buildCommand,
    plan.startCommand,
    plan.expectedPort,
    plan.runtime,
    [...plan.environmentVariables].sort((a, b) => a.key.localeCompare(b.key)),
  ]);
}

/**
 * Bounded repair.
 *
 * Two constraints define this, and both are enforced here rather than trusted to the
 * prompt:
 *
 * - **Blast radius.** Only a fixed whitelist of plan fields may change. Anything else in
 *   the response is discarded, so a model cannot relocate the working directory, claim
 *   to be rule-based, or edit repository files — it has no mechanism to.
 * - **Progress.** Each attempt must differ from every previous one. A confidently wrong
 *   model would otherwise burn both retries proposing the same thing.
 */
export class AIRepair {
  private readonly validator = new RunPlanValidator();

  constructor(private readonly provider: AIProvider) {}

  async repair(input: {
    plan: RunPlan;
    failure: FailureDetail;
    logs: string;
    metadata: RepositoryMetadata;
    previousAttempts: RunPlan[];
  }): Promise<RepairResult> {
    const attempt = input.previousAttempts.length + 1;
    if (attempt > MAX_REPAIR_ATTEMPTS) {
      throw new SecurityRejection(
        FailureCode.UNKNOWN_RUNTIME_ERROR,
        `Repair limit of ${MAX_REPAIR_ATTEMPTS} attempts reached.`,
      );
    }

    const raw = await this.provider.diagnoseFailure(input);
    const plan = this.applyDelta(input.plan, raw);

    const seen = new Set([input.plan, ...input.previousAttempts].map(signature));
    if (seen.has(signature(plan))) {
      throw new SecurityRejection(
        FailureCode.INVALID_AI_PLAN,
        'Repair proposed a plan identical to one already tried.',
      );
    }

    const note = (raw as Record<string, unknown> | null)?.confidenceNote;
    return {
      plan,
      attempt,
      note: typeof note === 'string' ? note.slice(0, 300) : undefined,
    };
  }

  /** Merge only repairable fields onto the original; discard everything else. */
  private applyDelta(original: RunPlan, raw: unknown): RunPlan {
    if (typeof raw !== 'object' || raw === null) {
      throw new SecurityRejection(
        FailureCode.INVALID_AI_PLAN,
        'Repair response was not a JSON object.',
      );
    }
    const r = raw as Record<string, unknown>;

    const candidate: Record<string, unknown> = {
      ...original,
      // Immutable regardless of what came back.
      workingDirectory: original.workingDirectory,
      hostBinding: 'unknown',
      planSource: 'ai-fallback',
    };

    if ('installCommand' in r) candidate.installCommand = r.installCommand ?? null;
    if ('buildCommand' in r) candidate.buildCommand = r.buildCommand ?? null;
    if (typeof r.startCommand === 'string') candidate.startCommand = r.startCommand;
    if (typeof r.expectedPort === 'number') candidate.expectedPort = r.expectedPort;
    if (Array.isArray(r.environmentVariables)) {
      // The model saw hidden values as REDACTED (see `redactPlan`); a variable it hands
      // back that way keeps the real value it never saw. One it invents with the marker
      // as its value has no real value to keep, and is dropped rather than set to it.
      const real = new Map(original.environmentVariables.map((v) => [v.key, v.value]));
      candidate.environmentVariables = (r.environmentVariables as unknown[]).flatMap((v) => {
        if (!v || typeof v !== 'object') return [v];
        const e = v as { key?: unknown; value?: unknown };
        if (e.value !== REDACTED) return [v];
        return typeof e.key === 'string' && real.has(e.key) ? [{ ...e, value: real.get(e.key) }] : [];
      });
    }
    if (r.runtime && typeof r.runtime === 'object') candidate.runtime = r.runtime;
    if (r.healthCheck && typeof r.healthCheck === 'object') candidate.healthCheck = r.healthCheck;

    try {
      return this.validator.validate({ plan: candidate });
    } catch (err) {
      throw new SecurityRejection(
        err instanceof SecurityRejection ? err.code : FailureCode.INVALID_AI_PLAN,
        `Repair plan rejected: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
