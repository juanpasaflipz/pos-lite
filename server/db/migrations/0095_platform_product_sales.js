export const version = 95;
export const name = 'platform_product_sales';

// Item-level delivery import (2026-07-29).
//
// Why: migration 0091 got delivery revenue and commissions into the books, but
// an imported settlement file has no product detail, so those orders carry no
// order_items — no COGS, no inventory deduction. The platforms do publish a
// per-product report (DiDi's "Reporte diario de productos"), which is what
// these two tables consume.
//
// Design note (important): a product report must NOT create orders.
//   - It has no order boundaries, so any orders synthesised from it would be
//     one-per-day and wreck average ticket / break-even, the exact failure
//     0091 warns about for settlement summaries.
//   - Worse, the tenant already imports the settlement or operations report
//     for revenue. Creating orders here too would DOUBLE-COUNT the same money.
// So this is a consumption + COGS feed that runs alongside the revenue feed,
// never a second source of revenue. `platform_product_sales.gross` is recorded
// for reconciliation only and is deliberately not summed into any revenue
// report.
//
// The report also carries no quantity column, and platform list prices differ
// from POS prices (delivery markup: a $99 POS item bills $129 on DiDi) while
// platform product names differ from POS menu names. `platform_item_map` is
// the tenant-confirmed bridge: name -> menu item + the price ON that platform,
// learned once and reused on every later import. Quantity is then
// gross / platform_price, which lands on exact integers.
export async function up(sql) {
  // ---- Learned mapping: platform product name -> POS menu item + price ----
  await sql`
    CREATE TABLE IF NOT EXISTS platform_item_map (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
      platform_id INTEGER NOT NULL REFERENCES delivery_platforms(id),
      platform_item_name TEXT NOT NULL,
      -- Accent/case-folded lookup key. The display name above is kept verbatim
      -- so the UI can show the tenant exactly what the file said.
      norm_name TEXT NOT NULL,
      -- Nullable: a platform-only item (a virtual-brand SKU with no POS row)
      -- can still have its quantity recorded, it just gets no recipe deduction.
      menu_item_id INTEGER REFERENCES menu_items(id) ON DELETE SET NULL,
      -- List price on the PLATFORM, not in the POS. Nullable until confirmed.
      platform_price NUMERIC(10,2),
      -- Free modifiers (salsas) bill 0.00 and have no unit price to divide by.
      -- Marking them ignored keeps them out of the "unresolved" count forever.
      ignored BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_item_map_key
    ON platform_item_map (tenant_id, platform_id, norm_name)
  `;

  // ---- The consumption feed itself ----
  await sql`
    CREATE TABLE IF NOT EXISTS platform_product_sales (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
      batch_id INTEGER REFERENCES manual_sales_batches(id) ON DELETE CASCADE,
      platform_id INTEGER REFERENCES delivery_platforms(id),
      business_date DATE NOT NULL,
      platform_item_name TEXT NOT NULL,
      menu_item_id INTEGER REFERENCES menu_items(id) ON DELETE SET NULL,
      quantity NUMERIC(10,2) NOT NULL,
      -- Reconciliation only. Never summed into revenue: the settlement import
      -- already booked this money as orders.
      gross NUMERIC(10,2) NOT NULL DEFAULT 0,
      -- Recipe cost per unit, frozen at import time. Ingredient costs move, and
      -- a historical COGS figure that silently re-prices itself is not a COGS
      -- figure.
      unit_cost NUMERIC(10,4),
      cogs NUMERIC(10,2),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_platform_product_sales_tenant_date
    ON platform_product_sales (tenant_id, business_date DESC, id DESC)
  `;

  // Re-importing an overlapping date range would double-deduct inventory. The
  // preview path checks (platform_id, business_date) against this index to
  // refuse days that are already covered.
  await sql`
    CREATE INDEX IF NOT EXISTS idx_platform_product_sales_platform_date
    ON platform_product_sales (tenant_id, platform_id, business_date)
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_platform_product_sales_batch
    ON platform_product_sales (batch_id)
  `;

  // ---- RLS — same shape as migrations 0089 / 0091 ----
  for (const table of ['platform_item_map', 'platform_product_sales']) {
    await sql.unsafe(`
      DO $$
      BEGIN
        EXECUTE 'ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY';

        IF NOT EXISTS (
          SELECT 1 FROM pg_policies
          WHERE tablename = '${table}' AND policyname = 'tenant_isolation'
        ) THEN
          EXECUTE
            'CREATE POLICY tenant_isolation ON ${table} '
            || 'USING (tenant_id = current_setting(''app.tenant_id'', true)) '
            || 'WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true))';
        END IF;
      END $$;
    `);

    await sql.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO app_user`);
    await sql.unsafe(`
      DO $$
      BEGIN
        IF to_regclass('public.${table}_id_seq') IS NOT NULL THEN
          EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE ${table}_id_seq TO app_user';
        END IF;
      END $$;
    `);
  }
}
