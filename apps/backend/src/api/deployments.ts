import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Express, Response } from 'express';
import { TERMINAL_STATES, FAILURE_TAXONOMY, type FailureCode } from '@devlaunch/shared';
import { SessionConflict, type Session, type SessionManager } from '../services/session/SessionManager.js';
import { phaseDurations } from '../services/session/DeploymentEvents.js';
import type { DeploymentRecord } from '../services/session/DeploymentStore.js';
import { SecurityRejection } from '../services/security/ImageAllowlist.js';
import { assertSafeRelativePath } from '../services/security/PathValidator.js';
import { ReadinessChecker } from '../services/readiness/ReadinessChecker.js';
import { normaliseRef, normaliseRepoUrl, splitRepoInput } from '../services/git/GitManager.js';

/**
 * The deployment API: `/api/deployments`.
 *
 * The same engine as `/api/sessions`, which the dashboard keeps using, shaped around a
 * deployment's lifecycle — with its identity, its timeline and its record after a restart
 * — and one error shape for every failure:
 *
 *   { "error": { "code", "category", "message", "retryable", "suggestedAction" } }
 *
 * Internal errors are never returned as stack traces.
 */
export interface DeploymentRouteOptions {
  sessions: SessionManager;
  fixturesDir: string;
}

type ApiErrorCode = 'INVALID_INPUT' | 'NOT_FOUND' | 'CONFLICT' | 'NOT_AVAILABLE' | 'INTERNAL';

const API_ERRORS: Record<ApiErrorCode, { status: number; category: string; retryable: boolean; suggestedAction: string }> = {
  INVALID_INPUT: { status: 400, category: 'VALIDATION_ERROR', retryable: false, suggestedAction: 'Correct the request and send it again.' },
  NOT_FOUND: { status: 404, category: 'VALIDATION_ERROR', retryable: false, suggestedAction: 'List deployments with GET /api/deployments.' },
  CONFLICT: { status: 409, category: 'CONCURRENCY_ERROR', retryable: true, suggestedAction: 'Wait for, or cancel, the deployment in the way, then retry.' },
  NOT_AVAILABLE: { status: 409, category: 'VALIDATION_ERROR', retryable: false, suggestedAction: 'This is only available while the deployment is running in this process.' },
  INTERNAL: { status: 500, category: 'INTERNAL_ERROR', retryable: true, suggestedAction: 'Retry; if it persists, run ./devlaunch doctor.' },
};

function apiError(res: Response, code: ApiErrorCode, message: string, extra: Record<string, unknown> = {}): void {
  const e = API_ERRORS[code];
  res.status(e.status).json({ error: { code, category: e.category, message, retryable: e.retryable, suggestedAction: e.suggestedAction, ...extra } });
}

/** A rejection carrying a failure code, in the same shape, with the taxonomy's answers. */
function rejection(res: Response, err: SecurityRejection): void {
  const t = FAILURE_TAXONOMY[err.code as FailureCode];
  res.status(400).json({
    error: {
      code: err.code,
      category: t?.category ?? 'VALIDATION_ERROR',
      message: err.message,
      retryable: t?.retryable ?? false,
      suggestedAction: t?.suggestedAction ?? 'Correct the request and send it again.',
    },
  });
}

/** Where to open it: the first web service, else the session's URL; the API's; and each service's. */
function urls(r: DeploymentRecord) {
  const web = r.services.find((s) => s.role === 'web' && s.url);
  const api = r.services.find((s) => s.role === 'api' && s.url);
  return {
    primaryUrl: web?.url ?? r.url ?? r.services.find((s) => s.url)?.url ?? null,
    apiUrl: api?.url ?? null,
    serviceUrls: Object.fromEntries(r.services.filter((s) => s.url).map((s) => [s.name, s.url!])),
  };
}

function summary(r: DeploymentRecord) {
  return {
    id: r.id,
    state: r.state,
    repository: r.repoUrl ?? null,
    ref: r.ref ?? null,
    commit: r.commit ?? null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    ...urls(r),
    failure: r.failure ? { code: r.failure.code, category: r.failure.category } : null,
    interrupted: r.interrupted ?? false,
  };
}

function detail(r: DeploymentRecord, live: Session | undefined) {
  return {
    ...summary(r),
    identity: { id: r.id, repository: r.repoUrl ?? r.sourceDir ?? null, ref: r.ref ?? null, commit: r.commit ?? null },
    live: Boolean(live && !TERMINAL_STATES.includes(live.state)),
    detected: r.detected ?? null,
    endedReason: r.endedReason ?? null,
    readyAt: r.readyAt ?? null,
    durations: phaseDurations(r.events),
    services: r.services,
    backing: r.backing,
    failure: r.failure ?? null,
    repairs: r.repairs ?? [],
    attempts: r.launchAttempts ?? [],
    pendingInput: live?.pending ?? null,
    verification: r.verification ?? null,
  };
}

export function registerDeploymentRoutes(app: Express, opts: DeploymentRouteOptions): void {
  const { sessions } = opts;

  const find = async (id: string, res: Response): Promise<DeploymentRecord | undefined> => {
    const r = await sessions.record(id);
    if (!r) apiError(res, 'NOT_FOUND', `No deployment ${id.slice(0, 64)}.`);
    return r;
  };

  app.post('/api/deployments', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      if (typeof body.repoUrl === 'string' && body.repoUrl.trim() !== '') {
        let { repoUrl, ref } = splitRepoInput(body.repoUrl);
        if (typeof body.ref === 'string' && body.ref.trim() !== '') ref = normaliseRef(body.ref);
        normaliseRepoUrl(repoUrl);
        const s = await sessions.launch({ repoUrl, ...(ref ? { ref } : {}), replace: body.replace === true });
        res.status(201).json({ id: s.id, state: s.state, links: { self: `/api/deployments/${s.id}` } });
        return;
      }
      if (typeof body.fixture === 'string' && body.fixture !== '') {
        assertSafeRelativePath(body.fixture, 'fixture');
        const known = (await readdir(opts.fixturesDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
        if (!known.includes(body.fixture)) {
          apiError(res, 'INVALID_INPUT', `Unknown fixture "${body.fixture.slice(0, 80)}".`, { available: known });
          return;
        }
        const s = await sessions.launch({ sourceDir: resolve(opts.fixturesDir, body.fixture), replace: body.replace === true });
        res.status(201).json({ id: s.id, state: s.state, links: { self: `/api/deployments/${s.id}` } });
        return;
      }
      apiError(res, 'INVALID_INPUT', 'Send { "repoUrl": "https://github.com/owner/repo" } (optionally "ref"), or { "fixture": "<name>" }.');
    } catch (err) {
      if (err instanceof SessionConflict) {
        apiError(res, 'CONFLICT', err.message, { activeDeploymentId: err.activeSessionId ?? null });
      } else if (err instanceof SecurityRejection) {
        rejection(res, err);
      } else {
        apiError(res, 'INVALID_INPUT', err instanceof Error ? err.message.slice(0, 300) : 'Invalid request.');
      }
    }
  });

  app.get('/api/deployments', async (_req, res) => {
    res.json({ deployments: (await sessions.records()).map(summary) });
  });

  app.get('/api/deployments/:id', async (req, res) => {
    const r = await find(req.params.id, res);
    if (r) res.json(detail(r, sessions.get(r.id)));
  });

  app.get('/api/deployments/:id/events', async (req, res) => {
    const r = await find(req.params.id, res);
    if (r) res.json({ id: r.id, events: r.events, durations: phaseDurations(r.events) });
  });

  app.get('/api/deployments/:id/services', async (req, res) => {
    const r = await find(req.params.id, res);
    if (r) res.json({ id: r.id, ...urls(r), services: r.services, backing: r.backing });
  });

  /** Logs are kept in memory, bounded; a deployment from before a restart has none. */
  app.get('/api/deployments/:id/logs', async (req, res) => {
    const live = sessions.get(req.params.id);
    if (!live) {
      const r = await sessions.record(req.params.id);
      if (!r) return apiError(res, 'NOT_FOUND', `No deployment ${req.params.id.slice(0, 64)}.`);
      return apiError(res, 'NOT_AVAILABLE', 'Logs are kept in memory only, and this deployment ran before the last restart. Its events are at /events.');
    }
    // Sequence numbers start at 0, so "everything" is "after -1"; a default of 0 dropped
    // the first line, which is the one saying which commit was cloned (audit A-18).
    const raw = Number(req.query.since);
    const since = req.query.since === undefined || !Number.isFinite(raw) ? -1 : raw;
    const limit = Math.min(Math.max(Number(req.query.limit ?? 1000) || 1000, 1), 10_000);
    const entries = live.logs.buffer.all().filter((e) => e.seq > since).slice(-limit);
    res.json({ id: live.id, entries, stats: live.logs.buffer.stats });
  });

  /**
   * Health as of now: the recorded state, and every service URL asked again — one short
   * HTTP(S) request each — rather than only what was true at READY.
   */
  app.get('/api/deployments/:id/health', async (req, res) => {
    const r = await find(req.params.id, res);
    if (!r) return;
    const live = sessions.get(r.id);
    const checker = new ReadinessChecker();
    // A single-service deployment has no service table; its one URL is the one to ask.
    // It used to answer `services: []` and check nothing (audit A-18).
    const targets = r.services.length > 0 ? r.services : r.url ? [{ name: 'app', state: r.state, url: r.url }] : [];
    const services = await Promise.all(
      targets.map(async (s) => {
        if (!live || !s.url) return { name: s.name, state: s.state, url: s.url ?? null, answered: null };
        const u = new URL(s.url);
        const probe = await checker.waitForReady({
          port: u.port,
          protocol: u.protocol === 'https:' ? 'https' : 'http',
          healthCheck: { path: '/', method: 'GET', expectedStatusCodes: [200, 204, 301, 302, 304] },
          timeoutMs: 3000,
        });
        return { name: s.name, state: s.state, url: s.url, answered: probe.ready, status: probe.status ?? null };
      }),
    );
    res.json({
      id: r.id,
      state: r.state,
      live: Boolean(live),
      services,
      backing: r.backing,
      failure: r.failure ?? null,
      checkedAt: Date.now(),
    });
  });

  app.post('/api/deployments/:id/cancel', async (req, res) => {
    const live = sessions.get(req.params.id);
    if (!live) {
      const r = await sessions.record(req.params.id);
      return r ? res.json({ id: r.id, state: r.state }) : apiError(res, 'NOT_FOUND', `No deployment ${req.params.id.slice(0, 64)}.`);
    }
    await sessions.cancel(live.id);
    res.json({ id: live.id, state: live.state });
  });

  /**
   * Try again. A running deployment is restarted in place (its ports and wiring kept); a
   * finished one is launched afresh from the same repository and ref, under a new id.
   */
  app.post('/api/deployments/:id/retry', async (req, res) => {
    const live = sessions.get(req.params.id);
    if (live && !TERMINAL_STATES.includes(live.state)) {
      // Answered 202 for a single-service run, where restart does nothing (audit A-07).
      const refusal = sessions.restartRefusal(live);
      if (refusal) return apiError(res, 'CONFLICT', refusal);
      void sessions.restart(live.id);
      return res.status(202).json({ id: live.id, state: live.state });
    }
    const r = await sessions.record(req.params.id);
    if (!r) return apiError(res, 'NOT_FOUND', `No deployment ${req.params.id.slice(0, 64)}.`);
    if (!r.repoUrl) return apiError(res, 'INVALID_INPUT', 'Only a deployment of a repository URL can be retried from its record.');
    try {
      const s = await sessions.launch({ repoUrl: r.repoUrl, ...(r.ref ? { ref: r.ref } : {}) });
      res.status(201).json({ id: s.id, state: s.state, retryOf: r.id, links: { self: `/api/deployments/${s.id}` } });
    } catch (err) {
      if (err instanceof SessionConflict) return apiError(res, 'CONFLICT', err.message, { activeDeploymentId: err.activeSessionId ?? null });
      return apiError(res, 'INTERNAL', 'The deployment could not be started again.');
    }
  });

  /** Stop it if it is running, and forget its record. */
  app.delete('/api/deployments/:id', async (req, res) => {
    const r = await find(req.params.id, res);
    if (!r) return;
    if (sessions.get(r.id)) await sessions.cancel(r.id);
    await sessions.forget(r.id);
    res.status(204).end();
  });
}

