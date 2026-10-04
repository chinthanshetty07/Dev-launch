import { readdir } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { readCapped } from './readCapped.js';

/**
 * Relative imports that resolve only if letter case is ignored.
 *
 * macOS and Windows file systems ignore case, so `import { FeedbackPanel } from
 * './feedbackPanel'` works on the author's machine when the file is `FeedbackPanel.tsx`.
 * Linux does not, and every DevLaunch container is Linux:
 * `fakir-tech/typescript-fullstack-monorepo` served a 500 for exactly that. Found before the
 * run and named — the file, the line, what it imports and what the file is really called.
 *
 * Bounded: source files only, at most `maxFiles` of them, never inside dependency or build
 * directories.
 */
export interface CaseMismatch {
  file: string;
  line: number;
  imported: string;
  actual: string;
}

const SOURCE = /\.(?:[cm]?[jt]sx?|vue|svelte)$/;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.nuxt', 'out', 'coverage', '.svelte-kit', 'vendor']);
const EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte', '.json', '.css', '.scss'];
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["'](\.{1,2}\/[^"']+)["']/gm;

async function sourceFiles(root: string, maxFiles: number): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (out.length >= maxFiles || depth > 12) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (out.length >= maxFiles) return;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) await walk(join(dir, e.name), depth + 1);
      } else if (e.isFile() && SOURCE.test(e.name)) {
        out.push(join(dir, e.name));
      }
    }
  };
  await walk(root, 0);
  return out;
}

/** Directory listings, read once each. */
function lister() {
  const cache = new Map<string, Promise<string[]>>();
  return (dir: string) => {
    let p = cache.get(dir);
    if (!p) {
      p = readdir(dir).catch(() => [] as string[]);
      cache.set(dir, p);
    }
    return p;
  };
}

/**
 * How `spec`, imported from `fromDir`, resolves: `exact` when a file or directory matches
 * as written, otherwise the case-insensitive match, otherwise nothing.
 */
async function resolveCase(
  fromDir: string,
  spec: string,
  list: (dir: string) => Promise<string[]>,
): Promise<{ exact: boolean; actual?: string }> {
  const parts = spec.split('/').filter((p) => p !== '' && p !== '.');
  let dir = fromDir;
  const actualParts: string[] = [];
  let caseOnly = false;
  for (const [i, part] of parts.entries()) {
    if (part === '..') {
      dir = dirname(dir);
      actualParts.push('..');
      continue;
    }
    const names = await list(dir);
    const last = i === parts.length - 1;
    const candidates = last ? EXTENSIONS.map((ext) => part + ext) : [part];
    const exact = candidates.find((c) => names.includes(c));
    if (exact) {
      actualParts.push(exact);
      dir = join(dir, exact);
      continue;
    }
    const lower = new Map(names.map((n) => [n.toLowerCase(), n]));
    const loose = candidates.map((c) => lower.get(c.toLowerCase())).find((n): n is string => n !== undefined);
    if (!loose) return { exact: false };
    caseOnly = true;
    actualParts.push(loose);
    dir = join(dir, loose);
  }
  return caseOnly ? { exact: false, actual: actualParts.join('/') } : { exact: true };
}

export async function findCaseMismatches(root: string, maxFiles = 2000, maxReports = 20): Promise<CaseMismatch[]> {
  const list = lister();
  const out: CaseMismatch[] = [];
  for (const file of await sourceFiles(root, maxFiles)) {
    const text = await readCapped(file);
    if (text === null) continue;
    for (const m of text.matchAll(IMPORT)) {
      const spec = m[1]!;
      const r = await resolveCase(dirname(file), spec, list);
      if (r.exact || !r.actual) continue;
      out.push({
        file: relative(root, file).split(sep).join('/'),
        line: text.slice(0, m.index).split('\n').length,
        imported: spec,
        actual: r.actual,
      });
      if (out.length >= maxReports) return out;
    }
  }
  return out;
}

/** The planning warning for them. */
export function caseMismatchWarning(found: readonly CaseMismatch[]): string {
  const shown = found
    .slice(0, 3)
    .map((f) => `${f.file}:${f.line} imports '${f.imported}', but the file is '${f.actual}'`)
    .join('; ');
  return (
    `${found.length} import${found.length === 1 ? '' : 's'} only match${found.length === 1 ? 'es' : ''} a file if letter case is ignored ` +
    `(${shown}${found.length > 3 ? `; and ${found.length - 3} more` : ''}). That works on macOS and Windows, which ignore case, and ` +
    'fails here, because DevLaunch runs on Linux, which does not. The import needs the file’s real spelling.'
  );
}
