import type { ServiceRunPlan } from '@devlaunch/shared';

/**
 * Which services a workspace's one root install is for.
 *
 * A workspace (`workspaces` in package.json, pnpm-workspace.yaml) belongs to a Node package
 * manager, so only Node services are in it. A Python backend beside one
 * (`fastapi/full-stack-fastapi-template`: frontend and packages/* in an npm workspace,
 * backend/ with uv) has its own install, its own files, and no reason to wait its turn.
 */
export function inWorkspace(plan: Pick<ServiceRunPlan, 'runtime'>): boolean {
  return plan.runtime.language === 'node';
}

/** Whether this service runs the project's shared root install (`sharedInstall`). */
export function sharesInstall(project: { sharedInstall?: boolean }, plan: Pick<ServiceRunPlan, 'runtime'>): boolean {
  return project.sharedInstall === true && inWorkspace(plan);
}
