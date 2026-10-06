import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { allowedHosts, configuredHosts, hostGuard } from '../services/security/HostGuard.js';
import { publicPlan } from '../services/security/Redaction.js';
import express, { type Express } from 'express';
import { SessionConflict, type Session, type SessionManager } from '../services/session/SessionManager.js';
import { assertSafeRelativePath } from '../services/security/PathValidator.js';
import { SecurityRejection } from '../services/security/ImageAllowlist.js';
import { TERMINAL_STATES, type BackingView, type ServiceView } from '@devlaunch/shared';
import { buildStamp } from '../services/build/BuildStamp.js';
import { normaliseRef, normaliseRepoUrl, splitRepoInput } from '../services/git/GitManager.js';
import { registerDeploymentRoutes } from './deployments.js';

export interface AppOptions {
  sessions: SessionManager;
  fixturesDir: string;
  /** Directories tried in order for static assets; the first that exists wins. */
  staticDirs: string[];
  /** The checkout to compare this process against. See `BuildStamp`. */
  repoRoot?: string;
  /** Pinged for health. Absent in tests that do not care whether Docker is reachable. */
  docker?: { ping(): Promise<unknown> };
  /** The egress probe's latest verdict. See `EgressProbe`. */
  egress?: () => { verdict: 'enforced' | 'absent' | 'unknown'; detail: string };
  /** Host names besides this machine's that may address the API. See `HostGuard`. */
  allowedHosts?: string[];
  /** Failures nothing caught. See `recordUnhandled` — health is where they surface. */
  recentErrors?: () => { at: number; detail: string }[];
}

/** Reject rather than hang. A health check that can block is not a health check. */
async function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function positiveInt(raw: unknown, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Shape a session for the wire. The handle and cleanup closures never leave the server. */
function present(session: Session, sessions?: Pick<SessionManager, 'installSummaries'>) {
  return {
    id: session.id,
    state: session.state,
    repoUrl: session.repoUrl,
    ref: session.ref,
    commit: session.commit,
    detected: session.detected,
    // How the plan was made, for a project too: `session.plan` is the single-service
    // field, so a project — the Docker path included — showed no source at all.
    planSource: session.plan?.planSource ?? session.project?.planSource,
    // Secrets hidden: see `publicPlan` (audit A-11).
    plan: publicPlan(session.plan),
    planWarnings: session.planWarnings,
    pending: session.pending,
    url: session.url,
    failure: session.failure,
    /**
     * What automated repair tried. Withheld until now, which left the plan on screen
     * unexplainable: it is the last plan repair produced, not the one that was planned
     * and not the one the reported failure came from.
     */
    repairAttempts: session.repairAttempts?.map((p) => ({
      installCommand: p.installCommand,
      startCommand: p.startCommand,
      expectedPort: p.expectedPort,
    })),
    aiNote: session.aiNote,
    /** Typed and evidenced, so what changed and why is readable rather than inferred. */
    repairs: session.repairs,
    /**
     * Every container this session ran, kept across retries — what it ran under and how
     * it ended — and a one-line summary per service. A run that took three tries says
     * which three and why, instead of showing only the last.
     */
    launchAttempts: session.launchAttempts,
    install: sessions?.installSummaries(session) ?? [],
    /**
     * Edits DevLaunch made to the clone, when DEVLAUNCH_REWRITE_SOURCE is set.
     *
     * Always surfaced. The whole argument for allowing a tool to change a repository at
     * all is that the change is small, named, and visible.
     */
    rewrites: session.rewrites,
    /**
     * Why a READY project will not work in a browser. Always sent, never a failure.
     *
     * A run can reach READY, publish two real URLs, serve a page, and have every
     * request that page makes refused. Withholding that leaves a dashboard that is
     * green about a project that does not work — which is worse than a failure,
     * because a failure at least sends somebody looking.
     */
    browserProblems: session.browserProblems,
    /** The routes the application declares, so an API's URL is not a blank 404. */
    routes: session.metadata?.httpRoutes,
    readiness: session.readiness,
    /** The end-to-end check READY waited for: every check, passed or not, with what it saw. */
    verification: session.verification,
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
        // What it was actually run with — the repaired plan when it was repaired, since
        // that is the one that produced the state beside it.
        plan: {
          installCommand: sv.plan.installCommand,
          buildCommand: sv.plan.buildCommand,
          startCommand: sv.plan.startCommand,
          workingDirectory: sv.plan.workingDirectory,
          runtime: `${sv.plan.runtime.language} ${sv.plan.runtime.version}`,
        },
      }),
    ),
    // From either path: a single service gets its database provisioned the same way a
    // project does, and a database running unannounced is the kind of thing a person
    // discovers in `docker ps` and cannot account for.
    backing: (session.run?.backing ?? session.backing?.runs)?.map(
      (db): BackingView => ({ kind: db.kind, alias: db.alias, ready: db.ready }),
    ),
  };
}

export function createApp(opts: AppOptions): Express {
  const app = express();
  // First, before anything reads the request: see `HostGuard` (audit A-10).
  app.use(hostGuard(allowedHosts(opts.allowedHosts ?? configuredHosts())));
  app.use(express.json({ limit: '64kb' }));

  // Prefer the built frontend; fall back to the plain harness page when it has not
  // been built, so the backend is never left serving nothing.
  const served = opts.staticDirs.find((dir) => existsSync(dir));
  if (served) app.use(express.static(served));

  /**
   * Liveness, and whether this process is running the code on disk.
   *
   * The second part is not decoration. A development server ran for five days here
   * while a fix landed twenty-nine minutes after it started, and every launch after
   * that was served by the old code — producing failures indistinguishable from real
   * ones. Nothing could have said so, because nothing knew what it was running.
   */
  app.get('/api/health', async (_req, res) => {
    // `ok` used to be the literal `true`, which is a liveness check pretending to be a
    // health check: it could not say "Docker is unreachable" or "the egress policy is
    // missing", and both happened during one afternoon's verification. A health endpoint
    // that cannot be unhealthy answers no question worth asking.
    const problems: string[] = [];

    if (opts.docker) {
      try {
        // Bounded, because the failure this reports includes a daemon that has wedged
        // without refusing. An unbounded `ping()` against one of those hangs the health
        // request — turning the endpoint that exists to say "Docker is broken" into
        // another thing that is broken.
        await withTimeout(opts.docker.ping(), 3000, 'ping timed out after 3s');
      } catch (err) {
        problems.push(
          `Docker is not reachable: ${err instanceof Error ? err.message : String(err)}. ` +
            'Nothing can be launched until it is.',
        );
      }
    }

    // A step that failed with nothing to catch it. Not `ok: false` — the process is
    // serving, and a past failure is not a present fault — but the first thing somebody
    // checks when a session stopped moving, so it has to be visible here.
    const errors = opts.recentErrors?.() ?? [];

    const egress = opts.egress?.();
    // `unknown` is not a problem. The probe is asynchronous and a health request that
    // arrives first should not report a fault that has not been established.
    if (egress?.verdict === 'absent') problems.push(egress.detail);

    res.json({
      ok: problems.length === 0,
      ...(problems.length > 0 ? { problems } : {}),
      sessions: opts.sessions.list().length,
      ...(egress ? { egress: egress.verdict } : {}),
      ...(errors.length > 0 ? { recentErrors: errors.slice(-5) } : {}),
      build: await buildStamp(opts.repoRoot ?? process.cwd()),
    });
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
        let repoUrl: string;
        let ref: string | undefined;

        // Rejected here, not four steps later inside the pipeline.
        //
        // The same check ran either way — `GitManager` has always refused a non-GitHub
        // host, a credentialed URL, plain http and an SSH remote. What it did not do is
        // refuse them *to the caller*: the route answered 201, a session was created,
        // and the rejection arrived asynchronously. So a typo looked accepted, and with
        // `maxSessions: 1` it held the only slot until it finished failing.
        //
        // Before the concurrency check, because a malformed URL is malformed whatever
        // else is running — "a session is already running" is the wrong answer to it.
        try {
          // A pasted `/tree/<branch>` URL carries its ref; an explicit `ref` wins over it.
          ({ repoUrl, ref } = splitRepoInput(body.repoUrl));
          if (typeof body.ref === 'string' && body.ref.trim() !== '') ref = normaliseRef(body.ref);
          normaliseRepoUrl(repoUrl);
        } catch (err) {
          if (err instanceof SecurityRejection) {
            res.status(400).json({ error: err.message, code: err.code });
            return;
          }
          throw err;
        }

        const session = await opts.sessions.launch({ repoUrl, ref, readinessTimeoutMs, replace: body.replace === true });
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
        replace: body.replace === true,
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
    res.json(present(session, opts.sessions));
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

    // Refused now rather than accepted and ignored: see `restartRefusal`.
    const refusal = opts.sessions.restartRefusal(session);
    if (refusal) {
      res.status(409).json({ error: refusal });
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

  registerDeploymentRoutes(app, { sessions: opts.sessions, fixturesDir: opts.fixturesDir });

  // Single-page app fallback: anything not an API route serves index.html, so a page
  // refresh does not 404.
  if (served) {
    app.get(/^\/(?!api\/|ws\/).*/, (_req, res) => {
      res.sendFile(resolve(served, 'index.html'));
    });
  }

  return app;
}
