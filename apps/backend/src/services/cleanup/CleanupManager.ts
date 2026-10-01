import type Dockerode from 'dockerode';
import { rm } from 'node:fs/promises';
import type { DockerManager } from '../docker/DockerManager.js';

/**
 * Cleanup must run even when commands fail, readiness fails, or a timeout fires.
 *
 * Registered resources are released in reverse order, and a failure releasing one
 * never prevents the rest — a leaked container is worse than a lost error message.
 */
export class CleanupManager {
  private containers: Dockerode.Container[] = [];
  private paths: string[] = [];
  private done = false;

  constructor(private readonly docker: DockerManager) {}

  trackContainer(container: Dockerode.Container): void {
    this.containers.push(container);
  }

  trackPath(path: string): void {
    this.paths.push(path);
  }

  /** Idempotent: safe to call from both the happy path and a catch block. */
  async cleanup(): Promise<{ errors: Error[] }> {
    if (this.done) return { errors: [] };
    this.done = true;
    const errors: Error[] = [];

    for (const container of [...this.containers].reverse()) {
      try {
        await this.docker.stop(container);
        await this.docker.remove(container);
      } catch (err) {
        errors.push(err instanceof Error ? err : new Error(String(err)));
      }
    }
    this.containers = [];

    for (const path of [...this.paths].reverse()) {
      try {
        await rm(path, { recursive: true, force: true });
      } catch (err) {
        errors.push(err instanceof Error ? err : new Error(String(err)));
      }
    }
    this.paths = [];

    return { errors };
  }

  /**
   * Remove containers this process created and has not released.
   *
   * Deliberately scoped to the current instance. Sweeping every container carrying the
   * managed label removed containers belonging to *other live* DevLaunch processes —
   * a developer running the server in one terminal and the test suite in another had
   * working sessions destroyed mid-run, and the session kept reporting READY against a
   * URL that no longer existed.
   *
   * Containers from genuinely dead processes are handled by `sweepAllOrphans`, which is
   * called only at startup, when no other instance of ours can be mid-run.
   */
  static async sweepOrphans(docker: DockerManager): Promise<number> {
    return CleanupManager.sweep(docker, 'instance');
  }

  /**
   * Remove every DevLaunch container regardless of creator.
   *
   * Only safe at startup: a crashed process leaves containers nothing else will claim,
   * and at that moment this process is by definition not mid-run.
   */
  static async sweepAllOrphans(docker: DockerManager): Promise<number> {
    return CleanupManager.sweep(docker, 'all');
  }

  /**
   * Remove cache volumes nothing has used for a while.
   *
   * Teardown removes containers. Nothing removed volumes, and nothing ever had — a
   * production-readiness check found **99** of them, 5.1 GB, 98% reclaimable, on a tool
   * whose job is cloning arbitrary repositories. One of them had been created by that
   * check's own smoke test. Unbounded disk on a 100 GB VM is a slow leak with a
   * deadline.
   *
   * By age, not by size. Age is predictable and explicable to somebody reading the log
   * line; a size budget needs bookkeeping this tool does not keep and would evict the
   * wrong thing on the day it mattered.
   *
   * Startup only, and for the same reason `sweepAllOrphans` is: a volume in use is a
   * volume this process might be about to mount, and at startup it is by definition
   * not mid-run. Docker refuses to remove a volume a container still holds, which is
   * the backstop rather than the plan.
   */
  static async sweepStaleCaches(
    docker: DockerManager,
    maxAgeMs: number,
    /** Injectable so the boundary is testable; two calls to `Date.now()` never align. */
    now: number = Date.now(),
  ): Promise<number> {
    if (maxAgeMs <= 0) return 0;
    // `>=` rather than `>`: a cache exactly at the threshold is spared. Warm caches are
    // why a repeat run takes six seconds instead of ninety, and nothing is gained by
    // being eager at the boundary.
    const cutoff = now - maxAgeMs;
    let removed = 0;

    for (const volume of await docker.listCacheVolumes()) {
      if (volume.createdAt >= cutoff) continue;
      try {
        await docker.removeVolume(volume.name);
        removed++;
      } catch {
        // In use, or gone between listing and removing. Both are fine: the next startup
        // tries again, and a cache that cannot be removed costs disk rather than
        // correctness.
      }
    }
    return removed;
  }

  private static async sweep(docker: DockerManager, scope: 'all' | 'instance'): Promise<number> {
    const managed = await docker.listManaged(scope);
    let removed = 0;
    for (const info of managed) {
      try {
        await docker.remove(docker.getContainer(info.Id));
        removed++;
      } catch {
        // Best effort: a container we cannot remove is reported by count, not thrown.
      }
    }
    // Then the workspaces those containers mounted, which outlive them by design. Same
    // scope, same reasoning: at startup nothing is mid-run; at shutdown only our own.
    if (typeof docker.listWorkspaceVolumes === 'function') {
      for (const volume of await docker.listWorkspaceVolumes(scope).catch(() => [] as string[])) {
        await docker.removeVolume(volume).catch(() => undefined);
      }
    }
    return removed;
  }
}
