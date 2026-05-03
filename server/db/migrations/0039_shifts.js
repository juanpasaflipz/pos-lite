export const version = 39;
export const name = 'shifts';

export async function up(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS shifts (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      clock_in_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      clock_out_at TIMESTAMPTZ,
      notes TEXT,
      edited_by_employee_id INTEGER REFERENCES employees(id),
      edited_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_shifts_tenant_employee
      ON shifts(tenant_id, employee_id, clock_in_at DESC)
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_shifts_open
      ON shifts(tenant_id, clock_out_at) WHERE clock_out_at IS NULL
  `;

  await sql`ALTER TABLE shifts ENABLE ROW LEVEL SECURITY`;
  await sql`ALTER TABLE shifts FORCE ROW LEVEL SECURITY`;
  await sql`DROP POLICY IF EXISTS tenant_isolation ON shifts`;
  await sql`
    CREATE POLICY tenant_isolation ON shifts
      USING (tenant_id = current_setting('app.tenant_id', true))
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true))
  `;

  await sql`GRANT SELECT, INSERT, UPDATE, DELETE ON shifts TO app_user`;
  await sql`GRANT USAGE, SELECT ON SEQUENCE shifts_id_seq TO app_user`;
}
