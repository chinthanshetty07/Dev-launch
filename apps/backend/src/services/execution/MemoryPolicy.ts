import { DEFAULT_RESERVE_MB, MAX_CEILING_MB, containerMemoryCeilingMb, memoryReserveMb } from './MemoryCeiling.js';

/**
 * How much memory a container starts with, how it grows after an out-of-memory kill, and
 * where it stops — in one place.
 *
 * Before this the answer was scattered: a 1024 default in the config module, a ceiling in
 * `MemoryCeiling`, and two repair paths that each jumped straight from the default to the
 * ceiling, once. That is the whole machine's worth of memory for an install that might
 * have fitted in twice the default, and no second chance if the jump was not enough.
 *
 * Read from the environment at call time, never at import: `config/index.ts` is evaluated
 * before `.env` is loaded, and a memory setting that honoured the shell but not `.env`
 * would be one nobody could explain. (`MemoryCeiling` records the same trap.)
 */

export const DEFAULT_INITIAL_MB = 1024;
export const DEFAULT_RETRY_LIMIT = 2;
export const MAX_RETRY_LIMIT = 5;
/** Below this a Node or Python install cannot start at all; a smaller setting is a typo. */
export const MIN_CONTAINER_MB = 256;
export { DEFAULT_RESERVE_MB };

export interface MemoryPolicy {
  /** What a container gets before anything has been learned about it. */
  initialMb: number;
  /** The most one container may be given; the existing derived ceiling. */
  maxMb: number;
  /** Where `maxMb` came from, in words — for a message a person reads. */
  maxSource: string;
  retryEnabled: boolean;
  /** Raises allowed after the first attempt. Attempts in all: this plus one. */
  retryLimit: number;
  /** A fixed increment, or null to double. */
  stepMb: number | null;
  /** Settings that were present and unusable, each with the value used instead. */
  warnings: string[];
}

export interface MemoryPolicyInputs {
  env?: NodeJS.ProcessEnv;
  /** The Docker VM's total memory, from `docker info`, or null when it cannot be read. */
  vmMemoryBytes?: number | null;
}

function intSetting(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  valid: (n: number) => boolean,
  warnings: string[],
): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (Number.isInteger(n) && valid(n)) return n;
  warnings.push(`${key}=${raw} is not usable; using ${fallback}.`);
  return fallback;
}

export function memoryPolicy({ env = process.env, vmMemoryBytes = null }: MemoryPolicyInputs = {}): MemoryPolicy {
  const warnings: string[] = [];
  const initialMb = intSetting(env, 'DEVLAUNCH_CONTAINER_MEMORY_MB', DEFAULT_INITIAL_MB, (n) => n >= MIN_CONTAINER_MB, warnings);
  const ceiling = containerMemoryCeilingMb(env, vmMemoryBytes);

  const explicitCeiling = Boolean(env.DEVLAUNCH_CONTAINER_MEMORY_CEILING_MB?.trim());
  const vmMb = vmMemoryBytes && vmMemoryBytes > 0 ? Math.floor(vmMemoryBytes / (1024 * 1024)) : null;
  const maxSource = explicitCeiling
    ? 'DEVLAUNCH_CONTAINER_MEMORY_CEILING_MB'
    : vmMb !== null
      ? ceiling >= MAX_CEILING_MB
        ? `the ${MAX_CEILING_MB} MB DevLaunch gives any one container`
        : `all this ${vmMb} MB Docker VM can give one container, less its ${memoryReserveMb(env)} MB reserve`
      : 'the fallback used when the VM size cannot be read';

  // An initial value above the ceiling is somebody's explicit choice and is honoured as
  // is; it simply leaves nothing to escalate to.
  const maxMb = Math.max(ceiling, initialMb);

  const retryRaw = env.DEVLAUNCH_MEMORY_RETRY_ENABLED?.trim().toLowerCase();
  const retryEnabled = !(retryRaw && ['0', 'false', 'no', 'off'].includes(retryRaw));
  if (retryRaw && !['0', 'false', 'no', 'off', '1', 'true', 'yes', 'on'].includes(retryRaw)) {
    warnings.push(`DEVLAUNCH_MEMORY_RETRY_ENABLED=${retryRaw} is not a yes or no; retrying is on.`);
  }
  const retryLimit = intSetting(env, 'DEVLAUNCH_MEMORY_RETRY_LIMIT', DEFAULT_RETRY_LIMIT, (n) => n >= 0 && n <= MAX_RETRY_LIMIT, warnings);
  const stepRaw = env.DEVLAUNCH_MEMORY_STEP_MB?.trim();
  const stepMb = stepRaw ? intSetting(env, 'DEVLAUNCH_MEMORY_STEP_MB', 0, (n) => n >= 64, warnings) || null : null;

  return { initialMb, maxMb, maxSource, retryEnabled, retryLimit, stepMb, warnings };
}

/**
 * The next limit to try after an out-of-memory kill at `currentMb`, or null.
 *
 * Null when retrying is off, the raises are spent, the ceiling is reached, or the memory
 * that is free cannot make the next limit larger than this one. Strictly increasing and
 * bounded by `maxMb`, so it cannot loop even without the raise count; the raise count
 * bounds it even if a step were somehow zero. Two independent bounds.
 */
export function nextMemoryMb(
  policy: MemoryPolicy,
  currentMb: number,
  raisesSoFar: number,
  freeMb: number | null = null,
): number | null {
  if (!policy.retryEnabled || raisesSoFar >= policy.retryLimit) return null;
  const wanted = policy.stepMb !== null ? currentMb + policy.stepMb : currentMb * 2;
  let next = Math.min(wanted, policy.maxMb);
  if (freeMb !== null) next = Math.min(next, freeMb);
  return next > currentMb ? next : null;
}

/** Every limit the policy would try, from the first — for a log line and a test. */
export function memoryLadder(policy: MemoryPolicy): number[] {
  const ladder = [policy.initialMb];
  for (let i = 0; ; i++) {
    const next = nextMemoryMb(policy, ladder[ladder.length - 1]!, i);
    if (next === null) return ladder;
    ladder.push(next);
  }
}

/**
 * The Node heap to allow inside a container of `containerMb`: three quarters of it.
 *
 * The heap is only part of what a Node process uses — native buffers, the code, and every
 * other process an install spawns share the same limit — so it is never allowed the whole
 * container. A quarter left over, and never less than 256 MB of headroom.
 */
export function nodeHeapMbFor(containerMb: number): number {
  return Math.max(128, Math.min(Math.floor(containerMb * 0.75), containerMb - 256));
}

/**
 * The memory the containers of this DevLaunch process hold, against what the VM has.
 *
 * Two answers. `freeMb` counts every other container at its *limit* — the worst case,
 * and the one to use when nothing better is known. `measuredFreeMb` counts each at what it
 * is *using*, sampled from Docker and capped by its limit: an API that needed 2955 MB to
 * install idles at a few hundred once it serves, and a database limited to 1024 MB uses
 * seventy. Counting their limits refused a sibling memory the VM plainly had. Escalation
 * asks the measured answer; a container whose use cannot be read counts at its limit.
 * Unknown capacity constrains nothing beyond the per-container ceiling, as before.
 *
 * Minimal on purpose — one process, one session at a time today — and keyed by container
 * so it can carry concurrent sessions without a second calculation.
 */
export class MemoryBudget {
  private readonly held = new Map<string, number>();
  private readonly samplers = new Map<string, () => Promise<number | null | 'gone'>>();

  constructor(private readonly capacity: () => number | null) {}

  /**
   * `usageMb`, when given, reads what the container is using now, in MB — or `'gone'`
   * when Docker says the container no longer exists, which releases the hold.
   */
  hold(id: string, mb: number, usageMb?: () => Promise<number | null | 'gone'>): void {
    this.held.set(id, mb);
    if (usageMb) this.samplers.set(id, usageMb);
  }

  release(id: string): void {
    this.held.delete(id);
    this.samplers.delete(id);
  }

  /**
   * Free memory counting every other container at what it uses now, capped by its limit.
   *
   * A hold whose container Docker no longer has is released here, whatever removed it.
   * Every path that removes a container is meant to release its hold, and at least one
   * does not: after a dashboard session of repeated stops, a live run was refused memory
   * because "the VM has no more to give: 86 MB is free after the 8 other container(s)",
   * beside a Docker with no DevLaunch container in it at all. A gone container's sample
   * cannot be read, and an unreadable sample counts at the full limit — so each leaked
   * hold cost 1024 MB for the life of the process. One path that does it was reproduced
   * (the label sweep on shutdown removing a database still being created); the one the
   * dashboard took was not. Checking against Docker covers both, and the next.
   */
  async measuredFreeMb(exceptId?: string): Promise<number | null> {
    const cap = this.capacity();
    if (cap === null) return null;
    let used = 0;
    for (const [id, limit] of [...this.held]) {
      if (id === exceptId) continue;
      const sampled = await this.samplers.get(id)?.().catch(() => null);
      if (sampled === 'gone') {
        this.release(id);
        continue;
      }
      used += sampled === null || sampled === undefined ? limit : Math.min(limit, Math.ceil(sampled));
    }
    return Math.max(0, cap - used);
  }

  heldMb(exceptId?: string): number {
    let total = 0;
    for (const [id, mb] of this.held) if (id !== exceptId) total += mb;
    return total;
  }

  /** What one container could be given, if `exceptId` gave its own allocation back. */
  freeMb(exceptId?: string): number | null {
    const cap = this.capacity();
    return cap === null ? null : Math.max(0, cap - this.heldMb(exceptId));
  }

  /** Who holds what, largest first, for a message that names the reason. */
  holders(exceptId?: string): { id: string; mb: number }[] {
    return [...this.held]
      .filter(([id]) => id !== exceptId)
      .map(([id, mb]) => ({ id, mb }))
      .sort((a, b) => b.mb - a.mb);
  }
}

/** The VM's capacity for containers: its memory less a reserve for itself. */
export function containerCapacityMb(vmMemoryBytes: number | null, env: NodeJS.ProcessEnv = process.env): number | null {
  if (!vmMemoryBytes || vmMemoryBytes <= 0) return null;
  return Math.max(0, Math.floor(vmMemoryBytes / (1024 * 1024)) - memoryReserveMb(env));
}
