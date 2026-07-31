// `scan_inventory` — permission to photograph a shelf or a supplier nota and
// commit the resulting count (server/routes/inventory-scan.js).
//
// Why a new permission rather than reusing one: the photo flow was shipped in
// 1.6.0 gated on `pos_access`, on the assumption that it meant "any employee".
// It does not — `pos_access` is the POS register permission, and the default
// matrix in server/tenants.js grants `kitchen` exactly `kitchen_access` and
// `bar` exactly `bar_access`. So the people the feature was built for could not
// use it at all, and granting them `pos_access` to fix that would have handed
// them the register as a side effect.
//
// Seeded true for the roles that stand near stock (kitchen, bar, cashier) plus
// manager/admin. Booking a PURCHASE still requires `manage_inventory` — that
// writes an expense — so this only opens the count path.
//
// Idempotent per tenant: role_permissions has a UNIQUE (tenant_id, role,
// permission), and existing rows are left alone so a tenant that has already
// revoked this keeps their choice on re-run.

export const version = 101;
export const name = 'scan_inventory_permission';

const GRANTED_ROLES = ['admin', 'manager', 'cashier', 'kitchen', 'bar'];

export async function up(sql) {
  // Insert one row per (tenant, role). Tenants are enumerated from
  // role_permissions rather than the tenants table so we only touch tenants
  // that actually have a seeded permission matrix — a half-provisioned tenant
  // gets its full matrix from seedTenantDefaults() instead.
  await sql`
    INSERT INTO role_permissions (tenant_id, role, permission, granted)
    SELECT DISTINCT rp.tenant_id, r.role, 'scan_inventory', true
    FROM role_permissions rp
    CROSS JOIN (SELECT unnest(${GRANTED_ROLES}::text[]) AS role) r
    ON CONFLICT (tenant_id, role, permission) DO NOTHING
  `;
}
