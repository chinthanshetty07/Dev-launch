import { join, normalize } from 'node:path';
import { readCapped } from '../analysis/readCapped.js';

/**
 * The settings a crash was about, read from the project's own code.
 *
 * Many projects read a key and hand it straight to a library that refuses to start
 * without it: `new Razorpay({ key_id: process.env.RAZORPAY_API_KEY })` throws "`key_id` is
 * mandatory" the moment the file loads (`fullstack-superdev/MERN-ECommerce-Project`). With
 * no `.env.example` to read, nothing asked for that key before the run, and the person was
 * left with a stack trace into a payment library.
 *
 * The stack trace says where in the project it happened. The lines there say which
 * settings they read. Those that were never set are what the person is asked for — the
 * setting names only, never a guess at their values.
 */

export interface CrashSettings {
  /** Settings read on the crashing lines that were not set. */
  keys: string[];
  /** Where, in the project, as a person would look for it. */
  file: string;
  line: number;
  /** The error the application printed. */
  error: string;
}

/** Ways code reads one named setting, the name captured: Node and Python. */
const READS = [
  /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
  /process\.env\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g,
  /import\.meta\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
  /os\.environ(?:\.get)?\s*[[(]\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g,
  /os\.getenv\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g,
];

/** How far around the crashing line to look: a constructor's options span a few lines. */
const SPAN = 4;

/** Frames in the project's own code, innermost first: `/workspace/<file>:<line>`. */
export function projectFrames(logs: string): { file: string; line: number }[] {
  const out: { file: string; line: number }[] = [];
  const add = (file: string, line: number) => {
    if (/(?:^|\/)(?:node_modules|site-packages|dist-packages)\//.test(file)) return;
    if (!out.some((f) => f.file === file && f.line === line)) out.push({ file, line });
  };
  // Node: `at fn (/workspace/a/b.js:14:18)` or `at /workspace/a/b.js:14:18`, innermost first.
  for (const m of logs.matchAll(/\bat (?:[^\n(]*\()?\/workspace\/([^\s():]+):(\d+):\d+\)?/g)) add(m[1]!, Number(m[2]));
  // Python: `File "/workspace/a/b.py", line 14`, innermost last.
  const py = [...logs.matchAll(/File "\/workspace\/([^"]+)", line (\d+)/g)].map((m) => ({ file: m[1]!, line: Number(m[2]) }));
  for (const f of py.reverse()) add(f.file, f.line);
  return out;
}

/** The last error line the application printed, for the question it leads to. */
function errorLine(logs: string): string {
  const lines = logs.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^(?:[A-Z]\w*)?(?:Error|Exception)\b.*:/.test(lines[i]!)) return lines[i]!.slice(0, 200);
  }
  return '';
}

/**
 * The unset settings the crash points at, or null. `isSet` says whether a name was given a
 * value for this run; `dirs` are where `/workspace` may sit in the source, the service's own
 * folder first. Only the first three frames in the project are read: past those, a setting
 * named is more likely the caller's business than the crash's cause.
 */
export async function missingSettingsFromCrash(input: {
  logs: string;
  dirs: readonly string[];
  isSet: (key: string) => boolean;
}): Promise<CrashSettings | null> {
  for (const frame of projectFrames(input.logs).slice(0, 3)) {
    const rel = normalize(frame.file);
    if (rel.startsWith('..')) continue;
    for (const dir of input.dirs) {
      const text = await readCapped(join(dir, rel));
      if (text === null) continue;
      const lines = text.split('\n');
      const near = lines.slice(Math.max(0, frame.line - 1 - SPAN), frame.line + SPAN).join('\n');
      const keys = new Set<string>();
      for (const re of READS) for (const m of near.matchAll(re)) keys.add(m[1]!);
      const missing = [...keys].filter((k) => !input.isSet(k));
      if (missing.length > 0) return { keys: missing, file: rel, line: frame.line, error: errorLine(input.logs) };
      break;
    }
  }
  return null;
}
