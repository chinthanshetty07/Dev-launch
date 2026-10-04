import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Load `.env` into `process.env` — as a side effect of being imported, and first.
 *
 * It used to be loaded by a function in `server.ts`, which ran after that file's imports —
 * and those imports evaluate `config/index.ts`, which reads its settings once, at import.
 * So every setting in `.env` that the config module reads (timeouts, intake limits, log
 * caps, the concurrency limit…) was silently ignored; only the few read at call time
 * worked. `server.ts` imports this module before anything else, so `.env` is in place by
 * the time any setting is read. A variable already set in the real environment wins.
 *
 * `DEVLAUNCH_ENV_FILE` points at another file (the doctor and tests use it).
 */
export function loadDotEnv(file = process.env.DEVLAUNCH_ENV_FILE || resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env')): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).replace(/^export\s+/, '').trim();
    if (process.env[key] !== undefined) continue;
    process.env[key] = trimmed.slice(eq + 1).trim();
  }
}

loadDotEnv();
