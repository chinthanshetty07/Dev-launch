import { stat } from 'node:fs/promises';
import { isAbsolute, join, normalize, sep } from 'node:path';
import type { RunPlan } from '@devlaunch/shared';

/**
 * Whether a plan names something this repository does not have.
 *
 * The validator asks two questions of every plan — is it the right shape, and is it
 * safe — and never asked the third: is it *possible*. So a model handed a repository
 * whose own import is broken answered with `npm run serve`, a script that appears
 * nowhere in its package.json, and DevLaunch dutifully built a container, installed a
 * dependency tree and waited sixty seconds to be told `Missing script: "serve"`.
 *
 * Checked against the manifest rather than by running anything, so it costs nothing and
 * happens before the container exists. Deliberately narrow: it reports only what it can
 * prove from a manifest it actually has. A plan running a binary, a file, or a script in
 * a repository whose manifest was not read is left alone — being quiet about what it
 * cannot see is the difference between a check and a guess.
 */
export function impossibleCommand(plan: RunPlan, declared: readonly string[] | undefined): string | null {
  // Script *names*, because that is what both callers have: a single service reads them
  // from the manifest it analysed, and a project's service carries them on its discovery
  // candidate, the root manifest having nothing to say about a subdirectory.
  //
  // No manifest, or one with no scripts at all: nothing to contradict. A repository with
  // an empty `scripts` block is not evidence that `npm run dev` is wrong, it is evidence
  // that we are looking at the wrong manifest.
  if (!declared || declared.length === 0) return null;
  const scripts = new Set(declared);

  for (const [label, command] of [
    ['start command', plan.startCommand],
    ['build command', plan.buildCommand],
    ['install command', plan.installCommand],
  ] as const) {
    if (!command) continue;
    const script = scriptRun(command);
    if (script && !scripts.has(script)) {
      const known = [...scripts].sort();
      return (
        `The ${label} runs the script "${script}", and package.json defines no such ` +
        `script. It defines: ${known.join(', ')}.`
      );
    }
  }
  return null;
}

/**
 * The script name a command runs, or null if it does not run one.
 *
 * `npm run dev`, `yarn run dev`, `pnpm run dev` and bare `yarn dev` all mean the same
 * thing. `npm start`, `npm test` and `yarn install` are the package manager's own verbs
 * rather than scripts — `npm start` falls back to `node server.js` with no `start`
 * script at all, so calling it impossible would be wrong.
 */
export function scriptRun(command: string): string | null {
  const words = command.trim().split(/\s+/);
  const manager = words[0];
  if (manager !== 'npm' && manager !== 'yarn' && manager !== 'pnpm') return null;

  if (words[1] === 'run') return words[2] ?? null;
  // `yarn <script>` with no `run`; npm and pnpm require the keyword.
  if (manager === 'yarn' && words.length >= 2 && !BUILT_IN_VERBS.has(words[1]!)) {
    return words[1] ?? null;
  }
  return null;
}

/** Verbs the package manager answers itself, script or no script. */
const BUILT_IN_VERBS = new Set([
  'install', 'add', 'remove', 'ci', 'dlx', 'exec', 'up', 'upgrade',
  'link', 'pack', 'publish', 'init', 'why',
  // `start`, `test` and `build` are in here for a different reason than the rest: they
  // are ordinary script names *and* things a package manager answers itself, and which
  // one `yarn start` meant cannot be decided from the word. Treating them as verbs is
  // the conservative half of that: a missed check costs a minute, and a wrong one
  // refuses a plan that would have worked.
  'start', 'test', 'build',
]);

/** Runners whose first argument is a file of the repository's own. */
const FILE_RUNNERS = new Set(['node', 'nodemon', 'ts-node', 'tsx', 'python', 'python3']);

/** Where a build or an install hook writes output that is not in the clone yet. */
const GENERATED_DIRS = ['dist', 'build', 'out', '.next', '.output'];

/**
 * Whether the start command runs a file this repository does not have.
 *
 * `techiescamp/kubernetes-ai-projects` keeps its application two folders down, with
 * nothing at the root; the model, given nothing to go on, answered `node index.js`, and
 * DevLaunch installed nothing, started a container and reported `Cannot find module
 * '/workspace/index.js'` as a missing *dependency*. The file was never there. Asking
 * the clone costs one `stat`.
 *
 * A model's plan only. A rule names an entry file because it found one, and a plan a
 * caller hands in directly is theirs to vouch for; a model is the one author here that
 * writes file names it has not seen.
 *
 * Quiet whenever the file could legitimately appear later: a plan with a build step,
 * or a path inside a directory builds write to. Quiet, too, about anything that is not
 * plainly a relative file path — a flag, a module (`python -m`), an absolute path.
 */
export async function missingEntryFile(plan: RunPlan, sourceDir: string): Promise<string | null> {
  if (plan.planSource !== 'ai-fallback' || plan.buildCommand) return null;
  const words = plan.startCommand.trim().split(/\s+/);
  if (!FILE_RUNNERS.has(words[0] ?? '')) return null;
  // Only `<runner> <file> [args]`. With a flag first, which word is the entry is a
  // question about that runner's flags (`node --require x.js app.js`), not worth a guess.
  const file = words[1];
  if (!file || file.startsWith('-') || isAbsolute(file) || !/\.(?:[cm]?js|ts|py)$/.test(file)) return null;

  const relativePath = normalize(join(plan.workingDirectory, file));
  if (relativePath.startsWith('..')) return null;
  if (GENERATED_DIRS.some((d) => relativePath.split(sep).includes(d))) return null;

  const found = await stat(join(sourceDir, relativePath)).then((s) => s.isFile(), () => false);
  if (found) return null;
  const where = plan.workingDirectory === '.' ? 'the repository' : `\`${plan.workingDirectory}/\``;
  return `The start command runs \`${file}\`, and ${where} has no such file.`;
}
