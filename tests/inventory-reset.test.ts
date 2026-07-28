// Inventory reset tests — the "clean slate" danger-zone action.
//
// Invariants guarded here:
//   1. RESET_WIPE_TABLES is COMPLETE: every table in the live schema with an FK
//      to inventory_items is listed. This is the one that actually protects us —
//      a future migration adding a child table makes 'wipe' fail with 23503,
//      and this test catches it before a tenant does.
//   2. 'zero' keeps the catalog (item rows, cost, threshold, recipes) and zeroes
//      quantity + physical-stock fields, while clearing movement history.
//   3. 'wipe' empties inventory_items and every dependent table.
//   4. Both modes are tenant-scoped — a second tenant's inventory is untouched.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestTenant,
  dropTestTenant,
  asTenant,
  closePools,
  type TestTenant,
} from './helpers/db.js';
// @ts-ignore — server files are plain JS
import { get, all, run } from '../server/db/index.js';
// @ts-ignore
import {
  resetInventoryData,
  buildResetPreview,
  RESET_WIPE_TABLES,
} from '../server/helpers/inventoryReset.js';

let tenant: TestTenant;
let other: TestTenant;

/**
 * Seed one inventory item plus a row in every dependent table we can reach,
 * so both modes have something to delete. Returns the item id.
 */
async function seedInventoryGraph(tenantId: string): Promise<number> {
  return asTenant(tenantId, async () => {
    const item = await get(
      `INSERT INTO inventory_items (name, quantity, unit, low_stock_threshold, category, cost_price, last_counted_at)
       VALUES ('Test Tortillas', 42, 'pza', 10, 'Test', 3.50, NOW())
       RETURNING id`,
    );
    const itemId = Number(item.id);

    // Movement history (cleared in both modes)
    await run(
      `INSERT INTO inventory_counts (inventory_item_id, counted_quantity, system_quantity, variance)
       VALUES ($1, 40, 42, -2)`,
      [itemId],
    );
    await run(
      `INSERT INTO shrinkage_alerts (inventory_item_id, alert_type, message)
       VALUES ($1, 'variance', 'test alert')`,
      [itemId],
    );
    await run(
      `INSERT INTO waste_log (inventory_item_id, quantity, reason) VALUES ($1, 2, 'spoilage')`,
      [itemId],
    );
    await run(
      `INSERT INTO inventory_cost_history (inventory_item_id, quantity_added, unit_cost, new_cost_price)
       VALUES ($1, 10, 3.50, 3.50)`,
      [itemId],
    );

    // Catalog-side references (only cleared by 'wipe')
    await run(`INSERT INTO inventory_aliases (inventory_item_id, alias) VALUES ($1, 'tortilla test')`, [itemId]);

    const category = await get(
      `INSERT INTO menu_categories (name, sort_order) VALUES ('Test Cat', 1) RETURNING id`,
    );
    const menuItem = await get(
      `INSERT INTO menu_items (category_id, name, price) VALUES ($1, 'Test Burrito', 100) RETURNING id`,
      [Number(category.id)],
    );
    await run(
      `INSERT INTO menu_item_ingredients (menu_item_id, inventory_item_id, quantity_used) VALUES ($1, $2, 2)`,
      [Number(menuItem.id), itemId],
    );

    const vendor = await get(`INSERT INTO vendors (name) VALUES ('Test Vendor') RETURNING id`);
    await run(
      `INSERT INTO vendor_items (vendor_id, inventory_item_id, unit_cost) VALUES ($1, $2, 3.50)`,
      [Number(vendor.id), itemId],
    );

    const po = await get(
      `INSERT INTO purchase_orders (po_number, vendor_id, status) VALUES ('PO-TEST-1', $1, 'draft') RETURNING id`,
      [Number(vendor.id)],
    );
    await run(
      `INSERT INTO purchase_order_items (po_id, inventory_item_id, quantity_ordered, unit_cost)
       VALUES ($1, $2, 10, 3.50)`,
      [Number(po.id), itemId],
    );

    const expense = await get(
      `INSERT INTO expenses (category, amount, description, expense_date)
       VALUES ('food_cost', 35, 'test expense', CURRENT_DATE) RETURNING id`,
    );
    await run(
      `INSERT INTO expense_items (expense_id, inventory_item_id, quantity, unit_cost, line_total)
       VALUES ($1, $2, 10, 3.50, 35)`,
      [Number(expense.id), itemId],
    );

    return itemId;
  });
}

async function countIn(tenantId: string, table: string): Promise<number> {
  return asTenant(tenantId, async () => {
    const row = await get(`SELECT COUNT(*)::int AS c FROM ${table} WHERE tenant_id = $1`, [tenantId]);
    return row?.c ?? 0;
  });
}

beforeAll(async () => {
  tenant = await createTestTenant('invreset-a');
  other = await createTestTenant('invreset-b');
}, 60_000);

afterAll(async () => {
  await dropTestTenant(tenant.id);
  await dropTestTenant(other.id);
  await closePools();
}, 60_000);

describe('inventory reset', () => {
  it('lists every table that references inventory_items', async () => {
    // The completeness invariant. pg_constraint is the source of truth; the
    // constant in inventoryReset.js must cover all of it or 'wipe' breaks.
    const referencing = await asTenant(tenant.id, async () =>
      all(`
        SELECT DISTINCT src.relname AS table_name
        FROM pg_constraint c
        JOIN pg_class src ON src.oid = c.conrelid
        JOIN pg_class tgt ON tgt.oid = c.confrelid
        WHERE c.contype = 'f' AND tgt.relname = 'inventory_items'
      `),
    );

    const listed = new Set(RESET_WIPE_TABLES);
    const missing = referencing
      .map((r: { table_name: string }) => r.table_name)
      .filter((name: string) => !listed.has(name));

    expect(missing).toEqual([]);
  });

  it("'zero' keeps the catalog, zeroes stock, clears history", async () => {
    const itemId = await seedInventoryGraph(tenant.id);

    const preview = await asTenant(tenant.id, () => buildResetPreview(tenant.id));
    expect(preview.items_with_stock).toBe(1);
    expect(preview.history_rows).toBe(4);
    expect(preview.recipe_links).toBe(1);

    const result = await asTenant(tenant.id, () =>
      resetInventoryData({ mode: 'zero', tenantId: tenant.id }),
    );
    expect(result.items_affected).toBe(1);

    const item = await asTenant(tenant.id, () =>
      get('SELECT quantity, cost_price, low_stock_threshold, last_counted_at FROM inventory_items WHERE id = $1', [itemId]),
    );
    expect(Number(item.quantity)).toBe(0);
    expect(Number(item.cost_price)).toBe(3.5);        // catalog survives
    expect(Number(item.low_stock_threshold)).toBe(10);
    expect(item.last_counted_at).toBeNull();

    expect(await countIn(tenant.id, 'inventory_counts')).toBe(0);
    expect(await countIn(tenant.id, 'waste_log')).toBe(0);
    expect(await countIn(tenant.id, 'shrinkage_alerts')).toBe(0);
    expect(await countIn(tenant.id, 'inventory_cost_history')).toBe(0);

    // Catalog-side links untouched
    expect(await countIn(tenant.id, 'menu_item_ingredients')).toBe(1);
    expect(await countIn(tenant.id, 'inventory_aliases')).toBe(1);
    expect(await countIn(tenant.id, 'vendor_items')).toBe(1);
    expect(await countIn(tenant.id, 'purchase_order_items')).toBe(1);
    expect(await countIn(tenant.id, 'expense_items')).toBe(1);
  });

  it("'wipe' empties inventory and every dependent table", async () => {
    // Second tenant seeded too — its rows must survive tenant A's wipe.
    await seedInventoryGraph(other.id);

    const result = await asTenant(tenant.id, () =>
      resetInventoryData({ mode: 'wipe', tenantId: tenant.id }),
    );
    expect(result.items_affected).toBe(1);

    expect(await countIn(tenant.id, 'inventory_items')).toBe(0);
    for (const table of RESET_WIPE_TABLES) {
      expect(await countIn(tenant.id, table)).toBe(0);
    }

    // The expense row itself survives — only its itemization went away.
    expect(await countIn(tenant.id, 'expenses')).toBe(1);
    // Menu item survives, just without a recipe.
    expect(await countIn(tenant.id, 'menu_items')).toBe(1);

    // Tenant isolation
    expect(await countIn(other.id, 'inventory_items')).toBe(1);
    expect(await countIn(other.id, 'menu_item_ingredients')).toBe(1);
  });

  it('rejects an unknown mode', async () => {
    await expect(
      asTenant(tenant.id, () => resetInventoryData({ mode: 'nuke', tenantId: tenant.id })),
    ).rejects.toThrow(/Unknown inventory reset mode/);
  });
});
