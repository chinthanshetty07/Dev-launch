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
  /** Set when the app crashed on these settings, rather than a file declaring them. */
  crash?: { file: string; line: number; error: string };
}

/** The end-to-end check READY waited for (backend `SmokeTest`). */
export interface VerificationView {
  passed: boolean;
  durationMs: number;
  checks: { name: string; kind: 'http' | 'wiring' | 'dependency'; service?: string; target: string; passed: boolean; skipped?: boolean; detail: string }[];
}

export interface SessionView {
  id: string;
  state: ExecutionState;
  repoUrl?: string;
  /** The branch, tag or commit asked for; absent means the default branch. */
  ref?: string;
  /** The commit actually running. */
  commit?: string | null;
  verification?: VerificationView;
  detected?: string | null;
  planSource?: 'rule-based' | 'ai-fallback' | 'repo-docker';
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

/** The server no longer knows this session: it was restarted, or the session was forgotten. */
export class GoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoneError';
  }
}

async function json<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as T & {
    error?: string | { message?: string };
    activeSessionId?: string;
  };
  // Two error shapes: the session routes' `{ error: "…" }` and the structured
  // `{ error: { message, … } }` of the deployments API and the host guard.
  const message = typeof body.error === 'string' ? body.error : body.error?.message;
  if (res.status === 409) {
    throw new ConflictError(message ?? 'A session is already running.', body.activeSessionId);
  }
  if (res.status === 404) throw new GoneError(message ?? 'Not found.');
  if (!res.ok) throw new Error(message ?? `Request failed (${res.status})`);
  return body;
}

/** `own-key`: the person's Groq key. `relay`: DevLaunch's shared one, limited daily. */
export type AiSource = 'own-key' | 'relay' | 'off';
export interface AiStatus {
  source: AiSource;
  /** A key added here, which can be removed here (one in .env cannot). */
  ownKeyRemovable: boolean;
  relay: boolean;
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
  health: () => fetch('/api/health').then((r) => json<{ build?: BuildStamp; ai?: boolean; aiSource?: AiSource }>(r)),

  // Where AI help comes from, and a person's own Groq key (kept on this machine only).
  aiStatus: () => fetch('/api/ai').then((r) => json<AiStatus>(r)),
  saveAiKey: (key: string) =>
    fetch('/api/ai/key', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key }),
    }).then((r) => json<AiStatus>(r)),
  removeAiKey: () => fetch('/api/ai/key', { method: 'DELETE' }).then((r) => json<AiStatus>(r)),

  fixtures: () => fetch('/api/fixtures').then((r) => json<string[]>(r)),

  sessions: () => fetch('/api/sessions').then((r) => json<SessionSummary[]>(r)),

  // `replace`: deploying something new stops what is running, which is how a person uses
  // this — look at one repository, then the next — rather than being refused.
  launch: (body: { repoUrl?: string; fixture?: string }) =>
    fetch('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, replace: true }),
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
