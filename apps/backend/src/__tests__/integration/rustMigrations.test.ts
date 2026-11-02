import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DockerManager } from '../../services/docker/DockerManager.js';

/**
 * The Rust runner's migration helpers against a real Postgres: what `diesel migration run`
 * and `sqlx migrate run` do, without compiling either CLI first. Recorded in each tool's own
 * table — for sqlx with its own checksum, which `sqlx::migrate!()` compares when the app
 * starts (`launchbadge/realworld-axum-sqlx` started cleanly on these records).
 */
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
const id = `dl-mig-${Date.now()}`;
const net = `${id}-net`;
const pgUrl = `postgres://postgres:pw@${id}-pg:5432/app`;

beforeAll(async () => {
  await new DockerManager().ensureImage('devlaunch/rust:1');
  docker('network', 'create', net);
  docker('run', '-d', '--name', `${id}-pg`, '--network', net, '-e', 'POSTGRES_PASSWORD=pw', '-e', 'POSTGRES_DB=app', 'postgres:16');
  docker('run', '-d', '--name', `${id}-rust`, '--network', net, '-e', `DATABASE_URL=${pgUrl}`, '--entrypoint', 'sleep', 'devlaunch/rust:1', '600');
  for (let i = 0; i < 60; i++) {
    try {
      docker('exec', `${id}-pg`, 'pg_isready', '-U', 'postgres', '-d', 'app');
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}, 300_000);

afterAll(() => {
  for (const c of [`${id}-rust`, `${id}-pg`]) {
    try { docker('rm', '-f', c); } catch { /* already gone */ }
  }
  try { docker('network', 'rm', net); } catch { /* already gone */ }
});

/** Copy a folder of migrations into the runner, as /workspace/<name>. */
function put(name: string, files: Record<string, string>): void {
  const dir = mkdtempSync(join(tmpdir(), 'devlaunch-mig-'));
  // mkdtemp makes it owner-only, and `docker cp` keeps that: the runner's user could not read it.
  chmodSync(dir, 0o755);
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(dir, p, '..'), { recursive: true, mode: 0o755 });
    writeFileSync(join(dir, p), body, { mode: 0o644 });
  }
  docker('cp', `${dir}/.`, `${id}-rust:/workspace/${name}`);
}
const sql = (q: string) => docker('exec', `${id}-pg`, 'psql', '-U', 'postgres', '-d', 'app', '-tAc', q);

describe('the Rust runner\'s migration helpers', () => {
  it('applies sqlx migrations with sqlx\'s own record and checksum, once', () => {
    const first = 'CREATE TABLE users (id serial primary key, name text);\n';
    put('sqlx', { '1_setup.sql': first, '2_add_email.sql': 'ALTER TABLE users ADD COLUMN email text;\n', '3_reversible.up.sql': 'CREATE TABLE tags (id serial);\n', '3_reversible.down.sql': 'DROP TABLE tags;\n' });
    const out = docker('exec', '-w', '/workspace', `${id}-rust`, 'devlaunch-sqlx-migrate', 'sqlx');
    expect(out).toMatch(/applying migration 1_setup\.sql[\s\S]*3_reversible\.up\.sql[\s\S]*migrations applied/);
    expect(sql("select version, description, success from _sqlx_migrations order by version")).toBe('1|setup|t\n2|add email|t\n3|reversible|t');
    expect(sql("select encode(checksum, 'hex') from _sqlx_migrations where version = 1")).toBe(createHash('sha384').update(first).digest('hex'));
    expect(sql("select count(*) from information_schema.columns where table_name = 'users' and column_name = 'email'")).toBe('1');
    // Run again: nothing applied twice.
    expect(docker('exec', '-w', '/workspace', `${id}-rust`, 'devlaunch-sqlx-migrate', 'sqlx')).not.toMatch(/applying/);
  }, 120_000);

  it('applies diesel migrations in order, recorded as diesel records them, once', () => {
    put('diesel', {
      '00000000000000_diesel_initial_setup/up.sql': 'CREATE OR REPLACE FUNCTION noop() RETURNS void AS $$ BEGIN END $$ LANGUAGE plpgsql;\n',
      '2022-02-22-082237_create_todo/up.sql': 'CREATE TABLE todo (id serial primary key, title text);\n',
      '2022-02-22-082237_create_todo/down.sql': 'DROP TABLE todo;\n',
    });
    const out = docker('exec', '-w', '/workspace', `${id}-rust`, 'devlaunch-diesel-migrate', 'diesel');
    expect(out).toMatch(/applying migration 00000000000000_diesel_initial_setup[\s\S]*create_todo[\s\S]*migrations applied/);
    expect(sql('select version from __diesel_schema_migrations order by version')).toBe('00000000000000\n20220222082237');
    expect(sql("select to_regclass('public.todo') is not null")).toBe('t');
    expect(docker('exec', '-w', '/workspace', `${id}-rust`, 'devlaunch-diesel-migrate', 'diesel')).not.toMatch(/applying/);
  }, 120_000);

  it('stops on a migration that fails, and records nothing for it', () => {
    // Version 9: 1 is applied above, and an applied version is (rightly) skipped.
    put('broken', { '9_bad.sql': 'CREATE TABLE ok (id int);\nTHIS IS NOT SQL;\n' });
    expect(() => docker('exec', '-w', '/workspace', `${id}-rust`, 'sh', '-c', 'DATABASE_URL=${DATABASE_URL%/app}/app devlaunch-sqlx-migrate broken')).toThrow();
    expect(sql("select to_regclass('public.ok') is null")).toBe('t');
    expect(sql('select count(*) from _sqlx_migrations where version = 9')).toBe('0');
  }, 120_000);
});
