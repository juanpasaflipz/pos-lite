export const version = 82;
export const name = 'print_jobs';

export async function up(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS print_jobs (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
      order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
      printer_id INTEGER REFERENCES printers(id) ON DELETE SET NULL,
      job_type TEXT NOT NULL DEFAULT 'kitchen',
      source TEXT,
      payload JSONB NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      claimed_by TEXT,
      claimed_at TIMESTAMPTZ,
      printed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_print_jobs_tenant_status
    ON print_jobs(tenant_id, status, id)
  `;

  await sql`
    ALTER TABLE print_jobs ENABLE ROW LEVEL SECURITY
  `;

  await sql`
    ALTER TABLE print_jobs FORCE ROW LEVEL SECURITY
  `;

  await sql`
    DROP POLICY IF EXISTS tenant_isolation ON print_jobs
  `;

  await sql`
    CREATE POLICY tenant_isolation ON print_jobs
      USING (tenant_id = current_setting('app.tenant_id', true))
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true))
  `;
}
