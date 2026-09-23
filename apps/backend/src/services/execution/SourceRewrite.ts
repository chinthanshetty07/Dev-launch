import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { FailureCode } from '@devlaunch/shared';
import { assertSafeRelativePath } from '../security/PathValidator.js';
import { SecurityRejection } from '../security/ImageAllowlist.js';

/**
 * Point a loopback address written into a repository's source at something the container
 * can actually reach.
 *
 * Off by default, and this is the one place DevLaunch modifies a repository at all. The
 * default is what it is because "run this project" and "change this project" are
 * different promises, and a tool that quietly does the second while claiming the first
 * is one you cannot trust the output of. So the rule elsewhere is to *find* the literal
 * and name the line — which costs nothing and is always right.
 *
 * But naming the line does not run the project, and two very common shapes cannot be run
 * any other way:
 *
 * - `proxy: { '/api': 'http://localhost:8000' }` in a Vite config. The dev server
 *   resolves this itself, inside the frontend's own container, so `localhost` is the
 *   frontend. Every request the page makes returns 502 through a stack that is otherwise
 *   working perfectly.
 * - `create_engine("postgresql://user:pw@localhost/db")` in Python. It reads no
 *   environment variable, so there is nothing to inject; the provisioned database sits
 *   unreachable beside the application.
 *
 * Both are a literal host in a file. Neither is reachable by any plan, any flag or any
 * variable. With the flag on, the literal is rewritten — in DevLaunch's own clone in a
 * temporary directory, never in anything the user has checked out — and every edit is
 * returned so the log can say exactly what changed and why.
 *
 * What keeps this from being a licence to edit repositories:
 *
 * - **Only files analysis already identified.** No tree-wide search and replace.
 * - **Only the exact literal that was found**, once, and only when it is still there.
 * - **Only inside the clone**, checked by resolved path rather than by trusting a name.
 * - **Only a loopback host.** A target that already names a reachable host is left alone.
 */

export interface SourceRewrite {
  /** Path relative to the repository root. */
  file: string;
  from: string;
  to: string;
  /** Why, for the log line that tells a person what was changed in their code. */
  reason: string;
}

export interface RewriteRequest {
  /** The file to edit, relative to `root`. */
  file: string;
  /** The exact text to replace. Nothing happens if it is not present. */
  from: string;
  to: string;
  reason: string;
}

/** Largest file this will read. A minified bundle is not a config file. */
const MAX_REWRITE_BYTES = 512 * 1024;

/**
 * Apply the requested rewrites, returning the ones that were actually made.
 *
 * A request whose file is missing, too large, or no longer contains the literal is
 * skipped rather than failing the run: the repository is the source of truth about what
 * it contains, and an edit that no longer applies is not an error.
 */
export async function applySourceRewrites(
  root: string,
  requests: readonly RewriteRequest[],
): Promise<SourceRewrite[]> {
  const applied: SourceRewrite[] = [];

  const base = await realpath(resolve(root)).catch(() => null);
  if (base === null) return applied;

  for (const request of requests) {
    const path = await resolveInside(base, request.file);
    if (path === null) continue;

    const info = await stat(path).catch(() => null);
    if (!info?.isFile() || info.size > MAX_REWRITE_BYTES) continue;

    const before = await readFile(path, 'utf8').catch(() => null);
    if (before === null || !before.includes(request.from)) continue;

    // Once. A literal appearing twice is two decisions, and replacing both on the
    // evidence of having found one is the kind of latitude this must not take.
    const after = before.replace(request.from, request.to);
    if (after === before) continue;

    await writeFile(path, after, 'utf8');
    applied.push({ file: request.file, from: request.from, to: request.to, reason: request.reason });
  }

  return applied;
}

/**
 * The real path of a file inside the clone, or null if it is not inside it.
 *
 * `path.resolve` is not enough and a test caught it: it flattens `..` but follows no
 * links, so `link.txt -> /tmp/elsewhere/secret.txt` inside the clone resolves to a path
 * that is textually inside it and physically is not. A repository is untrusted input and
 * can contain any symlink its author wrote, so the only sound check is the one the
 * kernel does — `realpath`, on both ends, compared after.
 *
 * A path that does not exist yet has no real path; that is a file this will not write,
 * which is the correct answer anyway.
 */
async function resolveInside(base: string, file: string): Promise<string | null> {
  try {
    assertSafeRelativePath(file, 'rewrite target');
  } catch (err) {
    if (err instanceof SecurityRejection) return null;
    throw err;
  }
  const real = await realpath(resolve(join(base, file))).catch(() => null);
  if (real === null) return null;
  return real === base || real.startsWith(base + sep) ? real : null;
}

/** Hosts a container cannot reach when its own source names them. */
const LOOPBACK_HOST = /^(?:localhost|127\.0\.0\.1|\[?::1\]?|0\.0\.0\.0)$/i;

/**
 * The same URL with its host replaced, or null when there is nothing to change.
 *
 * Only the host: the port, the path, the credentials and the scheme are the
 * repository's decisions and stay exactly as written. A proxy target pointing at
 * `localhost:8000` becomes `http://api:8000`, and the `/api` prefix it is mounted under
 * is not this function's business.
 */
export function repointHost(url: string, host: string, port?: number): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!LOOPBACK_HOST.test(parsed.hostname)) return null;

  const from = originalHost(url);
  if (from === '') return null;

  // The port too, when the caller knows one.
  //
  // The port in the literal describes the author's own machine — `localhost:5001` is
  // where *they* run the API — and DevLaunch does not have to guess where it put it: it
  // planned that service and knows the port it listens on. Keeping the literal's number
  // produced `http://backend:5001` against a service listening on 3000, which is the
  // same 502 the rewrite existed to prevent, now with a plausible-looking host.
  const authority = port === undefined ? host : `${host}:${port}`;
  const oldAuthority = parsed.port === '' ? from : `${from}:${parsed.port}`;
  return url.replace(port === undefined ? from : oldAuthority, authority);
}

/** The host exactly as the URL spells it, so the replacement changes nothing else. */
function originalHost(url: string): string {
  const m = /^[a-z0-9+.-]+:\/\/(?:[^@/]*@)?(\[[^\]]+\]|[^:/?#]+)/i.exec(url);
  return m?.[1] ?? '';
}

/**
 * A rewrite that sends a database URL at a provisioned server.
 *
 * The whole URL is replaced, not only its host, because the credentials and database
 * name in the literal describe a server on the author's machine — `postgres:test1234!`
 * against `TodoApplicationDatabase` — and none of them is true of the one DevLaunch
 * started. Repointing the host alone produces `password authentication failed`, which is
 * a worse failure than the one it replaced: it looks like a DevLaunch bug rather than a
 * hardcoded credential.
 */
export function databaseUrlRewrite(
  file: string,
  literal: string,
  provisioned: string,
): RewriteRequest | null {
  if (literal === provisioned) return null;
  let host: string;
  try {
    host = new URL(literal).hostname;
  } catch {
    return null;
  }
  if (!LOOPBACK_HOST.test(host)) return null;

  return {
    file,
    from: literal,
    to: provisioned,
    reason:
      `it names a database on localhost, which inside this container is the application ` +
      `itself; this is the server DevLaunch started for it`,
  };
}
