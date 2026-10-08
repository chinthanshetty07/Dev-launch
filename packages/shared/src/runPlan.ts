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

/**
 * A service that runs from the repository's own Docker setup: an image built from its
 * Dockerfile, or a stock image its compose file names. Used only when DevLaunch cannot run
 * the repository its own way. The image's own command runs; nothing here is a shell line.
 */
export const DockerSpecSchema = z.object({
  source: z.enum(['dockerfile', 'compose']),
  /** The file it came from, relative to the repository root. */
  file: z.string(),
  /** The name other services reach it by: the compose service name. */
  alias: z.string(),
  /** A stock image, when the service is not built. */
  image: z.string().optional(),
  build: z
    .object({
      context: z.string(),
      dockerfile: z.string(),
      target: z.string().optional(),
      args: z.record(z.string()).default({}),
    })
    .optional(),
  /** A command override, as arguments. */
  command: z.array(z.string()).optional(),
  /** An entrypoint override, as arguments. */
  entrypoint: z.array(z.string()).optional(),
  /** Container paths that need writable storage of their own. */
  dataPaths: z.array(z.string()).default([]),
  /** Every container port it declares; `expectedPort` is the one opened in a browser. */
  ports: z.array(z.number().int().positive()).default([]),
  /** A database or broker: ready when it accepts connections, not when it answers HTTP. */
  database: z.boolean().default(false),
});

export const PlanSourceSchema = z.enum(['rule-based', 'ai-fallback', 'repo-docker']);

export const RunPlanSchema = z.object({
  runtime: z.object({
    // `container`: the repository's own image decides the runtime (see `docker`).
    language: z.enum(['node', 'python', 'container']),
    version: z.string().min(1),
  }),
  packageManager: z.enum(['npm', 'yarn', 'pnpm', 'pip', 'poetry', 'none']),
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
  planSource: PlanSourceSchema,
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
  /**
   * Run Node with OpenSSL's legacy algorithms (`--openssl-legacy-provider`), which webpack 4
   * — react-scripts 4 and earlier — needs on Node 17+, or it stops on
   * `ERR_OSSL_EVP_UNSUPPORTED`. A flag rather than an environment variable: plans may never
   * set NODE_OPTIONS (`--require` in it runs code first), so DevLaunch writes this one value
   * itself (`buildWrapperEnv`).
   */
  legacyOpenssl: z.boolean().optional(),
  docker: DockerSpecSchema.optional(),
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
  planSource: PlanSourceSchema,
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
export type DockerSpec = z.infer<typeof DockerSpecSchema>;
export type EnvVar = z.infer<typeof EnvVarSchema>;
export type HealthCheck = z.infer<typeof HealthCheckSchema>;
