import type { BackingService } from '@devlaunch/shared';

/**
 * How DevLaunch runs a database, and how an application reaches it.
 *
 * These are stock upstream images rather than DevLaunch's own, which is safe for one
 * specific reason: they run **as the non-root user the image already defines**, so the
 * entrypoint never needs to chown a data directory or switch user. Measured, not
 * assumed — under `--cap-drop ALL` with `no-new-privileges`, mongo's entrypoint fails
 * with `failed switching to 'mongodb': operation not permitted`, because it tries to do
 * both. Starting as uid 999 skips that path entirely and keeps the full hardening
 * profile the runner images get.
 */
export interface BackingSpec {
  kind: BackingService['kind'];
  image: string;
  /** Hostname other containers reach it on. */
  alias: string;
  port: number;
  /** The image's own unprivileged user, so no privilege drop is needed. */
  user: string;
  /**
   * Paths that must be writable under a read-only rootfs.
   *
   * Anonymous volumes, so data lives exactly as long as the session does. A dev-launch
   * tool that silently accumulated database state across runs would be surprising in a
   * worse way than one that starts clean.
   */
  dataPaths: string[];
  /**
   * Environment for the server, given the database name the application will ask for.
   *
   * A function rather than a list because of what the name has to do: the connection
   * string DevLaunch injects names a database per repository, and Postgres and MySQL
   * create exactly one database at init and nothing afterwards. Without the name here,
   * every injected URL pointed at a database that was never created — the server was
   * healthy, the credentials right, and the connection refused with `database "x" does
   * not exist`. MongoDB hid this for a long time by creating databases on first write.
   */
  env(database: string, password?: string): string[];
  /** Command that exits 0 once the service is accepting connections. */
  readyCheck(password?: string): string[];
  /** Environment variable an application conventionally reads its connection from. */
  defaultEnvKey: string;
  /** Connection string, given a database name, and the run's password and host name. */
  url(database: string, creds?: Partial<BackingCredentials>): string;
}

/**
 * How one run reaches its database: the name it answers to on the network, and its
 * password.
 *
 * Both were the same for every run — `postgres`, `devlaunch` — so two runs at once (a
 * raised concurrency limit) registered one name twice, Docker answered it round-robin,
 * and an application connected, migrated and passed its checks against another run's
 * database, which it could read and write (audit A-08). Each run now has its own password,
 * and takes the plain name only when no other run holds it.
 */
export interface BackingCredentials {
  password: string;
  host: string;
}

/** The fallback, for callers that state none. Each provisioned run gets its own. */
const PASSWORD = 'devlaunch';

/**
 * Where an image keeps its data, for the tag it is. Postgres 18 moved it one level up, to
 * `/var/lib/postgresql`, and refuses to start with anything mounted at the old
 * `/var/lib/postgresql/data` ("in 18+, these Docker images are configured to store database
 * data in a format which is compatible with pg_ctlcluster"). With the old path every
 * `postgres:18` a project named fell back to DevLaunch's own Postgres 16, not the version
 * it asked for (`fastapi/full-stack-fastapi-template`).
 */
export function dataPathsFor(spec: Pick<BackingSpec, 'kind' | 'dataPaths'>, image: string): string[] {
  if (spec.kind !== 'postgres') return spec.dataPaths;
  const major = Number(/:(\d+)/.exec(image)?.[1] ?? NaN);
  if (!(major >= 18)) return spec.dataPaths;
  return spec.dataPaths.map((p) => (p === '/var/lib/postgresql/data' ? '/var/lib/postgresql' : p));
}

export const BACKING_SPECS: Readonly<Record<BackingService['kind'], BackingSpec>> = Object.freeze({
  mongodb: {
    kind: 'mongodb',
    image: 'mongo:7',
    alias: 'mongodb',
    port: 27017,
    user: '999:999',
    dataPaths: ['/data/db', '/data/configdb'],
    // Created on first write; naming it up front would change nothing.
    env: () => [],
    readyCheck: () => ['mongosh', '--quiet', '--eval', 'db.adminCommand({ ping: 1 }).ok'],
    defaultEnvKey: 'MONGODB_URI',
    url: (database, c) => `mongodb://${c?.host ?? 'mongodb'}:27017/${database}`,
  },
  postgres: {
    kind: 'postgres',
    image: 'postgres:16',
    alias: 'postgres',
    port: 5432,
    user: '999:999',
    dataPaths: ['/var/lib/postgresql/data', '/var/run/postgresql'],
    env: (database, password = PASSWORD) => [`POSTGRES_PASSWORD=${password}`, 'POSTGRES_USER=postgres', `POSTGRES_DB=${database}`],
    readyCheck: () => ['pg_isready', '-U', 'postgres'],
    defaultEnvKey: 'DATABASE_URL',
    url: (database, c) => `postgresql://postgres:${c?.password ?? PASSWORD}@${c?.host ?? 'postgres'}:5432/${database}`,
  },
  mysql: {
    kind: 'mysql',
    image: 'mysql:8',
    alias: 'mysql',
    port: 3306,
    user: '999:999',
    dataPaths: ['/var/lib/mysql', '/var/run/mysqld'],
    env: (database, password = PASSWORD) => [`MYSQL_ROOT_PASSWORD=${password}`, `MYSQL_DATABASE=${database}`],
    // As root, named. The check runs as the container's own user, `mysql`, and without
    // `-u` mysqladmin connects as that user, is refused, and never prints "mysqld is
    // alive" — so no MySQL was ever reported ready, while the server logged "ready for
    // connections" and the application connected to it without trouble.
    readyCheck: (password = PASSWORD) => ['mysqladmin', 'ping', '-h', '127.0.0.1', '-u', 'root', `-p${password}`],
    defaultEnvKey: 'MYSQL_URL',
    url: (database, c) => `mysql://root:${c?.password ?? PASSWORD}@${c?.host ?? 'mysql'}:3306/${database}`,
  },
  redis: {
    kind: 'redis',
    image: 'redis:7',
    alias: 'redis',
    port: 6379,
    user: '999:999',
    dataPaths: ['/data'],
    // Redis has no databases to create; it numbers them and they always exist.
    env: () => [],
    readyCheck: () => ['redis-cli', 'ping'],
    defaultEnvKey: 'REDIS_URL',
    url: (_database, c) => `redis://${c?.host ?? 'redis'}:6379`,
  },
});

/**
 * Images DevLaunch may run as a backing service, by kind.
 *
 * A repository's compose file names the image it needs, and often that is not the stock
 * one: a project using pgvector needs `pgvector/pgvector`, and plain `postgres` starts
 * perfectly and then fails the application's first `CREATE EXTENSION vector`. Honouring
 * that is the difference between a database that exists and one that works.
 *
 * It is also repository-controlled text choosing a container image, which is exactly the
 * thing an allowlist exists to prevent. So the repository may only move DevLaunch between
 * *known variants of the kind it already detected* — never to an arbitrary image, never
 * to another registry. An unrecognised name is declined and the stock image used, which
 * degrades to the previous behaviour rather than to trust.
 */
const APPROVED_BACKING_REPOS: Readonly<Record<BackingService['kind'], readonly string[]>> =
  Object.freeze({
    postgres: ['postgres', 'pgvector/pgvector', 'postgis/postgis', 'timescale/timescaledb'],
    mongodb: ['mongo'],
    mysql: ['mysql', 'mariadb'],
    redis: ['redis', 'valkey/valkey'],
  });

/** Every image name the allowlist permits, for tests and for reporting. */
export const APPROVED_BACKING_IMAGES: readonly string[] = Object.freeze(
  Object.values(BACKING_SPECS).map((s) => s.image),
);

/**
 * Whether this image may be run for this kind of backing service.
 *
 * Anchored deliberately: a bare `name` or `name:tag` on Docker Hub and nothing else. A
 * value carrying a registry host, a path, a digest or a tag outside the ordinary
 * character set is declined rather than parsed, because the only reason for a compose
 * file to name `evil.example.com/postgres` is one DevLaunch should not serve.
 */
export function isBackingImageApproved(image: string, kind: BackingService['kind']): boolean {
  const match = /^([a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)?)(?::([A-Za-z0-9][A-Za-z0-9._-]*))?$/.exec(
    image,
  );
  if (!match) return false;
  return (APPROVED_BACKING_REPOS[kind] ?? []).includes(match[1]!);
}

/**
 * A database name derived from the repository, so two projects do not share one.
 *
 * Cosmetic for an ephemeral database, but it is what appears in the application's own
 * logs and error messages, and `mongodb://mongodb:27017/undefined` reads like a bug.
 */
export function databaseName(repoName: string | undefined): string {
  const cleaned = (repoName ?? 'devlaunch')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return cleaned || 'devlaunch';
}

/**
 * SQLAlchemy dialects, which name the driver inside the URL scheme.
 *
 * Only the async ones are listed, because they are the ones that *must* be named. A
 * sync driver is SQLAlchemy's default for its dialect, so `postgresql://` already
 * reaches psycopg2; an async driver is not, so the same URL loads psycopg2 and raises
 * "The asyncio extension requires an async driver to be used" against a perfectly
 * healthy database. Observed on a repository that declared asyncpg and was handed the
 * plain scheme: three separate start attempts, none of which could have worked.
 */
const ASYNC_DIALECTS: Readonly<Record<string, string>> = Object.freeze({
  asyncpg: 'postgresql+asyncpg',
  aiomysql: 'mysql+aiomysql',
  asyncmy: 'mysql+asyncmy',
  aiosqlite: 'sqlite+aiosqlite',
});

/**
 * The connection string for one backing service, in the dialect its driver requires.
 *
 * Exported so both the single-service and the project path build it identically; a URL
 * that differs between them is a defect that only reproduces on one kind of repository.
 */
export function connectionUrl(need: BackingService, database: string, creds?: Partial<BackingCredentials>): string {
  const spec = BACKING_SPECS[need.kind];
  const url = spec.url(database, creds);
  const dialect = need.driver ? ASYNC_DIALECTS[need.driver] : undefined;
  if (!dialect) return url;

  // Replace only the scheme. Everything after it — credentials, host, database — was
  // decided by the spec and is already correct.
  return url.replace(/^[a-z0-9+]+:\/\//i, `${dialect}://`);
}

/**
 * The environment variables an application needs to reach its backing services.
 *
 * The key discovered from the repository wins: an application that reads `MONGO_URI`
 * will not find `MONGODB_URI`, and guessing wrong is indistinguishable from not
 * providing one at all.
 */
export function connectionEnv(
  backing: BackingService[],
  database: string,
  creds: Partial<Record<BackingService['kind'], BackingCredentials>> = {},
): { key: string; value: string; required: boolean }[] {
  const out: { key: string; value: string; required: boolean }[] = [];
  for (const need of backing) {
    const spec = BACKING_SPECS[need.kind];
    if (!spec) continue;
    const url = connectionUrl(need, database, creds[need.kind]);
    // An *empty* list is not a declaration, it is the absence of one, and `?? ` does not
    // catch it. A database detected only from a hardcoded URL in the source declares no
    // variable at all — correctly, because the application reads none — and it was
    // provisioned, healthy, and injected under no name whatsoever.
    const declared = need.urlEnvKeys?.length ? need.urlEnvKeys : undefined;
    const keys = new Set(declared ?? [need.urlEnvKey ?? spec.defaultEnvKey]);
    for (const key of keys) out.push({ key, value: url, required: false });
  }
  // The same database, as the separate settings many applications read instead of a URL.
  for (const v of componentEnv(backing, database, creds)) {
    if (!out.some((o) => o.key === v.key)) out.push({ ...v, required: false });
  }
  return out;
}

/** The SQL kinds, for which the generic DB_* names are unambiguous only when one is running. */
const SQL_KINDS: readonly BackingService['kind'][] = ['postgres', 'mysql'];

/**
 * A provisioned service's connection as separate settings — host, port, user, password and
 * database — under the names applications conventionally read.
 *
 * A URL alone was not enough. `jamall-mahmoudi-dev/django-react-production-stack` reads
 * `POSTGRES_HOST` (default `db`, its compose service), `POSTGRES_USER` and the rest; DevLaunch
 * started Postgres and passed only `DATABASE_URL`, so the backend looked for a host called
 * `db` and failed. Same values as the URL, so the two can never disagree. The generic
 * `DB_*` / `DATABASE_*` names are given only when exactly one SQL database runs: with two,
 * which one they mean is a guess.
 */
export function componentEnv(
  backing: readonly BackingService[],
  database: string,
  creds: Partial<Record<BackingService['kind'], BackingCredentials>> = {},
): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = [];
  const sql = backing.filter((b) => SQL_KINDS.includes(b.kind));
  for (const need of backing) {
    const spec = BACKING_SPECS[need.kind];
    if (!spec) continue;
    const host = creds[need.kind]?.host ?? spec.alias;
    const password = creds[need.kind]?.password ?? PASSWORD;
    const port = String(spec.port);
    const add = (names: string[], value: string) => names.forEach((key) => out.push({ key, value }));
    if (need.kind === 'postgres' || need.kind === 'mysql') {
      const user = need.kind === 'postgres' ? 'postgres' : 'root';
      const P = need.kind === 'postgres' ? 'POSTGRES' : 'MYSQL';
      add([`${P}_HOST`], host);
      add([`${P}_PORT`], port);
      add([`${P}_USER`], user);
      add([`${P}_PASSWORD`], password);
      add([need.kind === 'postgres' ? 'POSTGRES_DB' : 'MYSQL_DATABASE'], database);
      if (need.kind === 'postgres') {
        add(['PGHOST'], host); add(['PGPORT'], port); add(['PGUSER'], user);
        add(['PGPASSWORD'], password); add(['PGDATABASE'], database);
      }
      if (sql.length === 1) {
        add(['DB_HOST', 'DATABASE_HOST'], host);
        add(['DB_PORT', 'DATABASE_PORT'], port);
        add(['DB_USER', 'DB_USERNAME', 'DATABASE_USER'], user);
        add(['DB_PASSWORD', 'DATABASE_PASSWORD'], password);
        add(['DB_NAME', 'DB_DATABASE', 'DATABASE_NAME'], database);
      }
    } else if (need.kind === 'redis') {
      add(['REDIS_HOST'], host); add(['REDIS_PORT'], port);
    } else if (need.kind === 'mongodb') {
      add(['MONGO_HOST', 'MONGODB_HOST'], host); add(['MONGO_PORT', 'MONGODB_PORT'], port);
    }
  }
  return out;
}
