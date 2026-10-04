// First, before any module that reads a setting: see loadEnv.ts.
import './loadEnv.js';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createApp } from './api/app.js';
import { recordRunningCommit } from './services/build/BuildStamp.js';
import { DockerManager } from './services/docker/DockerManager.js';
import { ExecutionManager } from './services/execution/ExecutionManager.js';
import { SessionManager } from './services/session/SessionManager.js';
import { FileHints } from './services/execution/MemoryHints.js';
import { FileDeploymentStore } from './services/session/DeploymentStore.js';
import { GitManager } from './services/git/GitManager.js';
import { RepositoryAnalyzer } from './services/analysis/RepositoryAnalyzer.js';
import { RuleBasedPlanner } from './services/planning/RuleBasedPlanner.js';
import { ProjectPlanner } from './services/planning/ProjectPlanner.js';
import { GroqProvider } from './services/ai/GroqProvider.js';
import { AIPlanner } from './services/ai/AIPlanner.js';
import { AIRepair } from './services/ai/AIRepair.js';
import { LogSocketServer } from './websocket/LogSocketServer.js';
import { CleanupManager } from './services/cleanup/CleanupManager.js';
import { probeEgress, type ProbeResult } from './services/security/EgressProbe.js';

/** How stale an egress verdict may be before reading it triggers a fresh probe. */
const EGRESS_RECHECK_MS = 5 * 60 * 1000;

const HERE = dirname(fileURLToPath(import.meta.url));


/**
 * The address the HTTP API and the log socket listen on.
 *
 * Loopback by default, and that is a security boundary rather than a preference.
 * DevLaunch has no authentication — deliberately, because it is a single-user local
 * tool — and `POST /api/sessions` clones a URL and executes its contents. Those two
 * facts are only compatible while the port is unreachable from anywhere else.
 *
 * It was not. `http.listen(port)` with no host binds `::`, so the API answered on this
 * machine's LAN address; a verification confirmed `curl http://192.168.0.2:3939` → 200.
 * On a shared network that is unauthenticated remote code execution, and the log socket
 * shares the listener, so it streamed the output of whatever was running too.
 *
 * `DEVLAUNCH_HOST` widens it for the cases that need it — a devcontainer, a VM, a remote
 * workstation — and startup says so out loud, because anything reachable beyond this
 * machine wants authentication and there is none to turn on.
 *
 * Deliberately **not** in `config/index.ts`, unlike every other setting. That module is
 * a frozen object evaluated when it is first imported, which happens before
 * `loadDotEnv()` runs in `startServer` — so a value read there honours a real exported
 * variable but silently ignores the same line in `.env`. For a security default that
 * asymmetry is a trap, so this reads the environment when it is asked, exactly as
 * `GroqProvider.isConfigured()` does.
 *
 * (Since 2026-10-04 `.env` is loaded before any module is evaluated — `loadEnv.ts` is
 * this file's first import — so the trap is closed at its source. Reading at call time
 * stays: it is still the simplest thing that is obviously right.)
 */
export function bindHost(env: NodeJS.ProcessEnv = process.env): string {
  const requested = env.DEVLAUNCH_HOST?.trim();
  return requested ? requested : '127.0.0.1';
}

/**
 * How long an unused package cache is kept, in milliseconds. Zero disables the reaper.
 *
 * Read here rather than from `config/index.ts` for the same reason `bindHost` is, and
 * for a second one. The first: that module is evaluated before `loadDotEnv()`, so a
 * value read there honours an exported shell variable and silently ignores the same line
 * in `.env` — an `await import()` does not help, because the module was already loaded
 * transitively by then. The second: `intEnv` treats any value `<= 0` as absent and
 * substitutes the default, so a documented "zero disables it" would have quietly meant
 * fourteen days. A knob that does nothing is worse than no knob.
 */
export function cacheMaxAgeMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.DEVLAUNCH_CACHE_MAX_AGE_DAYS?.trim();
  if (raw === undefined || raw === '') return 14 * 24 * 60 * 60 * 1000;
  const days = Number.parseInt(raw, 10);
  // Unparseable is not a request for anything; fall back rather than guess.
  if (!Number.isFinite(days) || days < 0) return 14 * 24 * 60 * 60 * 1000;
  return days * 24 * 60 * 60 * 1000;
}

/** Whether an address reaches only this machine. `0.0.0.0` and `::` reach everything. */
export function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

/**
 * Record a rejection nothing caught, and make it readable afterwards.
 *
 * The pipeline is a long `void`-ed async chain — `void this.run(session, req)` and its
 * kin — so a throw outside a `try` is an unhandled rejection, and a session simply stops
 * advancing with nothing to say why.
 *
 * The first version of this was worse than nothing. Installing an `unhandledRejection`
 * listener **suppresses Node's default**, which on Node ≥15 is to print the stack and
 * exit; replacing that with a single `console.error` to stdout made a crash quieter
 * rather than more durable, and called it "recorded". That is the opposite of the
 * requirement.
 *
 * So the trade is made explicitly and the process keeps running, because killing a local
 * tool takes every other session's containers and logs with it — but the reason is kept
 * somewhere a person will actually look: stderr, and `/api/health`, which is the first
 * thing anyone checks when a session stops moving. Bounded, because this is a leak
 * otherwise, and the most recent failures are the ones being investigated.
 */
const recentErrors: { at: number; detail: string }[] = [];
const MAX_RECORDED_ERRORS = 20;

export function recordedErrors(): { at: number; detail: string }[] {
  return [...recentErrors];
}

/** Exported for tests; the handler itself is installed once per process. */
export function recordUnhandled(reason: unknown): void {
  const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  recentErrors.push({ at: Date.now(), detail: detail.slice(0, 2000) });
  if (recentErrors.length > MAX_RECORDED_ERRORS) recentErrors.shift();
  console.error(`Unhandled rejection — a step failed with nothing to catch it:\n${detail}`);
}

let rejectionHandlerInstalled = false;
export function installRejectionHandler(): void {
  if (rejectionHandlerInstalled) return;
  rejectionHandlerInstalled = true;
  process.on('unhandledRejection', recordUnhandled);
}

export interface StartedServer {
  port: number;
  sessions: SessionManager;
  close: () => Promise<void>;
}

export interface ServerOptions {
  /** Overrides the bind address. Exists so a test can pin it without the environment. */
  host?: string;
  /**
   * Force the AI fallback off even when a key is configured.
   *
   * A repairable failure costs two live model calls, so any test that provokes one
   * inherits an external, rate-limited service's latency and output. Tests that are not
   * about AI turn it off and stay deterministic; the default is unchanged.
   */
  ai?: boolean;
}

export async function startServer(port = 0, opts: ServerOptions = {}): Promise<StartedServer> {
  installRejectionHandler();

  const docker = new DockerManager();
  const exec = new ExecutionManager(docker);
  const analyzer = new RepositoryAnalyzer();

  // AI is opt-in. Without a key DevLaunch plans deterministically and reports
  // UNSUPPORTED_PROJECT for anything its detectors do not recognise — which is the
  // shipped v1 behaviour, not a degraded mode.
  const aiEnabled = opts.ai !== false && GroqProvider.isConfigured();
  const provider = aiEnabled ? new GroqProvider() : undefined;
  if (aiEnabled) {
    console.log(`AI fallback enabled via ${provider!.name} (${process.env.GROQ_MODEL ?? 'default model'})`);
  } else {
    console.log('AI fallback disabled (no GROQ_API_KEY); planning is fully deterministic.');
  }

  const planner = new RuleBasedPlanner(analyzer);
  const sessions = new SessionManager(exec, {
    git: new GitManager(),
    analyzer,
    planner,
    projectPlanner: new ProjectPlanner(analyzer, planner),
    aiPlanner: provider ? new AIPlanner(provider) : undefined,
    aiRepair: provider ? new AIRepair(provider) : undefined,
    // What each repository needed last time, so its next run starts there.
    memoryHints: FileHints.fromEnv(),
    // Each deployment's record, so a restart does not erase what ran and why.
    deploymentStore: FileDeploymentStore.fromEnv(),
    // READY only on evidence: the end-to-end check runs before it is declared.
    smokeTest: true,
  });

  // Sweep before accepting traffic.
  //
  // Graceful shutdown cleans up its own containers, but a killed process (SIGKILL, a
  // crash, a supervisor tearing the server down) never runs it. Sweeping at startup is
  // what actually guarantees no container outlives the backend that created it, since
  // the label is only ever applied by DevLaunch.
  // Startup is the one safe moment for a global sweep: a crashed process leaves
  // containers nothing will claim, and this process is not yet running anything.
  const swept = await CleanupManager.sweepAllOrphans(docker).catch(() => 0);
  if (swept > 0) console.log(`Removed ${swept} container(s) orphaned by a previous run.`);
  // Their deployments' records still claim to be running: say what happened to them.
  const interrupted = await sessions.recoverInterrupted().catch(() => 0);
  if (interrupted > 0) console.log(`Marked ${interrupted} deployment(s) interrupted by the last restart.`);

  // Volumes too, which nothing reaped until 99 of them had accumulated. Same moment and
  // the same reasoning as the container sweep: at startup nothing here is mid-run.
  const maxAge = cacheMaxAgeMs();
  const reaped = await CleanupManager.sweepStaleCaches(docker, maxAge).catch(() => 0);
  if (reaped > 0) {
    const days = Math.round(maxAge / (24 * 60 * 60 * 1000));
    console.log(`Removed ${reaped} package cache(s) unused for more than ${days} day(s).`);
  }

  // Whether the egress policy is actually in force. Kicked off here and awaited nowhere:
  // it starts a container, and a self-check that delays the port is a self-check nobody
  // keeps. The verdict lands on `/api/health` when it arrives.
  let egress: ProbeResult = { verdict: 'unknown', detail: 'The egress policy has not been checked yet.' };
  let egressCheckedAt = 0;
  let probing = false;

  // Re-checked, not checked once.
  //
  // The whole premise of this finding is that the rules vanish on `colima restart` —
  // which happens while the server is running. A verdict taken at startup and kept for
  // ever would report `enforced` right through the window it exists to catch.
  const refreshEgress = (): void => {
    if (probing || Date.now() - egressCheckedAt < EGRESS_RECHECK_MS) return;
    probing = true;
    void probeEgress(docker, 'devlaunch/node:20')
      .then((result) => {
        const changed = result.verdict !== egress.verdict;
        egress = result;
        egressCheckedAt = Date.now();
        if (result.verdict === 'absent' && changed) console.warn(`WARNING: ${result.detail}`);
      })
      .catch(() => undefined)
      .finally(() => {
        probing = false;
      });
  };
  refreshEgress();

  // Before anything can serve a request, so the commit reported is the one this
  // process actually started from rather than whatever the tree drifts to later.
  const repoRoot = resolve(HERE, '../../..');
  await recordRunningCommit(repoRoot);

  const app = createApp({
    sessions,
    repoRoot,
    docker,
    recentErrors: recordedErrors,
    egress: () => {
      // Reading the verdict is what schedules the next check. Nothing polls on a timer:
      // a probe runs a container, and one running every five minutes for ever on a
      // laptop nobody is looking at is a cost with no reader.
      refreshEgress();
      return egress;
    },
    fixturesDir: resolve(HERE, '../../../fixtures'),
    staticDirs: [
      resolve(HERE, '../../frontend/dist'),
      resolve(HERE, '../public'),
    ],
  });

  const http = createServer(app);
  const sockets = new LogSocketServer(sessions);
  sockets.attach(http);

  // The host is as load-bearing as the port. See `bindHost`.
  const host = opts.host ?? bindHost();
  await new Promise<void>((r) => http.listen(port, host, r));
  const actualPort = (http.address() as { port: number }).port;

  if (!isLoopback(host)) {
    console.warn(
      `WARNING: listening on ${host}:${actualPort}, which is reachable beyond this ` +
        'machine. DevLaunch has no authentication, and POST /api/sessions clones a URL ' +
        'and runs its contents. Unset DEVLAUNCH_HOST unless you meant this.',
    );
  }

  return {
    port: actualPort,
    sessions,
    close: async () => {
      sockets.close();
      await sessions.shutdown();
      await sessions.flushRecords();
      // A crashed or killed backend can still leave containers behind.
      await CleanupManager.sweepOrphans(docker).catch(() => 0);
      await new Promise<void>((r) => http.close(() => r()));
    },
  };
}

// Only start listening when executed directly, so tests can import this module.
//
// pathToFileURL is required rather than string concatenation: a path containing a
// space (this project lives in "Dev Launch") percent-encodes in import.meta.url, so a
// naive `file://${argv[1]}` never matches and the server exits silently with code 0.
const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  const port = Number(process.env.PORT ?? 3939);
  startServer(port)
    .then((started) => {
      console.log(`DevLaunch backend listening on http://localhost:${started.port}`);

      // Handles Ctrl-C and ordinary supervisor stops. SIGKILL cannot be caught by
      // anything, which is why the startup sweep above exists as the real guarantee.
      let closing = false;
      for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        process.on(signal, () => {
          if (closing) return;
          closing = true;
          console.log(`\nReceived ${signal}, cleaning up...`);
          started
            .close()
            .then(() => process.exit(0))
            .catch(() => process.exit(1));
        });
      }
    })
    .catch((err) => {
      console.error('Failed to start:', err);
      process.exit(1);
    });
}
