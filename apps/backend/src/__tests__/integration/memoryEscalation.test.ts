import { describe, it, expect, beforeAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ExecutionState, FailureCode } from '@devlaunch/shared';
import { DockerManager } from '../../services/docker/DockerManager.js';
import { ExecutionManager } from '../../services/execution/ExecutionManager.js';
import { SessionManager } from '../../services/session/SessionManager.js';
import { RepositoryAnalyzer } from '../../services/analysis/RepositoryAnalyzer.js';
import { RuleBasedPlanner } from '../../services/planning/RuleBasedPlanner.js';
import { ProjectPlanner } from '../../services/planning/ProjectPlanner.js';
import { config } from '../../config/index.js';

/**
 * A real out-of-memory kill, against real Docker, recovered by the memory policy.
 *
 * `node-install-oom` needs about 1.4 GB to install. At the initial 1024 MB the kernel kills
 * it — Docker reports OOMKilled while the wrapper exits 110 — and the session must raise
 * the limit, recreate the container cleanly, and reach READY at the next step.
 */
const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../fixtures');
const docker = new DockerManager();

describe('an install that needs more than the initial memory limit', () => {
  beforeAll(async () => {
    await docker.ping();
    await docker.ensureImage('devlaunch/node:20');
  }, 300_000);

  it('is killed at 1024 MB, raised to 2048 MB, and served', async () => {
    const exec = new ExecutionManager(docker);
    const analyzer = new RepositoryAnalyzer();
    const planner = new RuleBasedPlanner(analyzer);
    const sessions = new SessionManager(exec, { analyzer, planner, projectPlanner: new ProjectPlanner(analyzer, planner) });
    const s = await sessions.launch({ sourceDir: `${FIXTURES}/node-install-oom` });

    for (let i = 0; i < 600 && ![ExecutionState.READY, ExecutionState.FAILED].includes(s.state as never); i++) {
      await new Promise((r) => setTimeout(r, 500));
    }
    const log = s.logs.buffer.all().map((l) => l.text).join('\n');
    try {
      expect(s.state, log.slice(-3000)).toBe(ExecutionState.READY);
      expect(s.launchAttempts?.map((a) => [a.memoryMb, a.result])).toEqual([
        [1024, FailureCode.OUT_OF_MEMORY],
        [2048, 'ok'],
      ]);
      // Detected by the kernel's own flag, not by reading the word "Killed".
      expect(s.launchAttempts?.[0]?.detectedBy?.[0]).toBe('docker: OOMKilled');
      expect(s.repairs?.[0]).toMatchObject({ type: 'MEMORY_LIMIT_RAISED', before: { memoryMb: 1024 }, after: { memoryMb: 2048 } });
      expect(log).toMatch(/\[install\] Increasing memory: 1024 MB → 2048 MB/);
      expect(log).toMatch(/install step held 1400 MB and finished/);
      // The failed attempt's container is already gone: only the serving one holds memory.
      expect(exec.memory.heldMb()).toBe(2048);
    } finally {
      await sessions.shutdown();
    }
    // And after teardown, nothing is held and nothing is left.
    expect(exec.memory.heldMb()).toBe(0);
    const left = (await docker.listManaged('all')).filter((c) => c.Labels?.[config.docker.sessionLabel] === s.id);
    expect(left).toEqual([]);
  }, 600_000);
});
