import type {
  BackingService,
  ProjectPlan,
  RepositoryMetadata,
  RequiredEnvVar,
  ServiceCandidate,
  ServiceRunPlan,
} from '@devlaunch/shared';
import { wirableKeys } from '../execution/CrossServiceWiring.js';

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
  return (meta.envExample ?? [])
    .filter((v) => !v.hasDefault && !ALWAYS_SUPPLIED.includes(v.key))
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
