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
  env: string[];
  /** Command that exits 0 once the service is accepting connections. */
  readyCheck: string[];
  /** Environment variable an application conventionally reads its connection from. */
  defaultEnvKey: string;
  /** Connection string, given a database name. */
  url(database: string): string;
}

/** Password for the databases that insist on one. Local, ephemeral, never published. */
const PASSWORD = 'devlaunch';

export const BACKING_SPECS: Readonly<Record<BackingService['kind'], BackingSpec>> = Object.freeze({
  mongodb: {
    kind: 'mongodb',
    image: 'mongo:7',
    alias: 'mongodb',
    port: 27017,
    user: '999:999',
    dataPaths: ['/data/db', '/data/configdb'],
    env: [],
    readyCheck: ['mongosh', '--quiet', '--eval', 'db.adminCommand({ ping: 1 }).ok'],
    defaultEnvKey: 'MONGODB_URI',
    url: (database) => `mongodb://mongodb:27017/${database}`,
  },
  postgres: {
    kind: 'postgres',
    image: 'postgres:16',
    alias: 'postgres',
    port: 5432,
    user: '999:999',
    dataPaths: ['/var/lib/postgresql/data', '/var/run/postgresql'],
    env: [`POSTGRES_PASSWORD=${PASSWORD}`, 'POSTGRES_USER=postgres'],
    readyCheck: ['pg_isready', '-U', 'postgres'],
    defaultEnvKey: 'DATABASE_URL',
    url: (database) => `postgresql://postgres:${PASSWORD}@postgres:5432/${database}`,
  },
  mysql: {
    kind: 'mysql',
    image: 'mysql:8',
    alias: 'mysql',
    port: 3306,
    user: '999:999',
    dataPaths: ['/var/lib/mysql', '/var/run/mysqld'],
    env: [`MYSQL_ROOT_PASSWORD=${PASSWORD}`],
    readyCheck: ['mysqladmin', 'ping', '-h', '127.0.0.1', `-p${PASSWORD}`],
    defaultEnvKey: 'MYSQL_URL',
    url: (database) => `mysql://root:${PASSWORD}@mysql:3306/${database}`,
  },
  redis: {
    kind: 'redis',
    image: 'redis:7',
    alias: 'redis',
    port: 6379,
    user: '999:999',
    dataPaths: ['/data'],
    env: [],
    readyCheck: ['redis-cli', 'ping'],
    defaultEnvKey: 'REDIS_URL',
    url: () => 'redis://redis:6379',
  },
});

/** Images DevLaunch may run as backing services. Frozen, like the runtime allowlist. */
export const APPROVED_BACKING_IMAGES: readonly string[] = Object.freeze(
  Object.values(BACKING_SPECS).map((s) => s.image),
);

export function isBackingImageApproved(image: string): boolean {
  return APPROVED_BACKING_IMAGES.includes(image);
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
 * The environment variables an application needs to reach its backing services.
 *
 * The key discovered from the repository wins: an application that reads `MONGO_URI`
 * will not find `MONGODB_URI`, and guessing wrong is indistinguishable from not
 * providing one at all.
 */
export function connectionEnv(
  backing: BackingService[],
  database: string,
): { key: string; value: string; required: boolean }[] {
  const out: { key: string; value: string; required: boolean }[] = [];
  for (const need of backing) {
    const spec = BACKING_SPECS[need.kind];
    if (!spec) continue;
    const url = spec.url(database);
    const keys = new Set(need.urlEnvKeys ?? [need.urlEnvKey ?? spec.defaultEnvKey]);
    for (const key of keys) out.push({ key, value: url, required: false });
  }
  return out;
}
