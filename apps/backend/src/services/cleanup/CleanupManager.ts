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
    return removed;
  }
}
