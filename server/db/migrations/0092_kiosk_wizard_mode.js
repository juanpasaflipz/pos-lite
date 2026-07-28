export const version = 92;
export const name = 'kiosk_wizard_mode';

// Phase 2 — kiosk burrito-builder wizard.
//
// Adds three things:
// 1. tenants.kiosk_mode — per-tenant default. 'grid' (today) | 'wizard'.
//    Every tenant's default is 'grid' → zero visible change on deploy.
// 2. kiosk_devices — first-class device row created at bind time. Carries a
//    nullable per-device kiosk_mode_override so we can flip ONE device to
//    wizard (Samsung pilot) while the same tenant's iPad stays on grid.
//    Prior to this table the "device" was just a JWT — /bind now creates a
//    row when the caller sends device_name, and includes deviceId in the
//    token. Tokens without deviceId (existing iPad) still work; they simply
//    have no per-device override and fall through to tenant.kiosk_mode.
// 3. kiosk_builder_map — small config table mapping wizard slugs
//    ('asada', 'pollo', ..., 'rollbertos') to menu_item_id for a tenant.
//    Decouples the wizard's protein knobs from menu-item names, so a rename
//    in Menu Management doesn't break the wizard.
//
// Default kiosk_mode is 'grid' everywhere — deploy is a no-op for every
// tenant + device on the platform. Flip is per-tenant (super-admin) or
// per-device (super-admin device list).
export async function up(sql) {
  // 1. tenant column
  await sql`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS kiosk_mode TEXT DEFAULT 'grid'`;

  // 2. kiosk_devices table
  await sql`
    CREATE TABLE IF NOT EXISTS kiosk_devices (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
      name TEXT NOT NULL,
      bound_employee_id INTEGER,
      kiosk_mode_override TEXT,
      bound_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ,
      CONSTRAINT kiosk_devices_mode_override_valid
        CHECK (kiosk_mode_override IS NULL OR kiosk_mode_override IN ('grid', 'wizard'))
    )
  `;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_kiosk_devices_tenant_name_active
    ON kiosk_devices (tenant_id, name) WHERE revoked_at IS NULL
  `;

  await sql.unsafe(`
    DO $$
    BEGIN
      EXECUTE 'ALTER TABLE kiosk_devices ENABLE ROW LEVEL SECURITY';
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE tablename = 'kiosk_devices' AND policyname = 'tenant_isolation'
      ) THEN
        EXECUTE
          'CREATE POLICY tenant_isolation ON kiosk_devices '
          || 'USING (tenant_id = current_setting(''app.tenant_id'', true)) '
          || 'WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true))';
      END IF;
    END $$;
  `);
  await sql.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON kiosk_devices TO app_user`);

  // 3. kiosk_builder_map table
  await sql`
    CREATE TABLE IF NOT EXISTS kiosk_builder_map (
      tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
      slug TEXT NOT NULL,
      menu_item_id INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
      PRIMARY KEY (tenant_id, slug)
    )
  `;

  await sql.unsafe(`
    DO $$
    BEGIN
      EXECUTE 'ALTER TABLE kiosk_builder_map ENABLE ROW LEVEL SECURITY';
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE tablename = 'kiosk_builder_map' AND policyname = 'tenant_isolation'
      ) THEN
        EXECUTE
          'CREATE POLICY tenant_isolation ON kiosk_builder_map '
          || 'USING (tenant_id = current_setting(''app.tenant_id'', true)) '
          || 'WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true))';
      END IF;
    END $$;
  `);
  await sql.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON kiosk_builder_map TO app_user`);
}
