// Test-DB helpers: tenant factory, purge, and connection lifecycle.
//
// Each test suite creates one-or-more short-lived tenants against the Neon
// 'test' branch, then purges them in afterAll. Because tests run in a single
// fork (see vitest.config.ts), fixture state is deterministic across the suite.

import { randomUUID } from 'node:crypto';
import bcrypt from 'bcrypt';

// @ts-ignore — server files are plain JS
import { adminSql, shutdown as shutdownDb, withTenant } from '../../server/db/index.js';
// @ts-ignore
import { createTenant } from '../../server/tenants.js';

export interface TestTenant {
  id: string;
  subdomain: string;
  ownerEmail: string;
}

/**
 * Create a fresh tenant with a unique id + subdomain. The name is derived
 * from `label` so failing test output is scannable ("test_rls-a-<uuid>").
 */
export async function createTestTenant(label = 'suite'): Promise<TestTenant> {
  const uuid = randomUUID().slice(0, 8);
  const id = `test_${label}_${uuid}`;
  const subdomain = `test-${label}-${uuid}`;
  const ownerEmail = `${id}@test.local`;

  // Low bcrypt cost — tests don't need brute-force resistance.
  const owner_password_hash = await bcrypt.hash('test-password', 4);

  await createTenant({
    id,
    name: `Test tenant ${label}`,
    subdomain,
    owner_email: ownerEmail,
    owner_password_hash,
    plan: 'free',
  });

  return { id, subdomain, ownerEmail };
}

/**
 * Fast test-only tenant cleanup. Deletes every row belonging to this tenant
 * across all `tenant_id`-bearing tables in a single server-side loop.
 *
 * Prod uses `purgeTenant()` which does 3 sequential passes across ~50 tables
 * (one round-trip each) to survive background writers. Tests don't have
 * those schedulers, so we condense everything into one round-trip: a
 * PLPGSQL DO block that catches FK-violation per table (via a savepoint
 * sub-block) and does one mop-up pass. ~50× faster than the prod path.
 */
export async function dropTestTenant(tenantId: string): Promise<void> {
  // Guard: tenantId is our own generated string ("test_<label>_<uuid>"); the
  // format is enforced by createTestTenant. Reject anything else defensively
  // so a callsite can never smuggle SQL into the interpolated DO block.
  if (!/^test_[a-z0-9_-]+$/i.test(tenantId)) {
    throw new Error(`dropTestTenant refused non-test tenantId: ${tenantId}`);
  }

  await adminSql.unsafe(`
    DO $$
    DECLARE
      t text;
      tables text[];
      target_tenant text := '${tenantId}';
    BEGIN
      SELECT array_agg(c.table_name)
      INTO tables
      FROM information_schema.columns c
      JOIN information_schema.tables tt
        ON tt.table_schema = c.table_schema AND tt.table_name = c.table_name
      WHERE c.column_name = 'tenant_id'
        AND c.table_schema = 'public'
        AND tt.table_type = 'BASE TABLE';

      IF tables IS NULL THEN RETURN; END IF;

      -- First pass. FK-blocked rows raise; savepoint sub-block swallows them.
      FOREACH t IN ARRAY tables LOOP
        BEGIN
          EXECUTE format('DELETE FROM %I WHERE tenant_id = $1', t) USING target_tenant;
        EXCEPTION WHEN foreign_key_violation THEN
          NULL;
        END;
      END LOOP;

      -- Mop-up. Children cleared, parents now unblocked.
      FOREACH t IN ARRAY tables LOOP
        EXECUTE format('DELETE FROM %I WHERE tenant_id = $1', t) USING target_tenant;
      END LOOP;
    END $$;
  `);

  await adminSql`DELETE FROM tenants WHERE id = ${tenantId}`;
}

/** Run `fn` inside the tenant's RLS-scoped transaction — like a real /api/* request. */
export async function asTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return withTenant(tenantId, fn);
}

/** Close the postgres pools. Call in `afterAll` of the top-level test file. */
export async function closePools(): Promise<void> {
  await shutdownDb();
}
