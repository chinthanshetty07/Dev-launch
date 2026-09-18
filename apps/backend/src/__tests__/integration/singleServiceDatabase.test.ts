import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ExecutionState } from '@devlaunch/shared';
import { DockerManager } from '../../services/docker/DockerManager.js';
import { ExecutionManager } from '../../services/execution/ExecutionManager.js';
import { SessionManager } from '../../services/session/SessionManager.js';
import { RepositoryAnalyzer } from '../../services/analysis/RepositoryAnalyzer.js';
import { RuleBasedPlanner } from '../../services/planning/RuleBasedPlanner.js';
import { ProjectPlanner } from '../../services/planning/ProjectPlanner.js';
import { CleanupManager } from '../../services/cleanup/CleanupManager.js';

/**
 * One service, one database, against real Docker.
 *
 * This is the shape the project path never covered: a lone API that needs a database it
 * does not contain. Detection always worked — the analyzer reported Postgres — but
 * provisioning ran only for multi-service projects, so a repository like this started
 * with no server and no connection string, failed on its first query, and handed the
 * repair loop a problem it could only guess at. It guessed at an invented connection
 * string, then at a driver to satisfy it, then at nothing that could ever have worked.
 */

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../fixtures');
const docker = new DockerManager();
const analyzer = new RepositoryAnalyzer();
const created: SessionManager[] = [];

function newManager(): SessionManager {
  const planner = new RuleBasedPlanner(analyzer);
  const mgr = new SessionManager(new ExecutionManager(docker), {
    analyzer,
    planner,
    projectPlanner: new ProjectPlanner(analyzer, planner),
  });
  created.push(mgr);
  return mgr;
}

async function until(
  sessions: SessionManager,
  id: string,
  states: ExecutionState[],
  timeoutMs = 300_000,
): Promise<ExecutionState> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = sessions.get(id);
    if (s && states.includes(s.state)) return s.state;
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for ${states.join('/')}; session is ${s?.state} ` +
          `(${JSON.stringify(s?.failure)})\n` +
          sessions.get(id)?.logs.buffer.all().slice(-40).map((l) => l.text).join('\n'),
      );
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

describe('a single service that needs a database', () => {
  beforeAll(async () => {
    await docker.ping();
    await docker.ensureImage('devlaunch/python:3.12');
    await docker.ensureImage('postgres:16');
  }, 600_000);

  afterAll(async () => {
    for (const mgr of created) await mgr.shutdown();
    await CleanupManager.sweepOrphans(docker);
  }, 180_000);

  it('starts Postgres for it and serves a real query through an async driver', async () => {
    const sessions = newManager();
    const s = await sessions.launch({ sourceDir: `${FIXTURES}/python-async-postgres` });

    const state = await until(sessions, s.id, [ExecutionState.READY, ExecutionState.FAILED]);
    const session = sessions.get(s.id)!;
    expect(
      state,
      `logs:\n${session.logs.buffer.all().slice(-30).map((l) => l.text).join('\n')}`,
    ).toBe(ExecutionState.READY);

    // The connection string names the driver the repository declared. Without the
    // dialect, SQLAlchemy loads psycopg2 and refuses — against a database that is up.
    const url = session.plan?.environmentVariables.find((v) => v.key === 'DATABASE_URL')?.value;
    expect(url).toMatch(/^postgresql\+asyncpg:\/\//);

    // The application answering is not the claim. The claim is that a query reached a
    // real server and came back, which is the only thing this fixture reports.
    const res = await fetch(session.url!);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ database: 'reachable', value: 1 });

    // And the database is visible to the dashboard as something DevLaunch provisioned,
    // rather than as an unexplained container.
    expect(session.backing?.runs.map((r) => r.kind)).toEqual(['postgres']);
    expect(session.backing?.runs[0]?.ready).toBe(true);
  }, 600_000);
});
