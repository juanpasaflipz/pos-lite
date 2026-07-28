// Inventory reset — wipes the inventory slate for one tenant.
//
// Two modes, both irreversible:
//   'zero' — keep the catalog (items, recipes, aliases, vendors, POs) but set
//            every quantity to 0 and drop movement history. Undoes the stock
//            movements left behind by testing without losing the catalog.
//   'wipe' — delete every inventory item plus every row that references one,
//            including recipe links (menu_item_ingredients). Blank slate.
//
// Callers must run this inside a tenant-scoped transaction (the /api/*
// middleware already owns one) so a half-finished reset can never commit.

import { all, get, run } from '../db/index.js';

// Movement history — cleared in BOTH modes.
export const RESET_HISTORY_TABLES = [
  'inventory_counts',
  'shrinkage_alerts',
  'waste_log',
  'inventory_cost_history',
  'ai_inventory_velocity',
  'ai_restock_log',
];

// Everything that must be cleared before inventory_items can be deleted, in FK
// order. If you add a table with an FK to inventory_items, add it here — the
// final DELETE fails loudly with 23503 if you forget, it does not silently skip.
export const RESET_WIPE_TABLES = [
  ...RESET_HISTORY_TABLES,
  'inventory_aliases',
  'expense_items',         // itemization of expenses; the expense rows survive
  'purchase_order_items',
  'purchase_orders',       // headers left without lines are garbage
  'vendor_items',
  'menu_item_ingredients', // recipes — this is what makes 'wipe' admin-only
];

// Physical-stock fields cleared alongside quantity in 'zero' mode. Catalog
// fields (cost_price, low_stock_threshold, sku, pack_size, shelf_life_days)
// describe the item, not the stock on hand, so they survive.
const ZEROED_OPTIONAL_COLUMNS = ['last_restocked_at', 'expiry_date', 'lot_number'];

let resetTablesPromise = null;

// Some of the tables above arrived via migrations (0042, 0068, 0088). Filter to
// what actually exists so a reset can't 42P01 on an older database.
export async function getExistingResetTables() {
  if (!resetTablesPromise) {
    // Names come from the hardcoded constant above, never from a request.
    const names = RESET_WIPE_TABLES.map(t => `'${t}'`).join(', ');
    resetTablesPromise = all(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN (${names})
    `).then(rows => new Set(rows.map(r => r.table_name)));
  }
  return resetTablesPromise;
}

async function inventoryColumns() {
  const rows = await all(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'inventory_items'
  `);
  return new Set(rows.map(r => r.column_name));
}

/** Row counts a reset would touch, so the confirm dialog shows real numbers. */
export async function buildResetPreview(tenantId) {
  const existing = await getExistingResetTables();
  const counts = {};

  for (const table of RESET_WIPE_TABLES) {
    if (!existing.has(table)) continue;
    const row = await get(`SELECT COUNT(*)::int AS c FROM ${table} WHERE tenant_id = $1`, [tenantId]);
    counts[table] = row?.c ?? 0;
  }

  const items = await get(`
    SELECT COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE quantity <> 0)::int AS with_stock
    FROM inventory_items WHERE tenant_id = $1
  `, [tenantId]);

  return {
    inventory_items: items?.total ?? 0,
    items_with_stock: items?.with_stock ?? 0,
    history_rows: RESET_HISTORY_TABLES.reduce((sum, t) => sum + (counts[t] ?? 0), 0),
    recipe_links: counts.menu_item_ingredients ?? 0,
    counts,
  };
}

export class InventoryStillReferencedError extends Error {
  constructor(table) {
    super(`Inventory is still referenced by ${table || 'another table'}`);
    this.name = 'InventoryStillReferencedError';
    this.table = table;
  }
}

/**
 * Run the reset. Returns `{ items_affected, deleted }` where `deleted` maps
 * table name → rows removed. Throws InventoryStillReferencedError if a table
 * with an FK to inventory_items is missing from RESET_WIPE_TABLES — the caller
 * is inside a transaction, so nothing is left half-deleted.
 */
export async function resetInventoryData({ mode, tenantId }) {
  if (mode !== 'zero' && mode !== 'wipe') {
    throw new Error(`Unknown inventory reset mode: ${mode}`);
  }

  const existing = await getExistingResetTables();
  const tables = mode === 'wipe' ? RESET_WIPE_TABLES : RESET_HISTORY_TABLES;
  const deleted = {};

  for (const table of tables) {
    if (!existing.has(table)) continue;
    const result = await run(`DELETE FROM ${table} WHERE tenant_id = $1`, [tenantId]);
    deleted[table] = result.changes;
  }

  let itemsAffected = 0;

  if (mode === 'wipe') {
    try {
      const result = await run('DELETE FROM inventory_items WHERE tenant_id = $1', [tenantId]);
      itemsAffected = result.changes;
    } catch (error) {
      if (error?.code === '23503') {
        throw new InventoryStillReferencedError(error.table);
      }
      throw error;
    }
  } else {
    const columns = await inventoryColumns();
    const sets = ['quantity = 0', 'last_counted_at = NULL'];
    for (const col of ZEROED_OPTIONAL_COLUMNS) {
      if (columns.has(col)) sets.push(`${col} = NULL`);
    }
    const result = await run(
      `UPDATE inventory_items SET ${sets.join(', ')} WHERE tenant_id = $1`,
      [tenantId]
    );
    itemsAffected = result.changes;
  }

  return { items_affected: itemsAffected, deleted };
}
