/**
 * Migration: Agent SDK tracking & nightly reports
 * - agent_runs: tracks every SDK query() call (cost, tokens, duration)
 * - agent_reports: stores nightly/weekly report output
 * - agent_report_config: per-tenant scheduling preferences
 */

export const version = 2;
export const name = 'agent-reports';

export async function up(sql) {
  // ==================== 1. agent_runs ====================

  await sql`
    CREATE TABLE IF NOT EXISTS agent_runs (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      trigger_type TEXT NOT NULL DEFAULT 'chat' CHECK (trigger_type IN ('chat', 'scheduled', 'webhook')),
      prompt_summary TEXT,
      model TEXT,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cost_usd NUMERIC(10,6) DEFAULT 0,
      duration_ms INTEGER DEFAULT 0,
      num_turns INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'success' CHECK (status IN ('success', 'error', 'budget_exceeded')),
      error_message TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  await sql`ALTER TABLE agent_runs ENABLE ROW LEVEL SECURITY`;
  await sql`ALTER TABLE agent_runs FORCE ROW LEVEL SECURITY`;

  await sql`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE tablename = 'agent_runs' AND policyname = 'tenant_isolation'
      ) THEN
        EXECUTE 'CREATE POLICY tenant_isolation ON agent_runs
          USING (tenant_id = current_setting(''app.tenant_id'', true))
          WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true))';
      END IF;
    END $$
  `;

  await sql`GRANT SELECT, INSERT, UPDATE, DELETE ON agent_runs TO app_user`;
  await sql`GRANT USAGE, SELECT ON SEQUENCE agent_runs_id_seq TO app_user`;

  await sql`CREATE INDEX IF NOT EXISTS idx_agent_runs_tenant ON agent_runs(tenant_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_agent_runs_tenant_created ON agent_runs(tenant_id, created_at)`;

  // ==================== 2. agent_reports ====================

  await sql`
    CREATE TABLE IF NOT EXISTS agent_reports (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      report_date DATE NOT NULL,
      report_type TEXT NOT NULL DEFAULT 'nightly' CHECK (report_type IN ('nightly', 'weekly', 'custom')),
      content_md TEXT,
      highlights JSONB DEFAULT '[]'::jsonb,
      cost_usd NUMERIC(10,6) DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(tenant_id, report_date, report_type)
    )
  `;

  await sql`ALTER TABLE agent_reports ENABLE ROW LEVEL SECURITY`;
  await sql`ALTER TABLE agent_reports FORCE ROW LEVEL SECURITY`;

  await sql`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE tablename = 'agent_reports' AND policyname = 'tenant_isolation'
      ) THEN
        EXECUTE 'CREATE POLICY tenant_isolation ON agent_reports
          USING (tenant_id = current_setting(''app.tenant_id'', true))
          WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true))';
      END IF;
    END $$
  `;

  await sql`GRANT SELECT, INSERT, UPDATE, DELETE ON agent_reports TO app_user`;
  await sql`GRANT USAGE, SELECT ON SEQUENCE agent_reports_id_seq TO app_user`;

  await sql`CREATE INDEX IF NOT EXISTS idx_agent_reports_tenant ON agent_reports(tenant_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_agent_reports_tenant_date ON agent_reports(tenant_id, report_date)`;

  // ==================== 3. agent_report_config ====================

  await sql`
    CREATE TABLE IF NOT EXISTS agent_report_config (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
      enabled BOOLEAN DEFAULT false,
      report_hour INTEGER DEFAULT 5 CHECK (report_hour >= 0 AND report_hour <= 23),
      timezone TEXT DEFAULT 'America/Mexico_City',
      delivery_method TEXT DEFAULT 'in_app' CHECK (delivery_method IN ('in_app', 'email', 'both')),
      custom_prompt TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  await sql`ALTER TABLE agent_report_config ENABLE ROW LEVEL SECURITY`;
  await sql`ALTER TABLE agent_report_config FORCE ROW LEVEL SECURITY`;

  await sql`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE tablename = 'agent_report_config' AND policyname = 'tenant_isolation'
      ) THEN
        EXECUTE 'CREATE POLICY tenant_isolation ON agent_report_config
          USING (tenant_id = current_setting(''app.tenant_id'', true))
          WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true))';
      END IF;
    END $$
  `;

  await sql`GRANT SELECT, INSERT, UPDATE, DELETE ON agent_report_config TO app_user`;
  await sql`GRANT USAGE, SELECT ON SEQUENCE agent_report_config_id_seq TO app_user`;

  // ==================== 4. Seed config for existing Pro tenants ====================

  const proTenants = await sql`SELECT id FROM tenants WHERE plan = 'pro'`;
  for (const tenant of proTenants) {
    await sql`
      INSERT INTO agent_report_config (tenant_id, enabled)
      VALUES (${tenant.id}, false)
      ON CONFLICT (tenant_id) DO NOTHING
    `;
  }
}
