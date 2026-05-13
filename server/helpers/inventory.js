import { getConn, get } from '../db/index.js';

const OVERPAY_THRESHOLD = 1.15;
const OVERPAY_MIN_HISTORY = 3;
const OVERPAY_WINDOW_DAYS = 180;

/**
 * Detect whether an incoming unit_cost is significantly above the rolling median
 * of recent purchase prices for the same inventory item. Returns null when there
 * is insufficient history to make a judgement (avoids false alarms on new items).
 *
 * @param {number} inventoryItemId
 * @param {number} incomingUnitCost
 * @returns {Promise<{ median: number, deviation_pct: number, history_count: number } | null>}
 */
export async function detectOverpay(inventoryItemId, incomingUnitCost) {
  if (!inventoryItemId || !incomingUnitCost || incomingUnitCost <= 0) return null;
  try {
    const row = await get(
      `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY unit_cost) AS median,
              COUNT(*) AS history_count
       FROM inventory_cost_history
       WHERE inventory_item_id = $1
         AND unit_cost > 0
         AND created_at > NOW() - INTERVAL '${OVERPAY_WINDOW_DAYS} days'`,
      [inventoryItemId]
    );
    const historyCount = Number(row?.history_count) || 0;
    const median = row?.median == null ? null : Number(row.median);
    if (historyCount < OVERPAY_MIN_HISTORY || !median || median <= 0) return null;

    const ratio = incomingUnitCost / median;
    if (ratio <= OVERPAY_THRESHOLD) return null;

    return {
      median: Math.round(median * 10000) / 10000,
      deviation_pct: Math.round((ratio - 1) * 100 * 10) / 10,
      history_count: historyCount,
    };
  } catch (err) {
    // Table may not exist on a stale schema (pre-migration 0042). Non-fatal.
    console.warn('[Inventory] overpay check skipped:', err.message);
    return null;
  }
}

/**
 * Deduct inventory for all items in an order.
 * Single UPDATE+JOIN: aggregates all ingredient requirements across order items
 * and deducts from inventory in one query.
 */
export async function deductInventoryForOrder(orderId) {
  const conn = getConn();
  await conn.unsafe(`
    UPDATE inventory_items ii
    SET quantity = GREATEST(0, ii.quantity - deductions.total_needed)
    FROM (
      SELECT mii.inventory_item_id,
             SUM(mii.quantity_used * oi.quantity) AS total_needed
      FROM order_items oi
      JOIN menu_item_ingredients mii ON mii.menu_item_id = oi.menu_item_id
      WHERE oi.order_id = $1
      GROUP BY mii.inventory_item_id
    ) deductions
    WHERE ii.id = deductions.inventory_item_id
  `, [orderId]);
}

/**
 * Restore inventory for specific refunded items.
 * Single UPDATE+JOIN with unnest: passes per-item refund quantities
 * to handle partial refunds correctly.
 * @param {Array<{order_item_id: number, quantity: number}>} items
 */
export async function restoreInventoryForItems(items) {
  if (!items || items.length === 0) return;
  const conn = getConn();
  const orderItemIds = items.map(i => i.order_item_id);
  const quantities = items.map(i => i.quantity);

  await conn`
    UPDATE inventory_items ii
    SET quantity = ii.quantity + restorations.total_restore
    FROM (
      SELECT mii.inventory_item_id,
             SUM(mii.quantity_used * refund.qty) AS total_restore
      FROM unnest(${orderItemIds}::int[], ${quantities}::numeric[]) AS refund(order_item_id, qty)
      JOIN order_items oi ON oi.id = refund.order_item_id
      JOIN menu_item_ingredients mii ON mii.menu_item_id = oi.menu_item_id
      GROUP BY mii.inventory_item_id
    ) restorations
    WHERE ii.id = restorations.inventory_item_id
  `;
}
