export const version = 43;
export const name = 'recurring_expenses';

export async function up(sql) {
  // ── recurring_expenses ────────────────────────────────────────────────────
  // User-declared rules for fixed bills (rent, utilities, services, software).
  // Compared against each new expense to flag bills that drift outside the
  // expected range — catching gradual price creep humans don't notice.
  await sql`
    CREATE TABLE IF NOT EXISTS recurring_expenses (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
      label TEXT NOT NULL,
      category TEXT NOT NULL,
      vendor_id INTEGER REFERENCES vendors(id) ON DELETE SET NULL,
      payee TEXT,
      expected_amount NUMERIC(10,2) NOT NULL,
      variance_threshold_pct NUMERIC(5,2) NOT NULL DEFAULT 10,
      frequency TEXT NOT NULL DEFAULT 'monthly',
      last_charged_date DATE,
      next_expected_date DATE,
      active BOOLEAN NOT NULL DEFAULT true,
      notes TEXT,
      created_by INTEGER REFERENCES employees(id),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      CHECK (frequency IN ('weekly', 'biweekly', 'monthly', 'bimonthly', 'quarterly', 'annual'))
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_recurring_expenses_tenant
      ON recurring_expenses(tenant_id, active)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_recurring_expenses_match
      ON recurring_expenses(tenant_id, category, active)
      WHERE active = true
  `;

  await sql`ALTER TABLE recurring_expenses ENABLE ROW LEVEL SECURITY`;
  await sql`ALTER TABLE recurring_expenses FORCE ROW LEVEL SECURITY`;
  await sql`DROP POLICY IF EXISTS tenant_isolation ON recurring_expenses`;
  await sql`
    CREATE POLICY tenant_isolation ON recurring_expenses
      USING (tenant_id = current_setting('app.tenant_id', true))
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true))
  `;
  await sql`GRANT SELECT, INSERT, UPDATE, DELETE ON recurring_expenses TO app_user`;
  await sql`GRANT USAGE, SELECT ON SEQUENCE recurring_expenses_id_seq TO app_user`;

  // Link expenses → recurring rule they matched (nullable, set on save).
  await sql`
    ALTER TABLE expenses
      ADD COLUMN IF NOT EXISTS recurring_expense_id INTEGER REFERENCES recurring_expenses(id) ON DELETE SET NULL
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_expenses_recurring
      ON expenses(tenant_id, recurring_expense_id)
      WHERE recurring_expense_id IS NOT NULL
  `;
}
