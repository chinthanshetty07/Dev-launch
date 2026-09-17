import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import express, { type Express } from 'express';
import { SessionConflict, type Session, type SessionManager } from '../services/session/SessionManager.js';
import { assertSafeRelativePath } from '../services/security/PathValidator.js';
import { SecurityRejection } from '../services/security/ImageAllowlist.js';

export interface AppOptions {
  sessions: SessionManager;
  fixturesDir: string;
  publicDir: string;
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
  };
}

export function createApp(opts: AppOptions): Express {
  const app = express();
  app.use(express.json({ limit: '64kb' }));
  app.use(express.static(opts.publicDir));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, sessions: opts.sessions.list().length });
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
        res.status(409).json({ error: err.message });
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

  app.post('/api/sessions/:id/cancel', async (req, res) => {
    const session = opts.sessions.get(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'No such session.' });
      return;
    }
    await opts.sessions.cancel(session.id);
    res.json({ id: session.id, state: session.state });
  });

  return app;
}
