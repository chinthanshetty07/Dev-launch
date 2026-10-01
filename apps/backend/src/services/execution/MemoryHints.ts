import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * How much memory a repository needed last time, so the next run starts there.
 *
 * Without it every run of a repository that needs more than the starting limit was killed
 * at that limit first and only then retried: `wrrnlim/nextjs-docker-postgres-template` lost
 * its first 18 seconds to an install killed at 1024 MB on every run, and then needed 2048.
 *
 * Kept small and local: one number per repository (and service), saved only after a run
 * got past its install at more than the starting limit, read back as where to start —
 * never above the policy's ceiling, which the caller applies. A file in the user's own
 * state directory, readable only by them, bounded in size.
 */
export interface MemoryHintStore {
  get(key: string): Promise<number | undefined>;
  remember(key: string, memoryMb: number): Promise<void>;
}

interface Hint {
  memoryMb: number;
  at: number;
}

/** At most this many repositories are remembered; the oldest go first. */
export const MAX_HINTS = 500;

/** The key for a repository and service: its URL or directory, normalised. */
export function memoryHintKey(repo: string, service = 'app'): string {
  const clean = repo
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .toLowerCase();
  return `${clean}#${service}`;
}

/** Kept in memory only. What tests use, and what a session gets when none is supplied. */
export class InMemoryHints implements MemoryHintStore {
  readonly hints = new Map<string, Hint>();
  async get(key: string): Promise<number | undefined> {
    return this.hints.get(key)?.memoryMb;
  }
  async remember(key: string, memoryMb: number): Promise<void> {
    this.hints.set(key, { memoryMb, at: Date.now() });
  }
}

/**
 * Kept in a JSON file. Read once, written whole through a temporary file and a rename,
 * so a crash mid-write leaves the previous file rather than half of one.
 */
export class FileHints implements MemoryHintStore {
  private loaded?: Promise<Map<string, Hint>>;

  constructor(private readonly file: string) {}

  /** `$DEVLAUNCH_STATE_DIR/memory-hints.json`, else `~/.devlaunch/memory-hints.json`. Read at call time. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): FileHints {
    const dir = env.DEVLAUNCH_STATE_DIR?.trim() || join(homedir(), '.devlaunch');
    return new FileHints(join(dir, 'memory-hints.json'));
  }

  private load(): Promise<Map<string, Hint>> {
    return (this.loaded ??= readFile(this.file, 'utf8')
      .then((raw) => {
        const parsed = JSON.parse(raw) as Record<string, Hint>;
        const map = new Map<string, Hint>();
        for (const [k, v] of Object.entries(parsed)) {
          if (v && Number.isInteger(v.memoryMb) && v.memoryMb > 0) map.set(k, { memoryMb: v.memoryMb, at: Number(v.at) || 0 });
        }
        return map;
      })
      // Missing or unreadable: start empty. A hint is a saving, never a requirement.
      .catch(() => new Map<string, Hint>()));
  }

  async get(key: string): Promise<number | undefined> {
    return (await this.load()).get(key)?.memoryMb;
  }

  async remember(key: string, memoryMb: number): Promise<void> {
    const hints = await this.load();
    hints.set(key, { memoryMb, at: Date.now() });
    const kept = [...hints].sort((a, b) => b[1].at - a[1].at).slice(0, MAX_HINTS);
    if (kept.length < hints.size) {
      hints.clear();
      for (const [k, v] of kept) hints.set(k, v);
    }
    try {
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(Object.fromEntries(hints), null, 2), { mode: 0o600 });
      await rename(tmp, this.file);
    } catch {
      // Unwritable: the hint lives for this process only. Nothing depends on it.
    }
  }
}
