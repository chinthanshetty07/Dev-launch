/**
 * The most memory one container may be given when a repair raises its limit.
 *
 * This was the constant 2048, chosen when the VM had 3.8 GB, and then half the VM: the
 * other half was left for the database, the daemon and the project's other services.
 * `horusyeung/nextjs-nestjs-fullstack-starter`'s workspace install needs 2.4–2.9 GB —
 * measured, with headroom — and on a 5910 MB VM half is 2955, so it fitted some runs and
 * not others while gigabytes sat idle.
 *
 * Now (the user's decision): the VM less a reserve for its own kernel and daemon, capped
 * at 4096. What the *other* containers need is no longer guessed as "half": the memory
 * ledger (`MemoryBudget`) counts them at what they actually use when an escalation asks,
 * so this is the most one container may ever be given, and the ledger decides how much of
 * it is free at that moment.
 *
 * Read at call time rather than from `config/index.ts`, like `bindHost` and
 * `cacheMaxAgeMs`. That module is evaluated before `loadDotEnv()` runs, so a value read
 * there honours an exported shell variable and silently ignores the same line in `.env`.
 */
export const FALLBACK_CEILING_MB = 2048;
export const MAX_CEILING_MB = 4096;
/** Kept free of containers for the VM's own kernel and the Docker daemon. */
export const DEFAULT_RESERVE_MB = 512;

/** The reserve, from `DEVLAUNCH_MEMORY_RESERVE_MB`, or the default when it is unusable. */
export function memoryReserveMb(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.DEVLAUNCH_MEMORY_RESERVE_MB?.trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_RESERVE_MB;
}

export function containerMemoryCeilingMb(
  env: NodeJS.ProcessEnv = process.env,
  vmMemoryBytes: number | null = null,
): number {
  // An explicit request wins over any derivation. Somebody who set this knows something
  // about their machine that `docker info` does not report.
  const requested = env.DEVLAUNCH_CONTAINER_MEMORY_CEILING_MB?.trim();
  if (requested) {
    const mb = Number.parseInt(requested, 10);
    if (Number.isFinite(mb) && mb > 0) return mb;
  }

  // Unreadable memory is not evidence of a large machine. The old constant is the safe
  // answer: it is what every run before this used, so falling back cannot regress one.
  if (vmMemoryBytes === null || !Number.isFinite(vmMemoryBytes) || vmMemoryBytes <= 0) {
    return FALLBACK_CEILING_MB;
  }

  // No floor when the machine is known: a VM too small to give more than the initial limit
  // says so, rather than being offered memory it does not have.
  const vmMb = Math.floor(vmMemoryBytes / (1024 * 1024));
  return Math.max(0, Math.min(vmMb - memoryReserveMb(env), MAX_CEILING_MB));
}
