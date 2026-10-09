import { execFile } from 'node:child_process';

/**
 * Start Docker when it is stopped, if DevLaunch knows how: Colima, on a Mac.
 *
 * On a Mac, Docker lives in a small VM. After the Mac restarts, or the VM stops for any
 * other reason, every run failed — first as "Runner image is not built", then as "Docker
 * stopped answering" — until the person noticed and typed `colima start` themselves.
 * That is a step DevLaunch exists to take away, and a safe one: starting a stopped VM
 * keeps everything in it (images, volumes), and is what the installer does already.
 *
 * Only Colima, and only a VM the person already set up: Docker Desktop and OrbStack start
 * themselves at login, and a Linux docker service is the system's to start, not ours.
 * DEVLAUNCH_START_DOCKER=0 turns it off.
 */

export type Wake =
  | { state: 'running' }
  /** It was stopped, and DevLaunch started it. */
  | { state: 'started'; how: string }
  /** Not running, and not something DevLaunch starts; why, in a few words. */
  | { state: 'down'; why: string };

export interface WakeDeps {
  /** Whether Docker answers. */
  ping: () => Promise<boolean>;
  /** Run a command, resolving with its output, rejecting when it fails. */
  run: (cmd: string, args: string[], timeoutMs: number) => Promise<string>;
  /** Wait between pings. */
  sleep?: (ms: number) => Promise<void>;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}

/** How long Colima is given to come up: a cold start takes 20–60 s. */
const START_TIMEOUT_MS = 180_000;
const READY_TIMEOUT_MS = 60_000;

let inFlight: Promise<Wake> | undefined;

/**
 * Docker answering, or the reason it is not. Concurrent callers share one start: the
 * dashboard starting and a run arriving together must not run `colima start` twice.
 */
export function ensureDocker(deps: WakeDeps): Promise<Wake> {
  inFlight ??= wake(deps).finally(() => {
    inFlight = undefined;
  });
  return inFlight;
}

async function wake(deps: WakeDeps): Promise<Wake> {
  if (await deps.ping()) return { state: 'running' };

  const env = deps.env ?? process.env;
  if (env.DEVLAUNCH_START_DOCKER === '0') return { state: 'down', why: 'starting Docker automatically is turned off (DEVLAUNCH_START_DOCKER=0)' };

  // A Colima VM this person created, and stopped. Read from `colima list`, not `colima
  // status`: status says "not running" for a VM that does not exist, and `colima start`
  // would then create one — a download and a new VM nobody asked for.
  let list: string;
  try {
    list = await deps.run('colima', ['list', '--json'], 15_000);
  } catch {
    return { state: 'down', why: 'Docker is not running, and Colima is not installed' };
  }
  const vm = list
    .split('\n')
    .map((line) => {
      try {
        return JSON.parse(line) as { name?: string; status?: string };
      } catch {
        return null;
      }
    })
    .find((p) => p?.name === 'default');
  if (!vm) return { state: 'down', why: 'Docker is not running, and there is no Colima VM to start' };
  if (vm.status !== 'Stopped') return { state: 'down', why: `Colima is ${String(vm.status).toLowerCase()}, but Docker is not answering` };

  deps.log?.('Docker is stopped. Starting Colima (it usually takes under a minute)...');
  try {
    await deps.run('colima', ['start'], START_TIMEOUT_MS);
  } catch (err) {
    return { state: 'down', why: `starting Colima failed: ${String((err as Error).message ?? err).split('\n')[0]}` };
  }

  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await deps.ping()) {
      deps.log?.('Colima is up again, and Docker is answering.');
      return { state: 'started', how: 'Colima' };
    }
    await sleep(1000);
  }
  return { state: 'down', why: 'Colima came up, but Docker did not answer within a minute' };
}

/** `run` for real: a command with a time limit, never through a shell. */
export function runCommand(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr: `${stderr}${stdout}` }));
      else resolve(`${stdout}${stderr}`);
    });
  });
}
