import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    globalSetup: ['./tests/setup/global.ts'],
    setupFiles: ['./tests/setup/env.ts'],
    include: ['tests/**/*.test.ts', 'tests/**/*.test.js'],
    exclude: ['tests/helpers/**', 'tests/setup/**', 'node_modules/**'],
    testTimeout: 20_000,
    hookTimeout: 60_000,
    // Tests share a Postgres connection pool and rely on RLS transaction
    // semantics; parallel workers cause connection contention and flaky
    // cross-tenant fixtures. Single fork keeps the suite deterministic.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
