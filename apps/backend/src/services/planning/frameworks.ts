/**
 * Framework detection tables.
 *
 * Order is load-bearing. SvelteKit, Astro, Nuxt and Remix all depend on Vite, and
 * Docusaurus depends on React — so a table walked in the wrong order identifies every
 * meta-framework as its underlying build tool and produces a plan that cannot work.
 * Most specific first, always.
 */

export type ArgStyle =
  /** `--host 0.0.0.0 --port N`, the Vite-family convention. */
  | 'long'
  /** `-H 0.0.0.0 -p N`, used by Next and Gatsby. */
  | 'short'
  /** No usable flags; bind through HOST/PORT environment variables instead. */
  | 'env';

export interface NodeFramework {
  id: string;
  /** package.json dependency that identifies it. */
  dep: string;
  /** Additional file that also identifies it, e.g. angular.json. */
  configFile?: string;
  defaultPort: number;
  /** Scripts to look for, in order of preference. */
  scripts: string[];
  argStyle: ArgStyle;
  /** Extra arguments this framework needs to be reachable or non-interactive. */
  extraArgs?: string[];
  /**
   * Whether setting host/port actually guarantees reachability. 'unknown' means the
   * framework may still bind loopback despite our efforts, so readiness is left to
   * diagnose it rather than the plan claiming a certainty it does not have.
   */
  binding?: 'forced' | 'unknown';
  note?: string;
}

export const NODE_FRAMEWORKS: readonly NodeFramework[] = Object.freeze([
  // --- meta-frameworks first: each of these depends on a build tool below ---
  { id: 'next', dep: 'next', defaultPort: 3000, scripts: ['dev', 'start'], argStyle: 'short' },
  { id: 'nuxt', dep: 'nuxt', defaultPort: 3000, scripts: ['dev'], argStyle: 'long' },
  { id: 'sveltekit', dep: '@sveltejs/kit', defaultPort: 5173, scripts: ['dev'], argStyle: 'long' },
  { id: 'astro', dep: 'astro', defaultPort: 4321, scripts: ['dev', 'start'], argStyle: 'long' },
  { id: 'remix', dep: '@remix-run/dev', defaultPort: 3000, scripts: ['dev'], argStyle: 'env' },
  {
    id: 'gatsby',
    dep: 'gatsby',
    defaultPort: 8000,
    // Gatsby's dev script is conventionally "develop", not "dev".
    scripts: ['develop', 'start'],
    argStyle: 'short',
  },
  {
    id: 'docusaurus',
    dep: '@docusaurus/core',
    defaultPort: 3000,
    scripts: ['start', 'dev'],
    argStyle: 'long',
  },
  {
    id: 'angular',
    dep: '@angular/cli',
    configFile: 'angular.json',
    defaultPort: 4200,
    scripts: ['start', 'dev'],
    argStyle: 'long',
    // Angular rejects requests whose Host header it does not recognise, which is every
    // request arriving through a Docker port mapping.
    extraArgs: ['--disable-host-check'],
  },
  { id: 'vue-cli', dep: '@vue/cli-service', defaultPort: 8080, scripts: ['serve', 'dev'], argStyle: 'long' },
  { id: 'cra', dep: 'react-scripts', defaultPort: 3000, scripts: ['start'], argStyle: 'env' },

  // --- build tools ---
  { id: 'vite', dep: 'vite', defaultPort: 5173, scripts: ['dev', 'start', 'serve'], argStyle: 'long' },
  { id: 'parcel', dep: 'parcel', defaultPort: 1234, scripts: ['dev', 'start'], argStyle: 'long' },
  {
    id: 'webpack-dev-server',
    dep: 'webpack-dev-server',
    defaultPort: 8080,
    scripts: ['dev', 'start', 'serve'],
    argStyle: 'long',
  },

  // --- servers: these bind through the environment, not flags ---
  { id: 'nest', dep: '@nestjs/core', defaultPort: 3000, scripts: ['start:dev', 'start', 'dev'], argStyle: 'env' },
  {
    id: 'fastify',
    dep: 'fastify',
    defaultPort: 3000,
    scripts: ['dev', 'start'],
    argStyle: 'env',
    // Fastify defaults to 127.0.0.1 in code. If the repository does not read HOST,
    // readiness will correctly report PORT_BOUND_TO_LOCALHOST rather than guess.
    binding: 'unknown',
    note: 'Fastify binds 127.0.0.1 unless the application reads HOST.',
  },
  { id: 'koa', dep: 'koa', defaultPort: 3000, scripts: ['dev', 'start'], argStyle: 'env' },
  { id: 'express', dep: 'express', defaultPort: 3000, scripts: ['dev', 'start'], argStyle: 'env' },
]);

export interface PythonFramework {
  id: string;
  defaultPort: number;
  note?: string;
}

export const PYTHON_FRAMEWORKS: Readonly<Record<string, PythonFramework>> = Object.freeze({
  django: { id: 'django', defaultPort: 8000 },
  flask: { id: 'flask', defaultPort: 5000 },
  fastapi: { id: 'fastapi', defaultPort: 8000 },
  streamlit: {
    id: 'streamlit',
    defaultPort: 8501,
    // Without --server.headless, Streamlit prompts for an email address on first run
    // and blocks forever, which readiness would report as a timeout.
    note: 'Requires --server.headless to avoid the first-run email prompt.',
  },
  gradio: { id: 'gradio', defaultPort: 7860 },
});

/** Distribution names that identify a Python web framework in requirements.txt. */
export const PYTHON_REQUIREMENT_SIGNALS: Readonly<Record<string, string>> = Object.freeze({
  django: 'django',
  flask: 'flask',
  fastapi: 'fastapi',
  streamlit: 'streamlit',
  gradio: 'gradio',
});

/** Build the host/port arguments a framework needs to be reachable through Docker. */
export function bindingArgs(fw: NodeFramework, port: number): string[] {
  switch (fw.argStyle) {
    case 'long':
      return ['--host', '0.0.0.0', '--port', String(port), ...(fw.extraArgs ?? [])];
    case 'short':
      return ['-H', '0.0.0.0', '-p', String(port), ...(fw.extraArgs ?? [])];
    case 'env':
      return [];
  }
}
