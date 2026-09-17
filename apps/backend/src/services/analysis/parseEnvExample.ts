import type { EnvExampleVar } from '@devlaunch/shared';

/**
 * Read a `.env.example` into the variables it declares.
 *
 * Shared by the analyzer and by service discovery: a repository's configuration lives
 * beside the service that reads it, so both the root file and each service's own have
 * to be understood the same way.
 */
export function parseEnvExample(content: string): EnvExampleVar[] {
  const out: EnvExampleVar[] = [];
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).replace(/^export\s+/, '').trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    // A value present in .env.example means the variable has a usable default, so it
    // is not something the user must be prompted for.
    const value = line.slice(eq + 1).trim();
    out.push({ key, hasDefault: value.length > 0 });
  }
  return out;
}
