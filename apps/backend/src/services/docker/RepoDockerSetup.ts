import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, normalize, relative } from 'node:path';
import { parse } from 'yaml';

/**
 * A repository's own Docker setup, read as a plan DevLaunch can run under its own rules.
 *
 * Used only when DevLaunch cannot run a repository its own way (a stack it has no image
 * for, or a layout no rule recognises) and the repository ships a Dockerfile or a compose
 * file. Nothing here executes anything: it reads, decides, and refuses.
 *
 * The compose file is never handed to `docker compose`. Each service becomes a container
 * DevLaunch creates itself, which is the only way to guarantee the settings below are
 * refused rather than honoured — `docker compose up` would grant `privileged: true`
 * before anything had a chance to object.
 */

export interface DockerBuild {
  /** Directory sent to the builder, relative to the repository root. */
  context: string;
  /** Dockerfile path, relative to the repository root. */
  dockerfile: string;
  target?: string;
  /** Literal build arguments only; interpolations are dropped. */
  args: Record<string, string>;
}

export type DockerServiceRole = 'web' | 'api' | 'worker' | 'database';

export interface DockerService {
  /** The compose service name, or `app` for a lone Dockerfile. Also its network alias. */
  name: string;
  build?: DockerBuild;
  /** A stock image, when the service is not built. */
  image?: string;
  /** Command override, as an argument list. Never run through a shell by DevLaunch. */
  command?: string[];
  /** Entrypoint override, as an argument list. */
  entrypoint?: string[];
  /** Container ports, the first being the one a person opens. */
  ports: number[];
  environment: Record<string, string>;
  dependsOn: string[];
  /** Container paths that need persistent, writable storage (named volumes). */
  dataPaths: string[];
  role: DockerServiceRole;
}

export interface DockerSetup {
  source: 'dockerfile' | 'compose';
  /** The file it came from, relative to the repository root. */
  file: string;
  /** In start order: every service after the ones it depends on. */
  services: DockerService[];
  warnings: string[];
}

export type DockerSetupResult =
  | { kind: 'setup'; setup: DockerSetup }
  | { kind: 'refused'; file: string; reasons: string[] };

const COMPOSE_NAMES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];

/** Images whose port is a database protocol rather than HTTP. */
const DATABASE_IMAGES: { match: RegExp; port: number }[] = [
  { match: /(^|\/)(postgres|pgvector|timescale|postgis)/i, port: 5432 },
  { match: /(^|\/)(mysql|mariadb|percona)/i, port: 3306 },
  { match: /(^|\/)mongo(?!-express)/i, port: 27017 },
  { match: /(^|\/)(redis|valkey|keydb)/i, port: 6379 },
  { match: /(^|\/)memcached/i, port: 11211 },
  { match: /(^|\/)rabbitmq/i, port: 5672 },
  { match: /(^|\/)(elasticsearch|opensearch)/i, port: 9200 },
  { match: /(^|\/)(kafka|zookeeper|cp-kafka|redpanda)/i, port: 9092 },
  { match: /(^|\/)minio/i, port: 9000 },
];

/**
 * Settings refused outright, with why. Each one hands a container something the balanced
 * profile exists to withhold: the VM's kernel, its devices, its network, or its other
 * containers.
 */
const REFUSED_KEYS: Record<string, string> = {
  privileged: 'runs the container with every capability and every device of the VM',
  cap_add: 'adds Linux capabilities beyond the default set',
  devices: 'exposes the VM\'s devices to the container',
  device_cgroup_rules: 'allows the container to create device nodes',
  security_opt: 'changes the seccomp/AppArmor/no-new-privileges profile',
  userns_mode: 'changes the user namespace the container runs in',
  cgroup_parent: 'places the container in another cgroup',
  sysctls: 'changes kernel parameters',
  runtime: 'selects a different container runtime',
  isolation: 'changes the isolation technology',
  // Not applied by DevLaunch either way, but named rather than quietly ignored
  // (verifier D-4): each one asks for something the sandbox does not give.
  cgroup: 'shares the cgroup namespace with the VM',
  volumes_from: "mounts another container's volumes",
  extends: 'pulls service settings from elsewhere, which this reader does not follow',
  oom_kill_disable: 'turns off the kernel killing the container when it runs out of memory',
  pids_limit: 'changes the process limit DevLaunch sets',
  ulimits: 'changes resource limits DevLaunch sets',
  memswap_limit: 'changes the memory limit DevLaunch sets',
};

const HOST_NAMESPACES = ['network_mode', 'pid', 'ipc', 'uts'] as const;

/**
 * Read the repository's Docker setup, if it has one DevLaunch can run.
 *
 * A compose file wins over a lone Dockerfile: it is the author's statement of everything
 * that has to run, where a Dockerfile is one part of it.
 */
export async function readDockerSetup(root: string): Promise<DockerSetupResult | null> {
  for (const name of COMPOSE_NAMES) {
    const raw = await readFile(join(root, name), 'utf8').catch(() => null);
    if (raw === null) continue;
    return composeSetup(root, name, raw);
  }
  const dockerfile = await readFile(join(root, 'Dockerfile'), 'utf8').catch(() => null);
  if (dockerfile === null) return null;
  const ignoreNote = (await stat(join(root, '.dockerignore')).then(() => true, () => false))
    ? ['.dockerignore is not applied: the whole repository is sent to the build.']
    : [];
  return {
    kind: 'setup',
    setup: {
      source: 'dockerfile',
      file: 'Dockerfile',
      services: [
        {
          name: 'app',
          build: { context: '.', dockerfile: 'Dockerfile', args: {} },
          ports: exposedPorts(dockerfile),
          environment: {},
          dependsOn: [],
          dataPaths: [],
          role: 'web',
        },
      ],
      warnings: [
        ...(exposedPorts(dockerfile).length === 0
          ? ['The Dockerfile declares no EXPOSE port of its own; the port its base image declares is used, if it has one.']
          : []),
        ...ignoreNote,
      ],
    },
  };
}

/** `EXPOSE 8080`, `EXPOSE 80/tcp 443`, in file order. */
export function exposedPorts(dockerfile: string): number[] {
  const ports: number[] = [];
  for (const line of dockerfile.split('\n')) {
    const m = /^\s*EXPOSE\s+(.+)$/i.exec(line);
    if (!m) continue;
    for (const word of m[1]!.trim().split(/\s+/)) {
      const n = Number(word.replace(/\/(tcp|udp)$/i, ''));
      if (Number.isInteger(n) && n > 0 && n < 65536 && !/\/udp$/i.test(word)) ports.push(n);
    }
  }
  return [...new Set(ports)];
}

export async function composeSetup(root: string, file: string, raw: string): Promise<DockerSetupResult> {
  let doc: unknown;
  try {
    doc = parse(raw, { maxAliasCount: 100 }) as unknown;
  } catch (err) {
    return { kind: 'refused', file, reasons: [`${file} is not valid YAML: ${String(err instanceof Error ? err.message : err).split('\n')[0]}`] };
  }
  const services = (doc as { services?: unknown } | null)?.services;
  if (!services || typeof services !== 'object' || Array.isArray(services)) {
    return { kind: 'refused', file, reasons: [`${file} declares no services.`] };
  }

  const reasons: string[] = [];
  const warnings: string[] = [];
  if ((doc as { include?: unknown }).include !== undefined) {
    reasons.push('`include` pulls in other compose files, which this reader does not follow');
  }
  // What this reader applies, and what it does not, said rather than silently dropped
  // (verifier D-10).
  for (const extra of ['compose.override.yaml', 'compose.override.yml', 'docker-compose.override.yml', 'docker-compose.override.yaml']) {
    if (await stat(join(root, extra)).then(() => true, () => false)) warnings.push(`${extra} is not applied: only ${file} is read.`);
  }
  const out: DockerService[] = [];

  for (const [name, value] of Object.entries(services as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const s = value as Record<string, unknown>;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/.test(name)) {
      reasons.push(`service name "${name.slice(0, 40)}" is not a valid name`);
      continue;
    }
    // Not started by `docker compose up` either: a profile is an opt-in the author made.
    if (Array.isArray(s.profiles) && s.profiles.length > 0) {
      warnings.push(`Skipping ${name}: it belongs to a profile (${s.profiles.join(', ')}), which compose does not start by default.`);
      continue;
    }

    for (const [key, why] of Object.entries(REFUSED_KEYS)) {
      if (s[key] !== undefined && s[key] !== false && !(Array.isArray(s[key]) && (s[key] as unknown[]).length === 0)) {
        reasons.push(`${name}: \`${key}\` ${why}`);
      }
    }
    for (const ns of HOST_NAMESPACES) {
      const v = s[ns];
      if (typeof v === 'string' && (v === 'host' || v.startsWith('container:') || v.startsWith('service:'))) {
        reasons.push(`${name}: \`${ns}: ${v}\` shares a namespace with the VM or another container`);
      }
    }

    const volumes = readVolumes(root, name, s.volumes, reasons, warnings);
    let build: DockerBuild | undefined;
    if (s.build !== undefined) {
      build = readBuild(root, name, s.build, reasons) ?? undefined;
      if (!build) continue;
    }
    // `${TAG:-latest}`: the default is what compose would use with nothing in the shell.
    const image = typeof s.image === 'string' ? withDefaults(s.image) : undefined;
    if (!build && !image) {
      reasons.push(`${name}: has neither \`build\` nor \`image\``);
      continue;
    }
    if (image && !validImageName(image)) {
      reasons.push(`${name}: image "${image.slice(0, 80)}" is not a valid image reference`);
      continue;
    }

    const environment = {
      ...(await readEnvFiles(root, name, s.env_file, reasons)),
      ...readEnvironment(s.environment),
    };
    const ports = [...readPorts(s.ports), ...readPorts(s.expose)];
    if (ports.length === 0 && build) {
      const df = await readFile(join(root, build.dockerfile), 'utf8').catch(() => '');
      ports.push(...exposedPorts(df));
    }
    const database = image ? DATABASE_IMAGES.find((d) => d.match.test(image)) : undefined;
    if (database && ports.length === 0) ports.push(database.port);

    out.push({
      name,
      ...(build ? { build } : {}),
      ...(image ? { image } : {}),
      ...(readCommand(s.command) ? { command: readCommand(s.command)! } : {}),
      ...(readCommand(s.entrypoint) ? { entrypoint: readCommand(s.entrypoint)! } : {}),
      ports: [...new Set(ports)],
      environment,
      dependsOn: readDependsOn(s.depends_on),
      dataPaths: volumes,
      role: database ? 'database' : 'api',
    });
  }

  if (reasons.length > 0) return { kind: 'refused', file, reasons };
  if (out.length === 0) return { kind: 'refused', file, reasons: [`${file} has no service DevLaunch can start.`] };

  const known = new Set(out.map((s) => s.name));
  for (const s of out) {
    const missing = s.dependsOn.filter((d) => !known.has(d));
    if (missing.length) {
      warnings.push(`${s.name} depends on ${missing.join(', ')}, which is not started here.`);
      s.dependsOn = s.dependsOn.filter((d) => known.has(d));
    }
  }
  const ordered = startOrder(out);
  if (!ordered) return { kind: 'refused', file, reasons: [`${file}: depends_on forms a cycle, so no service can start first.`] };

  return { kind: 'setup', setup: { source: 'compose', file, services: assignRoles(ordered), warnings } };
}

/** Dependencies first; null on a cycle. */
export function startOrder(services: DockerService[]): DockerService[] | null {
  const byName = new Map(services.map((s) => [s.name, s]));
  const out: DockerService[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (s: DockerService): boolean => {
    const st = state.get(s.name);
    if (st === 'done') return true;
    if (st === 'visiting') return false;
    state.set(s.name, 'visiting');
    for (const d of s.dependsOn) if (!visit(byName.get(d)!)) return false;
    state.set(s.name, 'done');
    out.push(s);
    return true;
  };
  for (const s of services) if (!visit(s)) return null;
  return out;
}

/**
 * The browser's door: a non-database service nothing depends on, preferring one named
 * like a frontend. Every other HTTP service is an API; one with no port is a worker.
 */
function assignRoles(services: DockerService[]): DockerService[] {
  const dependedOn = new Set(services.flatMap((s) => s.dependsOn));
  const candidates = services.filter((s) => s.role !== 'database' && s.ports.length > 0);
  const named = candidates.find((s) => /^(frontend|web|ui|client|app|nginx|proxy|www)$/i.test(s.name));
  const leaf = candidates.filter((s) => !dependedOn.has(s.name));
  const door = named ?? (leaf.length === 1 ? leaf[0] : undefined) ?? candidates.at(-1);
  return services.map((s) => {
    if (s.role === 'database') return s;
    if (s.ports.length === 0) return { ...s, role: 'worker' };
    return { ...s, role: s === door ? 'web' : 'api' };
  });
}

/** Inside the repository, as a normalised relative path; null when it escapes. */
export function insideRepo(root: string, path: string): string | null {
  if (isAbsolute(path) || path.startsWith('~')) return null;
  const rel = normalize(path).replace(/\/+$/, '') || '.';
  const back = relative(root, join(root, rel));
  return back.startsWith('..') ? null : rel;
}

function readBuild(root: string, name: string, raw: unknown, reasons: string[]): DockerBuild | null {
  const spec = typeof raw === 'string' ? { context: raw } : (raw as Record<string, unknown>);
  if (!spec || typeof spec !== 'object') {
    reasons.push(`${name}: \`build\` is not understood`);
    return null;
  }
  const contextRaw = typeof spec.context === 'string' ? spec.context : '.';
  if (/^[a-z]+:\/\//i.test(contextRaw) || contextRaw.startsWith('git@')) {
    reasons.push(`${name}: builds from a remote context (${contextRaw.slice(0, 80)}), not from this repository`);
    return null;
  }
  const context = insideRepo(root, contextRaw);
  if (context === null) {
    reasons.push(`${name}: build context ${contextRaw} is outside the repository`);
    return null;
  }
  const dockerfileRaw = typeof spec.dockerfile === 'string' ? spec.dockerfile : 'Dockerfile';
  const dockerfile = insideRepo(root, join(context, dockerfileRaw));
  if (dockerfile === null) {
    reasons.push(`${name}: Dockerfile ${dockerfileRaw} is outside the repository`);
    return null;
  }
  if (spec.dockerfile_inline !== undefined) {
    reasons.push(`${name}: \`dockerfile_inline\` is not supported`);
    return null;
  }
  for (const key of ['ssh', 'secrets', 'additional_contexts', 'network', 'entitlements', 'privileged']) {
    if (spec[key] !== undefined) {
      reasons.push(`${name}: build \`${key}\` reaches outside the build sandbox`);
      return null;
    }
  }
  return {
    context,
    dockerfile,
    ...(typeof spec.target === 'string' ? { target: spec.target } : {}),
    args: readEnvironment(spec.args),
  };
}

/**
 * Volumes: a named volume becomes storage of the run's own; a bind mount inside the
 * repository is dropped (the image carries its code); anything else — a host path, the
 * Docker socket, a path above the repository — refuses the file.
 */
function readVolumes(root: string, name: string, raw: unknown, reasons: string[], warnings: string[]): string[] {
  if (!Array.isArray(raw)) return [];
  const data: string[] = [];
  for (const entry of raw) {
    let source: string | undefined;
    let target: string | undefined;
    let type: string | undefined;
    if (typeof entry === 'string') {
      const parts = entry.split(':');
      if (parts.length === 1) {
        target = parts[0];
      } else {
        source = parts[0];
        target = parts[1];
      }
    } else if (entry && typeof entry === 'object') {
      const e = entry as Record<string, unknown>;
      source = typeof e.source === 'string' ? e.source : undefined;
      target = typeof e.target === 'string' ? e.target : undefined;
      type = typeof e.type === 'string' ? e.type : undefined;
    }
    if (!target || !target.startsWith('/')) continue;
    if (source && /docker\.sock/.test(source)) {
      reasons.push(`${name}: mounts the Docker socket (${source}), which would control every container on the VM`);
      continue;
    }
    const isPath = source !== undefined && (type === 'bind' || /^[./~]/.test(source));
    if (!source || (!isPath && type !== 'bind')) {
      data.push(target);
      continue;
    }
    if (insideRepo(root, source) === null) {
      reasons.push(`${name}: mounts ${source} from outside the repository`);
      continue;
    }
    warnings.push(`${name}: not mounting ${source} at ${target}; the built image carries its own copy.`);
  }
  return data;
}

async function readEnvFiles(root: string, name: string, raw: unknown, reasons: string[]): Promise<Record<string, string>> {
  const files = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : [];
  const out: Record<string, string> = {};
  for (const f of files) {
    const path = typeof f === 'string' ? f : f && typeof f === 'object' && typeof (f as { path?: unknown }).path === 'string' ? (f as { path: string }).path : undefined;
    if (!path) continue;
    const rel = insideRepo(root, path);
    if (rel === null) {
      reasons.push(`${name}: reads env_file ${path} from outside the repository`);
      continue;
    }
    // A missing env_file is the common case (`.env` is gitignored); compose would fail,
    // DevLaunch carries on without it and the application says what it lacks.
    const ok = await stat(join(root, rel)).then((s) => s.isFile() && s.size < 256 * 1024, () => false);
    if (!ok) continue;
    const text = await readFile(join(root, rel), 'utf8');
    for (const line of text.split('\n')) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      let v = m[2]!.trim();
      const q = /^(["'])(.*)\1$/.exec(v);
      v = q ? q[2]! : v.replace(/\s+#.*$/, '');
      if (!v.includes('${')) out[m[1]!] = v;
    }
  }
  return out;
}

/** Literal values only; `${VAR}` resolves from a shell DevLaunch does not have. */
export function readEnvironment(env: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const add = (key: string, value: unknown): void => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return;
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return;
    const text = String(value);
    if (text.includes('${') || /[\0\n\r]/.test(text)) return;
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

/** Container ports from `ports` ("8000", "3000:80", "127.0.0.1:80:80/tcp", {target}) or `expose`. */
export function readPorts(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const out: number[] = [];
  for (const entry of raw) {
    if (typeof entry === 'number') {
      out.push(entry);
      continue;
    }
    if (entry && typeof entry === 'object') {
      const t = Number((entry as { target?: unknown }).target);
      if (Number.isInteger(t) && t > 0) out.push(t);
      continue;
    }
    if (typeof entry !== 'string' || /\/udp$/i.test(entry)) continue;
    const last = entry.replace(/\/tcp$/i, '').split(':').pop()!;
    const n = Number(last.split('-')[0]);
    if (Number.isInteger(n) && n > 0 && n < 65536) out.push(n);
  }
  return out;
}

function readCommand(command: unknown): string[] | undefined {
  if (Array.isArray(command) && command.length > 0 && command.every((c) => typeof c === 'string')) {
    return command as string[];
  }
  // Compose splits a string command the way a shell splits words — quotes kept together —
  // without running a shell. Splitting on spaces broke `sh -c "a && b"` (verifier D-9).
  if (typeof command === 'string' && command.trim() !== '') return shellWords(command);
  return undefined;
}

/** Words as a POSIX shell splits them: quotes group, backslash escapes, nothing expands. */
export function shellWords(text: string): string[] {
  const out: string[] = [];
  let word = '';
  let inWord = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < text.length && /["\\$`]/.test(text[i + 1]!)) word += text[++i];
      else word += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      inWord = true;
    } else if (c === '\\' && i + 1 < text.length) {
      word += text[++i];
      inWord = true;
    } else if (/\s/.test(c)) {
      if (inWord) out.push(word);
      word = '';
      inWord = false;
    } else {
      word += c;
      inWord = true;
    }
  }
  if (inWord) out.push(word);
  return out;
}

/** `${NAME:-default}` and `${NAME-default}` with nothing set: the default. */
function withDefaults(value: string): string {
  return value.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*:?-([^}]*)\}/g, '$1');
}

function readDependsOn(dep: unknown): string[] {
  if (Array.isArray(dep)) return dep.filter((d): d is string => typeof d === 'string');
  if (dep && typeof dep === 'object') return Object.keys(dep as Record<string, unknown>);
  return [];
}

/** `name[:tag][@digest]` with an optional registry; nothing a shell or API could misread. */
export function validImageName(image: string): boolean {
  return /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?(?:\/[a-z0-9]+(?:[._-]{1,2}[a-z0-9]+)*)*(?::[\w][\w.-]{0,127})?(?:@sha256:[a-f0-9]{64})?$/.test(image);
}
