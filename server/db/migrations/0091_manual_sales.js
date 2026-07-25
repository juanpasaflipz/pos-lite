export const version = 91;
export const name = 'manual_sales';

// Manual / imported sales entry (2026-07-25).
//
// Why: delivery-app revenue (Rappi, DiDi Food) is real money that never
// touches the POS, so every revenue report, the break-even calculator and the
// channel mix under-report reality for any tenant selling on those platforms.
// The API/webhook paths in server/routes/delivery.js need credentials the
// tenants don't have yet, and the portal-watcher scraper is a scaffold. This
// gives a first-class manual path in the meantime — and the same tables are
// what the eventual settlement-file importer writes through.
//
// Design note (important): an "aggregate" entry (one platform, one day, gross
// + order count) fans out into N real `orders` rows rather than a single row
// carrying a multiplier. That was deliberate — ~15 report queries compute
// COUNT(*) / AVG(total) over orders (including /reports/breakeven's
// orders_30d + avg_ticket), and a multiplier column would have required
// patching every one of them, with a silent-wrong-number failure mode on any
// site missed. Fanning out means zero report changes and zero drift: the rows
// look exactly like the orders they represent. `manual_batch_id` ties them
// back to their batch so an entry stays reversible as one unit.
export async function up(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS manual_sales_batches (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
      channel TEXT NOT NULL,
      platform_id INTEGER REFERENCES delivery_platforms(id),
      entry_mode TEXT NOT NULL DEFAULT 'aggregate',
      business_date DATE NOT NULL,
      order_count INTEGER NOT NULL DEFAULT 1,
      gross_total NUMERIC(10,2) NOT NULL DEFAULT 0,
      commission_total NUMERIC(10,2) NOT NULL DEFAULT 0,
      net_total NUMERIC(10,2) NOT NULL DEFAULT 0,
      commission_percent REAL DEFAULT 0,
      source_filename TEXT,
      note TEXT,
      created_by INTEGER REFERENCES employees(id),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_manual_sales_batches_tenant_date
    ON manual_sales_batches (tenant_id, business_date DESC, id DESC)
  `;

  await sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS manual_batch_id INTEGER`;

  // Partial index: only manual rows carry the column, and the reversal path
  // (DELETE ... WHERE manual_batch_id = $1) is the only reader.
  await sql`
    CREATE INDEX IF NOT EXISTS idx_orders_manual_batch
    ON orders (manual_batch_id) WHERE manual_batch_id IS NOT NULL
  `;

  // RLS — same shape as migration 0089. The tenant pool (app_user) is
  // policy-scoped; adminSql (table owner) bypasses without FORCE.
  await sql.unsafe(`
    DO $$
    BEGIN
      EXECUTE 'ALTER TABLE manual_sales_batches ENABLE ROW LEVEL SECURITY';

      IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE tablename = 'manual_sales_batches' AND policyname = 'tenant_isolation'
      ) THEN
        EXECUTE
          'CREATE POLICY tenant_isolation ON manual_sales_batches '
          || 'USING (tenant_id = current_setting(''app.tenant_id'', true)) '
          || 'WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true))';
      END IF;
    END $$;
  `);

  await sql.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON manual_sales_batches TO app_user`);
  await sql.unsafe(`
    DO $$
    BEGIN
      IF to_regclass('public.manual_sales_batches_id_seq') IS NOT NULL THEN
        EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE manual_sales_batches_id_seq TO app_user';
      END IF;
    END $$;
  `);
}
