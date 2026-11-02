import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { RustSummary } from '@devlaunch/shared';
import { readCapped } from './readCapped.js';

/**
 * What a Rust project is, read from `Cargo.toml` and its source: which package runs, with
 * which web framework, on which port, needing which database.
 *
 * Read with a small line reader rather than a TOML library: DevLaunch needs a handful of
 * keys (`[package] name`, the dependency names, `[[bin]]` names, `[workspace] members`),
 * and a manifest it cannot fully parse should still yield those, as `package.json` does.
 */

/** Web frameworks, by crate, as the planner names them. */
const WEB_FRAMEWORKS: Record<string, RustSummary['framework'] & string> = {
  'actix-web': 'actix-web',
  axum: 'axum',
  rocket: 'rocket',
  warp: 'warp',
  poem: 'poem',
  tide: 'tide',
  salvo: 'salvo',
  'loco-rs': 'loco',
  hyper: 'hyper',
};

/**
 * Crates that draw in a window or run a game loop on the computer's own screen: a desktop
 * program, with no web page (the Rust side of `desktopProgram`).
 */
const DESKTOP_CRATES = [
  'bevy', 'eframe', 'egui', 'iced', 'druid', 'tauri', 'gtk', 'gtk4', 'fltk', 'slint',
  'macroquad', 'ggez', 'piston_window', 'winit', 'minifb', 'sdl2', 'raylib', 'ratatui', 'crossterm',
];

/** Crates that build a page which runs in the browser as WebAssembly (served by Trunk). */
const WASM_FRONTENDS = ['yew', 'leptos', 'dioxus', 'sycamore', 'seed'];

/** The `[section]` a line belongs to, and its `key = value` lines, in order. */
function sections(toml: string): { name: string; lines: string[] }[] {
  const out: { name: string; lines: string[] }[] = [{ name: '', lines: [] }];
  for (const raw of toml.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    const head = /^\[\[?([^\]]+)\]\]?$/.exec(line);
    if (head) out.push({ name: head[1]!.trim(), lines: [] });
    else if (line) out[out.length - 1]!.lines.push(line);
  }
  return out;
}

const keyOf = (line: string): string | undefined => /^([A-Za-z0-9_-]+)\s*[=.]/.exec(line)?.[1];
const stringValue = (lines: string[], key: string): string | undefined =>
  lines.map((l) => new RegExp(`^${key}\\s*=\\s*"([^"]*)"`).exec(l)?.[1]).find((v) => v !== undefined);

/** The manifest's own facts, before the source is read. */
export function parseCargoToml(toml: string): {
  name?: string;
  dependencies: string[];
  bins: string[];
  workspaceMembers: string[];
  postgresFeature: boolean;
  mysqlFeature: boolean;
  sqliteFeature: boolean;
} {
  const secs = sections(toml);
  const pkg = secs.find((s) => s.name === 'package');
  const deps = new Set<string>();
  for (const s of secs) {
    if (/^(?:dependencies|target\..*\.dependencies)$/.test(s.name)) {
      for (const l of s.lines) {
        const k = keyOf(l);
        if (k) deps.add(k);
      }
    }
    // `[dependencies.actix-web]` with its version on the following lines.
    const dotted = /^dependencies\.([A-Za-z0-9_-]+)$/.exec(s.name);
    if (dotted) deps.add(dotted[1]!);
  }
  const bins = secs.filter((s) => s.name === 'bin').map((s) => stringValue(s.lines, 'name')).filter((n): n is string => !!n);
  const ws = secs.find((s) => s.name === 'workspace');
  const membersText = ws ? /members\s*=\s*\[([\s\S]*?)\]/.exec(toml.slice(toml.indexOf('[workspace]')))?.[1] ?? '' : '';
  const workspaceMembers = [...membersText.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
  return {
    ...(pkg && stringValue(pkg.lines, 'name') ? { name: stringValue(pkg.lines, 'name') } : {}),
    dependencies: [...deps],
    bins,
    workspaceMembers,
    postgresFeature: /\bpostgres\b/.test(toml),
    mysqlFeature: /\bmysql\b/.test(toml),
    sqliteFeature: /\bsqlite\b/.test(toml),
  };
}

/**
 * The port the code listens on, from the address it binds: `"0.0.0.0:8080"`,
 * `("127.0.0.1", 8080)`, `SocketAddr::from(([0, 0, 0, 0], 3000))`, a PORT default
 * (`unwrap_or("8080")`), or `.port(8000)`.
 */
export function findRustPort(source: string): number | undefined {
  const patterns = [
    /"(?:0\.0\.0\.0|127\.0\.0\.1|localhost|\[::\]|::1?):(\d{2,5})"/,
    /\(\s*"(?:0\.0\.0\.0|127\.0\.0\.1|localhost|::1?)"\s*,\s*(\d{2,5})\s*\)/,
    /\[\s*(?:0|127)\s*,\s*0\s*,\s*0\s*,\s*[01]\s*\]\s*,\s*(\d{2,5})\s*\)/,
    // `SocketAddr::from((Ipv4Addr::UNSPECIFIED, 8000))` (`litsynp/rust-axum-todo-api`).
    /(?:Ipv4Addr|Ipv6Addr|IpAddr)::(?:UNSPECIFIED|LOCALHOST|V4\([^)]*\)|V6\([^)]*\))\s*,\s*(\d{2,5})\s*\)/,
    /env::var\(\s*"PORT"\s*\)[\s\S]{0,80}?unwrap_or(?:_else)?\([^)]*?"?(\d{2,5})"?/,
    /\.port\(\s*(\d{2,5})\s*\)/,
  ];
  for (const p of patterns) {
    const m = p.exec(source);
    if (m) return Number(m[1]);
  }
  return undefined;
}

/** Up to `limit` `.rs` files under `src/`, the entry points first. */
async function sourceFiles(base: string, limit = 40): Promise<string[]> {
  const out: string[] = [];
  for (const f of ['src/main.rs', 'src/lib.rs']) out.push(join(base, f));
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (out.length >= limit || depth > 3) return;
    const entries = (await readdir(dir, { withFileTypes: true }).catch(() => [])).sort((a, b) => Number(a.isDirectory()) - Number(b.isDirectory()));
    for (const e of entries) {
      if (out.length >= limit) return;
      if (e.isDirectory()) {
        if (e.name !== 'target' && !e.name.startsWith('.')) await walk(join(dir, e.name), depth + 1);
      } else if (e.name.endsWith('.rs') && !out.includes(join(dir, e.name))) out.push(join(dir, e.name));
    }
  };
  await walk(join(base, 'src'), 0);
  return out;
}

/** A Rust project at `base`, or undefined when there is no Cargo.toml. */
export async function readRust(base: string): Promise<RustSummary | undefined> {
  const toml = await readCapped(join(base, 'Cargo.toml'));
  if (toml === null) return undefined;
  const manifest = parseCargoToml(toml);

  // A workspace root with no package of its own: the member that serves something runs.
  if (!manifest.name && manifest.workspaceMembers.length > 0) {
    const members: { dir: string; summary: RustSummary }[] = [];
    for (const pattern of manifest.workspaceMembers.slice(0, 20)) {
      const dirs = pattern.endsWith('/*')
        ? (await readdir(join(base, pattern.slice(0, -2)), { withFileTypes: true }).catch(() => []))
            .filter((e) => e.isDirectory())
            .map((e) => `${pattern.slice(0, -2)}/${e.name}`)
        : [pattern];
      for (const dir of dirs) {
        const summary = await readRust(join(base, dir));
        if (summary?.packageName) members.push({ dir, summary });
      }
    }
    const runs = members.find((m) => m.summary.framework) ?? members.find((m) => m.summary.hasMain);
    const chosen: RustSummary = runs ? { ...runs.summary, runPackage: runs.summary.packageName!, memberDir: runs.dir } : { dependencies: [], bins: [], hasMain: false };
    return { ...chosen, workspaceMembers: members.map((m) => m.dir) };
  }

  const deps = manifest.dependencies;
  const framework = Object.entries(WEB_FRAMEWORKS).find(([crate]) => deps.includes(crate))?.[1];
  const files = await sourceFiles(base);
  let port: number | undefined;
  let readsPort = false;
  for (const file of files) {
    const src = await readCapped(file);
    if (src === null) continue;
    port ??= findRustPort(src);
    if (/env::var\(\s*"PORT"\s*\)/.test(src)) readsPort = true;
  }
  const hasMain = (await readCapped(join(base, 'src/main.rs'))) !== null || manifest.bins.length > 0;
  const desktop = DESKTOP_CRATES.find((c) => deps.includes(c));
  const wasm = WASM_FRONTENDS.find((c) => deps.includes(c));
  const sqlx = deps.includes('sqlx');
  const database: RustSummary['database'] =
    deps.includes('mongodb') ? 'mongodb'
    : (sqlx || deps.includes('diesel') || deps.includes('sea-orm')) && manifest.postgresFeature ? 'postgres'
    : deps.includes('tokio-postgres') || deps.includes('postgres') ? 'postgres'
    : (sqlx || deps.includes('diesel') || deps.includes('sea-orm')) && manifest.mysqlFeature ? 'mysql'
    : deps.includes('redis') ? 'redis'
    : undefined;

  return {
    ...(manifest.name ? { packageName: manifest.name } : {}),
    dependencies: deps,
    bins: manifest.bins,
    hasMain,
    ...(framework ? { framework } : {}),
    ...(port ? { port } : {}),
    ...(readsPort ? { readsPort } : {}),
    ...(desktop && !framework ? { desktopCrate: desktop } : {}),
    ...(wasm && !framework ? { wasmFrontend: wasm } : {}),
    ...(database ? { database } : {}),
    ...(deps.includes('diesel') ? { diesel: true } : {}),
    ...(sqlx && (await readdir(join(base, '.sqlx')).then(() => true, () => false)) ? { sqlxOffline: true } : {}),
    ...(await readdir(join(base, 'migrations')).then(() => ({ migrations: true }), () => ({}))),
  };
}
