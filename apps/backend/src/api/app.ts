import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import express, { type Express } from 'express';
import { RunPlanSchema } from '@devlaunch/shared';
import { SessionConflict, type SessionManager } from '../services/session/SessionManager.js';
import { assertSafeRelativePath } from '../services/security/PathValidator.js';
import { SecurityRejection } from '../services/security/ImageAllowlist.js';

export interface AppOptions {
  sessions: SessionManager;
  fixturesDir: string;
  publicDir: string;
  image?: string;
}

/**
 * HTTP surface for Phase 4.
 *
 * Only what log streaming needs: a way to start something worth streaming, a way to
 * read session status, and a way to stop. Repository cloning arrives in Phase 5, so
 * for now a run is started from a vendored fixture by name — never a caller-supplied
 * path, which would be an arbitrary-directory read.
 */
function positiveInt(raw: unknown, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
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

  app.post('/api/sessions', async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const fixture = String(body.fixture ?? '');

      // The name must be a single safe path segment, and must actually exist as a
      // vendored fixture — membership in a known set, not merely a well-formed string.
      assertSafeRelativePath(fixture, 'fixture');
      const available = (await readdir(opts.fixturesDir, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
      if (!available.includes(fixture)) {
        res.status(400).json({ error: `Unknown fixture "${fixture}".`, available });
        return;
      }

      const plan = RunPlanSchema.parse({
        runtime: { language: 'node', version: '20' },
        packageManager: 'npm',
        installCommand: body.installCommand ?? null,
        buildCommand: null,
        startCommand: body.startCommand ?? 'node server.js',
        workingDirectory: '.',
        expectedPort: body.expectedPort ?? 3000,
        hostBinding: 'forced',
        planSource: 'rule-based',
      });

      const session = await opts.sessions.launch({
        plan,
        sourceDir: resolve(opts.fixturesDir, fixture),
        image: opts.image ?? 'devlaunch/node:20',
        // A malformed value would become NaN, and setTimeout(NaN) fires immediately.
        readinessTimeoutMs: positiveInt(body.readinessTimeoutMs, 30_000),
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
    res.json({
      id: session.id,
      state: session.state,
      url: session.url,
      failure: session.failure,
      createdAt: session.createdAt,
      readyAt: session.readyAt,
      logs: session.logs.buffer.stats,
    });
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
