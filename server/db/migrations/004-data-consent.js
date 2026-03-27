export const version = 4;
export const name = 'data-consent';

export async function up(sql) {
  // Add financing consent columns to tenants table
  await sql`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS financing_consent_at TIMESTAMPTZ`;
  await sql`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS financing_consent_ip TEXT`;
  await sql`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS financing_consent_version TEXT`;

  // Create data_processing_consent table (platform-level, no RLS — like tenants, leads)
  await sql`
    CREATE TABLE IF NOT EXISTS data_processing_consent (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      consent_type TEXT NOT NULL,
      accepted BOOLEAN NOT NULL DEFAULT false,
      accepted_at TIMESTAMPTZ DEFAULT NOW(),
      ip_address TEXT,
      user_agent TEXT,
      consent_version TEXT DEFAULT '1.0',
      UNIQUE(tenant_id, consent_type)
    )
  `;

  // Index for quick lookups by tenant
  await sql`CREATE INDEX IF NOT EXISTS idx_data_processing_consent_tenant ON data_processing_consent(tenant_id)`;
}
