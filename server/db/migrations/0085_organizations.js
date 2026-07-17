export const version = 85;
export const name = 'organizations';

// Corporate layer: an organization groups many tenants (stores) under one
// corporate login for cross-store, READ-ONLY reporting (see routes/org.js).
//
// Isolation notes (deliberate, do not "fix"):
// - organizations must NOT be readable by app_user: the RLS-scoped tenant
//   pool can never read or join it. Only adminSql (org routes, migrations,
//   seeds) touches this table.
// - Neon's neondb_owner has `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON
//   TABLES TO app_user, authenticated` — every new table auto-inherits the
//   grant. We REVOKE explicitly below; tests/org-dashboard.test.ts asserts
//   the SELECT is denied.
// - tenants.org_id is a nullable FK; tenants without an org are unaffected.
// - Per-tenant RLS policies are untouched. Org endpoints do their own
//   scoping (WHERE t.org_id = $1) on the admin pool and are read-only.

export async function up(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS organizations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      admin_email TEXT NOT NULL UNIQUE,
      admin_password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  await sql`
    ALTER TABLE tenants
      ADD COLUMN IF NOT EXISTS org_id TEXT REFERENCES organizations(id)
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_tenants_org
      ON tenants(org_id) WHERE org_id IS NOT NULL
  `;

  // Strip the auto-inherited GRANT ALL (see isolation notes above).
  await sql`REVOKE ALL ON organizations FROM app_user`;
  await sql`REVOKE ALL ON organizations FROM authenticated`;
}
