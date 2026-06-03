import { getConn, get } from '../db/index.js';

const OVERPAY_THRESHOLD = 1.15;
const OVERPAY_MIN_HISTORY = 3;
const OVERPAY_WINDOW_DAYS = 180;

// Cost-anomaly thresholds. "soft" is the rolling-median 15% deviation already
// used by detectOverpay. "severe" is the unit-of-measure mismatch fingerprint:
// when a SKU's incoming cost is multiple times its own history (or its
// same-unit peers for new SKUs), the most likely explanation is that the
// model treated a line_total as a per-unit price. We block these at the
// confirmation step instead of writing them straight through.
const ANOMALY_SEVERE_RATIO_EXISTING = 3.0;
const ANOMALY_SEVERE_RATIO_NEW = 5.0;
const ANOMALY_NEW_MIN_PEERS = 10;
// Floor so cheap-item ratios don't false-fire. Below this absolute unit cost
// we don't bother — small typos on inexpensive items aren't worth interrupting
// the owner over.
const ANOMALY_NEW_ABSOLUTE_FLOOR = 50;

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
 * Cost-anomaly pre-write check. Surfaces the unit-of-measure mismatch class
 * before it lands on inventory_items.cost_price, where it would silently
 * inflate every recipe using the SKU.
 *
 * Two paths:
 *   - inventoryItemId set: rolling-median check on this SKU's own history.
 *     Returns {severity:'severe'} when ratio > 3×, 'soft' when > 1.15×.
 *   - inventoryItemId null + unit provided: peer-median check across the
 *     tenant's other items with the same unit. Returns 'severe' only when
 *     ratio > 5× AND incoming cost > a small absolute floor (so cheap items
 *     don't false-fire) AND there are enough peers to anchor a median.
 *
 * Returns null when there's no signal. Non-fatal on schema errors.
 *
 * @param {object} args
 * @param {number|null} args.inventoryItemId  null for SKUs about to be created
 * @param {number} args.incomingUnitCost      derived_unit_cost (line_total ÷ received_qty)
 * @param {string|null} args.unit             SKU base unit (used for the new-SKU peer check)
 * @returns {Promise<{ severity:'soft'|'severe', median:number, deviation_pct:number, basis:'history'|'peers', sample_size:number } | null>}
 */
export async function detectCostAnomaly({ inventoryItemId, incomingUnitCost, unit }) {
  if (!incomingUnitCost || incomingUnitCost <= 0) return null;
  try {
    if (inventoryItemId) {
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
        severity: ratio >= ANOMALY_SEVERE_RATIO_EXISTING ? 'severe' : 'soft',
        median: Math.round(median * 10000) / 10000,
        deviation_pct: Math.round((ratio - 1) * 100 * 10) / 10,
        basis: 'history',
        sample_size: historyCount,
      };
    }

    if (!unit) return null;
    const row = await get(
      `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY cost_price) AS median,
              COUNT(*) AS peer_count
       FROM inventory_items
       WHERE unit = $1 AND cost_price > 0`,
      [unit]
    );
    const peerCount = Number(row?.peer_count) || 0;
    const median = row?.median == null ? null : Number(row.median);
    if (peerCount < ANOMALY_NEW_MIN_PEERS || !median || median <= 0) return null;
    if (incomingUnitCost < ANOMALY_NEW_ABSOLUTE_FLOOR) return null;
    const ratio = incomingUnitCost / median;
    if (ratio < ANOMALY_SEVERE_RATIO_NEW) return null;
    return {
      severity: 'severe',
      median: Math.round(median * 10000) / 10000,
      deviation_pct: Math.round((ratio - 1) * 100 * 10) / 10,
      basis: 'peers',
      sample_size: peerCount,
    };
  } catch (err) {
    console.warn('[Inventory] cost anomaly check skipped:', err.message);
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
