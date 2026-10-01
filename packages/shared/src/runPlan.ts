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
  /**
   * Where the install step runs, when that is not the working directory.
   *
   * A workspace installs once at its root: its packages depend on each other through
   * `workspace:*`, and no package manager can resolve that for a single package in
   * isolation — npm refuses it outright with `EUNSUPPORTEDPROTOCOL`.
   */
  installDirectory: z.string().nullable().default(null),
  expectedPort: z.number().int().positive().nullable(),
  hostBinding: HostBindingSchema.default('unknown'),
  environmentVariables: z.array(EnvVarSchema).default([]),
  healthCheck: HealthCheckSchema.default({}),
  planSource: z.enum(['rule-based', 'ai-fallback']),
  /**
   * How the application answers: over plain HTTP, or over TLS with a certificate the
   * repository ships. Absent means HTTP, which is nearly everything.
   *
   * Exists for applications that refuse plain HTTP outright — `nkwus/fastapi-starter`
   * answers every request with `403 HTTPS is required for all requests.` and its README
   * starts uvicorn with `--ssl-certfile certs/localhost.pem`. Served over HTTP it was up,
   * and useless.
   */
  protocol: z.enum(['http', 'https']).optional(),
});

/**
 * One service's plan, within a project made of several.
 *
 * A repository is not one application: `frontend/` calling `backend/` is the ordinary
 * shape of a web project, and running only one of them produces a page that loads and
 * then fails every request it makes.
 */
export const ServiceRunPlanSchema = RunPlanSchema.extend({
  /** Unique within the project, and the DNS name other services reach it on. */
  name: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'must be a DNS label'),
  role: z.enum(['web', 'api', 'worker']),
});

/**
 * Everything a repository needs running, as one unit.
 *
 * Readiness belongs to the project rather than to any single service: a frontend that
 * answers while its API is still starting is not a project a person can use.
 */
export const ProjectPlanSchema = z.object({
  services: z.array(ServiceRunPlanSchema).min(1),
  planSource: z.enum(['rule-based', 'ai-fallback']),
  /**
   * Every service installs the same workspace, so they must not do it at once.
   *
   * A workspace's packages reference each other as `workspace:*`, which no package
   * manager resolves for one package alone, so each service is given the *root* install
   * — the whole tree, once per service. They then ran concurrently, and a NestJS plus
   * Next.js monorepo needed more memory than the VM had: both containers were killed
   * mid-fetch, and the limit that killed them was DevLaunch's own.
   *
   * Set only for a detected workspace. Two unrelated services with their own manifests
   * install different things and gain nothing from waiting for each other.
   */
  sharedInstall: z.boolean().optional(),
});

export type ServiceRunPlan = z.infer<typeof ServiceRunPlanSchema>;
export type ProjectPlan = z.infer<typeof ProjectPlanSchema>;

export type RunPlan = z.infer<typeof RunPlanSchema>;
export type EnvVar = z.infer<typeof EnvVarSchema>;
export type HealthCheck = z.infer<typeof HealthCheckSchema>;
