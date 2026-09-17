import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createApp } from './api/app.js';
import { DockerManager } from './services/docker/DockerManager.js';
import { ExecutionManager } from './services/execution/ExecutionManager.js';
import { SessionManager } from './services/session/SessionManager.js';
import { GitManager } from './services/git/GitManager.js';
import { RepositoryAnalyzer } from './services/analysis/RepositoryAnalyzer.js';
import { RuleBasedPlanner } from './services/planning/RuleBasedPlanner.js';
import { LogSocketServer } from './websocket/LogSocketServer.js';
import { CleanupManager } from './services/cleanup/CleanupManager.js';

const HERE = dirname(fileURLToPath(import.meta.url));

export interface StartedServer {
  port: number;
  sessions: SessionManager;
  close: () => Promise<void>;
}

export async function startServer(port = 0): Promise<StartedServer> {
  const docker = new DockerManager();
  const exec = new ExecutionManager(docker);
  const analyzer = new RepositoryAnalyzer();
  const sessions = new SessionManager(exec, {
    git: new GitManager(),
    analyzer,
    planner: new RuleBasedPlanner(analyzer),
  });

  // Sweep before accepting traffic.
  //
  // Graceful shutdown cleans up its own containers, but a killed process (SIGKILL, a
  // crash, a supervisor tearing the server down) never runs it. Sweeping at startup is
  // what actually guarantees no container outlives the backend that created it, since
  // the label is only ever applied by DevLaunch.
  const swept = await CleanupManager.sweepOrphans(docker).catch(() => 0);
  if (swept > 0) console.log(`Removed ${swept} container(s) orphaned by a previous run.`);

  const app = createApp({
    sessions,
    fixturesDir: resolve(HERE, '../../../fixtures'),
    publicDir: resolve(HERE, '../public'),
  });

  const http = createServer(app);
  const sockets = new LogSocketServer(sessions);
  sockets.attach(http);

  await new Promise<void>((r) => http.listen(port, r));
  const actualPort = (http.address() as { port: number }).port;

  return {
    port: actualPort,
    sessions,
    close: async () => {
      sockets.close();
      await sessions.shutdown();
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
