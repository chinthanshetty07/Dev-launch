import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * What a Dockerfile makes the Docker daemon fetch — and whether DevLaunch lets it.
 *
 * Build steps run on `devlaunch-net`, under the egress rules. Some fetches are made by the
 * daemon itself, on the VM's own network, where those rules do not apply: `ADD <url>`,
 * and pulling the images named by `FROM` and `COPY --from` (and by a compose `image:`). An
 * `ADD http://192.168.1.1/` reached the home router; `192.168.5.2` is the Mac's own
 * localhost through Lima; `169.254.169.254` is cloud metadata — and the response is baked
 * into an image whose container can then send it anywhere (found by the independent
 * verifier, D-1). So those fetches are judged before anything is built.
 */

export interface DockerfileFetches {
  /** Images the daemon pulls: `FROM`, and `COPY --from=` naming an image. */
  images: string[];
  /** URLs the daemon downloads itself: `ADD https://…`, `ADD git@…`. */
  urls: string[];
  /** `FROM` lines whose image could not be worked out (an unset variable). */
  unresolved: string[];
}

/** Read a Dockerfile's instructions: comments dropped, `\` continuations joined. */
function instructions(text: string): string[] {
  const out: string[] = [];
  let pending = '';
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!pending && /^\s*#/.test(line)) continue;
    if (/\\\s*$/.test(line)) {
      pending += line.replace(/\\\s*$/, ' ');
      continue;
    }
    const full = (pending + line).trim();
    pending = '';
    if (full) out.push(full);
  }
  if (pending.trim()) out.push(pending.trim());
  return out;
}

function substitute(value: string, vars: Record<string, string>): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?-([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, a, def, b) => {
    const name = a ?? b;
    if (vars[name] !== undefined && vars[name] !== '') return vars[name]!;
    return def !== undefined ? def : m;
  });
}

/** Everything a Dockerfile makes the daemon fetch, with `ARG` defaults and build args applied. */
export function dockerfileFetches(text: string, buildArgs: Record<string, string> = {}): DockerfileFetches {
  const vars: Record<string, string> = {};
  const stages = new Set<string>();
  const out: DockerfileFetches = { images: [], urls: [], unresolved: [] };
  for (const ins of instructions(text)) {
    const [word, ...rest] = ins.split(/\s+/);
    const keyword = (word ?? '').toUpperCase();
    const args = rest;
    if (keyword === 'ARG') {
      for (const a of args) {
        const eq = a.indexOf('=');
        const name = eq > 0 ? a.slice(0, eq) : a;
        vars[name] = buildArgs[name] ?? (eq > 0 ? a.slice(eq + 1).replace(/^["']|["']$/g, '') : vars[name] ?? '');
      }
    } else if (keyword === 'FROM') {
      const positional = args.filter((a) => !a.startsWith('--'));
      const image = substitute(positional[0] ?? '', vars);
      const as = positional.findIndex((a) => a.toUpperCase() === 'AS');
      if (as > 0 && positional[as + 1]) stages.add(positional[as + 1]!.toLowerCase());
      if (!image) continue;
      if (/\$/.test(image)) out.unresolved.push(positional[0]!);
      else if (!stages.has(image.toLowerCase()) && image.toLowerCase() !== 'scratch') out.images.push(image);
    } else if (keyword === 'COPY' || keyword === 'ADD') {
      for (const a of args) {
        const from = /^--from=(.+)$/.exec(a)?.[1];
        if (from) {
          const name = substitute(from, vars);
          if (!stages.has(name.toLowerCase()) && !/^\d+$/.test(name)) out.images.push(name);
        }
      }
      if (keyword === 'ADD') {
        for (const a of args.filter((x) => !x.startsWith('--'))) {
          if (/^(?:https?|git|ssh):\/\//i.test(a) || /^git@/i.test(a)) out.urls.push(substitute(a, vars));
        }
      }
    }
  }
  return out;
}

/** The registry host an image is pulled from, or null for Docker Hub. */
export function registryHost(image: string): string | null {
  const first = image.split('/')[0]!;
  if (!image.includes('/')) return null;
  return /[.:]/.test(first) || first === 'localhost' ? first : null;
}

const LOCAL_NAMES = /(^|\.)(localhost|local|internal|lan|home|intranet|corp|localdomain)$/i;

/** True for an address no public service lives at: private, loopback, link-local, CGNAT. */
export function privateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v6 = ip.toLowerCase();
  return v6 === '::1' || v6 === '::' || v6.startsWith('fe80') || v6.startsWith('fc') || v6.startsWith('fd') ||
    v6.startsWith('::ffff:') && privateAddress(v6.slice(7));
}

/**
 * Why the daemon must not pull this image, or null. Docker Hub and public registries
 * are allowed; a registry on this machine, the VM, the home network or a cloud's
 * metadata range is not — the daemon would reach it from outside the egress rules.
 */
export async function registryProblem(
  image: string,
  resolve: (host: string) => Promise<string[]> = async (h) => (await lookup(h, { all: true })).map((a) => a.address),
): Promise<string | null> {
  const host = registryHost(image);
  if (host === null) return null;
  const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  // Any address literal: a public registry has a name, and an address is how a private
  // one — or this machine's — is reached.
  if (isIP(name)) return `${image} is pulled from ${privateAddress(name) ? 'a private address' : 'an address'} (${name}), not a public registry`;
  if (LOCAL_NAMES.test(name) || !name.includes('.')) return `${image} is pulled from ${name}, a name that only means something on this network`;
  const addresses = await resolve(name).catch(() => [] as string[]);
  if (addresses.length === 0) return `${image} is pulled from ${name}, which does not resolve`;
  const inside = addresses.find(privateAddress);
  return inside ? `${image} is pulled from ${name}, which points at a private address (${inside})` : null;
}

/**
 * Every reason a Dockerfile cannot be built here, named. Empty when it can.
 */
export async function dockerfileProblems(
  text: string,
  buildArgs: Record<string, string> = {},
  resolve?: (host: string) => Promise<string[]>,
): Promise<string[]> {
  const f = dockerfileFetches(text, buildArgs);
  const out: string[] = [];
  for (const url of f.urls) {
    out.push(`ADD ${url.slice(0, 120)}: the Docker daemon downloads it itself, outside the build sandbox's network rules — download it in a RUN step instead`);
  }
  for (const from of f.unresolved) out.push(`FROM ${from}: the image depends on a variable with no value, so where it comes from cannot be checked`);
  for (const image of [...new Set(f.images)]) {
    const problem = await registryProblem(image, resolve);
    if (problem) out.push(problem);
  }
  return out;
}
