export const version = 54;
export const name = 'payroll';

// Payroll foundation: pay rates (with history), tip policy, period snapshots.
// We store labor as a first-class concept so managers can see labor % of sales
// in real time and freeze periods for CSV export to Runa / Worky / Aspel.
//
// CFDI 4.0 nómina stamping, IMSS, ISR are deliberately OUT of scope — those are
// handled by the operator's payroll provider. We give them clean hours + rates.
export async function up(sql) {
  // ---- employees: denormalized current pay ----
  await sql`
    ALTER TABLE employees
      ADD COLUMN IF NOT EXISTS pay_type TEXT NOT NULL DEFAULT 'hourly'
        CHECK (pay_type IN ('hourly','salary','commission','no_pay'))
  `;
  await sql`
    ALTER TABLE employees
      ADD COLUMN IF NOT EXISTS hourly_rate_cents INTEGER NOT NULL DEFAULT 0
        CHECK (hourly_rate_cents >= 0)
  `;
  await sql`
    ALTER TABLE employees
      ADD COLUMN IF NOT EXISTS weekly_salary_cents INTEGER NOT NULL DEFAULT 0
        CHECK (weekly_salary_cents >= 0)
  `;

  // ---- employee_pay_rates: historical rate changes ----
  // Why historical: if a manager raises someone's rate mid-period, retroactive
  // shift edits or reopening a period should compute pay at the rate that was
  // in effect at the time of the shift, not today's rate.
  await sql`
    CREATE TABLE IF NOT EXISTS employee_pay_rates (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      pay_type TEXT NOT NULL CHECK (pay_type IN ('hourly','salary','commission','no_pay')),
      hourly_rate_cents INTEGER NOT NULL DEFAULT 0 CHECK (hourly_rate_cents >= 0),
      weekly_salary_cents INTEGER NOT NULL DEFAULT 0 CHECK (weekly_salary_cents >= 0),
      effective_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      set_by_employee_id INTEGER REFERENCES employees(id),
      note TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_employee_pay_rates_tenant_emp
      ON employee_pay_rates(tenant_id, employee_id, effective_from DESC)
  `;
  await sql`ALTER TABLE employee_pay_rates ENABLE ROW LEVEL SECURITY`;
  await sql`ALTER TABLE employee_pay_rates FORCE ROW LEVEL SECURITY`;
  await sql`DROP POLICY IF EXISTS tenant_isolation ON employee_pay_rates`;
  await sql`
    CREATE POLICY tenant_isolation ON employee_pay_rates
      USING (tenant_id = current_setting('app.tenant_id', true))
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true))
  `;
  await sql`GRANT SELECT, INSERT, UPDATE, DELETE ON employee_pay_rates TO app_user`;
  await sql`GRANT USAGE, SELECT ON SEQUENCE employee_pay_rates_id_seq TO app_user`;

  // ---- payroll_settings: per-tenant config ----
  // tip_policy: taker_keeps | pool_by_hours | pool_equal | house_keeps
  // period_type: weekly (only one supported in v1; reserved for catorcenal/quincenal later)
  // period_start_dow: 1 = Monday (ISO), default for MX restaurants
  // overtime_threshold_hours: 48 per Mexico LFT
  // labor_warn_pct / labor_critical_pct: drive widget color thresholds
  await sql`
    CREATE TABLE IF NOT EXISTS payroll_settings (
      tenant_id TEXT PRIMARY KEY DEFAULT current_setting('app.tenant_id', true),
      tip_policy TEXT NOT NULL DEFAULT 'pool_by_hours'
        CHECK (tip_policy IN ('taker_keeps','pool_by_hours','pool_equal','house_keeps')),
      period_type TEXT NOT NULL DEFAULT 'weekly'
        CHECK (period_type IN ('weekly','biweekly','catorcenal','quincenal')),
      period_start_dow SMALLINT NOT NULL DEFAULT 1 CHECK (period_start_dow BETWEEN 0 AND 6),
      overtime_threshold_hours NUMERIC(5,2) NOT NULL DEFAULT 48.00,
      labor_warn_pct NUMERIC(5,2) NOT NULL DEFAULT 25.00,
      labor_critical_pct NUMERIC(5,2) NOT NULL DEFAULT 30.00,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`ALTER TABLE payroll_settings ENABLE ROW LEVEL SECURITY`;
  await sql`ALTER TABLE payroll_settings FORCE ROW LEVEL SECURITY`;
  await sql`DROP POLICY IF EXISTS tenant_isolation ON payroll_settings`;
  await sql`
    CREATE POLICY tenant_isolation ON payroll_settings
      USING (tenant_id = current_setting('app.tenant_id', true))
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true))
  `;
  await sql`GRANT SELECT, INSERT, UPDATE, DELETE ON payroll_settings TO app_user`;

  // ---- payroll_periods: frozen snapshots ----
  // status='open' = current/historical window, recomputed live from shifts.
  // status='closed' = frozen; UI must never recompute, only read totals_cents.
  // Why: once payroll is exported to Runa, you don't want a retroactive shift
  // edit to silently shift the closed period — that creates reconciliation hell.
  await sql`
    CREATE TABLE IF NOT EXISTS payroll_periods (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
      period_start DATE NOT NULL,
      period_end DATE NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
      total_hours NUMERIC(10,2) NOT NULL DEFAULT 0,
      total_overtime_hours NUMERIC(10,2) NOT NULL DEFAULT 0,
      total_base_pay_cents BIGINT NOT NULL DEFAULT 0,
      total_tip_pool_cents BIGINT NOT NULL DEFAULT 0,
      total_sales_cents BIGINT NOT NULL DEFAULT 0,
      labor_pct_of_sales NUMERIC(5,2),
      tip_policy_snapshot TEXT,
      closed_by_employee_id INTEGER REFERENCES employees(id),
      closed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (tenant_id, period_start, period_end)
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_payroll_periods_tenant
      ON payroll_periods(tenant_id, period_start DESC)
  `;
  await sql`ALTER TABLE payroll_periods ENABLE ROW LEVEL SECURITY`;
  await sql`ALTER TABLE payroll_periods FORCE ROW LEVEL SECURITY`;
  await sql`DROP POLICY IF EXISTS tenant_isolation ON payroll_periods`;
  await sql`
    CREATE POLICY tenant_isolation ON payroll_periods
      USING (tenant_id = current_setting('app.tenant_id', true))
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true))
  `;
  await sql`GRANT SELECT, INSERT, UPDATE, DELETE ON payroll_periods TO app_user`;
  await sql`GRANT USAGE, SELECT ON SEQUENCE payroll_periods_id_seq TO app_user`;

  // ---- payroll_period_lines: per-employee row inside a closed period ----
  await sql`
    CREATE TABLE IF NOT EXISTS payroll_period_lines (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
      period_id INTEGER NOT NULL REFERENCES payroll_periods(id) ON DELETE CASCADE,
      employee_id INTEGER NOT NULL REFERENCES employees(id),
      employee_name TEXT NOT NULL,
      employee_role TEXT,
      pay_type TEXT NOT NULL,
      hourly_rate_cents INTEGER NOT NULL DEFAULT 0,
      weekly_salary_cents INTEGER NOT NULL DEFAULT 0,
      hours_worked NUMERIC(8,2) NOT NULL DEFAULT 0,
      hours_overtime NUMERIC(8,2) NOT NULL DEFAULT 0,
      base_pay_cents BIGINT NOT NULL DEFAULT 0,
      tip_share_cents BIGINT NOT NULL DEFAULT 0,
      total_cents BIGINT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (period_id, employee_id)
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_payroll_period_lines_period
      ON payroll_period_lines(tenant_id, period_id)
  `;
  await sql`ALTER TABLE payroll_period_lines ENABLE ROW LEVEL SECURITY`;
  await sql`ALTER TABLE payroll_period_lines FORCE ROW LEVEL SECURITY`;
  await sql`DROP POLICY IF EXISTS tenant_isolation ON payroll_period_lines`;
  await sql`
    CREATE POLICY tenant_isolation ON payroll_period_lines
      USING (tenant_id = current_setting('app.tenant_id', true))
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true))
  `;
  await sql`GRANT SELECT, INSERT, UPDATE, DELETE ON payroll_period_lines TO app_user`;
  await sql`GRANT USAGE, SELECT ON SEQUENCE payroll_period_lines_id_seq TO app_user`;

  // ---- Seed payroll_settings for every existing tenant ----
  await sql`
    INSERT INTO payroll_settings (tenant_id)
    SELECT id FROM tenants
    ON CONFLICT (tenant_id) DO NOTHING
  `;

  // ---- Seed manage_payroll permission for admin + manager on every tenant ----
  // Cashier/kitchen/bar deliberately excluded — payroll exposes wages.
  await sql`
    INSERT INTO role_permissions (tenant_id, role, permission, granted)
    SELECT t.id, r.role, 'manage_payroll', true
    FROM tenants t
    CROSS JOIN (VALUES ('admin'), ('manager')) AS r(role)
    ON CONFLICT (tenant_id, role, permission) DO NOTHING
  `;
  // Also insert a not-granted row for other roles so the permissions UI shows them.
  await sql`
    INSERT INTO role_permissions (tenant_id, role, permission, granted)
    SELECT t.id, r.role, 'manage_payroll', false
    FROM tenants t
    CROSS JOIN (VALUES ('cashier'), ('kitchen'), ('bar')) AS r(role)
    ON CONFLICT (tenant_id, role, permission) DO NOTHING
  `;
}
