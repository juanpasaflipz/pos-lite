// Global setup — runs once for the entire vitest session (main process).
// Loads env, runs pending migrations against the test branch, tears down pools.
import './env.js';

export async function setup() {
  const { initDb, shutdown } = await import('../../server/db/index.js');
  const { initMigrations, runMigrations } = await import('../../server/db/migrate.js');
  await initDb();
  await initMigrations();
  await runMigrations('test');
  await shutdown();
}

export async function teardown() {
  // Workers own their own pool lifecycles; nothing global to clean up here.
}
