/**
 * Migration v3: Sales CRM tables
 *
 * Platform-level tables (no RLS) for sales rep accounts, commission tracking,
 * demo tenant config, and agent monitoring.
 */

export const version = 3;
export const name = 'sales-crm';

export async function up(sql) {
  // ── Sales rep accounts ──
  await sql`
    CREATE TABLE IF NOT EXISTS sales_reps (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      phone TEXT,
      role TEXT NOT NULL DEFAULT 'rep' CHECK (role IN ('rep', 'manager')),
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  // ── Extend leads table ──
  await sql`ALTER TABLE leads ADD COLUMN IF NOT EXISTS assigned_rep_id INTEGER REFERENCES sales_reps(id)`;
  await sql`ALTER TABLE leads ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'new'`;
  await sql`ALTER TABLE leads ADD COLUMN IF NOT EXISTS tenant_id TEXT REFERENCES tenants(id)`;
  await sql`ALTER TABLE leads ADD COLUMN IF NOT EXISTS converted_at TIMESTAMPTZ`;
  await sql`ALTER TABLE leads ADD COLUMN IF NOT EXISTS notes TEXT`;
  await sql`ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_contacted_at TIMESTAMPTZ`;

  // ── Commission tracking ──
  await sql`
    CREATE TABLE IF NOT EXISTS sales_commissions (
      id SERIAL PRIMARY KEY,
      rep_id INTEGER NOT NULL REFERENCES sales_reps(id),
      tenant_id TEXT NOT NULL REFERENCES tenants(id),
      commission_percent NUMERIC(5,2) NOT NULL DEFAULT 10.00,
      duration_months INTEGER NOT NULL DEFAULT 12,
      start_date DATE NOT NULL DEFAULT CURRENT_DATE,
      end_date DATE,
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(rep_id, tenant_id)
    )
  `;

  // ── Monthly commission payouts ──
  await sql`
    CREATE TABLE IF NOT EXISTS commission_payouts (
      id SERIAL PRIMARY KEY,
      rep_id INTEGER NOT NULL REFERENCES sales_reps(id),
      commission_id INTEGER NOT NULL REFERENCES sales_commissions(id),
      tenant_id TEXT NOT NULL REFERENCES tenants(id),
      period TEXT NOT NULL,
      mrr_amount NUMERIC(10,2) NOT NULL,
      commission_amount NUMERIC(10,2) NOT NULL,
      status TEXT DEFAULT 'earned' CHECK (status IN ('earned', 'paid', 'cancelled')),
      paid_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(commission_id, period)
    )
  `;

  // ── Sales activity log ──
  await sql`
    CREATE TABLE IF NOT EXISTS sales_activities (
      id SERIAL PRIMARY KEY,
      rep_id INTEGER NOT NULL REFERENCES sales_reps(id),
      lead_id INTEGER REFERENCES leads(id),
      tenant_id TEXT REFERENCES tenants(id),
      activity_type TEXT NOT NULL CHECK (activity_type IN ('call', 'email', 'meeting', 'demo', 'note', 'follow_up')),
      description TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  // ── Demo tenant config ──
  await sql`
    CREATE TABLE IF NOT EXISTS demo_config (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) UNIQUE,
      reset_schedule TEXT DEFAULT '0 4 * * *',
      last_reset_at TIMESTAMPTZ,
      data_volume TEXT DEFAULT 'medium',
      active BOOLEAN DEFAULT true
    )
  `;

  // ── Agent monitoring alerts ──
  await sql`
    CREATE TABLE IF NOT EXISTS agent_alerts (
      id SERIAL PRIMARY KEY,
      alert_type TEXT NOT NULL,
      severity TEXT DEFAULT 'warning' CHECK (severity IN ('info', 'warning', 'critical')),
      tenant_id TEXT REFERENCES tenants(id),
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      metadata JSONB DEFAULT '{}'::jsonb,
      auto_action_taken TEXT,
      acknowledged BOOLEAN DEFAULT false,
      acknowledged_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  // ── Agent monitoring rules ──
  await sql`
    CREATE TABLE IF NOT EXISTS agent_monitor_rules (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      metric TEXT NOT NULL,
      condition TEXT NOT NULL,
      threshold NUMERIC(10,2) NOT NULL,
      severity TEXT DEFAULT 'warning',
      auto_action TEXT,
      cooldown_hours INTEGER DEFAULT 24,
      enabled BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  // ── Indexes ──
  await sql`CREATE INDEX IF NOT EXISTS idx_leads_assigned_rep ON leads(assigned_rep_id) WHERE assigned_rep_id IS NOT NULL`;
  await sql`CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_sales_commissions_rep ON sales_commissions(rep_id) WHERE active = true`;
  await sql`CREATE INDEX IF NOT EXISTS idx_commission_payouts_rep ON commission_payouts(rep_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_commission_payouts_period ON commission_payouts(period)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_sales_activities_rep ON sales_activities(rep_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_sales_activities_lead ON sales_activities(lead_id) WHERE lead_id IS NOT NULL`;
  await sql`CREATE INDEX IF NOT EXISTS idx_agent_alerts_type ON agent_alerts(alert_type)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_agent_alerts_unack ON agent_alerts(acknowledged) WHERE acknowledged = false`;

  // ── Seed default monitoring rules ──
  await sql`
    INSERT INTO agent_monitor_rules (name, metric, condition, threshold, severity, auto_action, cooldown_hours)
    VALUES
      ('Inactive tenant', 'days_inactive', 'gt', 7, 'warning', 'notify_sales_rep', 48),
      ('Revenue drop', 'revenue_change_pct', 'lt', -30, 'warning', 'notify_sales_rep', 168),
      ('No orders (pro)', 'days_no_orders', 'gt', 3, 'critical', 'flag_for_review', 72)
    ON CONFLICT DO NOTHING
  `;
}
