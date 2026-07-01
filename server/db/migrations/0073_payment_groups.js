export const version = 73;
export const name = 'payment_groups';

// "Cobrar Juntas" — one card swipe (or one cash payment) closes N open tickets
// at once. Cashier's workflow used to be either N swipes or void-and-re-ring,
// which left orphan "ready + unpaid" rows in the DB (see 2026-06-30 audit,
// order #6505). This table is the anchor for the combined transaction so we
// can (a) reprint a single grouped receipt, (b) tie one CFDI invoice to the
// group later, (c) attribute owner-facing reports to the grouped charge.
//
// One payment_groups row → N orders share the same mp_order_id /
// payment_intent_id via their order_payments rows. Orders keep their own
// KDS lifecycle, their own loyalty attribution, their own refund path.

export async function up(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS payment_groups (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
      employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      subtotal NUMERIC(10,2) NOT NULL,
      tax NUMERIC(10,2) NOT NULL DEFAULT 0,
      tip NUMERIC(10,2) NOT NULL DEFAULT 0,
      total NUMERIC(10,2) NOT NULL,
      payment_method TEXT NOT NULL,
      mp_order_id TEXT,
      mp_terminal_id TEXT,
      payment_intent_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      paid_at TIMESTAMPTZ
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_payment_groups_tenant_created
      ON payment_groups(tenant_id, created_at DESC)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_payment_groups_mp_order
      ON payment_groups(mp_order_id) WHERE mp_order_id IS NOT NULL
  `;

  await sql`ALTER TABLE payment_groups ENABLE ROW LEVEL SECURITY`;
  await sql`ALTER TABLE payment_groups FORCE ROW LEVEL SECURITY`;
  await sql`DROP POLICY IF EXISTS tenant_isolation ON payment_groups`;
  await sql`
    CREATE POLICY tenant_isolation ON payment_groups
      USING (tenant_id = current_setting('app.tenant_id', true))
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true))
  `;

  await sql`GRANT SELECT, INSERT, UPDATE ON payment_groups TO app_user`;
  await sql`GRANT USAGE, SELECT ON SEQUENCE payment_groups_id_seq TO app_user`;

  await sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_group_id INTEGER REFERENCES payment_groups(id) ON DELETE SET NULL`;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_orders_payment_group
      ON orders(tenant_id, payment_group_id) WHERE payment_group_id IS NOT NULL
  `;
}
