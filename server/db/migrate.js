/**
 * Lightweight migration runner for Postgres (postgres.js).
 *
 * - No external dependencies, no CLI, no down migrations.
 * - Migrations are loaded once at startup via initMigrations() (async import).
 * - runMigrations() uses adminSql.begin() for atomic transactions.
 * - Each migration's up(sql) receives the postgres.js transaction scope.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { adminSql } from './index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, 'migrations');

/** In-memory cache of migration modules, sorted by version. */
let migrationCache = null;

/**
 * Load all migration files from disk (async dynamic import).
 * Must be called once at startup before any runMigrations() call.
 */
export async function initMigrations() {
  if (migrationCache) return;

  const files = fs.existsSync(migrationsDir)
    ? fs.readdirSync(migrationsDir).filter(f => f.endsWith('.js')).sort()
    : [];

  const modules = [];
  for (const file of files) {
    const mod = await import(path.join(migrationsDir, file));
    if (typeof mod.version !== 'number' || typeof mod.up !== 'function') {
      console.warn(`[Migrate] Skipping ${file}: missing version or up()`);
      continue;
    }
    modules.push({ version: mod.version, name: mod.name || file, up: mod.up });
  }

  modules.sort((a, b) => a.version - b.version);
  migrationCache = modules;
  console.log(`[Migrate] Loaded ${modules.length} migration(s)`);
}

/**
 * Run all pending migrations (async).
 * Uses adminSql (bypasses RLS) for schema operations.
 *
 * @param {string} [label='db'] — label for log messages
 */
export async function runMigrations(label = 'db') {
  if (!migrationCache) {
    throw new Error('[Migrate] initMigrations() must be called before runMigrations()');
  }

  // Ensure schema_version table exists
  await adminSql`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  const result = await adminSql`
    SELECT COALESCE(MAX(version), 0) AS v FROM schema_version
  `;
  const currentVersion = result[0].v;

  const pending = migrationCache.filter(m => m.version > currentVersion);

  if (pending.length === 0) return;

  console.log(`[Migrate] ${label}: ${pending.length} pending migration(s) from v${currentVersion}`);

  for (const migration of pending) {
    try {
      await adminSql.begin(async (sql) => {
        await migration.up(sql);
        await sql`
          INSERT INTO schema_version (version, name) VALUES (${migration.version}, ${migration.name})
        `;
      });
      console.log(`[Migrate] ${label}: applied v${migration.version} (${migration.name})`);
    } catch (err) {
      console.error(`[Migrate] ${label}: FAILED v${migration.version} (${migration.name}):`, err.message);
      throw err; // stop — don't skip broken migrations
    }
  }
}
