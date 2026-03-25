/**
 * Migration: Add payroll tracking
 * - Extends employees with wage config columns
 * - Creates payroll_payments table with RLS
 * - Seeds manage_payroll permission for existing tenants
 */

export const version = 1;
export const name = 'add-payroll';

export async function up(sql) {
  // 1. Extend employees table with wage config
  await sql`
    ALTER TABLE employees
      ADD COLUMN IF NOT EXISTS wage_type TEXT NOT NULL DEFAULT 'hourly' CHECK (wage_type IN ('hourly', 'salary')),
      ADD COLUMN IF NOT EXISTS wage_rate NUMERIC(10,2) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS pay_frequency TEXT NOT NULL DEFAULT 'biweekly' CHECK (pay_frequency IN ('weekly', 'biweekly', 'monthly')),
      ADD COLUMN IF NOT EXISTS hire_date DATE
  `;

  // 2. Create payroll_payments table
  await sql`
    CREATE TABLE IF NOT EXISTS payroll_payments (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      pay_period_start DATE NOT NULL,
      pay_period_end DATE NOT NULL,
      hours_worked NUMERIC(8,2),
      gross_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
      deductions NUMERIC(10,2) NOT NULL DEFAULT 0,
      bonuses NUMERIC(10,2) NOT NULL DEFAULT 0,
      net_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
      payment_method TEXT NOT NULL DEFAULT 'cash' CHECK (payment_method IN ('cash', 'transfer', 'check')),
      payment_date DATE NOT NULL,
      notes TEXT,
      created_by INTEGER REFERENCES employees(id),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  // 3. Enable RLS
  await sql`ALTER TABLE payroll_payments ENABLE ROW LEVEL SECURITY`;
  await sql`ALTER TABLE payroll_payments FORCE ROW LEVEL SECURITY`;

  // 4. Tenant isolation policy
  await sql`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE tablename = 'payroll_payments' AND policyname = 'tenant_isolation'
      ) THEN
        EXECUTE 'CREATE POLICY tenant_isolation ON payroll_payments
          USING (tenant_id = current_setting(''app.tenant_id'', true))
          WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true))';
      END IF;
    END $$
  `;

  // 5. Grants for app_user
  await sql`GRANT SELECT, INSERT, UPDATE, DELETE ON payroll_payments TO app_user`;
  await sql`GRANT USAGE, SELECT ON SEQUENCE payroll_payments_id_seq TO app_user`;

  // 6. Indexes
  await sql`CREATE INDEX IF NOT EXISTS idx_payroll_payments_tenant ON payroll_payments(tenant_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_payroll_payments_tenant_employee ON payroll_payments(tenant_id, employee_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_payroll_payments_tenant_date ON payroll_payments(tenant_id, payment_date)`;

  // 7. Seed manage_payroll permission for all existing tenant/role combos
  const roles = ['admin', 'manager', 'cashier', 'kitchen', 'bar'];
  const grantedRoles = ['admin', 'manager'];

  const tenants = await sql`SELECT id FROM tenants`;
  for (const tenant of tenants) {
    for (const role of roles) {
      await sql`
        INSERT INTO role_permissions (tenant_id, role, permission, granted)
        VALUES (${tenant.id}, ${role}, 'manage_payroll', ${grantedRoles.includes(role)})
        ON CONFLICT (tenant_id, role, permission) DO NOTHING
      `;
    }
  }
}
