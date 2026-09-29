/**
 * The most memory one container may be given when a repair raises its limit.
 *
 * This was the constant 2048, chosen when the VM had 3.8 GB. The VM was later given 6 GB
 * and the constant did not notice, so `horusyeung/nextjs-nestjs-fullstack-starter` was
 * still killed at 1477/2048 MB on a machine with gigabytes to spare — the limit was
 * DevLaunch's, the failure was reported as the repository's, and raising the VM had no
 * effect because nothing connected the two.
 *
 * Half the machine, capped. Half because the VM also holds whatever database the project
 * asked for, the daemon, and the other services of the same project; capped because past
 * a few gigabytes a single install that still will not fit is a repository problem, and
 * handing it 32 GB only makes the eventual failure slower.
 *
 * Read at call time rather than from `config/index.ts`, like `bindHost` and
 * `cacheMaxAgeMs`. That module is evaluated before `loadDotEnv()` runs, so a value read
 * there honours an exported shell variable and silently ignores the same line in `.env`.
 * Three settings have now met this; it is a property of the config module, noted in
 * `docs/production-readiness.md` as an open finding.
 */
export const FALLBACK_CEILING_MB = 2048;
export const MAX_CEILING_MB = 4096;

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

  // No floor when the machine is known.
  //
  // An earlier version kept the old constant as a minimum, so that a small VM would not
  // get weaker repairs than before. That is exactly the wedge this is supposed to
  // prevent: on a 2 GB VM it hands one container 2048 MB — the entire machine, with the
  // daemon and a database already in it — and on 1 GB it offers twice what exists.
  // Where the size is known, half of it is the answer; a machine that cannot do better
  // than the default should say so and stop, which is what "already at the ceiling"
  // means. The constant remains the answer only when the size is *unknown*, above.
  const halfMb = Math.floor(vmMemoryBytes / 2 / (1024 * 1024));
  return Math.min(halfMb, MAX_CEILING_MB);
}
