import { adminSql } from './db/index.js';
import { tenantCache } from './lib/tenantCache.js';

// ==================== Tenant CRUD ====================
// All operations use adminSql (neondb_owner, bypasses RLS).
// No more file management — everything is in Postgres.

/** Look up a tenant by ID (cached, 60s TTL) */
export async function getTenant(tenantId) {
  const cached = tenantCache.getById(tenantId);
  if (cached) return cached;

  const rows = await adminSql`SELECT * FROM tenants WHERE id = ${tenantId}`;
  const tenant = rows[0] || undefined;
  if (tenant) tenantCache.set(tenant);
  return tenant;
}

/** Look up a tenant by subdomain (cached, 60s TTL) */
export async function getTenantBySubdomain(subdomain) {
  const cached = tenantCache.getBySubdomain(subdomain);
  if (cached) return cached;

  const rows = await adminSql`SELECT * FROM tenants WHERE subdomain = ${subdomain} AND active = true`;
  const tenant = rows[0] || undefined;
  if (tenant) tenantCache.set(tenant);
  return tenant;
}

/** Look up a tenant by email */
export async function getTenantByEmail(email) {
  const rows = await adminSql`SELECT * FROM tenants WHERE owner_email = ${email}`;
  return rows[0] || undefined;
}

/** Create a new tenant in the registry */
export async function createTenant({ id, name, subdomain, owner_email, owner_password_hash, plan, branding_json }) {
  const effectivePlan = plan || 'free';
  await adminSql`
    INSERT INTO tenants (id, name, subdomain, owner_email, owner_password_hash, plan, branding_json)
    VALUES (${id}, ${name}, ${subdomain || id}, ${owner_email}, ${owner_password_hash}, ${effectivePlan}, ${branding_json || null})
  `;

  // Seed default role permissions for the new tenant
  await seedTenantDefaults(id);

  return getTenant(id);
}

/** Update tenant fields */
export async function updateTenant(tenantId, updates) {
  const fields = Object.entries(updates);
  if (fields.length === 0) return;

  // Build SET clause dynamically
  const setClauses = fields.map(([key], i) => `${key} = $${i + 1}`).join(', ');
  const values = [...fields.map(([, val]) => val), tenantId];
  await adminSql.unsafe(
    `UPDATE tenants SET ${setClauses} WHERE id = $${values.length}`,
    values
  );
  tenantCache.invalidate(tenantId);
}

/** List all tenants with stats (uses admin pool, cross-tenant subqueries) */
export async function listTenants() {
  const tenants = await adminSql`
    SELECT t.*,
      (SELECT COUNT(*) FROM orders WHERE tenant_id = t.id) AS order_count,
      (SELECT COUNT(*) FROM employees WHERE tenant_id = t.id) AS employee_count
    FROM tenants t
    ORDER BY created_at DESC
  `;
  return Array.from(tenants);
}

/** Seed default role permissions and loyalty config for a new tenant */
async function seedTenantDefaults(tenantId) {
  const allPermissions = [
    'pos_access', 'kitchen_access', 'bar_access', 'view_reports', 'manage_menu',
    'manage_inventory', 'manage_employees', 'manage_printers', 'manage_delivery',
    'manage_modifiers', 'manage_ai', 'process_refunds', 'void_orders',
    'apply_discounts', 'view_dashboard', 'manage_permissions', 'manage_purchase_orders',
    'manage_loyalty', 'manage_branding', 'manage_invoicing',
  ];

  const roleDefaults = {
    admin: allPermissions,
    manager: allPermissions.filter(p => p !== 'manage_permissions'),
    cashier: ['pos_access', 'view_dashboard'],
    kitchen: ['kitchen_access'],
    bar: ['bar_access'],
  };

  const permRows = [];
  for (const [role, perms] of Object.entries(roleDefaults)) {
    for (const perm of allPermissions) {
      const granted = perms.includes(perm);
      permRows.push({ tenant_id: tenantId, role, permission: perm, granted });
    }
  }

  // Batch insert role_permissions
  if (permRows.length > 0) {
    await adminSql`
      INSERT INTO role_permissions ${adminSql(permRows, 'tenant_id', 'role', 'permission', 'granted')}
      ON CONFLICT (tenant_id, role, permission) DO NOTHING
    `;
  }

  // Seed loyalty config
  const loyaltyDefaults = [
    { key: 'stamps_required', value: '10', description: 'Number of stamps needed for a free reward' },
    { key: 'reward_description', value: 'Free item of your choice', description: 'Default reward description' },
    { key: 'referral_bonus_stamps', value: '2', description: 'Bonus stamps for referrer and referee' },
    { key: 'sms_enabled', value: 'true', description: 'Enable SMS notifications for loyalty events' },
  ];

  for (const { key, value, description } of loyaltyDefaults) {
    await adminSql`
      INSERT INTO loyalty_config (tenant_id, key, value, description)
      VALUES (${tenantId}, ${key}, ${value}, ${description})
      ON CONFLICT (tenant_id, key) DO NOTHING
    `;
  }

  // Seed financial targets
  const financialDefaults = [
    ['food_cost', 30], ['labor', 25], ['rent', 8], ['utilities', 4],
    ['stripe_fees', 3], ['delivery_commissions', 5], ['marketing', 2],
    ['insurance', 2], ['supplies', 3],
  ];

  for (const [category, target_percent] of financialDefaults) {
    await adminSql`
      INSERT INTO financial_targets (tenant_id, category, target_percent, updated_at)
      VALUES (${tenantId}, ${category}, ${target_percent}, NOW())
      ON CONFLICT (tenant_id, category) DO NOTHING
    `;
  }

  // Seed default virtual brands for menu board
  try {
    await adminSql`
      INSERT INTO virtual_brands (tenant_id, name, slug, description, primary_color, show_in_pos, display_type, active)
      VALUES (${tenantId}, 'Brand 1', 'brand-1', 'Your first brand', '#0d9488', true, 'menu_board', true)
      ON CONFLICT DO NOTHING
    `;
    await adminSql`
      INSERT INTO virtual_brands (tenant_id, name, slug, description, primary_color, show_in_pos, display_type, active)
      VALUES (${tenantId}, 'Brand 2', 'brand-2', 'Your second brand', '#3b82f6', true, 'menu_board', true)
      ON CONFLICT DO NOTHING
    `;
  } catch (err) {
    console.log(`[Tenants] Could not seed virtual brands for ${tenantId}:`, err.message);
  }
}

// No-ops replacing SQLite file management
export function initMasterDb() {}
export function getMasterDb() { return null; }
export function openTenantDb() { return null; }
export function closeAllTenantDbs() {}
