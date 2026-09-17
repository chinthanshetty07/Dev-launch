import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import express, { type Express } from 'express';
import { SessionConflict, type Session, type SessionManager } from '../services/session/SessionManager.js';
import { assertSafeRelativePath } from '../services/security/PathValidator.js';
import { SecurityRejection } from '../services/security/ImageAllowlist.js';
import { TERMINAL_STATES, type BackingView, type ServiceView } from '@devlaunch/shared';

export interface AppOptions {
  sessions: SessionManager;
  fixturesDir: string;
  /** Directories tried in order for static assets; the first that exists wins. */
  staticDirs: string[];
}

function positiveInt(raw: unknown, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Shape a session for the wire. The handle and cleanup closures never leave the server. */
function present(session: Session) {
  return {
    id: session.id,
    state: session.state,
    repoUrl: session.repoUrl,
    detected: session.detected,
    plan: session.plan,
    planWarnings: session.planWarnings,
    pending: session.pending,
    url: session.url,
    failure: session.failure,
    endedReason: session.endedReason,
    createdAt: session.createdAt,
    readyAt: session.readyAt,
    logs: session.logs.buffer.stats,
    // A project has several of everything a single session had one of. Collapsing them
    // into the session's own state is what let a dashboard show READY beside a page
    // that did not work.
    services: session.run?.services.map(
      (sv): ServiceView => ({
        name: sv.name,
        role: sv.role,
        state: sv.state,
        url: sv.url,
        containerPort: sv.plan.expectedPort,
        hostPort: sv.hostPort,
        failure: sv.failure,
      }),
    ),
    backing: session.run?.backing.map(
      (db): BackingView => ({ kind: db.kind, alias: db.alias, ready: db.ready }),
    ),
  };
}

export function createApp(opts: AppOptions): Express {
  const app = express();
  app.use(express.json({ limit: '64kb' }));

  // Prefer the built frontend; fall back to the plain harness page when it has not
  // been built, so the backend is never left serving nothing.
  const served = opts.staticDirs.find((dir) => existsSync(dir));
  if (served) app.use(express.static(served));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, sessions: opts.sessions.list().length });
  });

  /**
   * Every session this process knows about, newest first.
   *
   * Exists so a session can always be found again. Without it a client that lost the id
   * — a page reload is enough — could neither see the running session nor stop it, and
   * the only way past "a session is already running" was to restart the backend.
   */
  app.get('/api/sessions', (_req, res) => {
    res.json(
      opts.sessions
        .list()
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((session) => ({
          id: session.id,
          state: session.state,
          repoUrl: session.repoUrl,
          url: session.url,
          createdAt: session.createdAt,
          readyAt: session.readyAt,
          active: !TERMINAL_STATES.includes(session.state),
        })),
    );
  });

  app.get('/api/fixtures', async (_req, res) => {
    const entries = await readdir(opts.fixturesDir, { withFileTypes: true });
    res.json(entries.filter((e) => e.isDirectory()).map((e) => e.name));
  });

  /**
   * Start a session from a GitHub URL, or from a vendored fixture by name.
   *
   * A fixture is named, never given as a path: accepting a caller-supplied directory
   * would be an arbitrary-filesystem read. Either way the pipeline is identical —
   * analyse, plan deterministically, validate, run.
   */
  app.post('/api/sessions', async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const readinessTimeoutMs = positiveInt(body.readinessTimeoutMs, 60_000);

      if (typeof body.repoUrl === 'string' && body.repoUrl.trim() !== '') {
        const session = await opts.sessions.launch({
          repoUrl: body.repoUrl.trim(),
          readinessTimeoutMs,
        });
        res.status(201).json({ id: session.id, state: session.state });
        return;
      }

      const fixture = String(body.fixture ?? '');
      assertSafeRelativePath(fixture, 'fixture');
      const available = (await readdir(opts.fixturesDir, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
      if (!available.includes(fixture)) {
        res.status(400).json({ error: `Unknown fixture "${fixture}".`, available });
        return;
      }

      const session = await opts.sessions.launch({
        sourceDir: resolve(opts.fixturesDir, fixture),
        readinessTimeoutMs,
      });
      res.status(201).json({ id: session.id, state: session.state });
    } catch (err) {
      if (err instanceof SessionConflict) {
        // The id is what makes the message actionable: a client can offer to stop the
        // session that is in the way instead of only reporting that one exists.
        res.status(409).json({ error: err.message, activeSessionId: err.activeSessionId });
        return;
      }
      if (err instanceof SecurityRejection) {
        res.status(400).json({ error: err.message, code: err.code });
        return;
      }
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/sessions/:id', (req, res) => {
    const session = opts.sessions.get(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'No such session.' });
      return;
    }
    opts.sessions.touch(session.id);
    res.json(present(session));
  });

  /** Supply what a session in AWAITING_INPUT is blocked on: env values, or a package. */
  app.post('/api/sessions/:id/resolve', async (req, res) => {
    const session = opts.sessions.get(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'No such session.' });
      return;
    }
    if (session.state !== 'AWAITING_INPUT') {
      res.status(409).json({ error: `Session is ${session.state}, not awaiting input.` });
      return;
    }

    const body = (req.body ?? {}) as { env?: Record<string, string>; workspaceDir?: string };
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(body.env ?? {})) {
      // Values are kept in memory only and never written to disk.
      if (typeof v === 'string') env[k] = v;
    }

    await opts.sessions.resolve(session.id, { env, workspaceDir: body.workspaceDir });
    res.json({ id: session.id, state: session.state });
  });

  /**
   * Restart the whole project, or one service of it.
   *
   * Ports and injected configuration survive, so siblings that refer to the restarted
   * service still reach it — which is what makes this cheaper than starting again.
   */
  app.post('/api/sessions/:id/restart', async (req, res) => {
    const session = opts.sessions.get(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'No such session.' });
      return;
    }

    const service = typeof req.body?.service === 'string' ? req.body.service : undefined;
    if (service && !session.run?.services.some((sv) => sv.name === service)) {
      res.status(400).json({ error: `No service named "${service}" in this session.` });
      return;
    }

    // Not awaited: a restart takes as long as a start, and the client follows it over
    // the same stream it follows a launch on.
    void opts.sessions.restart(session.id, service);
    res.status(202).json({ id: session.id, state: session.state });
  });

  /** Live resource use per container. Sampled on request; see SessionManager.stats. */
  app.get('/api/sessions/:id/stats', async (req, res) => {
    const session = opts.sessions.get(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'No such session.' });
      return;
    }
    res.json(await opts.sessions.stats(session.id));
  });

  app.post('/api/sessions/:id/cancel', async (req, res) => {
    const session = opts.sessions.get(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'No such session.' });
      return;
    }
    await opts.sessions.cancel(session.id);
    res.json({ id: session.id, state: session.state });
  });

  // Single-page app fallback: anything not an API route serves index.html, so a page
  // refresh does not 404.
  if (served) {
    app.get(/^\/(?!api\/|ws\/).*/, (_req, res) => {
      res.sendFile(resolve(served, 'index.html'));
    });
  }

  return app;
}
