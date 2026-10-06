import { isSecretKey, type RunPlan } from '@devlaunch/shared';

/** What a hidden value is shown as. */
export const HIDDEN = '•••••• (hidden)';

/** `scheme://user:password@host` → `scheme://user:••••••@host`. */
export function maskUrlPassword(value: string): string {
  return value.replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^:/@\s]*:)[^@\s]+@/gi, '$1••••••@');
}

/**
 * A plan as it may leave the server: every variable named, secrets hidden.
 *
 * The plan carried the key a person typed at the configuration gate, the secrets
 * DevLaunch generated and database URLs with their passwords, and `GET /api/sessions/:id`
 * returned all of it — rendered in the Plan panel, in a screen share, and readable by
 * anything that can reach the API (audit A-11). Ordinary settings stay readable: they
 * are what someone debugging the run needs to see.
 */
export function publicPlan<P extends RunPlan | undefined>(plan: P): P {
  if (!plan) return plan;
  return {
    ...plan,
    environmentVariables: plan.environmentVariables.map((v) => {
      if (v.value === null) return v;
      if (isSecretKey(v.key)) return { ...v, value: HIDDEN };
      return { ...v, value: maskUrlPassword(v.value) };
    }),
  };
}
