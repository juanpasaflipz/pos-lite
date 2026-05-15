export const version = 41;
export const name = 'tenant_timezone';

export async function up(sql) {
  await sql`
    ALTER TABLE tenants
      ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'UTC'
  `;
}
