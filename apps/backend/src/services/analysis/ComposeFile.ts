import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { BackingService, ServiceRole } from '@devlaunch/shared';

/**
 * What the repository's author already wrote down about how to run it.
 *
 * Every other signal DevLaunch reads is an inference: a start script implies a command,
 * a dependency implies a database, a literal in source implies a port. A compose file is
 * none of those — it is a declaration, by the person who wrote the project, of exactly
 * which services exist, what each one runs, which ports they listen on, what environment
 * they need and which databases they depend on.
 *
 * Ignoring it is what made complex repositories fail. Measured on the three that failed
 * here, two shipped a compose file and one shipped a Makefile; DevLaunch read neither and
 * asked a model to guess what was written in plain sight. For one of them the guess was
 * `pip install -e .` at a repository root containing no Python package at all — the code
 * was two directories down, in a path the compose file names.
 *
 * This reads it as *evidence*, not as an execution format. DevLaunch still runs its own
 * hardened containers with its own networking; nothing here causes a compose file to be
 * executed, and `build:` contexts are read for their directory only.
 */

export interface ComposeService {
  name: string;
  /** Directory the service is built from, relative to the repository root. */
  dir?: string;
  /** Stock image, when the service is not built from source. */
  image?: string;
  /** Command override the author specified. */
  command?: string;
  /** Container port the service listens on, from the first published mapping. */
  containerPort?: number;
  /** Host port the author published it on, which siblings and browsers may assume. */
  hostPort?: number;
  /** Literal environment values. Interpolations and secrets are dropped. */
  environment: Record<string, string>;
  /** Variable names declared with no usable value, which still say what it reads. */
  declaredKeys: string[];
  dependsOn: string[];
  role: ServiceRole;
}

export interface ComposeSummary {
  services: ComposeService[];
  /** Services that are plainly databases, with the image the author chose. */
  backing: (Omit<BackingService, 'neededBy'> & { image?: string })[];
}

/** Images whose presence identifies a backing service, and what kind it is. */
const BACKING_IMAGES: { match: RegExp; kind: BackingService['kind'] }[] = [
  { match: /(^|\/)(postgres|pgvector|timescale|postgis)/i, kind: 'postgres' },
  { match: /(^|\/)mongo/i, kind: 'mongodb' },
  { match: /(^|\/)(mysql|mariadb|percona)/i, kind: 'mysql' },
  { match: /(^|\/)(redis|valkey)/i, kind: 'redis' },
];

const COMPOSE_NAMES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];

/** Read and summarise the repository's compose file, if it has one. */
export async function readCompose(base: string): Promise<ComposeSummary | null> {
  for (const name of COMPOSE_NAMES) {
    const raw = await readFile(join(base, name), 'utf8').catch(() => null);
    if (raw === null) continue;
    return summarise(raw);
  }
  return null;
}

export function summarise(raw: string): ComposeSummary | null {
  // Malformed YAML answers "nothing", never throws. A compose file is one signal among
  // several and nobody asked us to read it, so a parse error must not take down an
  // analysis that every other signal would have survived.
  let doc: unknown;
  try {
    doc = parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!doc || typeof doc !== 'object') return null;
  const services = (doc as { services?: unknown }).services;
  if (!services || typeof services !== 'object') return null;

  const out: ComposeService[] = [];
  const backing: ComposeSummary['backing'] = [];

  for (const [name, value] of Object.entries(services as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const s = value as Record<string, unknown>;

    const image = typeof s.image === 'string' ? s.image : undefined;
    const kind = image && BACKING_IMAGES.find((b) => b.match.test(image))?.kind;

    if (kind) {
      const env = readEnvironment(s.environment);
      backing.push({
        kind,
        // The author's own image, which matters: a project using pgvector needs
        // `pgvector/pgvector`, and plain `postgres` fails its first CREATE EXTENSION.
        image,
        evidence: `docker-compose declares ${name} (${image})`,
        urlEnvKeys: [],
        ...(env.POSTGRES_DB || env.MYSQL_DATABASE || env.MONGO_INITDB_DATABASE
          ? { database: env.POSTGRES_DB ?? env.MYSQL_DATABASE ?? env.MONGO_INITDB_DATABASE }
          : {}),
      });
      continue;
    }

    const { port: containerPort, hostPort } = readFirstPort(s.ports);
    const environment = readEnvironment(s.environment);
    out.push({
      name,
      dir: readBuildDir(s.build),
      image,
      command: readCommand(s.command),
      containerPort,
      hostPort,
      environment,
      declaredKeys: [...new Set([...Object.keys(environment), ...readDeclaredKeys(s.environment)])],
      dependsOn: readDependsOn(s.depends_on),
      role: 'api',
    });
  }

  if (out.length === 0 && backing.length === 0) return null;
  return { services: assignRoles(out), backing };
}

/**
 * Which service a browser opens.
 *
 * Compose says nothing about roles, so this is inferred the same way the rest of the
 * analyzer does it — but with one signal only compose has: a service published on a
 * browser-ish host port, depended on by nothing, is the front door.
 */
function assignRoles(services: ComposeService[]): ComposeService[] {
  const dependedOn = new Set(services.flatMap((s) => s.dependsOn));
  return services.map((s) => {
    const webName = /^(frontend|web|ui|client|app)$/i.test(s.name);
    const webPort = s.containerPort === 80 || s.containerPort === 3000 || s.containerPort === 5173;
    const isLeaf = !dependedOn.has(s.name);
    if (webName || (webPort && isLeaf)) return { ...s, role: 'web' as ServiceRole };
    // No published port at all is a worker: nothing can reach it and nothing should wait
    // for it to answer.
    if (s.containerPort === undefined) return { ...s, role: 'worker' as ServiceRole };
    return s;
  });
}

function readBuildDir(build: unknown): string | undefined {
  const raw =
    typeof build === 'string'
      ? build
      : build && typeof build === 'object' && typeof (build as { context?: unknown }).context === 'string'
        ? (build as { context: string }).context
        : undefined;
  if (raw === undefined) return undefined;
  const cleaned = raw.replace(/^\.\/+/, '').replace(/\/+$/, '');
  // `.` means the repository root, which is how the rest of DevLaunch spells it.
  return cleaned === '' || cleaned === '.' ? '.' : cleaned;
}

function readCommand(command: unknown): string | undefined {
  if (typeof command === 'string') return command;
  if (Array.isArray(command) && command.every((c) => typeof c === 'string')) {
    return (command as string[]).join(' ');
  }
  return undefined;
}

/** The first published mapping, which is the one a person is expected to open. */
function readFirstPort(ports: unknown): { port?: number; hostPort?: number } {
  if (!Array.isArray(ports)) return {};
  for (const entry of ports) {
    if (typeof entry === 'number') return { port: entry, hostPort: entry };
    if (typeof entry !== 'string') continue;
    // "8000", "8000:8000", "127.0.0.1:8000:8000", "3000:80"
    const parts = entry.split(':').filter(Boolean);
    const nums = parts.map(Number).filter((n) => Number.isInteger(n) && n > 0);
    if (nums.length === 0) continue;
    if (nums.length === 1) return { port: nums[0]!, hostPort: nums[0]! };
    return { hostPort: nums[nums.length - 2]!, port: nums[nums.length - 1]! };
  }
  return {};
}

/**
 * Literal environment values only.
 *
 * A compose file is full of `${VAR}` and `${VAR:-}` interpolations that resolve from the
 * user's shell, which DevLaunch does not have. Passing one through verbatim sets the
 * variable to the literal text `${VAR}` — worse than leaving it unset, because the
 * application then believes it is configured.
 */
function readEnvironment(env: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const add = (key: string, value: unknown): void => {
    if (typeof value !== 'string' && typeof value !== 'number') return;
    const text = String(value);
    if (text.includes('${') || text === '') return;
    out[key] = text;
  };

  if (Array.isArray(env)) {
    for (const entry of env) {
      if (typeof entry !== 'string') continue;
      const eq = entry.indexOf('=');
      if (eq > 0) add(entry.slice(0, eq), entry.slice(eq + 1));
    }
  } else if (env && typeof env === 'object') {
    for (const [k, v] of Object.entries(env as Record<string, unknown>)) add(k, v);
  }
  return out;
}

/** Names present but unusable, which still tell us what the service reads. */
function readDeclaredKeys(env: unknown): string[] {
  const keys: string[] = [];
  if (Array.isArray(env)) {
    for (const entry of env) {
      if (typeof entry === 'string') keys.push(entry.split('=')[0]!);
    }
  } else if (env && typeof env === 'object') {
    keys.push(...Object.keys(env as Record<string, unknown>));
  }
  return keys.filter(Boolean);
}

function readDependsOn(dep: unknown): string[] {
  if (Array.isArray(dep)) return dep.filter((d): d is string => typeof d === 'string');
  if (dep && typeof dep === 'object') return Object.keys(dep as Record<string, unknown>);
  return [];
}
