export const version = 61;
export const name = 'kds_devices';

// Paired KDS devices (wall-mounted TVs, kitchen tablets) get their own
// long-lived identity instead of borrowing an employee's JWT. The pairing
// flow is: TV shows a 6-char code; a logged-in manager enters that code
// from /admin/devices; server issues a device JWT carrying { deviceId,
// tenantId, deviceType, jti }. Revocation = rotate token_jti.
export async function up(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS kds_devices (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
      device_label TEXT,
      device_type TEXT NOT NULL DEFAULT 'kds'
        CHECK (device_type IN ('kds','bar','expo')),
      pairing_code TEXT,
      pairing_code_expires_at TIMESTAMPTZ,
      claimed_at TIMESTAMPTZ,
      claimed_by_employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      token_jti UUID,
      last_seen_at TIMESTAMPTZ,
      last_seen_ip TEXT,
      user_agent TEXT,
      revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  // One unclaimed code per tenant at a time is fine; we never collide because
  // claim consumes the code (sets it to NULL).
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_kds_devices_pairing_code
      ON kds_devices(tenant_id, pairing_code)
      WHERE pairing_code IS NOT NULL
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_kds_devices_tenant_claimed
      ON kds_devices(tenant_id, claimed_at DESC NULLS LAST)
  `;

  await sql`ALTER TABLE kds_devices ENABLE ROW LEVEL SECURITY`;
  await sql`ALTER TABLE kds_devices FORCE ROW LEVEL SECURITY`;
  await sql`DROP POLICY IF EXISTS tenant_isolation ON kds_devices`;
  await sql`
    CREATE POLICY tenant_isolation ON kds_devices
      USING (tenant_id = current_setting('app.tenant_id', true))
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true))
  `;
  await sql`GRANT SELECT, INSERT, UPDATE, DELETE ON kds_devices TO app_user`;

  // Permission row so the existing role-permissions UI surfaces it.
  // Granted for admin + manager; denied for everyone else.
  await sql`
    INSERT INTO role_permissions (tenant_id, role, permission, granted)
    SELECT t.id, r.role, 'manage_devices', true
    FROM tenants t
    CROSS JOIN (VALUES ('admin'), ('manager')) AS r(role)
    ON CONFLICT (tenant_id, role, permission) DO NOTHING
  `;
  await sql`
    INSERT INTO role_permissions (tenant_id, role, permission, granted)
    SELECT t.id, r.role, 'manage_devices', false
    FROM tenants t
    CROSS JOIN (VALUES ('cashier'), ('kitchen'), ('bar')) AS r(role)
    ON CONFLICT (tenant_id, role, permission) DO NOTHING
  `;
}
