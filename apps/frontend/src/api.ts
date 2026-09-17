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

export const api = {
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
