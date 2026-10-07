#!/usr/bin/env node
// `./devlaunch doctor` — is this machine ready to run DevLaunch, and if not, what to do.
//
// Every check prints one line: ✓ fine, ! works but worth knowing, ✗ must be fixed. Each ✗
// and ! says the command or step that fixes it. Exit code 1 when anything is ✗.
//
// Never prints a value from .env — only which keys are set. It changes nothing, except
// creating DevLaunch's own state directory (~/.devlaunch) if it is missing.
import { execFile } from 'node:child_process';
import { access, mkdir, readFile, statfs } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const run = promisify(execFile);
const results = [];
const ok = (what, detail = '') => results.push({ level: 'ok', what, detail });
const warn = (what, detail) => results.push({ level: 'warn', what, detail });
const bad = (what, detail) => results.push({ level: 'bad', what, detail });

async function cmd(file, args, timeout = 15_000) {
  try {
    const { stdout } = await run(file, args, { timeout });
    return stdout.trim();
  } catch {
    return null;
  }
}

/** The keys an env file sets, never the values. Exported for the test that proves it. */
export function envKeys(text) {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => l.slice(0, l.indexOf('=')).replace(/^export\s+/, '').trim())
    .filter((k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k));
}

async function main() {
  // --- Runtimes and tools ----------------------------------------------------------
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 20) ok(`Node ${process.versions.node}`);
  else bad(`Node ${process.versions.node}`, 'DevLaunch needs Node 20 or newer. Install it from nodejs.org or with nvm.');

  const pnpm = await cmd('pnpm', ['--version']);
  if (pnpm) ok(`pnpm ${pnpm}`);
  else bad('pnpm not found', 'Run: corepack enable  (comes with Node), then: pnpm --version');

  const git = await cmd('git', ['--version']);
  if (git) ok(git);
  else bad('git not found', 'Install git (macOS: xcode-select --install).');

  // --- Docker ------------------------------------------------------------------------
  const server = await cmd('docker', ['info', '--format', '{{.ServerVersion}}|{{.MemTotal}}|{{.NCPU}}|{{.Architecture}}']);
  if (!server) {
    bad('Docker is not reachable', 'Start it. With Colima: colima start --cpu 4 --memory 6');
  } else {
    const [version, mem, cpus, arch] = server.split('|');
    const gb = Number(mem) / 1024 ** 3;
    ok(`Docker ${version} (${cpus} CPUs, ${gb.toFixed(1)} GB, ${arch})`);
    if (gb < 4) warn(`Docker has only ${gb.toFixed(1)} GB of memory`, 'Large installs need more. With Colima: colima stop && colima start --cpu 4 --memory 6');

    const missing = [];
    for (const image of ['devlaunch/node:20', 'devlaunch/node:22', 'devlaunch/python:3.12']) {
      if ((await cmd('docker', ['image', 'inspect', '--format', '{{.Id}}', image])) === null) missing.push(image);
    }
    if (missing.length === 0) ok('Runner images built (node:20, node:22, python:3.12)');
    else bad(`Runner images missing: ${missing.join(', ')}`, 'Run: ./devlaunch install   (or: bash scripts/build-runner-images.sh)');

    const net = await cmd('docker', ['network', 'inspect', '--format', '{{.Name}}', 'devlaunch-net']);
    if (net) ok('Protected network devlaunch-net exists');
    else warn('Network devlaunch-net is missing', 'Containers would run without the rule that keeps them off your home network. Run: bash scripts/setup-network-policy.sh');

    // The process cap a repository's own Dockerfile build runs under (see BuildSandbox).
    const pidsMax = await cmd('docker', ['run', '--rm', '--cgroupns', 'host', '--network', 'none', '--user', '1000:1000',
      '--cap-drop', 'ALL', 'devlaunch/node:20', 'cat', '/sys/fs/cgroup/devlaunch-build/pids.max'], 30_000);
    if (pidsMax && /^\d+$/.test(pidsMax)) ok(`Dockerfile builds are capped at ${pidsMax} processes`);
    else warn('Dockerfile builds have no process cap', 'A repository\'s own Dockerfile will not be built until it does. Run: bash scripts/setup-network-policy.sh');

    const ours = await cmd('docker', ['ps', '-aq', '--filter', 'label=com.devlaunch.managed=true']);
    const count = ours ? ours.split('\n').filter(Boolean).length : 0;
    if (count > 0) warn(`${count} DevLaunch container(s) exist`, 'Fine while DevLaunch is running something. If it is not: ./devlaunch clean');
  }

  // --- Port and backend ------------------------------------------------------------------
  const health = await fetch('http://127.0.0.1:3939/api/health', { signal: AbortSignal.timeout(3000) })
    .then((r) => r.json())
    .catch(() => null);
  if (health?.ok) {
    if (health.build?.stale) warn('DevLaunch is running, but older code than this checkout', 'Restart it: stop it, then ./devlaunch start');
    else ok(`DevLaunch is running on port 3939 (commit ${String(health.build?.running ?? '?').slice(0, 7)})`);
  } else {
    const inUse = await cmd('lsof', ['-nP', '-iTCP:3939', '-sTCP:LISTEN', '-t']);
    if (inUse) bad('Port 3939 is used by something that is not DevLaunch', `Stop process ${inUse.split('\n')[0]}, or set PORT in .env.`);
    else ok('Port 3939 is free (DevLaunch is not running)');
  }

  // --- Disk ----------------------------------------------------------------------------
  try {
    const fs = await statfs(homedir());
    const freeGb = (fs.bavail * fs.bsize) / 1024 ** 3;
    if (freeGb < 5) warn(`Only ${freeGb.toFixed(1)} GB free on disk`, 'Installs and images need space. Free some, or: docker system prune (removes unused Docker data).');
    else ok(`${freeGb.toFixed(0)} GB free on disk`);
  } catch {
    warn('Could not read free disk space', 'Check it yourself: df -h ~');
  }

  // --- Project ---------------------------------------------------------------------------
  try {
    await access(join(ROOT, 'node_modules'), constants.R_OK);
    await access(join(ROOT, 'apps', 'backend', 'node_modules'), constants.R_OK);
    ok('Project dependencies installed');
  } catch {
    bad('Project dependencies are not installed', 'Run: ./devlaunch install   (or: pnpm install)');
  }

  const stateDir = process.env.DEVLAUNCH_STATE_DIR?.trim() || join(homedir(), '.devlaunch');
  try {
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    await access(stateDir, constants.W_OK);
    ok(`State directory writable (${stateDir})`);
  } catch {
    bad(`State directory not writable: ${stateDir}`, 'Fix its permissions, or set DEVLAUNCH_STATE_DIR in .env.');
  }

  const envFile = process.env.DEVLAUNCH_ENV_FILE || join(ROOT, '.env');
  const env = await readFile(envFile, 'utf8').catch(() => null);
  if (env === null) {
    ok('.env not present (optional: defaults are used)');
  } else {
    const keys = envKeys(env);
    ok(`.env sets ${keys.length} key(s)${keys.length ? `: ${keys.join(', ')}` : ''}`);
    if (!keys.includes('GROQ_API_KEY')) warn('No GROQ_API_KEY in .env', 'Optional. Without it, repositories no rule recognises are declined instead of planned by a model.');
  }

  const openssl = await cmd('openssl', ['version']);
  if (openssl) ok(openssl);
  else warn('openssl not found', 'Only the HTTPS tests need it.');

  // --- Report ------------------------------------------------------------------------------
  const mark = { ok: '✓', warn: '!', bad: '✗' };
  for (const r of results) {
    console.log(`${mark[r.level]} ${r.what}${r.detail && r.level !== 'ok' ? `\n    → ${r.detail}` : ''}`);
  }
  const failures = results.filter((r) => r.level === 'bad').length;
  const warnings = results.filter((r) => r.level === 'warn').length;
  console.log(
    failures
      ? `\n${failures} problem(s) to fix before DevLaunch can run.`
      : `\nReady${warnings ? `, with ${warnings} thing(s) worth knowing` : ''}.`,
  );
  process.exitCode = failures ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
