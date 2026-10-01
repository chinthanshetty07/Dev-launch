import type Dockerode from 'dockerode';
import type { BackingService } from '@devlaunch/shared';
import { config } from '../../config/index.js';
import { buildLabels } from '../docker/ContainerSecurity.js';
import {
  BACKING_SPECS,
  connectionEnv,
  connectionUrl,
  databaseName,
  isBackingImageApproved,
} from './BackingServices.js';
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
    /** Overridable so a database that never starts can be tested without waiting 90s. */
    readyMs?: number;
  }): Promise<ProvisionResult> {
    // The name the repository expects, when its compose file states one. A connection
    // string DevLaunch invents points at a database the application's own migrations
    // and fixtures know nothing about.
    const database = opts.backing.find((b) => b.database)?.database ?? databaseName(opts.repoName);
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
          this.exec.memory?.release(db.container.id);
        } catch (err) {
          errors.push(err instanceof Error ? err : new Error(String(err)));
        }
      }
      return errors;
    };

    try {
      for (const need of opts.backing) {
        const run = await this.startOne(opts.sessionId, need, database, opts.logs, opts.readyMs);
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
    readyMs?: number,
  ): Promise<BackingRun | null> {
    const spec = BACKING_SPECS[need.kind];
    if (!spec) return null;

    const docker = this.exec.docker;

    // The repository may name a variant of the kind already detected, and nothing else.
    // Declining an unrecognised name falls back to the stock image, which is the
    // behaviour from before compose files were read — a degradation, not a trust.
    let image = spec.image;
    if (need.image && need.image !== spec.image) {
      if (isBackingImageApproved(need.image, need.kind)) {
        image = need.image;
      } else {
        logs.write(
          'stderr',
          `Ignoring the ${need.kind} image the repository names (${need.image}); it is ` +
            `not an approved variant. Using ${spec.image}.`,
        );
      }
    }

    const networkName = (await docker.networkExists(config.docker.networkName))
      ? config.docker.networkName
      : undefined;

    const attempt = async (from: string): Promise<BackingRun> => {
      logs.write('stdout', `Starting ${need.kind} (${need.evidence}) as ${spec.alias} from ${from}...`);
      await docker.ensureImage(from);
      const container = await docker.createBackingContainer({
        image: from,
        alias: spec.alias,
        user: spec.user,
        env: spec.env(database),
        labels: buildLabels(sessionId),
        dataPaths: spec.dataPaths,
        networkName,
      });
      // A database's limit counts against the VM like an application's does, so a memory
      // escalation beside it cannot promise the machine more than it has.
      this.exec.memory?.hold(container.id, config.container.memoryMb, () => this.exec.usageMb(container));
      await docker.start(container);
      const ready = await this.waitForReady(docker, container, spec.readyCheck, readyMs);
      return { kind: need.kind, alias: spec.alias, container, ready };
    };

    let run = await attempt(image);

    // A tag the repository named is a preference, not a promise that it runs here.
    //
    // The approval check reads the repository name and adopts whatever tag follows,
    // which is how one compose file's `postgres:15.1-alpine` was started under the
    // hardening profile the runner images get — non-root, read-only rootfs, all
    // capabilities dropped — where its entrypoint chmods the data directory and exits 1.
    // The application then started, was handed a connection string, and failed with
    // `could not translate host name "postgres"`, because the alias belonged to a
    // container that no longer existed. Neither message named the cause.
    //
    // The image DevLaunch ships is verified against that profile, so falling back to it
    // is the one thing known to work. Once, and said out loud: a repository asking for
    // pgvector and quietly getting plain Postgres would fail later on its first
    // `CREATE EXTENSION`, and it deserves to know which it got.
    if (!run.ready && image !== spec.image) {
      const why = await docker.logTail(run.container, 12);
      logs.write(
        'stderr',
        `${image} did not start under the sandbox profile${why ? `: ${lastLineOf(why)}` : '.'}`,
      );
      logs.write('stdout', `Falling back to ${spec.image}, which DevLaunch verifies against it.`);
      try {
        await docker.stop(run.container);
        await docker.remove(run.container);
        this.exec.memory?.release(run.container.id);
      } catch {
        /* a container that will not release must not block the replacement */
      }
      run = await attempt(spec.image);
    }

    if (!run.ready) {
      const why = await docker.logTail(run.container, 12);
      logs.write(
        'stderr',
        `${need.kind} did not become ready; the project will fail${why ? `. It said: ${lastLineOf(why)}` : '.'}`,
      );
    } else {
      logs.write('stdout', `${need.kind} is accepting connections at ${connectionUrl(need, database)}`);
    }
    return run;
  }

  /**
   * Poll the image's own health command until it succeeds, the container stops, or the
   * budget runs out.
   *
   * A container that has stopped will not become ready, however long it is polled. It
   * used to be polled anyway: `postgres:15.1-alpine`, named by a compose file, exits under
   * the sandbox profile within two seconds, and the health command was retried against the
   * dead container for the whole 90-second budget before the fallback image — ready 1.6
   * seconds after it started — was tried. Measured on `testdrivenio/fastapi-crud-sync`:
   * 92 of its 107 seconds. A database still starting is running, and keeps its budget.
   */
  private async waitForReady(
    docker: ExecutionManager['docker'],
    container: Dockerode.Container,
    check: string[],
    timeoutMs = config.timeouts.backingReadyMs,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.hasStopped(docker, container)) return false;
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

  /** Whether Docker says the container is no longer running. Unknown counts as running. */
  private async hasStopped(docker: ExecutionManager['docker'], container: Dockerode.Container): Promise<boolean> {
    try {
      const info = await docker.inspect(container);
      return info.State?.Running === false;
    } catch (err) {
      return (err as { statusCode?: number }).statusCode === 404;
    }
  }
}

/** The last non-empty line of a log tail — the reason, where a stack of them is noise. */
function lastLineOf(text: string): string {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  return (lines[lines.length - 1] ?? '').slice(0, 200);
}
