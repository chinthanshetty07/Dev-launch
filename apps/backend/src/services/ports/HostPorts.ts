import { createServer } from 'node:net';

/**
 * Choose the host port a service will be published on, before anything starts.
 *
 * Docker can assign one itself, and for a lone service that is the better answer — it
 * cannot collide. A project cannot afford it: the frontend's `VITE_API_URL` and the
 * backend's `CORS_ORIGIN` both have to be decided *before* either container is created,
 * and a port Docker has not assigned yet cannot be written into either. Choosing first
 * turns a circular dependency into a straight line.
 *
 * The preference matters too. A repository that hardcodes `http://localhost:5001` works
 * only if its API is reachable there, and publishing on a random port is what made a
 * healthy stack show `Failed to fetch`.
 */
/**
 * Addresses that must all be bindable before a port counts as free.
 *
 * One probe is not enough, and which one is missing depends on who is holding the port.
 * Measured on a real machine, against two ports that were genuinely in use:
 *
 * ```
 * held by Colima's forwarder on *:5001      held by a Vite server on ::1:5173
 *   bind 127.0.0.1 -> free                    bind 127.0.0.1 -> free
 *   bind ::1       -> free                    bind ::1       -> EADDRINUSE
 *   bind 0.0.0.0   -> EADDRINUSE              bind 0.0.0.0   -> free
 * ```
 *
 * Node sets `SO_REUSEADDR`, which on BSD lets a specific address bind alongside a
 * wildcard — so a loopback probe walks straight past every Docker-published port, and a
 * wildcard probe walks past anything bound to `::1`. Getting this wrong is not a near
 * miss: publishing onto an occupied port fails the whole project with an opaque
 * `failed to set up container networking` from the daemon, and publishing onto a port
 * something else owns silently sends the browser to that other application.
 */
const PROBE_ADDRESSES = ['0.0.0.0', '::1', '127.0.0.1'] as const;

function canBind(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, host);
  });
}

export async function isPortFree(port: number): Promise<boolean> {
  for (const host of PROBE_ADDRESSES) {
    // A host with no IPv6 at all reports every ::1 bind as failing, which would make
    // every port look taken. Treat an address-family error as "nothing is there".
    const free = await canBind(port, host).catch(() => true);
    if (!free) return false;
  }
  return true;
}

/** A free ephemeral port, chosen by the OS and released immediately. */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error('no port assigned'))));
    });
  });
}

export interface PortChoice {
  port: number;
  /** True when the preferred port was taken, so a URL built from it would be wrong. */
  substituted: boolean;
  preferred?: number;
}

/**
 * The first free port from `preferences`, falling back to any free one.
 *
 * `taken` carries ports already handed out in this same project but not yet bound, which
 * `isPortFree` cannot see: two services asking for 3000 would otherwise both be told yes.
 */
export async function choosePort(
  preferences: readonly (number | null | undefined)[],
  taken: Set<number>,
): Promise<PortChoice> {
  const wanted = preferences.filter((p): p is number => typeof p === 'number' && p > 0);

  for (const port of wanted) {
    if (taken.has(port)) continue;
    if (await isPortFree(port)) {
      taken.add(port);
      return { port, substituted: false, preferred: wanted[0] };
    }
  }

  for (;;) {
    const port = await freePort();
    if (taken.has(port)) continue;
    taken.add(port);
    return { port, substituted: wanted.length > 0, preferred: wanted[0] };
  }
}
