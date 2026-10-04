import type {
  BackingService,
  EnvExampleVar,
  ProjectPlan,
  RepositoryMetadata,
  RequiredEnvVar,
  RunPlan,
  ServiceCandidate,
  ServiceRunPlan,
} from '@devlaunch/shared';
import { wirableKeys } from '../execution/CrossServiceWiring.js';
import { validateEnvVarKey, validateEnvVarValue } from '../security/CommandValidator.js';

/**
 * What a person still has to supply before a project can run.
 *
 * A repository's configuration lives beside the service that reads it — an API key in
 * `backend/.env.example`, not at the root — so a gate that reads only the root asks for
 * nothing and lets the container start without it. That failure arrives as an
 * application crash with the reason buried in its own logs, which is exactly the shape
 * of problem the gate exists to prevent.
 *
 * The harder half is what *not* to ask for. DevLaunch fills in the database URL, the API
 * base, the permitted origin and the port itself, and asking a person for any of them is
 * asking them to guess a value that has not been decided yet — one that will either be
 * overridden, or respected and wrong.
 */

/** Variables the planner and the wrapper always provide. */
const ALWAYS_SUPPLIED = ['PORT', 'HOST', 'NODE_ENV'];

export function requiredConfiguration(
  project: ProjectPlan,
  candidates: readonly ServiceCandidate[],
  backing: readonly BackingService[],
): RequiredEnvVar[] {
  const out: RequiredEnvVar[] = [];
  const seen = new Set<string>();

  for (const service of project.services) {
    const candidate = candidates.find((c) => c.dir === service.workingDirectory);
    const declared = candidate?.envExample ?? [];
    if (declared.length === 0) continue;

    const supplied = suppliedKeys(service, candidate, backing);

    for (const variable of declared) {
      // A declaration that ships a value is documentation, not a request.
      if (variable.hasDefault) continue;
      if (supplied.has(variable.key)) continue;

      // Two services needing the same key are asked once; the value reaches both.
      const id = `${service.name}:${variable.key}`;
      if (seen.has(id)) continue;
      seen.add(id);

      out.push({ key: variable.key, hasDefault: false, service: service.name });
    }
  }

  return out;
}

/** Everything DevLaunch will set for this service without being told. */
function suppliedKeys(
  service: ServiceRunPlan,
  candidate: ServiceCandidate | undefined,
  backing: readonly BackingService[],
): Set<string> {
  const keys = new Set<string>(ALWAYS_SUPPLIED);

  // Values the plan already carries, including anything the planner resolved.
  for (const variable of service.environmentVariables) {
    if (variable.value !== null) keys.add(variable.key);
  }

  // Database connection strings, under every name this service might read them by.
  for (const need of backing) {
    for (const key of need.urlEnvKeys ?? (need.urlEnvKey ? [need.urlEnvKey] : [])) keys.add(key);
  }

  // The sibling URLs, which cannot be known yet and must not be guessed at.
  for (const key of wirableKeys(service.role, candidate?.envKeys ?? [])) keys.add(key);

  return keys;
}

/**
 * The same question for a single-service repository, which has only a root file.
 *
 * Kept here so both paths answer "what is still missing" the same way, rather than one
 * of them quietly meaning something narrower.
 */
export function requiredConfigurationForSingle(meta: RepositoryMetadata): RequiredEnvVar[] {
  // A database DevLaunch starts is injected under every name the application reads it by,
  // and the injected value wins. Asking for it as well asked a person for a value that was
  // then thrown away — the project path already knew; this path did not.
  const provisioned = provisionedKeys(meta.backing ?? []);
  return (meta.envExample ?? [])
    .filter((v) => !v.hasDefault && !ALWAYS_SUPPLIED.includes(v.key) && !provisioned.has(v.key))
    .map((v) => ({ key: v.key, hasDefault: false }));
}

/**
 * Route supplied values to the services that declared them.
 *
 * Values arrive as a flat map because that is what a person filling in a form produces.
 * A service only receives a key it actually declares, so one service's secret does not
 * leak into another's environment — which matters when the value is an API key.
 */
export function applyConfiguration(
  project: ProjectPlan,
  candidates: readonly ServiceCandidate[],
  env: Record<string, string>,
): ProjectPlan {
  const supplied = Object.entries(env);
  if (supplied.length === 0) return project;

  return {
    ...project,
    services: project.services.map((service) => {
      const candidate = candidates.find((c) => c.dir === service.workingDirectory);
      const declares = new Set([
        ...(candidate?.envExample ?? []).map((v) => v.key),
        ...(candidate?.envKeys ?? []),
      ]);
      const mine = supplied.filter(([key]) => declares.has(key));
      if (mine.length === 0) return service;

      return {
        ...service,
        environmentVariables: [
          ...service.environmentVariables.filter((v) => !mine.some(([key]) => key === v.key)),
          ...mine.map(([key, value]) => ({ key, value, required: true })),
        ],
      };
    }),
  };
}

/**
 * A value that names this machine. In a container that is the container itself, so the
 * example's `http://localhost:8000` is wrong there in a way the application's own
 * default is not more wrong than; leaving it out keeps what happened before.
 */
const LOOPBACK = /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])\b/i;

/**
 * Give a plan the values its `.env.example` ships — what `cp .env.example .env` does.
 *
 * A declared value used to count only as "nothing to ask for", on the theory that the
 * application has the same default in code. Often it does not:
 * `techiescamp/kubernetes-ai-projects` reads `os.environ["AWS_REGION"]` at import, its
 * example says `AWS_REGION=us-east-1`, and nothing ever set it, so the backend could
 * only crash with a `KeyError`.
 *
 * The lowest layer, always. Nothing DevLaunch supplies itself is touched — a database
 * address, a sibling's URL, the port — and neither is anything the plan already carries.
 * A value pointing at `localhost` is left out (see `LOOPBACK`), and so is any variable the
 * plan validator would refuse: `NODE_OPTIONS=--max-old-space-size=4096` is common in
 * examples, and refusing a whole plan over a line in a file nobody runs would be worse
 * than not copying it.
 */
export function withExampleDefaults<P extends RunPlan>(
  plan: P,
  declared: readonly EnvExampleVar[],
  supplied: ReadonlySet<string>,
): P {
  const present = new Set(plan.environmentVariables.map((v) => v.key));
  const added: RunPlan['environmentVariables'] = [];
  for (const v of declared) {
    if (v.value === undefined || present.has(v.key) || supplied.has(v.key)) continue;
    if (ALWAYS_SUPPLIED.includes(v.key) || LOOPBACK.test(v.value)) continue;
    try {
      validateEnvVarKey(v.key);
      validateEnvVarValue(v.key, v.value);
    } catch {
      continue;
    }
    present.add(v.key);
    added.push({ key: v.key, value: v.value, required: false });
  }
  if (added.length === 0) return plan;
  return { ...plan, environmentVariables: [...plan.environmentVariables, ...added] };
}

/** `withExampleDefaults` for every service of a project, each from its own example file. */
export function projectWithExampleDefaults(
  project: ProjectPlan,
  candidates: readonly ServiceCandidate[],
  backing: readonly BackingService[],
): ProjectPlan {
  return {
    ...project,
    services: project.services.map((service) => {
      const candidate = candidates.find((c) => c.dir === service.workingDirectory);
      if (!candidate?.envExample?.length) return service;
      return withExampleDefaults(service, candidate.envExample, suppliedKeys(service, candidate, backing));
    }),
  };
}

/** Every name a provisioned database is injected under. */
export function provisionedKeys(backing: readonly BackingService[]): Set<string> {
  const keys = new Set<string>();
  for (const need of backing) {
    for (const key of need.urlEnvKeys ?? (need.urlEnvKey ? [need.urlEnvKey] : [])) keys.add(key);
  }
  return keys;
}
