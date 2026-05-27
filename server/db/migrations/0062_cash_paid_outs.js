export const version = 62;
export const name = 'cash_paid_outs';

// Tracks cash taken from the register for non-order payments
// (water, trash collection, supplies, small vendor pay-outs).
// Anchored to the active drawer session so it nets against
// expected_cash_total at shift close-out.
//
// Audit trail:
//   - by_employee_id: who took the cash out
//   - payee: free text of who it went to (vendor, person)
//   - reason: short category for owner reporting
//   - receipt_image_url: optional photo of the supporting receipt
//   - no_receipt: explicit flag so owner can review unsupported pay-outs
//   - voided_at + voided_by: soft-delete for mistakes (kept for audit)

export async function up(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS cash_paid_outs (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
      shift_id INTEGER REFERENCES shifts(id) ON DELETE SET NULL,
      drawer_session_id INTEGER REFERENCES cash_drawer_sessions(id) ON DELETE SET NULL,
      by_employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      amount_out NUMERIC(10,2) NOT NULL CHECK (amount_out > 0),
      change_returned NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (change_returned >= 0),
      net_amount NUMERIC(10,2) GENERATED ALWAYS AS (amount_out - change_returned) STORED,
      payee TEXT,
      reason TEXT NOT NULL DEFAULT 'other',
      notes TEXT,
      receipt_image_url TEXT,
      no_receipt BOOLEAN NOT NULL DEFAULT false,
      source TEXT NOT NULL DEFAULT 'pos',
      voided_at TIMESTAMPTZ,
      voided_by_employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      void_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (change_returned <= amount_out)
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_cash_paid_outs_tenant_created
      ON cash_paid_outs(tenant_id, created_at DESC)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_cash_paid_outs_shift
      ON cash_paid_outs(tenant_id, shift_id)
      WHERE voided_at IS NULL
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_cash_paid_outs_drawer
      ON cash_paid_outs(tenant_id, drawer_session_id)
      WHERE voided_at IS NULL
  `;

  await sql`ALTER TABLE cash_paid_outs ENABLE ROW LEVEL SECURITY`;
  await sql`ALTER TABLE cash_paid_outs FORCE ROW LEVEL SECURITY`;
  await sql`DROP POLICY IF EXISTS tenant_isolation ON cash_paid_outs`;
  await sql`
    CREATE POLICY tenant_isolation ON cash_paid_outs
      USING (tenant_id = current_setting('app.tenant_id', true))
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true))
  `;

  await sql`GRANT SELECT, INSERT, UPDATE, DELETE ON cash_paid_outs TO app_user`;
  await sql`GRANT USAGE, SELECT ON SEQUENCE cash_paid_outs_id_seq TO app_user`;

  // ---- Seed manage_cash_paid_outs permission ----
  // Cashiers need this to record on the line. Kitchen/bar do not handle cash,
  // so we deny by default; admin + manager get it for void/edit on top.
  await sql`
    INSERT INTO role_permissions (tenant_id, role, permission, granted)
    SELECT t.id, r.role, 'manage_cash_paid_outs', true
    FROM tenants t
    CROSS JOIN (VALUES ('admin'), ('manager'), ('cashier')) AS r(role)
    ON CONFLICT (tenant_id, role, permission) DO NOTHING
  `;
  await sql`
    INSERT INTO role_permissions (tenant_id, role, permission, granted)
    SELECT t.id, r.role, 'manage_cash_paid_outs', false
    FROM tenants t
    CROSS JOIN (VALUES ('kitchen'), ('bar')) AS r(role)
    ON CONFLICT (tenant_id, role, permission) DO NOTHING
  `;
}
