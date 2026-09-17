import { z } from 'zod';

/**
 * How the start command's host binding was determined.
 * See docs/planning-strategy.md — "Ports and host binding".
 */
export const HostBindingSchema = z.enum(['forced', 'discovered', 'unknown']);

export const EnvVarSchema = z.object({
  key: z.string().min(1),
  value: z.string().nullable().default(null),
  required: z.boolean().default(true),
});

export const HealthCheckSchema = z.object({
  path: z.string().default('/'),
  method: z.enum(['GET', 'HEAD']).default('GET'),
  /**
   * Retained from §11 but demoted to a *health hint*. Readiness never gates on this:
   * a 302 to /login and a 404 on / are both healthy servers.
   */
  expectedStatusCodes: z.array(z.number().int()).default([200, 201, 204]),
});

export const RunPlanSchema = z.object({
  runtime: z.object({
    language: z.enum(['node', 'python']),
    version: z.string().min(1),
  }),
  packageManager: z.enum(['npm', 'yarn', 'pnpm', 'pip', 'poetry']),
  installCommand: z.string().nullable(),
  buildCommand: z.string().nullable(),
  startCommand: z.string().min(1),
  workingDirectory: z.string().default('.'),
  expectedPort: z.number().int().positive().nullable(),
  hostBinding: HostBindingSchema.default('unknown'),
  environmentVariables: z.array(EnvVarSchema).default([]),
  healthCheck: HealthCheckSchema.default({}),
  planSource: z.enum(['rule-based', 'ai-fallback']),
});

export type RunPlan = z.infer<typeof RunPlanSchema>;
export type EnvVar = z.infer<typeof EnvVarSchema>;
export type HealthCheck = z.infer<typeof HealthCheckSchema>;
