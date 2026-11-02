import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FailureCode, RunPlanSchema, classifyEnvVar } from '@devlaunch/shared';
import { RepositoryAnalyzer } from '../services/analysis/RepositoryAnalyzer.js';
import { RuleBasedPlanner, planRust } from '../services/planning/RuleBasedPlanner.js';
import { RunPlanValidator } from '../services/planning/RunPlanValidator.js';
import { findRustPort, parseCargoToml, readRust } from '../services/analysis/rustProject.js';
import { clapEnvFields, discoverServices, selfSigningReads } from '../services/analysis/ServiceDiscovery.js';
import { isPlaceholder } from '../services/analysis/parseEnvExample.js';
import { desktopProgram } from '../services/session/SessionManager.js';
import { runnerRecipe } from '../services/docker/DockerManager.js';
import { buildWrapperEnv } from '../services/docker/wrapper.js';
import { imageForRuntime } from '../services/security/ImageAllowlist.js';
import { foreignRuntimes } from '../services/analysis/ForeignRuntimes.js';

/**
 * Rust: planned by rule, from Cargo.toml and the source. Each case below is from a real
 * repository that ran end to end: `litsynp/rust-axum-todo-api` (axum + sqlx, port from
 * `SocketAddr::from((Ipv4Addr::UNSPECIFIED, 8000))`), `SL-Lee/actix-web-todo-app` (actix +
 * diesel + a rollup-built Svelte page beside it), `launchbadge/realworld-axum-sqlx` (sqlx
 * macros that need the tables while compiling; HMAC_KEY through clap).
 */
const scratch: string[] = [];
afterAll(async () => {
  await Promise.all(scratch.map((d) => rm(d, { recursive: true, force: true })));
});
async function repo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'devlaunch-rust-'));
  scratch.push(root);
  for (const [p, body] of Object.entries(files)) {
    await mkdir(dirname(join(root, p)), { recursive: true });
    await writeFile(join(root, p), body);
  }
  return root;
}
const analyzer = new RepositoryAnalyzer();
const planOf = async (files: Record<string, string>) => new RuleBasedPlanner(analyzer).plan(await analyzer.analyze(await repo(files)));

const axum = {
  'Cargo.toml': '[package]\nname = "todo-api"\nversion = "0.1.0"\n\n[dependencies]\naxum = "0.7"\ntokio = { version = "1", features = ["full"] }\n',
  'src/main.rs': 'mod server;\nfn main() {}\n',
  'src/server.rs': 'let addr = SocketAddr::from((Ipv4Addr::UNSPECIFIED, 8000));\nlet listener = TcpListener::bind(&addr).await.unwrap();\n',
};

describe('reading a Rust project', () => {
  it('reads the manifest: name, dependencies (both table styles), programs, workspace members', () => {
    const m = parseCargoToml([
      '[package]', 'name = "app"', '', '[dependencies]', 'axum = "0.7"', 'sqlx = { version = "0.7", features = ["postgres"] }',
      '', '[dependencies.actix-web]', 'version = "4"', '', '[[bin]]', 'name = "app"', '[[bin]]', 'name = "add-user"',
    ].join('\n'));
    expect(m.name).toBe('app');
    expect(m.dependencies).toEqual(['axum', 'sqlx', 'actix-web']);
    expect(m.bins).toEqual(['app', 'add-user']);
    expect(m.postgresFeature).toBe(true);
    expect(parseCargoToml('[workspace]\nmembers = [\n  "crates/api",\n  "crates/cli",\n]\n').workspaceMembers).toEqual(['crates/api', 'crates/cli']);
  });

  it('reads the port from the ways servers write it down', () => {
    expect(findRustPort('TcpListener::bind("127.0.0.1:8080")')).toBe(8080);
    expect(findRustPort('HttpServer::new(f).bind(("0.0.0.0", 5000))?')).toBe(5000);
    expect(findRustPort('SocketAddr::from(([0, 0, 0, 0], 3000))')).toBe(3000);
    expect(findRustPort('SocketAddr::from((Ipv4Addr::UNSPECIFIED, 8000))')).toBe(8000);
    expect(findRustPort('let port = env::var("PORT").unwrap_or("4000".to_string());')).toBe(4000);
    expect(findRustPort('fn main() { println!("hi"); }')).toBeUndefined();
  });

  it('runs the member of a workspace that serves', async () => {
    const root = await repo({
      'Cargo.toml': '[workspace]\nmembers = ["crates/*"]\n',
      'crates/cli/Cargo.toml': '[package]\nname = "tool"\n[dependencies]\nclap = "4"\n',
      'crates/cli/src/main.rs': 'fn main() {}\n',
      'crates/api/Cargo.toml': '[package]\nname = "api-server"\n[dependencies]\nactix-web = "4"\n',
      'crates/api/src/main.rs': 'HttpServer::new(app).bind("127.0.0.1:8080")\n',
    });
    const rust = await readRust(root);
    expect(rust).toMatchObject({ runPackage: 'api-server', memberDir: 'crates/api', framework: 'actix-web', port: 8080 });
    expect(rust?.workspaceMembers?.sort()).toEqual(['crates/api', 'crates/cli']);
  });
});

describe('planning a Rust project', () => {
  it('fetches, compiles, then runs a server on the port its code binds', async () => {
    const out = await planOf(axum);
    expect(out.detected).toBe('axum');
    expect(out.plan).toMatchObject({
      runtime: { language: 'rust', version: '1' },
      packageManager: 'cargo',
      installCommand: 'cargo fetch',
      buildCommand: 'cargo build --release',
      startCommand: 'cargo run --release',
      expectedPort: 8000,
    });
    expect(() => new RunPlanValidator().validate({ plan: out.plan!, image: imageForRuntime('rust', '1') })).not.toThrow();
  });

  it('names the program when a package has several, and the package in a workspace', () => {
    const plan = planRust({ packageName: 'rust-todo-api', dependencies: ['axum'], bins: ['rust-todo-api', 'add-user'], hasMain: true, framework: 'axum', port: 8000 }, '.', [])!.plan!;
    expect(plan.startCommand).toBe('cargo run --release --bin rust-todo-api');
    const ws = planRust({ dependencies: ['actix-web'], bins: [], hasMain: true, framework: 'actix-web', runPackage: 'api-server' }, '.', [])!.plan!;
    expect(ws.buildCommand).toBe('cargo build --release -p api-server');
    // A name that is not a plain Cargo name is never put on the command line.
    expect(planRust({ dependencies: ['axum'], bins: [], hasMain: true, framework: 'axum', runPackage: 'x;rm' }, '.', [])!.plan!.startCommand).toBe('cargo run --release');
  });

  it('gives Rocket its own address variables, and its port', () => {
    const plan = planRust({ dependencies: ['rocket'], bins: [], hasMain: true, framework: 'rocket' }, '.', [])!.plan!;
    expect(plan.expectedPort).toBe(8000);
    expect(plan.environmentVariables).toEqual(expect.arrayContaining([
      { key: 'ROCKET_ADDRESS', value: '0.0.0.0', required: false },
      { key: 'ROCKET_PORT', value: '8000', required: false },
    ]));
  });

  it('runs a program that is not a server to completion, with no port to watch', () => {
    const plan = planRust({ dependencies: ['clap'], bins: [], hasMain: true }, '.', [])!.plan!;
    expect(plan.expectedPort).toBeNull();
    expect(planRust({ dependencies: ['serde'], bins: [], hasMain: false }, '.', [])).toBeNull();
  });

  it('builds what a Rust server serves, and its tables, before it compiles', async () => {
    // SL-Lee/actix-web-todo-app's shape: rollup bundles Svelte; diesel migrations; Postgres.
    const out = await planOf({
      'Cargo.toml': '[package]\nname = "todo"\n[dependencies]\nactix-web = "4"\ndiesel = { version = "2", features = ["postgres"] }\n',
      'src/main.rs': '.bind(env::var("SERVER_URL").unwrap_or_else(|_| "127.0.0.1:8080".to_string()))?\n',
      'migrations/2022-02-22-082237_create_users/up.sql': 'CREATE TABLE users (id uuid);\n',
      'package.json': JSON.stringify({ name: 'todo', scripts: { build: 'rollup -c', dev: 'rollup -c -w' }, devDependencies: { rollup: '2', svelte: '3' } }),
      'package-lock.json': '{"lockfileVersion": 3}',
    });
    expect(out.detected).toBe('actix-web');
    expect(out.plan?.buildCommand).toBe('npm ci --no-audit --no-fund && npm run build && devlaunch-diesel-migrate && cargo build --release');
    expect(out.plan?.expectedPort).toBe(8080);
    expect(() => new RunPlanValidator().validate({ plan: out.plan! })).not.toThrow();
  });

  it('applies sqlx migrations before compiling, since its macros check the tables', () => {
    const plan = planRust({ dependencies: ['axum', 'sqlx'], bins: [], hasMain: true, framework: 'axum', database: 'postgres', migrations: true }, '.', [])!.plan!;
    expect(plan.buildCommand).toBe('devlaunch-sqlx-migrate && cargo build --release');
    const offline = planRust({ dependencies: ['axum', 'sqlx'], bins: [], hasMain: true, framework: 'axum', database: 'postgres', sqlxOffline: true }, '.', [])!.plan!;
    expect(offline.environmentVariables).toContainEqual({ key: 'SQLX_OFFLINE', value: 'true', required: false });
  });

  it('says browser-side Rust is not run yet, rather than guessing', () => {
    const out = planRust({ dependencies: ['yew'], bins: [], hasMain: true, wasmFrontend: 'yew' }, '.', []);
    expect(out).toMatchObject({ plan: null, unrunnable: true });
    expect(out?.reason).toMatch(/yew app: Rust compiled to WebAssembly/);
  });

  it('is no longer a runtime DevLaunch declines', () => {
    expect(foreignRuntimes(['Cargo.toml', 'go.mod']).map((f) => f.runtime)).toEqual(['Go']);
  });
});

describe('a Rust desktop or terminal program', () => {
  it('is named as one, and a server that also uses such a crate is not', async () => {
    const game = await analyzer.analyze(await repo({ 'Cargo.toml': '[package]\nname = "game"\n[dependencies]\nbevy = "0.14"\n', 'src/main.rs': 'fn main() {}\n' }));
    expect(desktopProgram(game)).toMatchObject({ code: FailureCode.UNSUPPORTED_PROJECT });
    expect(desktopProgram(game)?.message).toMatch(/desktop program: it uses the bevy crate/);
    const tui = await analyzer.analyze(await repo({ 'Cargo.toml': '[package]\nname = "t"\n[dependencies]\nratatui = "0.28"\n', 'src/main.rs': 'fn main() {}\n' }));
    expect(desktopProgram(tui)?.message).toMatch(/terminal program/);
    const server = await analyzer.analyze(await repo({ 'Cargo.toml': '[package]\nname = "s"\n[dependencies]\naxum = "0.7"\ncrossterm = "0.27"\n', 'src/main.rs': 'fn main() {}\n' }));
    expect(desktopProgram(server)).toBeNull();
  });
});

describe('a Rust server among other services', () => {
  it('is a service with its database, and a package.json beside it does not hide it', async () => {
    const root = await repo({
      'Cargo.toml': '[package]\nname = "todo"\n[dependencies]\nactix-web = "4"\ndiesel = { version = "2", features = ["postgres"] }\n',
      'src/main.rs': '.bind("127.0.0.1:8080")\nlet url = env::var("DATABASE_URL").unwrap();\n',
      'package.json': JSON.stringify({ name: 'todo', scripts: { dev: 'rollup -c -w', build: 'rollup -c' } }),
    });
    const found = await discoverServices(root);
    expect(found.candidates.map((c) => [c.name, c.language, c.role])).toEqual([['todo', 'rust', 'api']]);
    expect(found.backing).toMatchObject([{ kind: 'postgres', evidence: 'uses diesel (postgres)' }]);
    expect(found.candidates[0]!.envKeys).toContain('DATABASE_URL');
  });

  it('leaves a Cargo.toml that is not a server to the other checks (a Node add-on built in Rust)', async () => {
    const root = await repo({
      'Cargo.toml': '[package]\nname = "native"\n[lib]\ncrate-type = ["cdylib"]\n[dependencies]\nnapi = "2"\n',
      'package.json': JSON.stringify({ name: 'web', scripts: { start: 'node server.js' }, dependencies: { express: '4' } }),
      'server.js': "require('express')().listen(3000);\n",
    });
    expect((await discoverServices(root)).candidates.map((c) => c.language)).toEqual(['node']);
  });
});

describe('settings a Rust program reads', () => {
  it('reads clap\'s env fields, and generates a signing key like HMAC_KEY itself', async () => {
    const config = [
      '#[derive(clap::Parser)]', 'pub struct Config {', '    /// The database.', '    #[clap(long, env)]', '    pub database_url: String,',
      '    #[clap(long, env)]', '    pub hmac_key: String,', '    #[arg(long, env = "APP_PORT")]', '    port: u16,', '    #[clap(long)]', '    verbose: bool,', '}',
    ].join('\n');
    expect(clapEnvFields(config)).toEqual(['DATABASE_URL', 'HMAC_KEY', 'APP_PORT']);
    expect(classifyEnvVar('HMAC_KEY')).toBe('AUTO_GENERATABLE_VALUE');
    const root = await repo({ 'Cargo.toml': '[package]\nname = "x"\n', 'src/config.rs': config });
    expect([...(await selfSigningReads(root))]).toEqual(['HMAC_KEY']);
    // `HMAC_KEY={random-string}` in .env.sample is where a value goes, not a value.
    expect(isPlaceholder('{random-string-at-least-48-characters}')).toBe(true);
  });
});

describe('the Rust runner', () => {
  it('is built from its recipe when missing, and gets the loopback bridge', () => {
    expect(runnerRecipe('devlaunch/rust:1')).toEqual({ dockerfile: 'rust.Dockerfile', buildargs: { RUST_VERSION: '1' } });
    expect(runnerRecipe('devlaunch/rust:2')).toBeNull();
    const plan = RunPlanSchema.parse({
      runtime: { language: 'rust', version: '1' }, packageManager: 'cargo', installCommand: 'cargo fetch', buildCommand: 'cargo build --release',
      startCommand: 'cargo run --release', workingDirectory: '.', expectedPort: 8080, planSource: 'rule-based',
    });
    expect(buildWrapperEnv(plan, '/workspace').filter((e) => e.startsWith('DL_BRIDGE_PORT='))).toEqual(['DL_BRIDGE_PORT=8080']);
  });
});
