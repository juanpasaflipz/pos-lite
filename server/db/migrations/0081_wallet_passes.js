export const version = 81;
export const name = 'wallet_passes';

export async function up(sql) {
  // One row per issued pass. A customer can hold an apple and a google pass simultaneously.
  await sql`
    CREATE TABLE IF NOT EXISTS wallet_passes (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
      customer_id INTEGER NOT NULL REFERENCES loyalty_customers(id),
      platform TEXT NOT NULL CHECK (platform IN ('apple', 'google')),
      serial_number TEXT NOT NULL UNIQUE,
      auth_token TEXT NOT NULL,
      enroll_token TEXT UNIQUE,
      revoked BOOLEAN DEFAULT false,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(tenant_id, customer_id, platform)
    )
  `;

  // Apple Wallet device registrations (PassKit Web Service spec).
  await sql`
    CREATE TABLE IF NOT EXISTS wallet_registrations (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
      pass_id INTEGER NOT NULL REFERENCES wallet_passes(id) ON DELETE CASCADE,
      device_library_id TEXT NOT NULL,
      push_token TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(pass_id, device_library_id)
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS idx_wallet_passes_tenant ON wallet_passes(tenant_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_wallet_passes_customer ON wallet_passes(tenant_id, customer_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_wallet_passes_enroll_token ON wallet_passes(enroll_token) WHERE enroll_token IS NOT NULL`;
  await sql`CREATE INDEX IF NOT EXISTS idx_wallet_registrations_tenant ON wallet_registrations(tenant_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_wallet_registrations_device ON wallet_registrations(device_library_id)`;

  // RLS (same pattern as 0037)
  for (const tbl of ['wallet_passes', 'wallet_registrations']) {
    await sql.unsafe(`ALTER TABLE ${tbl} ENABLE ROW LEVEL SECURITY`);
    await sql.unsafe(`ALTER TABLE ${tbl} FORCE ROW LEVEL SECURITY`);
    await sql.unsafe(`DROP POLICY IF EXISTS tenant_isolation ON ${tbl}`);
    await sql.unsafe(
      `CREATE POLICY tenant_isolation ON ${tbl}
         USING (tenant_id = current_setting('app.tenant_id', true))
         WITH CHECK (tenant_id = current_setting('app.tenant_id', true))`
    );
  }

  // The blanket GRANT in pg-schema.sql ran before these tables existed —
  // grant explicitly so app_user (tenant pool) can touch them.
  await sql`GRANT SELECT, INSERT, UPDATE, DELETE ON wallet_passes, wallet_registrations TO app_user`;
  await sql`GRANT USAGE, SELECT ON SEQUENCE wallet_passes_id_seq, wallet_registrations_id_seq TO app_user`;

  // Seed wallet-related loyalty_config keys for existing tenants
  // (migration runs as admin — no app.tenant_id — so insert explicit tenant_ids).
  await sql`
    INSERT INTO loyalty_config (tenant_id, key, value, description)
    SELECT t.id, k.key, k.value, k.description
    FROM tenants t
    CROSS JOIN (VALUES
      ('store_latitude',  '', 'Store latitude for wallet pass geofence (e.g. 32.5149)'),
      ('store_longitude', '', 'Store longitude for wallet pass geofence (e.g. -117.0382)'),
      ('wallet_location_message', '', 'Lock-screen message shown when the customer is near the store')
    ) AS k(key, value, description)
    ON CONFLICT (tenant_id, key) DO NOTHING
  `;
}
