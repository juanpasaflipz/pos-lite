export const version = 49;
export const name = 'tenant_timezone_mexico_default';

export async function up(sql) {
  await sql`
    ALTER TABLE tenants
      ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'America/Mexico_City'
  `;

  await sql`
    ALTER TABLE tenants
      ALTER COLUMN timezone SET DEFAULT 'America/Mexico_City'
  `;

  await sql`
    UPDATE tenants
    SET timezone = 'America/Mexico_City'
    WHERE timezone IS NULL OR timezone = 'UTC'
  `;
}
