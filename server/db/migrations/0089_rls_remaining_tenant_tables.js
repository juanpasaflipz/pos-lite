export const version = 89;
export const name = 'rls_remaining_tenant_tables';

// Close the last RLS gaps flagged across three audits: seven tenant-bearing
// tables that had a tenant_id column but no row-level security policy. RLS is
// the load-bearing isolation boundary here — a missing policy means a bug in
// a tenant-pool query path (or a future one) could read across tenants.
//
// Two of the seven (daily_order_counter, kiosk_suggestion_events) were
// runtime-created (CREATE TABLE IF NOT EXISTS inside route/helper code) and
// never in pg-schema.sql, so a fresh DB wouldn't have them at migration time.
// We codify both here (same pattern as 0088's ai_* tables) so a repo-built
// database is complete and RLS-covered from boot; the runtime ensure* helpers
// remain as harmless idempotent belt-and-suspenders.
//
// Table owner (adminSql / neondb_owner) bypasses RLS by default (no FORCE),
// so every existing adminSql access path — audit writes, the public
// receipt/CFDI token lookups, demo provisioning — is unaffected. Only the
// tenant pool (app_user) becomes policy-scoped, which is exactly the goal.
export async function up(sql) {
  // Codify the two runtime-created tables (no-op on prod where they exist).
  await sql`
    CREATE TABLE IF NOT EXISTS daily_order_counter (
      tenant_id TEXT NOT NULL,
      date_key DATE NOT NULL,
      last_seq INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (tenant_id, date_key)
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS kiosk_suggestion_events (
      id BIGSERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      loyalty_customer_id INTEGER,
      menu_item_id INTEGER,
      lane TEXT NOT NULL,
      source TEXT,
      event_type TEXT NOT NULL,
      reason TEXT,
      order_id INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_kiosk_suggestion_events_tenant
    ON kiosk_suggestion_events (tenant_id, created_at DESC)
  `;

  const tables = [
    'audit_log',
    'receipt_tokens',
    'cfdi_invoice_tokens',
    'demo_tokens',
    'stress_test_runs',
    'daily_order_counter',
    'kiosk_suggestion_events',
  ];

  for (const table of tables) {
    // Defensive: only touch tables that actually exist (all seven do on prod;
    // the two codified above now exist on fresh DBs too).
    await sql.unsafe(`
      DO $$
      BEGIN
        IF to_regclass('public.${table}') IS NULL THEN
          RAISE NOTICE 'skip RLS: %.% not present', 'public', '${table}';
          RETURN;
        END IF;

        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', '${table}');

        IF NOT EXISTS (
          SELECT 1 FROM pg_policies
          WHERE tablename = '${table}' AND policyname = 'tenant_isolation'
        ) THEN
          EXECUTE format(
            'CREATE POLICY tenant_isolation ON %I '
            || 'USING (tenant_id = current_setting(''app.tenant_id'', true)) '
            || 'WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true))',
            '${table}'
          );
        END IF;
      END $$;
    `);

    // app_user already holds these on prod; idempotent + needed on fresh DBs.
    await sql.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO app_user`);
  }

  // BIGSERIAL sequence grant for the one codified table with a serial PK
  // (needed for app_user inserts on a fresh DB; harmless on prod).
  await sql.unsafe(`
    DO $$
    BEGIN
      IF to_regclass('public.kiosk_suggestion_events_id_seq') IS NOT NULL THEN
        EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE kiosk_suggestion_events_id_seq TO app_user';
      END IF;
    END $$;
  `);
}
