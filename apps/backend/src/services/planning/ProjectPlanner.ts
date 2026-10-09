import type {
  ProjectPlan,
  RepositoryMetadata,
  ServiceCandidate,
  ServiceRunPlan,
} from '@devlaunch/shared';
import { ProjectPlanSchema } from '@devlaunch/shared';
import type { RepositoryAnalyzer } from '../analysis/RepositoryAnalyzer.js';
import type { RuleBasedPlanner } from './RuleBasedPlanner.js';
import { workspaceInstall } from '../analysis/ServiceDiscovery.js';
import { inWorkspace } from '../execution/SharedInstall.js';
import { submoduleWarning } from '../analysis/RepositoryAnalyzer.js';
import { config } from '../../config/index.js';

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
    // The project path reports its services' warnings, not the repository's, so the one
    // repository-level warning that bears on every service is carried across here.
    if (meta.submodules?.length) warnings.push(submoduleWarning(meta.submodules));
    const used = new Set<string>();

    // A workspace installs once, at its root, with the tool that wrote its lockfile.
    // Installing a single package in isolation cannot work: its siblings are referenced
    // as `workspace:*`, which npm rejects outright with EUNSUPPORTEDPROTOCOL.
    const workspace = await workspaceInstall(root);
    if (workspace) {
      warnings.push(
        `Workspace detected; installing once at the repository root with ${workspace.manager}.`,
      );
    }

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

      // Named before the run. The dev server resolves this target itself, inside this
      // service's own container, so `localhost` is this service — not the API beside it.
      // DevLaunch does something about it either way, and says what: by default its
      // gateway forwards what the proxy would have (the project is not edited); with
      // DEVLAUNCH_REWRITE_SOURCE on, the line is changed in its own clone instead.
      if (candidate.devProxy) {
        const api = candidates.find((c) => c.role === 'api' && c !== candidate);
        const suggestion = api
          ? `http://${api.name}:${api.declaredPort ?? 'PORT'}`
          : 'the API service\'s name on the container network';
        warnings.push(
          `${candidate.name}: ${candidate.devProxy.file} proxies to ` +
            `${candidate.devProxy.target}, which inside this container is this service ` +
            'itself, so the dev server cannot forward the page\'s API calls. ' +
            (config.rewriteSource
              ? `DEVLAUNCH_REWRITE_SOURCE is set, so DevLaunch will point it at ${suggestion} ` +
                'in its own clone before starting; your checkout is untouched.'
              : 'DevLaunch forwards those calls to the API itself, from the address it gives ' +
                'you; the project is not changed. Open that address rather than the ' +
                `frontend's own port. (To fix it in the project, point it at ${suggestion}.)`),
        );
      }

      const port = candidate.declaredPort ?? outcome.plan.expectedPort;
      services.push({
        ...outcome.plan,
        // The per-package install is replaced, not supplemented: running both would
        // install the same tree twice and the second would fail the same way.
        // Node services only: a workspace is a Node package manager's. The template's
        // Python backend (`fastapi/full-stack-fastapi-template`) was given `npm install`
        // in place of its own, and died on `npm: not found`.
        ...(workspace && inWorkspace(outcome.plan)
          ? { installCommand: workspace.command, installDirectory: '.', packageManager: workspace.manager }
          : {}),
        // The port the service's own code declares wins over the planner's default.
        //
        // Alone, a service can be told to listen anywhere — DevLaunch injects PORT and
        // reads the mapping back. In a project it cannot: siblings refer to it by name
        // *and port*, and a frontend that calls `http://backend:5000` is broken by
        // moving the backend to 3000. The repository's own number is the only one
        // everything else already agrees on.
        expectedPort: port,
        // And the port flag DevLaunch wrote into the start command, when it wrote one.
        // `niksbanna/mern-boilerplate`'s client declares 3000 in vite.config.ts; the plan
        // moved to 3000 and kept `--port 5173`, which Vite obeys over its config — so it
        // listened on 5173 while DevLaunch watched 3000, and the client never came up.
        startCommand: withStartPort(outcome.plan.startCommand, outcome.plan.expectedPort, port),
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
      plan: ProjectPlanSchema.parse({
        services,
        planSource: 'rule-based',
        // Every service was given the same root install; they must not run it at once.
        ...(workspace ? { sharedInstall: true } : {}),
      }),
      skipped,
      warnings,
    };
  }
}

/** Replace the planner's PORT with the project's, leaving every other variable alone. */
/**
 * A start command's port flag moved from one port to another: `--port 5173`,
 * `--port=5173` and `-p 5173` — the forms `bindingArgs` writes. Nothing else in the
 * command is touched, and nothing changes when the ports agree or there is no such flag.
 */
export function withStartPort(command: string, from: number | null, to: number | null): string {
  if (from === null || to === null || from === to) return command;
  return command.replace(new RegExp(`(--port[= ]|-p )${from}(?![0-9])`, 'g'), `$1${to}`);
}

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
