import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FailureCode } from '@devlaunch/shared';
import { RepoDockerRunner, DockerSetupFailure, dockerProjectPlan } from '../services/docker/RepoDockerRunner.js';
import { LaunchStopped } from '../services/execution/ProjectExecutor.js';
import { LogManager } from '../services/logs/LogManager.js';
import type { DockerSetup } from '../services/docker/RepoDockerSetup.js';

/** The runner's own decisions, with Docker and the builder stood in for. */
function harness(opts: { pull?: (image: string) => Promise<void>; build?: (req: { signal?: AbortSignal }) => Promise<unknown> } = {}) {
  const calls: string[] = [];
  const held = new Map<string, number>();
  const exec = {
    docker: {
      pullImage: opts.pull ?? (async (i: string) => { calls.push(`pull:${i}`); }),
      ensureImage: async () => undefined,
      client: () => ({ getImage: () => ({ inspect: async () => ({ Config: { ExposedPorts: {} } }) }) }),
    },
    memory: { hold: (id: string, mb: number) => held.set(id, mb), release: (id: string) => held.delete(id) },
    launchImage: async () => { calls.push('launch'); throw new Error('not in these tests'); },
  };
  const sandbox = {
    memoryMb: 2048,
    build: opts.build ?? (async () => { calls.push('build'); return { ok: true, image: 'devlaunch-built/x-app:latest', timedOut: false, durationMs: 1 }; }),
    remove: async (i: string) => { calls.push(`remove:${i}`); },
  };
  return { runner: new RepoDockerRunner(exec as never, sandbox as never), calls, held };
}

function repo(dockerfile: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'devlaunch-runner-'));
  writeFileSync(join(dir, 'Dockerfile'), dockerfile);
  return dir;
}
const built = (): DockerSetup => ({ source: 'dockerfile', file: 'Dockerfile', warnings: [], services: [{ name: 'app', build: { context: '.', dockerfile: 'Dockerfile', args: {} }, ports: [8080], environment: {}, dependsOn: [], dataPaths: [], role: 'web' }] });
const stock = (image: string): DockerSetup => ({ source: 'compose', file: 'compose.yaml', warnings: [], services: [{ name: 'db', image, ports: [5432], environment: {}, dependsOn: [], dataPaths: [], role: 'database' }] });
const launch = (runner: RepoDockerRunner, setup: DockerSetup, sourceDir: string, stopped?: () => boolean) =>
  runner.launch({ sessionId: 's-1', setup, project: dockerProjectPlan(setup), sourceDir, logs: new LogManager(), ...(stopped ? { stopped } : {}) });

describe('what the runner refuses before Docker fetches anything (verifier D-1, D-11)', () => {
  it('refuses a Dockerfile whose ADD the daemon would download itself, and builds nothing', async () => {
    const { runner, calls } = harness();
    const err = await launch(runner, built(), repo('FROM alpine\nADD http://169.254.169.254/latest/ /m\n')).catch((e) => e);
    expect(err).toBeInstanceOf(DockerSetupFailure);
    expect((err as DockerSetupFailure).failure.code).toBe(FailureCode.PLAN_REJECTED_UNSAFE_COMMAND);
    expect((err as DockerSetupFailure).failure.message).toMatch(/ADD http:\/\/169\.254\.169\.254/);
    expect(calls).not.toContain('build');
  });

  it("refuses DevLaunch's own images by name", async () => {
    const { runner, calls } = harness();
    const err = await launch(runner, stock('devlaunch-built/other-run-app:latest'), repo('FROM alpine\n')).catch((e) => e);
    expect((err as DockerSetupFailure).failure.message).toMatch(/one of DevLaunch's own images/);
    expect(calls.filter((c) => c.startsWith('pull'))).toEqual([]);
  });

  it('pulls a compose image fresh, and refuses one that exists only on this machine', async () => {
    const { runner } = harness({ pull: async () => { throw new Error('pull access denied for stockwatch, repository does not exist'); } });
    const err = await launch(runner, stock('stockwatch:test'), repo('FROM alpine\n')).catch((e) => e);
    expect((err as DockerSetupFailure).failure.code).toBe(FailureCode.UNSUPPORTED_PROJECT);
    expect((err as DockerSetupFailure).failure.message).toMatch(/exists only on this machine is not used/);
  });

  it('calls a failed pull on the network a network failure, not a missing image', async () => {
    const { runner } = harness({ pull: async () => { throw new Error('Get "https://registry-1.docker.io/v2/": dial tcp: lookup registry-1.docker.io: i/o timeout'); } });
    const err = await launch(runner, stock('postgres:16'), repo('FROM alpine\n')).catch((e) => e);
    expect((err as DockerSetupFailure).failure.code).toBe(FailureCode.NETWORK_FAILURE);
  });
});

describe('a stop during a build (verifier D-3)', () => {
  it('stops the build, releases its memory, and removes what it made', async () => {
    let stop = false;
    const { runner, calls, held } = harness({
      build: (req) => new Promise((resolve) => {
        calls.push('build');
        setTimeout(() => { stop = true; }, 20);
        req.signal?.addEventListener('abort', () => resolve({ ok: false, image: 'devlaunch-built/s-1-app:latest', timedOut: false, durationMs: 1 }));
      }),
    });
    let heldDuring = 0;
    const timer = setInterval(() => { heldDuring = Math.max(heldDuring, [...held.values()].reduce((a, b) => a + b, 0)); }, 5);
    const err = await launch(runner, built(), repo('FROM alpine\n'), () => stop).catch((e) => e);
    clearInterval(timer);
    expect(err).toBeInstanceOf(LaunchStopped);
    expect(heldDuring, 'the build was counted against the VM').toBe(2048);
    expect(held.size, 'and released').toBe(0);
    expect(calls).toContain('remove:devlaunch-built/s-1-app:latest');
    expect(calls).not.toContain('launch');
  }, 10_000);
});
