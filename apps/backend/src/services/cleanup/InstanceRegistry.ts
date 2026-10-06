import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Which DevLaunch processes are alive on this machine.
 *
 * Each process labels what it creates with its own instance id. At startup a process
 * cannot tell, from Docker alone, a crashed process's leftovers from a live one's
 * running containers — so the startup sweep removed both, and a test run in one
 * terminal deleted the dashboard's running application in another (audit A-12).
 *
 * Each live process keeps a file here naming its pid; a file whose pid is gone is a
 * process that died without cleaning up, and its containers are fair game.
 */
export class InstanceRegistry {
  constructor(private readonly dir: string) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env): InstanceRegistry {
    const root = env.DEVLAUNCH_STATE_DIR?.trim() || join(homedir(), '.devlaunch');
    return new InstanceRegistry(join(root, 'instances'));
  }

  async register(id: string, pid: number = process.pid): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await writeFile(this.file(id), JSON.stringify({ pid, startedAt: Date.now() }), { mode: 0o600 });
  }

  async unregister(id: string): Promise<void> {
    await rm(this.file(id), { force: true });
  }

  /** Ids of processes still running. Files of dead ones are removed on the way. */
  async live(isAlive: (pid: number) => boolean = pidAlive): Promise<Set<string>> {
    const out = new Set<string>();
    for (const name of await readdir(this.dir).catch(() => [] as string[])) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -'.json'.length);
      const pid = await readFile(join(this.dir, name), 'utf8')
        .then((raw) => Number((JSON.parse(raw) as { pid?: unknown }).pid))
        .catch(() => NaN);
      if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) out.add(id);
      else await rm(join(this.dir, name), { force: true });
    }
    return out;
  }

  private file(id: string): string {
    return join(this.dir, `${id.replace(/[^a-zA-Z0-9-]/g, '')}.json`);
  }
}

/** Signal 0 checks existence without sending anything; EPERM means it exists. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
