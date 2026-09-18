import type Dockerode from 'dockerode';
import type { BackingService } from '@devlaunch/shared';
import { config } from '../../config/index.js';
import { buildLabels } from '../docker/ContainerSecurity.js';
import { BACKING_SPECS, connectionEnv, connectionUrl, databaseName } from './BackingServices.js';
import type { ExecutionManager } from './ExecutionManager.js';

/**
 * Start the databases a repository expects, and say how to reach them.
 *
 * This lives apart from the project executor because it is not a multi-service concern
 * and never was. A single-service repository needs a database exactly as much as a
 * four-service one does — more often, in fact, since a lone API with a database is the
 * commonest shape there is. While this logic sat inside the project path, those
 * repositories got nothing: the analyzer detected Postgres, reported it, and the run
 * started anyway with no server and no connection string. What filled the gap was the
 * repair loop inventing `postgresql://user:pass@db:5432/dbname` — a host that does not
 * exist, credentials that were never real — and then spending two further attempts
 * installing drivers to satisfy a URL that could never have connected.
 */

/** Just enough of a log to write to, so either kind of caller can pass its own. */
export interface LogSink {
  write(stream: 'stdout' | 'stderr', line: string): void;
}

export interface BackingRun {
  kind: BackingService['kind'];
  alias: string;
  container: Dockerode.Container;
  ready: boolean;
}

export interface ProvisionResult {
  runs: BackingRun[];
  /** Connection variables to merge into the application's environment. */
  injected: { key: string; value: string; required: boolean }[];
  /** Stop and remove every container this started. Safe to call more than once. */
  cleanup(): Promise<Error[]>;
}

export class BackingProvisioner {
  constructor(private readonly exec: ExecutionManager) {}

  /**
   * Start every requested service and wait for each to accept connections.
   *
   * Waiting is the point. Applications connect at boot and most do not retry — the
   * repository that prompted this exits with "MongoDB connection error" rather than
   * backing off — so returning before a database answers is a race the application
   * loses, and loses in a way that reads like the application being broken.
   */
  async provision(opts: {
    sessionId: string;
    backing: readonly BackingService[];
    repoName?: string;
    logs: LogSink;
  }): Promise<ProvisionResult> {
    const database = databaseName(opts.repoName);
    const runs: BackingRun[] = [];

    const cleanup = async (): Promise<Error[]> => {
      const errors: Error[] = [];
      // Every container is released even if an earlier one refuses, so a half-cleaned
      // run does not leave a database alive with nothing tracking it.
      while (runs.length) {
        const db = runs.pop()!;
        try {
          await this.exec.docker.stop(db.container);
          await this.exec.docker.remove(db.container);
        } catch (err) {
          errors.push(err instanceof Error ? err : new Error(String(err)));
        }
      }
      return errors;
    };

    try {
      for (const need of opts.backing) {
        const run = await this.startOne(opts.sessionId, need, database, opts.logs);
        if (run) runs.push(run);
      }
    } catch (err) {
      await cleanup();
      throw err;
    }

    const injected = connectionEnv([...opts.backing], database);
    if (injected.length) {
      opts.logs.write(
        'stdout',
        `Provisioned ${runs.map((b) => b.kind).join(', ')}; ` +
          `injected ${injected.map((v) => v.key).join(', ')}.`,
      );
    }

    return { runs, injected, cleanup };
  }

  private async startOne(
    sessionId: string,
    need: BackingService,
    database: string,
    logs: LogSink,
  ): Promise<BackingRun | null> {
    const spec = BACKING_SPECS[need.kind];
    if (!spec) return null;

    const docker = this.exec.docker;
    logs.write('stdout', `Starting ${need.kind} (${need.evidence}) as ${spec.alias}...`);
    await docker.ensureImage(spec.image);

    const networkName = (await docker.networkExists(config.docker.networkName))
      ? config.docker.networkName
      : undefined;

    const container = await docker.createBackingContainer({
      image: spec.image,
      alias: spec.alias,
      user: spec.user,
      env: spec.env(database),
      labels: buildLabels(sessionId),
      dataPaths: spec.dataPaths,
      networkName,
    });

    await docker.start(container);
    const ready = await this.waitForReady(docker, container, spec.readyCheck);

    if (!ready) {
      logs.write('stderr', `${need.kind} did not become ready; the project will fail.`);
    } else {
      logs.write('stdout', `${need.kind} is accepting connections at ${connectionUrl(need, database)}`);
    }
    return { kind: need.kind, alias: spec.alias, container, ready };
  }

  /** Poll the image's own health command until it succeeds, or the budget runs out. */
  private async waitForReady(
    docker: ExecutionManager['docker'],
    container: Dockerode.Container,
    check: string[],
    timeoutMs = config.timeouts.backingReadyMs,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const out = await docker.execCapture(container, check);
        // Every one of these commands prints something recognisable on success and
        // fails or stays silent otherwise.
        if (/\b(1|PONG|accepting connections|mysqld is alive)\b/i.test(out)) return true;
      } catch {
        /* not up yet; the loop is the retry */
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }
}
