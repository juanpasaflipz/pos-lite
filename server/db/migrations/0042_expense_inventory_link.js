export const version = 42;
export const name = 'expense_inventory_link';

export async function up(sql) {
  // ── expense_items ─────────────────────────────────────────────────────────
  // Normalized line items per expense (one expense → many inventory purchases).
  // Replaces the inventory_matches JSON blob inside expenses.receipt_data, which
  // was opaque to SQL aggregations (recipe cost rollups, overpay detection).
  await sql`
    CREATE TABLE IF NOT EXISTS expense_items (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
      expense_id INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
      inventory_item_id INTEGER NOT NULL REFERENCES inventory_items(id),
      quantity NUMERIC(12,4) NOT NULL,
      unit_cost NUMERIC(12,4) NOT NULL,
      line_total NUMERIC(12,2) NOT NULL,
      raw_description TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS idx_expense_items_expense ON expense_items(expense_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_expense_items_inventory ON expense_items(tenant_id, inventory_item_id)`;

  await sql`ALTER TABLE expense_items ENABLE ROW LEVEL SECURITY`;
  await sql`ALTER TABLE expense_items FORCE ROW LEVEL SECURITY`;
  await sql`DROP POLICY IF EXISTS tenant_isolation ON expense_items`;
  await sql`
    CREATE POLICY tenant_isolation ON expense_items
      USING (tenant_id = current_setting('app.tenant_id', true))
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true))
  `;
  await sql`GRANT SELECT, INSERT, UPDATE, DELETE ON expense_items TO app_user`;
  await sql`GRANT USAGE, SELECT ON SEQUENCE expense_items_id_seq TO app_user`;

  // ── inventory_cost_history ────────────────────────────────────────────────
  // Append-only ledger of every cost_price change. Feeds Phase 2 overpay
  // detection (rolling median vs new unit_cost). Survives expense deletion via
  // SET NULL so historical pricing context is preserved.
  await sql`
    CREATE TABLE IF NOT EXISTS inventory_cost_history (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
      inventory_item_id INTEGER NOT NULL REFERENCES inventory_items(id),
      vendor_id INTEGER REFERENCES vendors(id),
      expense_id INTEGER REFERENCES expenses(id) ON DELETE SET NULL,
      quantity_added NUMERIC(12,4) NOT NULL,
      unit_cost NUMERIC(12,4) NOT NULL,
      prev_cost_price NUMERIC(12,4),
      new_cost_price NUMERIC(12,4) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_inv_cost_history_item
      ON inventory_cost_history(tenant_id, inventory_item_id, created_at DESC)
  `;

  await sql`ALTER TABLE inventory_cost_history ENABLE ROW LEVEL SECURITY`;
  await sql`ALTER TABLE inventory_cost_history FORCE ROW LEVEL SECURITY`;
  await sql`DROP POLICY IF EXISTS tenant_isolation ON inventory_cost_history`;
  await sql`
    CREATE POLICY tenant_isolation ON inventory_cost_history
      USING (tenant_id = current_setting('app.tenant_id', true))
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true))
  `;
  await sql`GRANT SELECT, INSERT, UPDATE, DELETE ON inventory_cost_history TO app_user`;
  await sql`GRANT USAGE, SELECT ON SEQUENCE inventory_cost_history_id_seq TO app_user`;

  // ── menu_item_costs view ──────────────────────────────────────────────────
  // Sums quantity_used × cost_price across menu_item_ingredients. Joined with
  // menu_items.price to surface margin %. Recreated as a regular view (not
  // materialized) since menu/inventory edits are low-frequency and we want
  // live data.
  await sql`DROP VIEW IF EXISTS menu_item_costs`;
  await sql`
    CREATE VIEW menu_item_costs AS
    SELECT
      mi.id AS menu_item_id,
      mi.tenant_id,
      mi.name,
      mi.price,
      COALESCE(SUM(mii.quantity_used * inv.cost_price), 0)::NUMERIC(12,4) AS food_cost,
      CASE
        WHEN mi.price > 0
          THEN ROUND((COALESCE(SUM(mii.quantity_used * inv.cost_price), 0) / mi.price * 100)::NUMERIC, 2)
        ELSE NULL
      END AS food_cost_pct,
      CASE
        WHEN mi.price > 0
          THEN (mi.price - COALESCE(SUM(mii.quantity_used * inv.cost_price), 0))::NUMERIC(12,4)
        ELSE NULL
      END AS margin,
      COUNT(mii.inventory_item_id) AS ingredient_count
    FROM menu_items mi
    LEFT JOIN menu_item_ingredients mii
      ON mii.menu_item_id = mi.id AND mii.tenant_id = mi.tenant_id
    LEFT JOIN inventory_items inv
      ON inv.id = mii.inventory_item_id AND inv.tenant_id = mii.tenant_id
    GROUP BY mi.id, mi.tenant_id, mi.name, mi.price
  `;
  await sql`GRANT SELECT ON menu_item_costs TO app_user`;
}
