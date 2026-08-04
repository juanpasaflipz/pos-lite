import { getConn, get, adminSql, getTenantId } from '../db/index.js';
import { applyStockDeltas } from './stockLedger.js';

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
 * Deduct inventory for all items in an order, at PAYMENT time.
 * Single UPDATE+JOIN: aggregates all ingredient requirements across order items
 * and deducts from inventory in one query.
 *
 * This is the ingredients-mode path and it stays exactly as it was. Two-stage
 * tenants deduct components at order-creation time instead (see
 * deductComponentsForOrderLines), so this must NOT also fire for them or every
 * sale would be counted twice.
 *
 * The mode check lives here rather than at the ~9 call sites on purpose: it is
 * the one place every payment path already funnels through, and a call site
 * added later inherits the guard instead of reintroducing the bug.
 *
 * @param {number} orderId
 * @param {{mode?: string}} [opts] caller's tenant mode when it already has it
 *   (saves a lookup); omitted callers get the authoritative lookup below.
 */
export async function deductInventoryForOrder(orderId, opts = {}) {
  const mode = opts.mode ?? await inventoryModeForOrder(orderId);
  if (mode === 'two_stage') return;

  const conn = getConn();
  // voided_at IS NULL: a line the cashier voided before payment was never sold,
  // so deducting it would quietly walk stock down for food nobody made. This is
  // a correctness fix for ingredients mode too, not just two-stage plumbing.
  await conn.unsafe(`
    UPDATE inventory_items ii
    SET quantity = GREATEST(0, ii.quantity - deductions.total_needed)
    FROM (
      SELECT mii.inventory_item_id,
             SUM(mii.quantity_used * oi.quantity) AS total_needed
      FROM order_items oi
      JOIN menu_item_ingredients mii ON mii.menu_item_id = oi.menu_item_id
      WHERE oi.order_id = $1 AND oi.voided_at IS NULL
      GROUP BY mii.inventory_item_id
    ) deductions
    WHERE ii.id = deductions.inventory_item_id
  `, [orderId]);
}

/**
 * The inventory model the order's tenant runs on.
 *
 * Uses adminSql via a join through orders → tenants because several callers
 * (kiosk payment polling, the Getnet webhook) run outside any tenant context
 * and have nothing but an order id.
 */
export async function inventoryModeForOrder(orderId) {
  const row = await adminSql`
    SELECT t.inventory_mode
    FROM orders o
    JOIN tenants t ON t.id = o.tenant_id
    WHERE o.id = ${orderId}
  `;
  return row[0]?.inventory_mode || 'ingredients';
}

/** The inventory model a tenant runs on. Defaults to today's behavior. */
export async function inventoryModeForTenant(tenantId) {
  if (!tenantId) return 'ingredients';
  const row = await adminSql`SELECT inventory_mode FROM tenants WHERE id = ${tenantId}`;
  return row[0]?.inventory_mode || 'ingredients';
}

/**
 * Deduct (or restore) inventory straight from menu-item quantities, with no
 * order to hang them off.
 *
 * The delivery product-report import needs this: it knows "17 Cochinita
 * Burritos were sold on the 28th" but deliberately creates no orders, because
 * the settlement import already booked that revenue and a second set of orders
 * would double-count it (see migration 0095).
 *
 * @param {Array<{menu_item_id:number, quantity:number}>} pairs
 * @param {1|-1} direction  -1 deducts (a sale), +1 restores (undoing a batch)
 */
export async function adjustInventoryForMenuQuantities(pairs, direction = -1, opts = {}) {
  const usable = (pairs || []).filter((p) => p.menu_item_id && Number(p.quantity) > 0);
  if (!usable.length) return;

  const conn = getConn();
  const menuItemIds = usable.map((p) => Number(p.menu_item_id));
  const quantities = usable.map((p) => Number(p.quantity) * (direction < 0 ? -1 : 1));

  // Two-stage tenants move PORTIONS through the ledger instead. Same input
  // (menu item + how many sold), different layer: components, not raw.
  const mode = opts.mode ?? await inventoryModeForTenant(opts.tenantId ?? getTenantId());
  if (mode === 'two_stage') {
    const needed = await conn`
      SELECT mii.inventory_item_id, SUM(mii.quantity_used * sold.qty) AS delta
      FROM unnest(${menuItemIds}::int[], ${quantities}::numeric[]) AS sold(menu_item_id, qty)
      JOIN menu_item_ingredients mii ON mii.menu_item_id = sold.menu_item_id
      JOIN inventory_items ii ON ii.id = mii.inventory_item_id AND ii.kind = 'component'
      GROUP BY mii.inventory_item_id
      HAVING SUM(mii.quantity_used * sold.qty) <> 0
    `;
    if (!needed.length) return;
    await applyStockDeltas(conn, needed.map((r) => ({
      itemId: Number(r.inventory_item_id),
      delta: Number(r.delta),
      reason: direction < 0 ? 'sale' : 'void_restore',
      refType: opts.refType || 'manual_sales_batch',
      refId: opts.refId ?? null,
      employeeId: opts.employeeId ?? null,
    })));
    return;
  }

  // GREATEST(0, …) on the deduct side only — a restore must be free to climb
  // back up past whatever the floor clamped away.
  await conn`
    UPDATE inventory_items ii
    SET quantity = GREATEST(0, ii.quantity + adjustments.delta)
    FROM (
      SELECT mii.inventory_item_id,
             SUM(mii.quantity_used * sold.qty) AS delta
      FROM unnest(${menuItemIds}::int[], ${quantities}::numeric[]) AS sold(menu_item_id, qty)
      JOIN menu_item_ingredients mii ON mii.menu_item_id = sold.menu_item_id
      GROUP BY mii.inventory_item_id
    ) adjustments
    WHERE ii.id = adjustments.inventory_item_id
  `;
}

/**
 * Deduct COMPONENT portions for specific order lines — the two-stage sale path.
 *
 * Ledger rows are written per (order_item, component) with
 * ref_type='order_item', which is what makes this idempotent: a line that
 * already has a 'sale' row is skipped. Kiosk orders can reach this more than
 * once (a payment poll retrying, a draft promoted after being created), and
 * relying on every call site to be careful is how double-deduction ships. Here
 * it is structural.
 *
 * Recipe rows pointing at kind='raw' items are ignored: raw is consumed by prep
 * runs, and deducting it again at sale would count the same kilo twice.
 *
 * @param {import('postgres').Sql|null} sql explicit handle for callers holding
 *   their own transaction (the kiosk routes run on adminSql.begin).
 * @param {{tenantId?:string|null, lines:Array<{order_item_id:number, menu_item_id:number, quantity:number}>,
 *          employeeId?:number|null, reason?:string}} args
 * @returns {Promise<Array<{itemId:number, quantity:number}>>}
 */
export async function deductComponentsForOrderLines(sql, {
  tenantId = null, lines, employeeId = null, reason = 'sale',
} = {}) {
  const usable = (lines || []).filter(
    (l) => l && l.order_item_id && l.menu_item_id && Number(l.quantity) > 0
  );
  if (!usable.length) return [];

  const conn = sql || getConn();
  const orderItemIds = usable.map((l) => Number(l.order_item_id));
  const menuItemIds = usable.map((l) => Number(l.menu_item_id));
  const quantities = usable.map((l) => Number(l.quantity));

  // One row per (order_item, component). NOT EXISTS drops lines already
  // deducted, so a replayed call returns nothing rather than double-charging.
  const needed = await conn`
    SELECT sold.order_item_id,
           mii.inventory_item_id,
           SUM(mii.quantity_used * sold.qty) AS total_needed
    FROM unnest(
      ${orderItemIds}::int[], ${menuItemIds}::int[], ${quantities}::numeric[]
    ) AS sold(order_item_id, menu_item_id, qty)
    JOIN menu_item_ingredients mii ON mii.menu_item_id = sold.menu_item_id
    JOIN inventory_items ii ON ii.id = mii.inventory_item_id AND ii.kind = 'component'
    WHERE NOT EXISTS (
      SELECT 1 FROM portion_ledger pl
      WHERE pl.ref_type = 'order_item'
        AND pl.ref_id = sold.order_item_id
        AND pl.reason = 'sale'
    )
    GROUP BY sold.order_item_id, mii.inventory_item_id
  `;
  if (!needed.length) return [];

  return applyStockDeltas(
    conn,
    needed.map((r) => ({
      itemId: Number(r.inventory_item_id),
      delta: -Number(r.total_needed),
      reason,
      refType: 'order_item',
      refId: Number(r.order_item_id),
      employeeId,
    })),
    { tenantId }
  );
}

/**
 * Move a single already-rung line's component usage by a quantity delta.
 *
 * Used when a cashier edits the quantity on a live tab: 2 → 5 consumes three
 * more portions, 5 → 1 gives four back. Unlike the create path this does NOT
 * skip lines that already have a 'sale' row — adjusting is the whole point.
 * It is still safe to replay, because the caller derives the delta from the
 * row's current quantity, so a repeated request computes a delta of zero.
 *
 * @param {import('postgres').Sql|null} sql
 * @param {{tenantId?:string|null, orderItemId:number, menuItemId:number,
 *          quantityDelta:number, employeeId?:number|null}} args
 */
export async function adjustComponentsForOrderLine(sql, {
  tenantId = null, orderItemId, menuItemId, quantityDelta, employeeId = null,
} = {}) {
  const delta = Number(quantityDelta);
  if (!orderItemId || !menuItemId || !Number.isFinite(delta) || delta === 0) return [];

  const conn = sql || getConn();
  const rows = await conn`
    SELECT mii.inventory_item_id, mii.quantity_used
    FROM menu_item_ingredients mii
    JOIN inventory_items ii ON ii.id = mii.inventory_item_id AND ii.kind = 'component'
    WHERE mii.menu_item_id = ${Number(menuItemId)}
  `;
  if (!rows.length) return [];

  return applyStockDeltas(
    conn,
    rows.map((r) => ({
      itemId: Number(r.inventory_item_id),
      delta: -Number(r.quantity_used) * delta,
      reason: delta > 0 ? 'sale' : 'void_restore',
      refType: 'order_item',
      refId: Number(orderItemId),
      employeeId,
    })),
    { tenantId }
  );
}

/**
 * Give back what specific order lines consumed.
 *
 * The amount restored is the NET of each line's existing ledger rows, never a
 * recomputation from the recipe: a line that was partly refunded, or whose
 * quantity was edited after it was rung, must not hand back more than it ever
 * took. A line with nothing left to restore contributes nothing.
 *
 * @param {import('postgres').Sql|null} sql
 * @param {{tenantId?:string|null, orderItemIds:number[], employeeId?:number|null,
 *          reason?:'refund_restore'|'void_restore'}} args
 */
export async function restoreComponentsForOrderLines(sql, {
  tenantId = null, orderItemIds, employeeId = null, reason = 'void_restore',
} = {}) {
  const ids = [...new Set((orderItemIds || []).map(Number).filter(Boolean))];
  if (!ids.length) return [];

  const conn = sql || getConn();
  // Grouped per (line, component) rather than collapsed across the whole set:
  // the restoring rows then point at the line they came from, so a ledger read
  // still answers "what did THIS line consume, and what came back".
  const net = await conn`
    SELECT ref_id, inventory_item_id, SUM(delta) AS net
    FROM portion_ledger
    WHERE ref_type = 'order_item' AND ref_id = ANY(${ids}::int[])
    GROUP BY ref_id, inventory_item_id
    HAVING SUM(delta) < 0
  `;
  if (!net.length) return [];

  return applyStockDeltas(
    conn,
    net.map((r) => ({
      itemId: Number(r.inventory_item_id),
      delta: -Number(r.net), // net is negative; restoring flips it positive
      reason,
      refType: 'order_item',
      refId: Number(r.ref_id),
      employeeId,
    })),
    { tenantId }
  );
}

/**
 * How many of each menu item the line can still serve, derived from component
 * stock. Availability is never stored — it is always this calculation.
 *
 * Absent from the map means "no component recipe", which is unlimited, NOT
 * zero. Items nobody has wired a recipe for must never 86 themselves.
 *
 * @param {import('postgres').Sql|null} sql
 * @param {number[]} menuItemIds
 * @param {{tenantId?: string|null}} [opts]
 * @returns {Promise<Map<number, {sellable:number, low:boolean}>>}
 */
export async function sellableCountsFor(sql, menuItemIds, opts = {}) {
  const ids = [...new Set((menuItemIds || []).filter(Boolean).map(Number))];
  if (!ids.length) return new Map();

  const conn = sql || getConn();
  const tenantId = opts.tenantId ?? null;

  // The limiting component sets the count: you can build as many plates as your
  // scarcest ingredient allows. sold_out_manual forces 0 — "86 the asada" has
  // to beat whatever the shelf count says.
  //
  // auto_86=false components are excluded from the floor entirely (garnishes
  // the kitchen can always improvise) but still honour a manual 86.
  const rows = tenantId
    ? await conn`
        SELECT mii.menu_item_id,
               MIN(CASE WHEN ii.sold_out_manual THEN 0
                        ELSE FLOOR(ii.quantity / NULLIF(mii.quantity_used, 0)) END)::int AS sellable,
               BOOL_OR(ii.low_threshold_portions IS NOT NULL
                       AND ii.quantity <= ii.low_threshold_portions) AS low
        FROM menu_item_ingredients mii
        JOIN inventory_items ii ON ii.id = mii.inventory_item_id
        WHERE mii.menu_item_id = ANY(${ids}::int[])
          AND ii.kind = 'component'
          AND (ii.auto_86 OR ii.sold_out_manual)
          AND mii.tenant_id = ${tenantId}
        GROUP BY mii.menu_item_id
      `
    : await conn`
        SELECT mii.menu_item_id,
               MIN(CASE WHEN ii.sold_out_manual THEN 0
                        ELSE FLOOR(ii.quantity / NULLIF(mii.quantity_used, 0)) END)::int AS sellable,
               BOOL_OR(ii.low_threshold_portions IS NOT NULL
                       AND ii.quantity <= ii.low_threshold_portions) AS low
        FROM menu_item_ingredients mii
        JOIN inventory_items ii ON ii.id = mii.inventory_item_id
        WHERE mii.menu_item_id = ANY(${ids}::int[])
          AND ii.kind = 'component'
          AND (ii.auto_86 OR ii.sold_out_manual)
        GROUP BY mii.menu_item_id
      `;

  return new Map(rows.map((r) => [
    Number(r.menu_item_id),
    { sellable: Math.max(0, Number(r.sellable) || 0), low: !!r.low },
  ]));
}

/**
 * Stamp availability onto menu items for a two-stage tenant.
 *
 * The fields are emitted ONLY in two-stage mode, and their absence is how the
 * clients know the tenant isn't on this model — no separate mode flag has to
 * reach the browser, and an ingredients-mode payload stays byte-identical to
 * what it has always been.
 *
 *   sellable_count  number | null   null = no component recipe = unlimited
 *   sold_out        boolean         sellable_count === 0
 *   low_stock       boolean         a component is at/below its portion threshold
 *
 * @param {Array<object>} items menu rows carrying `id`
 * @param {{mode?:string, sql?:any, tenantId?:string|null}} opts
 */
export async function attachSellable(items, { mode, sql = null, tenantId = null } = {}) {
  const list = items || [];
  if (mode !== 'two_stage' || !list.length) return list;

  const counts = await sellableCountsFor(sql, list.map((i) => i.id), { tenantId });
  return list.map((item) => {
    const entry = counts.get(Number(item.id));
    return {
      ...item,
      sellable_count: entry ? entry.sellable : null,
      sold_out: entry ? entry.sellable <= 0 : false,
      low_stock: entry ? entry.low : false,
    };
  });
}

/**
 * Recipe cost per unit for a set of menu items, from current ingredient costs.
 * Items with no recipe come back absent, not zero — "no recipe" and "costs
 * nothing" are different answers and only the caller can say which matters.
 *
 * @param {number[]} menuItemIds
 * @returns {Promise<Map<number, number>>} menu_item_id -> unit cost
 */
export async function unitCostForMenuItems(menuItemIds) {
  const ids = [...new Set((menuItemIds || []).filter(Boolean).map(Number))];
  if (!ids.length) return new Map();

  const conn = getConn();
  const rows = await conn`
    SELECT mii.menu_item_id,
           SUM(mii.quantity_used * COALESCE(ii.cost_price, 0)) AS unit_cost
    FROM menu_item_ingredients mii
    JOIN inventory_items ii ON ii.id = mii.inventory_item_id
    WHERE mii.menu_item_id = ANY(${ids}::int[])
    GROUP BY mii.menu_item_id
  `;
  return new Map(rows.map((r) => [Number(r.menu_item_id), Number(r.unit_cost) || 0]));
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
