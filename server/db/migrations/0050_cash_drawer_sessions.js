export const version = 50;
export const name = 'cash_drawer_sessions';

export async function up(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS cash_drawer_sessions (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
      shift_id INTEGER NOT NULL UNIQUE REFERENCES shifts(id) ON DELETE CASCADE,
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      opening_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
      opening_total NUMERIC(10,2) NOT NULL DEFAULT 0,
      closing_counts JSONB,
      closing_total NUMERIC(10,2),
      expected_cash_total NUMERIC(10,2),
      variance_total NUMERIC(10,2),
      variance_note TEXT,
      opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      closed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_cash_drawer_sessions_tenant
      ON cash_drawer_sessions(tenant_id, opened_at DESC)
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_cash_drawer_sessions_shift
      ON cash_drawer_sessions(tenant_id, shift_id)
  `;

  await sql`ALTER TABLE cash_drawer_sessions ENABLE ROW LEVEL SECURITY`;
  await sql`ALTER TABLE cash_drawer_sessions FORCE ROW LEVEL SECURITY`;
  await sql`DROP POLICY IF EXISTS tenant_isolation ON cash_drawer_sessions`;
  await sql`
    CREATE POLICY tenant_isolation ON cash_drawer_sessions
      USING (tenant_id = current_setting('app.tenant_id', true))
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true))
  `;

  await sql`GRANT SELECT, INSERT, UPDATE, DELETE ON cash_drawer_sessions TO app_user`;
  await sql`GRANT USAGE, SELECT ON SEQUENCE cash_drawer_sessions_id_seq TO app_user`;
}
