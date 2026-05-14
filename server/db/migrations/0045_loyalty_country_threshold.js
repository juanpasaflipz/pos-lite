export const version = 45;
export const name = 'loyalty_country_threshold';

// Adds per-customer country_code so the loyalty program supports US (+1) and
// other countries alongside MX (+52). Also seeds stamp_bonus_threshold config —
// every $threshold spent on a single ticket earns an extra stamp on top of the
// base one. The same 10-digit local number can exist in two countries, so the
// unique constraint widens from (tenant, phone) to (tenant, country_code, phone).
export async function up(sql) {
  await sql`
    ALTER TABLE loyalty_customers
      ADD COLUMN IF NOT EXISTS country_code TEXT NOT NULL DEFAULT 'MX'
  `;

  // Drop the legacy (tenant_id, phone) unique if present (auto-named by CREATE
  // TABLE in pg-schema.sql) and replace with the wider 3-column unique.
  await sql`
    DO $$
    DECLARE c_name TEXT;
    BEGIN
      SELECT con.conname INTO c_name
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      WHERE rel.relname = 'loyalty_customers'
        AND con.contype = 'u'
        AND pg_get_constraintdef(con.oid) = 'UNIQUE (tenant_id, phone)';
      IF c_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE loyalty_customers DROP CONSTRAINT %I', c_name);
      END IF;
    END $$;
  `;

  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'loyalty_customers_tenant_country_phone_key'
      ) THEN
        ALTER TABLE loyalty_customers
          ADD CONSTRAINT loyalty_customers_tenant_country_phone_key
          UNIQUE (tenant_id, country_code, phone);
      END IF;
    END $$;
  `;

  // Seed stamp_bonus_threshold for every tenant that already has any loyalty
  // config rows. New tenants get this via tenants.js seed.
  await sql`
    INSERT INTO loyalty_config (tenant_id, key, value, description)
    SELECT DISTINCT tenant_id, 'stamp_bonus_threshold', '400',
           'Spend amount (per ticket) that earns one extra stamp on top of the base stamp'
    FROM loyalty_config
    ON CONFLICT (tenant_id, key) DO NOTHING
  `;
}
