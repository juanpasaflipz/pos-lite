export const version = 67;
export const name = 'order_tip_adjustments';

// Post-close cash-tip adjustments.
//
// Why: in MX fast-casual + dine-in, the cash tip is often left on the table
// after the receipt has already been printed and the order closed. Today the
// only path to record that tip is to edit the order pre-payment, so the tip
// gets lost from payroll and reports. This table is the audit trail for
// `POST /api/payments/cash-tip-adjust`, which atomically bumps `orders.tip`
// (and the matching cash leg in `order_payments` for splits) and inserts a
// row here.
//
// Attribution choice: the tip is added to `orders.tip` so the *original*
// shift's payroll absorbs it (clean tip-share math for the server who took
// the order). This audit table preserves a separate `created_at` so reports
// can break out post-close tips later if owners want that view.

export async function up(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS order_tip_adjustments (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
      order_id INTEGER NOT NULL REFERENCES orders(id),
      amount NUMERIC(10,2) NOT NULL CHECK (amount > 0),
      payment_method TEXT NOT NULL DEFAULT 'cash',
      by_employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_order_tip_adjustments_order
      ON order_tip_adjustments(tenant_id, order_id)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_order_tip_adjustments_created
      ON order_tip_adjustments(tenant_id, created_at DESC)
  `;

  await sql`ALTER TABLE order_tip_adjustments ENABLE ROW LEVEL SECURITY`;
  await sql`ALTER TABLE order_tip_adjustments FORCE ROW LEVEL SECURITY`;
  await sql`DROP POLICY IF EXISTS tenant_isolation ON order_tip_adjustments`;
  await sql`
    CREATE POLICY tenant_isolation ON order_tip_adjustments
      USING (tenant_id = current_setting('app.tenant_id', true))
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true))
  `;

  await sql`GRANT SELECT, INSERT ON order_tip_adjustments TO app_user`;
  await sql`GRANT USAGE, SELECT ON SEQUENCE order_tip_adjustments_id_seq TO app_user`;
}
