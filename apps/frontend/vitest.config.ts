import { defineConfig } from 'vitest/config';

/*
 * Standalone rather than merged into vite.config.ts.
 *
 * That config is entirely dev-server and build machinery — the React and Tailwind
 * plugins, the /api and /ws proxies, sourcemap output — and defines no path aliases, so
 * there is nothing in it a test needs. Loading it would only make the suite depend on a
 * Tailwind build and a proxy target that no test uses.
 */
export default defineConfig({
  test: {
    globals: true,
    /*
     * No DOM environment, deliberately.
     *
     * Every component here is a pure function of its props — no state, no effects, no
     * event handlers — so `renderToStaticMarkup` exercises exactly what a browser would
     * paint, without pulling in jsdom to simulate a document nothing touches. Add
     * `environment: 'jsdom'` and @testing-library/react the day a component needs to
     * respond to interaction; until then it would be a dependency that proves nothing.
     */
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
