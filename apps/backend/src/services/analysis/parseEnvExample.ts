import type { EnvExampleVar } from '@devlaunch/shared';

/**
 * Read a `.env.example` into the variables it declares.
 *
 * Shared by the analyzer and by service discovery: a repository's configuration lives
 * beside the service that reads it, so both the root file and each service's own have
 * to be understood the same way.
 */
/**
 * Comments that say a variable need not be supplied.
 *
 * An empty declaration usually means "you must provide this", which is why the gate
 * treats it as required — but not when the file says otherwise directly above it.
 * DevLaunch's own `.env.example` is the case in point: `GROQ_API_KEY=` under a line
 * reading "Optional. Without a key DevLaunch plans deterministically", and blocking a
 * session on it contradicts the sentence explaining that it is not needed.
 */
const OPTIONAL_COMMENT = /\b(optional|not required|if you have one|leave (?:it )?(?:blank|empty))\b/i;

/**
 * Values that are a placeholder rather than a default.
 *
 * `OPENAI_API_KEY=sk-your-key-here` is not a usable value; it is the author telling you
 * where yours goes. Counted as a default, the gate asked for nothing, the container
 * started without the variable, and the application died at import time with "Missing
 * credentials … set the OPENAI_API_KEY environment variable" — the exact failure the
 * gate exists to prevent, on a repository that had documented the variable perfectly.
 *
 * Deliberately narrow. `development`, `localhost`, `5000` and `info` are real defaults
 * and must stay that way; only the shapes people write to mean "put yours here" match.
 */
const PLACEHOLDER = new RegExp(
  [
    /^<[^>]*>$/, // <your-token>
    /^\$\{[^}]*\}$/, // ${SECRET} — resolved from a shell DevLaunch does not have
    /^(?:sk|pk|ghp|xox[abp]|AKIA)[-_]?(?:your|xxx|test|placeholder|\.\.\.|example)/i,
    /^(?:your|my)[-_ ]?[a-z0-9_-]*(?:key|token|secret|password|id|url|here)/i,
    /[-_](?:here|goes[-_]here)$/i,
    /^(?:changeme|change[-_]me|replace[-_]?me|replace[-_]this|todo|fixme|placeholder|dummy|xxx+|x{4,}|\.{3,}|\*{3,})$/i,
    /^(?:your|enter|insert|paste|add|put)[-_ ](?:your[-_ ])?/i,
  ]
    .map((r) => r.source)
    .join('|'),
  'i',
);

export function isPlaceholder(value: string): boolean {
  return PLACEHOLDER.test(value.trim().replace(/^["']|["']$/g, ''));
}

export function parseEnvExample(content: string): EnvExampleVar[] {
  const out: EnvExampleVar[] = [];
  // Comments since the last declaration: a file documents a variable above it, and the
  // run resets so one variable's note is never read as the next one's.
  let notes: string[] = [];

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line === '') {
      // A blank line ends a comment block, so a heading far above does not leak down.
      notes = [];
      continue;
    }
    if (line.startsWith('#')) {
      notes.push(line);
      continue;
    }

    const eq = line.indexOf('=');
    if (eq <= 0) {
      notes = [];
      continue;
    }
    const key = line.slice(0, eq).replace(/^export\s+/, '', ).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      notes = [];
      continue;
    }

    // A value present in .env.example means the variable has a usable default, so it
    // is not something the user must be prompted for. Documented as optional counts
    // the same way: there is nothing the user has to decide.
    const value = line.slice(eq + 1).trim();
    const optional = notes.some((note) => OPTIONAL_COMMENT.test(note));
    // A placeholder is a request with the answer's shape written in, not an answer.
    out.push({ key, hasDefault: (value.length > 0 && !isPlaceholder(value)) || optional });
    notes = [];
  }
  return out;
}
