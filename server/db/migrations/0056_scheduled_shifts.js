export const version = 56;
export const name = 'scheduled_shifts';

export async function up(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS scheduled_shifts (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      starts_at TIMESTAMPTZ NOT NULL,
      ends_at TIMESTAMPTZ NOT NULL,
      notes TEXT,
      created_by_employee_id INTEGER REFERENCES employees(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT scheduled_shifts_time_order CHECK (ends_at > starts_at)
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_scheduled_shifts_tenant_emp_start
      ON scheduled_shifts(tenant_id, employee_id, starts_at)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_scheduled_shifts_tenant_range
      ON scheduled_shifts(tenant_id, starts_at, ends_at)
  `;

  await sql`ALTER TABLE scheduled_shifts ENABLE ROW LEVEL SECURITY`;
  await sql`ALTER TABLE scheduled_shifts FORCE ROW LEVEL SECURITY`;
  await sql`DROP POLICY IF EXISTS tenant_isolation ON scheduled_shifts`;
  await sql`
    CREATE POLICY tenant_isolation ON scheduled_shifts
      USING (tenant_id = current_setting('app.tenant_id', true))
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true))
  `;
  await sql`GRANT SELECT, INSERT, UPDATE, DELETE ON scheduled_shifts TO app_user`;
  await sql`GRANT USAGE, SELECT ON SEQUENCE scheduled_shifts_id_seq TO app_user`;

  // Link from actual shift → the scheduled shift it matched (if any).
  // Unique so we never link two shifts to the same scheduled slot.
  await sql`
    ALTER TABLE shifts
      ADD COLUMN IF NOT EXISTS scheduled_shift_id INTEGER
        REFERENCES scheduled_shifts(id) ON DELETE SET NULL
  `;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_shifts_scheduled_shift_id
      ON shifts(scheduled_shift_id) WHERE scheduled_shift_id IS NOT NULL
  `;
}
