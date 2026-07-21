// Bulk menu insert shared by template-apply and AI-import (onboarding wizard).
//
// Runs inside the tenant middleware's request transaction — uses the
// tenant-scoped db helpers so RLS applies. Payload shape (same as
// AIMenuParseResult.data / getTemplate()):
//   { categories: [{name, sort_order}], items: [{name, category, price, description?, prep_time_minutes?}] }
//
// mode 'replace': deactivates the existing menu first (soft — order history
// keeps its FK rows). mode 'append': adds alongside what exists.
// Returns MenuImportStats.

import { all, get, run, getTenantId } from '../db/index.js';
import { getPlanLimits } from '../planLimits.js';

export async function bulkInsertMenu(payload, { plan = 'free', mode = 'replace' } = {}) {
  const tid = getTenantId();
  const stats = {
    categoriesCreated: 0,
    itemsCreated: 0,
    inventoryCreated: 0,
    recipesCreated: 0,
    modifierGroupsCreated: 0,
    combosCreated: 0,
    skipped: [],
    warnings: [],
  };

  const categories = Array.isArray(payload?.categories) ? payload.categories : [];
  const items = Array.isArray(payload?.items) ? payload.items : [];
  if (items.length === 0) return stats;

  if (mode === 'replace') {
    // Soft-replace: never DELETE (order_items FK menu history) — deactivate.
    await run('UPDATE menu_items SET active = false WHERE active = true');
    await run('UPDATE menu_categories SET active = false WHERE active = true');
  }

  // Plan ceiling on menu items
  const limits = getPlanLimits(plan);
  const maxItems = typeof limits.menuItems === 'number' ? limits.menuItems : Infinity;
  const existing = await get('SELECT COUNT(*) AS n FROM menu_items WHERE active = true');
  let remaining = maxItems - Number(existing?.n || 0);

  // Categories: reuse an active category with the same name, else create.
  const catIdByName = new Map();
  const sortBase = Number((await get('SELECT COALESCE(MAX(sort_order), 0) AS m FROM menu_categories'))?.m || 0);
  let catIdx = 0;
  for (const c of categories) {
    const name = String(c?.name || '').trim();
    if (!name) continue;
    const found = await get('SELECT id FROM menu_categories WHERE LOWER(name) = LOWER($1) AND active = true', [name]);
    if (found) {
      catIdByName.set(name.toLowerCase(), found.id);
      continue;
    }
    catIdx += 1;
    const row = await get(
      'INSERT INTO menu_categories (tenant_id, name, sort_order, active) VALUES ($1, $2, $3, true) RETURNING id',
      [tid, name, Number(c.sort_order) || sortBase + catIdx],
    );
    catIdByName.set(name.toLowerCase(), row.id);
    stats.categoriesCreated += 1;
  }

  // Fallback category if an item references a name we don't have.
  async function fallbackCategoryId() {
    const key = 'menú';
    if (catIdByName.has(key)) return catIdByName.get(key);
    const row = await get(
      'INSERT INTO menu_categories (tenant_id, name, sort_order, active) VALUES ($1, $2, $3, true) RETURNING id',
      [tid, 'Menú', sortBase + 99],
    );
    catIdByName.set(key, row.id);
    stats.categoriesCreated += 1;
    return row.id;
  }

  let itemSort = 0;
  for (const it of items) {
    const name = String(it?.name || '').trim();
    const price = Number(it?.price);
    if (!name || !Number.isFinite(price) || price < 0) {
      stats.skipped.push(name || '(sin nombre)');
      continue;
    }
    if (remaining <= 0) {
      stats.warnings.push(`Límite de platillos del plan alcanzado (${maxItems}) — se omitieron los restantes`);
      break;
    }
    const catKey = String(it.category || '').trim().toLowerCase();
    const categoryId = catIdByName.get(catKey) || await fallbackCategoryId();
    itemSort += 1;
    await run(
      `INSERT INTO menu_items (tenant_id, category_id, name, price, description, sort_order, active, prep_time_minutes)
       VALUES ($1, $2, $3, $4, $5, $6, true, $7)`,
      [
        tid,
        categoryId,
        name.slice(0, 100),
        price,
        String(it.description || '').trim().slice(0, 300) || null,
        itemSort,
        Math.min(60, Math.max(1, Number(it.prep_time_minutes) || 8)),
      ],
    );
    stats.itemsCreated += 1;
    remaining -= 1;
  }

  // Advanced payload sections (inventory/recipes/modifier groups) are not
  // part of the onboarding wizard scope — surface as a warning, not silence.
  for (const key of ['inventory', 'recipes', 'modifier_groups']) {
    if (Array.isArray(payload?.[key]) && payload[key].length > 0) {
      stats.warnings.push(`Sección "${key}" no importada — configúrala desde el POS`);
    }
  }

  return stats;
}
