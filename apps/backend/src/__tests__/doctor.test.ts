import { describe, it, expect, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

/** `./devlaunch doctor`: it reports which keys .env sets, and never a value. */
const DOCTOR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../scripts/doctor.mjs');
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe('the doctor', () => {
  it('reads the keys of an env file, not the values', async () => {
    const { envKeys } = (await import(DOCTOR as string)) as { envKeys: (t: string) => string[] };
    expect(envKeys('# c\nGROQ_API_KEY=gsk_secret\nexport A=1\nnot a line\nB = 2\n')).toEqual(['GROQ_API_KEY', 'A', 'B']);
  });

  it('never prints a value from .env', async () => {
    const d = await mkdtemp(join(tmpdir(), 'devlaunch-doctor-'));
    dirs.push(d);
    // Was 2048, which the doctor now prints for its own reason (the build process cap), so
    // the value must be one nothing else prints.
    await writeFile(join(d, '.env'), 'GROQ_API_KEY=gsk_THIS_MUST_NOT_APPEAR_123\nDEVLAUNCH_CONTAINER_MEMORY_MB=3517\n');
    const out = await promisify(execFile)('node', [DOCTOR], {
      env: { ...process.env, DEVLAUNCH_ENV_FILE: join(d, '.env'), DEVLAUNCH_STATE_DIR: join(d, 'state') },
      timeout: 60_000,
    }).then((r) => r.stdout, (e: { stdout?: string }) => e.stdout ?? '');
    expect(out).toMatch(/\.env sets 2 key\(s\): GROQ_API_KEY, DEVLAUNCH_CONTAINER_MEMORY_MB/);
    expect(out).not.toContain('gsk_THIS_MUST_NOT_APPEAR_123');
    expect(out).not.toContain('3517');
  }, 90_000);
});
