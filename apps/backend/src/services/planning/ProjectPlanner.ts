import type {
  ProjectPlan,
  RepositoryMetadata,
  ServiceCandidate,
  ServiceRunPlan,
} from '@devlaunch/shared';
import { ProjectPlanSchema } from '@devlaunch/shared';
import type { RepositoryAnalyzer } from '../analysis/RepositoryAnalyzer.js';
import type { RuleBasedPlanner } from './RuleBasedPlanner.js';

export interface ProjectPlanningOutcome {
  plan: ProjectPlan | null;
  /** Why no project plan was produced. Present only when plan is null. */
  reason?: string;
  /** Services that were found but could not be planned, with the reason for each. */
  skipped: { name: string; reason: string }[];
  warnings: string[];
}

/**
 * Plan every service a repository contains, as one unit.
 *
 * Deliberately built on the single-service planner rather than beside it: each service
 * directory is an ordinary project in its own right, and the 22 detectors already know
 * how to read one. What is new here is only what a *set* of services needs — unique DNS
 * names, and a decision about which of them the session's URL points at.
 */
export class ProjectPlanner {
  constructor(
    private readonly analyzer: RepositoryAnalyzer,
    private readonly planner: RuleBasedPlanner,
  ) {}

  async planProject(root: string, meta: RepositoryMetadata): Promise<ProjectPlanningOutcome> {
    const candidates = meta.services ?? [];
    if (candidates.length < 2) {
      return {
        plan: null,
        reason: 'Not a multi-service repository.',
        skipped: [],
        warnings: [],
      };
    }

    const services: ServiceRunPlan[] = [];
    const skipped: { name: string; reason: string }[] = [];
    const warnings: string[] = [];
    const used = new Set<string>();

    for (const candidate of candidates) {
      const subMeta = await this.analyzer.analyze(root, candidate.dir);
      const outcome = this.planner.plan(subMeta, candidate.dir);
      warnings.push(...outcome.warnings.map((w) => `${candidate.name}: ${w}`));

      if (!outcome.plan) {
        // One unplannable service does not sink the project: a repository with a Go
        // worker beside a Node web app is still worth running the parts we understand.
        skipped.push({ name: candidate.name, reason: outcome.reason ?? 'no plan could be produced' });
        continue;
      }

      const port = candidate.declaredPort ?? outcome.plan.expectedPort;
      services.push({
        ...outcome.plan,
        // The port the service's own code declares wins over the planner's default.
        //
        // Alone, a service can be told to listen anywhere — DevLaunch injects PORT and
        // reads the mapping back. In a project it cannot: siblings refer to it by name
        // *and port*, and a frontend that calls `http://backend:5000` is broken by
        // moving the backend to 3000. The repository's own number is the only one
        // everything else already agrees on.
        expectedPort: port,
        // PORT is injected as an environment variable too, and the variable is what the
        // application actually reads. Changing the plan's port without changing it moves
        // the number DevLaunch watches while the service keeps binding the old one.
        environmentVariables: withPort(outcome.plan.environmentVariables, port),
        name: dnsName(candidate, used),
        role: candidate.role,
      });
    }

    if (services.length < 2) {
      return {
        plan: null,
        reason:
          services.length === 0
            ? 'None of the services could be planned.'
            : 'Only one service could be planned, so this is not a multi-service run.',
        skipped,
        warnings,
      };
    }

    return {
      plan: ProjectPlanSchema.parse({ services, planSource: 'rule-based' }),
      skipped,
      warnings,
    };
  }
}

/** Replace the planner's PORT with the project's, leaving every other variable alone. */
function withPort(
  vars: { key: string; value: string | null; required: boolean }[],
  port: number | null,
): { key: string; value: string | null; required: boolean }[] {
  if (port === null) return vars;
  const rest = vars.filter((v) => v.key !== 'PORT');
  return [...rest, { key: 'PORT', value: String(port), required: false }];
}

/**
 * A DNS label other services can resolve, unique within the project.
 *
 * Names become hostnames on the shared network, so `@scope/web-app` cannot be one and a
 * project with two directories called `api` needs them told apart.
 */
export function dnsName(candidate: ServiceCandidate, used: Set<string>): string {
  const fromDir = candidate.dir === '.' ? candidate.name : candidate.dir.split('/').pop()!;
  const base =
    fromDir
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || candidate.role;

  let name = base;
  for (let i = 2; used.has(name); i++) name = `${base}-${i}`;
  used.add(name);
  return name;
}
