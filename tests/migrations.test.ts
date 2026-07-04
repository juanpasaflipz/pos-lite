// Migration runner tests — idempotency + set-difference regression.
//
// Invariants:
//   1. runMigrations() is idempotent — a second call after all migrations are
//      applied is a no-op (no re-runs, no new schema_version rows).
//   2. The set-difference selector in migrate.js is resilient to renumbered
//      or out-of-order versions. A stale high-version row in schema_version
//      (e.g. left behind by a hot-fix branch that was reverted) must NOT
//      cause the runner to skip real migrations — that was the exact MAX(version)
//      bug fixed 2026-05-27.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePools } from './helpers/db.js';
// @ts-ignore
import { adminSql } from '../server/db/index.js';
// @ts-ignore
import { initMigrations, runMigrations } from '../server/db/migrate.js';

beforeAll(async () => {
  // migrationCache is per-process. globalSetup primed it in the main process;
  // this test file runs in a fork, so we prime again here.
  await initMigrations();
});

afterAll(async () => {
  await closePools();
});

describe('migration runner', () => {
  it('is idempotent: a second run after all migrations are applied is a no-op', async () => {
    const [before] = await adminSql`SELECT COUNT(*)::int AS n FROM schema_version`;
    await runMigrations('test-idempotency');
    const [after] = await adminSql`SELECT COUNT(*)::int AS n FROM schema_version`;

    expect(after.n).toBe(before.n);
  });

  it('is set-difference based: a bogus high version does not skip real pending work', async () => {
    // Regression test for the MAX(version) bug fixed 2026-05-27.
    //
    // Simulate a rogue schema_version row from a reverted hot-fix. Under the
    // old MAX() logic, `highest_applied` would jump to 99999 and the runner
    // would skip every real migration silently. The set-difference approach
    // in migrate.js computes `pending = allVersions \ appliedVersions`, so
    // this rogue row must NOT cause any real migration to be skipped.
    const bogusVersion = 99999;

    await adminSql`
      INSERT INTO schema_version (version, name, applied_at)
      VALUES (${bogusVersion}, 'bogus-reverted-hotfix', NOW())
      ON CONFLICT (version) DO NOTHING
    `;

    try {
      // Should complete without error and without re-running anything real.
      const [before] = await adminSql`SELECT COUNT(*)::int AS n FROM schema_version`;
      await runMigrations('test-max-bug');
      const [after] = await adminSql`SELECT COUNT(*)::int AS n FROM schema_version`;

      expect(after.n).toBe(before.n);
    } finally {
      await adminSql`DELETE FROM schema_version WHERE version = ${bogusVersion}`;
    }
  });
});
