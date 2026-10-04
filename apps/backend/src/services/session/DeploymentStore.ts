import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DescribedFailure, ExecutionState, RepairRecord, LaunchAttempt } from '@devlaunch/shared';
import type { DeploymentEvent } from './DeploymentEvents.js';

/**
 * What survives a backend restart: one record per deployment.
 *
 * Sessions live in memory, so a restart used to lose every trace of what had run — which
 * repository, which commit, which containers, why it failed. The startup sweep removed the
 * containers and nobody could say what they had been. A record is written on every state
 * change; on startup, one left in a state that was still running is marked as interrupted,
 * because its containers are gone.
 */
export interface DeploymentRecord {
  id: string;
  state: ExecutionState;
  repoUrl?: string;
  ref?: string;
  commit?: string | null;
  sourceDir?: string;
  createdAt: number;
  updatedAt: number;
  readyAt?: number;
  endedReason?: string;
  detected?: string;
  url?: string;
  services: { name: string; role?: string; state: string; url?: string; hostPort?: number; containerPort?: number | null; containerId?: string }[];
  backing: { kind: string; alias: string; ready: boolean; containerId?: string }[];
  containerIds: string[];
  failure?: DescribedFailure;
  repairs?: RepairRecord[];
  launchAttempts?: LaunchAttempt[];
  events: DeploymentEvent[];
  /** The end-to-end check run before READY (`SmokeTest`). */
  verification?: import('../verification/SmokeTest.js').Verification;
  /** Set when a backend restart found this record still running. */
  interrupted?: boolean;
}

export interface DeploymentStore {
  save(record: DeploymentRecord): Promise<void>;
  get(id: string): Promise<DeploymentRecord | undefined>;
  list(): Promise<DeploymentRecord[]>;
  remove(id: string): Promise<void>;
}

/** Records in memory only: what tests use, and what a SessionManager gets by default. */
export class InMemoryDeploymentStore implements DeploymentStore {
  readonly records = new Map<string, DeploymentRecord>();
  async save(r: DeploymentRecord) {
    this.records.set(r.id, structuredClone(r));
  }
  async get(id: string) {
    const r = this.records.get(id);
    return r ? structuredClone(r) : undefined;
  }
  async list() {
    return [...this.records.values()].map((r) => structuredClone(r)).sort((a, b) => b.createdAt - a.createdAt);
  }
  async remove(id: string) {
    this.records.delete(id);
  }
}

/** A deployment id is a UUID; anything else never becomes a file name. */
const SAFE_ID = /^[A-Za-z0-9-]{8,64}$/;

/**
 * Records as files: `<dir>/<id>.json`, written whole through a temporary file and a
 * rename, readable only by their owner. At most `keep` records; the oldest go first.
 */
export class FileDeploymentStore implements DeploymentStore {
  constructor(
    private readonly dir: string,
    private readonly keep = 200,
  ) {}

  /** `$DEVLAUNCH_STATE_DIR/deployments`, else `~/.devlaunch/deployments`. Read at call time. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): FileDeploymentStore {
    const root = env.DEVLAUNCH_STATE_DIR?.trim() || join(homedir(), '.devlaunch');
    return new FileDeploymentStore(join(root, 'deployments'));
  }

  private file(id: string): string {
    if (!SAFE_ID.test(id)) throw new Error(`Not a deployment id: ${id.slice(0, 40)}`);
    return join(this.dir, `${id}.json`);
  }

  async save(record: DeploymentRecord): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const target = this.file(record.id);
    const tmp = `${target}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(record, null, 2), { mode: 0o600 });
    await rename(tmp, target);
  }

  async get(id: string): Promise<DeploymentRecord | undefined> {
    try {
      return JSON.parse(await readFile(this.file(id), 'utf8')) as DeploymentRecord;
    } catch {
      return undefined;
    }
  }

  async list(): Promise<DeploymentRecord[]> {
    let names: string[];
    try {
      names = (await readdir(this.dir)).filter((n) => n.endsWith('.json'));
    } catch {
      return [];
    }
    const out: DeploymentRecord[] = [];
    for (const n of names) {
      const r = await this.get(n.slice(0, -'.json'.length)).catch(() => undefined);
      if (r) out.push(r);
    }
    out.sort((a, b) => b.createdAt - a.createdAt);
    for (const old of out.slice(this.keep)) await this.remove(old.id);
    return out.slice(0, this.keep);
  }

  async remove(id: string): Promise<void> {
    const { rm } = await import('node:fs/promises');
    await rm(this.file(id), { force: true });
  }
}
