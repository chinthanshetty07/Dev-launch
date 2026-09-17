import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Integration tests drive real Docker containers; concurrency is 1 by design
    // (see docs/planning-strategy.md — Sandbox policy), so they must not overlap.
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
