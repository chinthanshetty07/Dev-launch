import type {
  EnvExampleVar,
  ExecutionState,
  FailureDetail,
  RunPlan,
  WorkspacePackage,
} from '@devlaunch/shared';

export interface PendingInput {
  requiredEnv: EnvExampleVar[];
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
}

async function json<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body;
}

export const api = {
  fixtures: () => fetch('/api/fixtures').then((r) => json<string[]>(r)),

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

  cancel: (id: string) =>
    fetch(`/api/sessions/${id}/cancel`, { method: 'POST' }).then((r) =>
      json<{ id: string; state: ExecutionState }>(r),
    ),
};
