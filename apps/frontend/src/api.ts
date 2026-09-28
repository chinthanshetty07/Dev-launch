import type { HttpRoute, ReadinessView, RepairRecord } from '@devlaunch/shared';
import type {
  BackingView,
  RequiredEnvVar,
  ExecutionState,
  FailureDetail,
  RunPlan,
  ServiceStats,
  ServiceView,
  WorkspacePackage,
} from '@devlaunch/shared';

/** One edit DevLaunch made to the repository it cloned, and why. */
export interface SourceRewrite {
  /** Path relative to the repository root. */
  file: string;
  from: string;
  to: string;
  reason: string;
}

/** Why a READY project will still not work in a browser. Never a failure. */
export interface BrowserWiringProblem {
  service: string;
  file?: string;
  /** The address the source names. */
  expected: string;
  /** The address the sibling actually got. */
  actual: string;
  problem: string;
}

export interface PendingInput {
  requiredEnv: RequiredEnvVar[];
  choices?: WorkspacePackage[];
}

export interface SessionView {
  id: string;
  state: ExecutionState;
  repoUrl?: string;
  detected?: string | null;
  plan?: RunPlan;
  planWarnings?: string[];
  pending?: PendingInput;
  url?: string;
  failure?: FailureDetail;
  /** What automated repair changed, why, and whether a rule or a model decided it. */
  repairs?: RepairRecord[];
  /** Edits DevLaunch made to the clone, when DEVLAUNCH_REWRITE_SOURCE is set. */
  rewrites?: SourceRewrite[];
  /** Present when the project runs but the browser cannot wire it up. */
  browserProblems?: BrowserWiringProblem[];
  routes?: HttpRoute[];
  readiness?: ReadinessView;
  endedReason?: string;
  createdAt: number;
  readyAt?: number;
  /** Present only for a multi-service project. */
  services?: ServiceView[];
  backing?: BackingView[];
}

/** An error that also says which session is in the way, so a client can offer to stop it. */
export class ConflictError extends Error {
  constructor(
    message: string,
    readonly activeSessionId?: string,
  ) {
    super(message);
    this.name = 'ConflictError';
  }
}

async function json<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as T & {
    error?: string;
    activeSessionId?: string;
  };
  if (res.status === 409) {
    throw new ConflictError(body.error ?? 'A session is already running.', body.activeSessionId);
  }
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body;
}

export interface SessionSummary {
  id: string;
  state: ExecutionState;
  repoUrl?: string;
  url?: string;
  createdAt: number;
  active: boolean;
}

/** Whether the backend answering is running the code in the working tree. */
export interface BuildStamp {
  running?: string;
  head?: string;
  stale: boolean;
  startedAt: number;
}

export const api = {
  health: () => fetch('/api/health').then((r) => json<{ build?: BuildStamp }>(r)),

  fixtures: () => fetch('/api/fixtures').then((r) => json<string[]>(r)),

  sessions: () => fetch('/api/sessions').then((r) => json<SessionSummary[]>(r)),

  launch: (body: { repoUrl?: string; fixture?: string }) =>
    fetch('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => json<{ id: string; state: ExecutionState }>(r)),

  get: (id: string) => fetch(`/api/sessions/${id}`).then((r) => json<SessionView>(r)),

  resolve: (id: string, body: { env?: Record<string, string>; workspaceDir?: string }) =>
    fetch(`/api/sessions/${id}/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => json<{ id: string; state: ExecutionState }>(r)),

  restart: (id: string, service?: string) =>
    fetch(`/api/sessions/${id}/restart`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(service ? { service } : {}),
    }).then((r) => json<{ id: string; state: ExecutionState }>(r)),

  stats: (id: string) =>
    fetch(`/api/sessions/${id}/stats`).then((r) => json<Record<string, ServiceStats>>(r)),

  cancel: (id: string) =>
    fetch(`/api/sessions/${id}/cancel`, { method: 'POST' }).then((r) =>
      json<{ id: string; state: ExecutionState }>(r),
    ),
};
