import { describe, it, expect } from 'vitest';
import type { BackingService } from '@devlaunch/shared';
import { componentEnv, connectionEnv } from '../services/execution/BackingServices.js';
import { provisionedKeys, requiredConfigurationForSingle } from '../services/planning/RequiredConfiguration.js';

/**
 * A database DevLaunch starts, given as separate settings as well as a URL. Taken from
 * `jamall-mahmoudi-dev/django-react-production-stack`: it reads POSTGRES_HOST (default
 * `db`), POSTGRES_USER and the rest, was given only DATABASE_URL, and failed on
 * "could not translate host name "db"" against a Postgres DevLaunch had started.
 */
const pg: BackingService = { kind: 'postgres', evidence: 'psycopg2', urlEnvKeys: ['DATABASE_URL'], neededBy: [] } as BackingService;
const my: BackingService = { kind: 'mysql', evidence: 'mysqlclient', neededBy: [] } as BackingService;
const redis: BackingService = { kind: 'redis', evidence: 'redis', neededBy: [] } as BackingService;
const creds = { postgres: { password: 'p4ss', host: 'postgres-ab12' } };
const env = (list: { key: string; value: string }[]) => Object.fromEntries(list.map((v) => [v.key, v.value]));

describe('a started database, as separate settings', () => {
  it('gives Postgres under the names Django and node-postgres read, matching the URL exactly', () => {
    const all = env(connectionEnv([pg], 'app', creds));
    expect(all).toMatchObject({
      POSTGRES_HOST: 'postgres-ab12', POSTGRES_PORT: '5432', POSTGRES_USER: 'postgres',
      POSTGRES_PASSWORD: 'p4ss', POSTGRES_DB: 'app',
      PGHOST: 'postgres-ab12', PGUSER: 'postgres', PGPASSWORD: 'p4ss', PGDATABASE: 'app',
      DB_HOST: 'postgres-ab12', DB_NAME: 'app',
    });
    // The URL and the pieces name the same server, user, password and database.
    expect(all.DATABASE_URL).toBe('postgresql://postgres:p4ss@postgres-ab12:5432/app');
  });

  it('gives the generic DB_* names only when one SQL database runs', () => {
    const both = env(componentEnv([pg, my], 'app'));
    expect(both.POSTGRES_HOST).toBe('postgres');
    expect(both.MYSQL_HOST).toBe('mysql');
    expect(both.DB_HOST).toBeUndefined();
    expect(env(componentEnv([my], 'app'))).toMatchObject({ DB_HOST: 'mysql', DB_USER: 'root', MYSQL_DATABASE: 'app' });
  });

  it('gives Redis its host and port, and nothing that names a SQL database', () => {
    expect(env(componentEnv([redis], 'app'))).toEqual({ REDIS_HOST: 'redis', REDIS_PORT: '6379' });
  });

  it('never asks a person for a setting DevLaunch is about to supply', () => {
    expect(provisionedKeys([pg])).toEqual(expect.objectContaining({}));
    expect([...provisionedKeys([pg])]).toEqual(expect.arrayContaining(['DATABASE_URL', 'POSTGRES_PASSWORD', 'PGHOST', 'DB_PASSWORD']));
    const asked = requiredConfigurationForSingle({
      backing: [pg],
      envExample: [
        { key: 'POSTGRES_PASSWORD', hasDefault: false },
        { key: 'STRIPE_API_KEY', hasDefault: false },
      ],
    } as never);
    expect(asked.map((v) => v.key)).toEqual(['STRIPE_API_KEY']);
  });
});
