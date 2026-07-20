import { adminSql } from '../db/index.js';

/**
 * Seed a newly created tenant with 1 example category and 2 example menu items
 * so the POS isn't completely empty on first login.
 *
 * Shared by /api/auth/register (free signup) and provisionPaidTenant
 * (pay-first checkout flow). Idempotent enough for retry paths: the category
 * insert is not deduped, but both callers only run it once per fresh tenant.
 */
export async function seedNewTenant(tenantId) {
  const catRows = await adminSql`
    INSERT INTO menu_categories (name, sort_order, active, tenant_id)
    VALUES ('Platillos', 1, true, ${tenantId})
    RETURNING id
  `;
  const categoryId = catRows[0].id;

  await adminSql`
    INSERT INTO menu_items (category_id, name, price, description, active, is_example, tenant_id)
    VALUES
      (${categoryId}, 'Ejemplo: Taco de Res', 45, 'Platillo de ejemplo — edita o elimina desde el menú', true, true, ${tenantId}),
      (${categoryId}, 'Ejemplo: Agua de Jamaica', 25, 'Bebida de ejemplo — edita o elimina desde el menú', true, true, ${tenantId})
  `;
}
