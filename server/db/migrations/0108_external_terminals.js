export const version = 108;
export const name = 'external_terminals';

// Non-integrated bank card terminals (Inbursa, BBVA, Banorte, ...), 2026-08-24.
//
// Why: bank-acquired terminals often price MSI/discount rates well below
// Mercado Pago / Clip, but banks publish no charge API — the cashier keys the
// amount into the device by hand. This table lets a tenant register each such
// terminal (name + agreed discount rate) so the POS can offer a "cobrar en
// terminal X" button that marks the order paid with payment_method =
// 'external_terminal' and pins WHICH device took it via
// orders.external_terminal_id. Reports then split these sales out per terminal
// and estimate fees from fee_percent — an estimate, since the bank never tells
// us the real per-transaction fee.
//
// Rows are soft-deactivated (active = false), never deleted: historic orders
// keep their external_terminal_id and reports still need the name.

export async function up(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS external_terminals (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
      name TEXT NOT NULL,
      -- Agreed discount rate in percent (e.g. 1.75 for 1.75%). Estimation
      -- only — the true fee lives on the bank statement.
      fee_percent NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (fee_percent >= 0 AND fee_percent <= 99.99),
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_external_terminals_tenant
      ON external_terminals(tenant_id, active)
  `;

  await sql`ALTER TABLE external_terminals ENABLE ROW LEVEL SECURITY`;
  await sql`ALTER TABLE external_terminals FORCE ROW LEVEL SECURITY`;
  await sql`DROP POLICY IF EXISTS tenant_isolation ON external_terminals`;
  await sql`
    CREATE POLICY tenant_isolation ON external_terminals
      USING (tenant_id = current_setting('app.tenant_id', true))
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true))
  `;

  await sql`GRANT SELECT, INSERT, UPDATE, DELETE ON external_terminals TO app_user`;
  await sql`GRANT USAGE, SELECT ON SEQUENCE external_terminals_id_seq TO app_user`;

  // Which external terminal took the payment. No FK: RLS-scoped lookups only,
  // and orders must survive a terminal row ever being hard-deleted by hand.
  await sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS external_terminal_id INTEGER`;
}
