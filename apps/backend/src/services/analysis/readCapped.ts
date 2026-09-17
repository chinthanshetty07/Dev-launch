import { readFile, stat } from 'node:fs/promises';
import { config } from '../../config/index.js';

/**
 * Read a file, refusing anything large enough to be a payload rather than a manifest.
 *
 * Extracted so service discovery reads under the same cap the analyzer does: both walk
 * an untrusted repository, and one of them having its own idea of "too large" is how a
 * cap stops being one.
 */
export async function readCapped(path: string): Promise<string | null> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > config.intake.maxReadBytes) return null;
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}
