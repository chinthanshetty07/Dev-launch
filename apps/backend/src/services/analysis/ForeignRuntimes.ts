/**
 * Manifests of runtimes DevLaunch has no image for.
 *
 * A repository whose only manifest is a `pom.xml` used to reach the model, which planned
 * `node index.js` or `npm start` in a directory with no JavaScript in it, and the run failed
 * minutes later with a diagnosis about the invention. Recognised by its manifest instead, it
 * is declined at once, naming what it needs.
 */
export interface ForeignRuntime {
  runtime: string;
  manifest: string;
}

const MANIFESTS: { test: (name: string) => boolean; runtime: string }[] = [
  { test: (n) => n === 'pom.xml', runtime: 'Java (Maven)' },
  { test: (n) => n === 'build.gradle' || n === 'build.gradle.kts', runtime: 'Java/Kotlin (Gradle)' },
  { test: (n) => n === 'go.mod', runtime: 'Go' },
  { test: (n) => n === 'Cargo.toml', runtime: 'Rust' },
  { test: (n) => n === 'composer.json', runtime: 'PHP' },
  { test: (n) => n === 'Gemfile', runtime: 'Ruby' },
  { test: (n) => /\.(?:csproj|fsproj|sln)$/.test(n), runtime: '.NET' },
  { test: (n) => n === 'mix.exs', runtime: 'Elixir' },
  { test: (n) => n === 'deno.json' || n === 'deno.jsonc', runtime: 'Deno' },
];

export function foreignRuntimes(fileNames: readonly string[]): ForeignRuntime[] {
  const out: ForeignRuntime[] = [];
  for (const name of fileNames) {
    const m = MANIFESTS.find((x) => x.test(name));
    if (m && !out.some((o) => o.runtime === m.runtime)) out.push({ runtime: m.runtime, manifest: name });
  }
  return out;
}

export function foreignRuntimeReason(found: readonly ForeignRuntime[]): { reason: string; remedy: string } {
  const what = found.map((f) => `${f.runtime} (${f.manifest})`).join(', ');
  return {
    reason:
      `This is a ${what} project. DevLaunch runs Node 20, Node 22 and Python 3.12, and has no ` +
      `${found.length === 1 ? 'image' : 'images'} for ${found.map((f) => f.runtime).join(' or ')} yet, so nothing it can plan would start it.`,
    remedy:
      'Run it with its own toolchain. Support for another runtime needs a hardened runner image and a planner for it; ' +
      'docs/SUPPORTED_STACKS.md lists what is supported.',
  };
}
