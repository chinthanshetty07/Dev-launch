import { describe, it, expect, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

/**
 * Settings in `.env` reach the config module. They did not: `.env` was loaded after the
 * imports that read the settings, so most of them were silently ignored.
 */
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe('.env', () => {
  it('is the server’s first import, so it is loaded before any setting is read', async () => {
    const server = await readFile(join(SRC, 'server.ts'), 'utf8');
    const firstImport = server.split('\n').find((l) => l.startsWith('import '));
    expect(firstImport).toBe("import './loadEnv.js';");
  });

  it('reaches settings the config module reads at import', async () => {
    const d = await mkdtemp(join(tmpdir(), 'devlaunch-env-'));
    dirs.push(d);
    await writeFile(join(d, '.env'), 'DEVLAUNCH_TIMEOUT_CLONE_MS=12345\nexport DEVLAUNCH_REPO_MAX_FILES=777\n');
    const probe = join(d, 'probe.mts');
    // The same order as server.ts: loadEnv first, then something that pulls in config.
    await writeFile(probe, `import ${JSON.stringify(join(SRC, 'loadEnv.ts'))};\nconst { config } = await import(${JSON.stringify(join(SRC, 'config/index.ts'))});\nconsole.log(config.timeouts.cloneMs, config.intake.maxFiles);\n`);
    const tsx = resolve(SRC, '../node_modules/.bin/tsx');
    const env: NodeJS.ProcessEnv = { ...process.env, DEVLAUNCH_ENV_FILE: join(d, ".env") };
    delete env.DEVLAUNCH_TIMEOUT_CLONE_MS;
    delete env.DEVLAUNCH_REPO_MAX_FILES;
    const { stdout } = await promisify(execFile)(tsx, [probe], { env, timeout: 60_000 });
    expect(stdout.trim()).toBe('12345 777');
  }, 90_000);

  it('never overrides a variable already in the real environment', async () => {
    const { loadDotEnv } = await import('../loadEnv.js');
    const d = await mkdtemp(join(tmpdir(), 'devlaunch-env-'));
    dirs.push(d);
    await writeFile(join(d, '.env'), 'DEVLAUNCH_TEST_ONLY_VAR=from-file\n');
    process.env.DEVLAUNCH_TEST_ONLY_VAR = 'from-shell';
    loadDotEnv(join(d, '.env'));
    expect(process.env.DEVLAUNCH_TEST_ONLY_VAR).toBe('from-shell');
    delete process.env.DEVLAUNCH_TEST_ONLY_VAR;
  });
});
