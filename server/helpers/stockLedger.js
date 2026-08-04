import { getConn } from '../db/index.js';

/**
 * portion_ledger reasons. Mirrors the CHECK constraint in migration 0103 —
 * validating here as well means a typo fails in JS with a readable message
 * instead of as a constraint violation halfway through a transaction.
 */
export const LEDGER_REASONS = Object.freeze([
  'purchase',           // receipt match stocked the walk-in
  'prep_consume',       // a prep run took raw off the shelf
  'prep_produce',       // a prep run put portions on the line
  'sale',               // an order consumed portions
  'refund_restore',     // a refund gave them back
  'void_restore',       // a void / line removal gave them back
  'waste',              // spoilage, drops, prep errors
  'count_adjust',       // a physical count disagreed with the cache
  'carryover_discard',  // end-of-day discard of a perishable
]);

const REASON_SET = new Set(LEDGER_REASONS);

function validateEntry(entry, index) {
  const where = index == null ? 'entry' : `entry[${index}]`;
  if (!entry || typeof entry !== 'object') {
    throw new Error(`applyStockDelta: ${where} must be an object`);
  }
  const itemId = Number(entry.itemId);
  if (!Number.isInteger(itemId) || itemId <= 0) {
    throw new Error(`applyStockDelta: ${where}.itemId must be a positive integer, got ${entry.itemId}`);
  }
  const delta = Number(entry.delta);
  if (!Number.isFinite(delta)) {
    throw new Error(`applyStockDelta: ${where}.delta must be a finite number, got ${entry.delta}`);
  }
  // A zero delta is always a bug in the caller (an empty prep line, a
  // no-op refund). Writing a ledger row that says "nothing happened" costs a
  // row and buys nothing, so refuse it rather than silently skipping.
  if (delta === 0) {
    throw new Error(`applyStockDelta: ${where}.delta must not be zero`);
  }
  if (!REASON_SET.has(entry.reason)) {
    throw new Error(
      `applyStockDelta: ${where}.reason must be one of ${LEDGER_REASONS.join(', ')}, got ${entry.reason}`
    );
  }
  return {
    itemId,
    delta,
    reason: entry.reason,
    refType: entry.refType ?? null,
    refId: entry.refId == null ? null : Number(entry.refId),
    employeeId: entry.employeeId == null ? null : Number(entry.employeeId),
  };
}

/**
 * Apply one stock movement: append a portion_ledger row and move the cached
 * inventory_items.quantity, in the caller's transaction.
 *
 * This is the only sanctioned way to change inventory_items.quantity on
 * two-stage paths. Everything else in this codebase mutates quantity directly
 * and leaves no trace of why.
 *
 * The cache CLAMPS at zero; the ledger records the UNCLAMPED delta. Selling a
 * portion that isn't there drives quantity to 0 and leaves the ledger summing
 * below it — that gap is real oversell, and P3's variance report is supposed to
 * see it. Restoring later climbs back from 0, so a clamped-away deduction is
 * deliberately not "given back".
 *
 * @param {import('postgres').Sql|null} sql  Explicit handle for callers that
 *   own their transaction — the kiosk routes run OUTSIDE tenantMiddleware on
 *   `adminSql.begin(...)`, and a helper reaching for getConn() there would
 *   silently escape their transaction and autocommit. Pass null only from
 *   routes running under tenantMiddleware.
 * @param {{itemId:number, delta:number, reason:string, refType?:string|null,
 *          refId?:number|null, employeeId?:number|null, tenantId?:string|null}} entry
 *   `tenantId` is REQUIRED when `sql` is an adminSql handle: RLS is not there to
 *   scope the write, so it is what keeps one tenant from moving another's stock.
 * @returns {Promise<{itemId:number, quantity:number}>} post-update cached quantity
 */
export async function applyStockDelta(sql, entry) {
  const [result] = await applyStockDeltas(sql, [entry], { tenantId: entry?.tenantId ?? null });
  return result;
}

/**
 * Batch form. One UPDATE for the quantities (aggregated per item, so several
 * lines touching the same component collapse into a single write) and one
 * INSERT for the ledger rows (kept per-entry, so reason/ref granularity
 * survives — that per-line granularity is what P2's idempotency check reads).
 *
 * @param {import('postgres').Sql|null} sql
 * @param {Array<object>} entries  see applyStockDelta
 * @param {{tenantId?: string|null}} [opts]
 * @returns {Promise<Array<{itemId:number, quantity:number}>>} in `entries` order
 */
export async function applyStockDeltas(sql, entries, opts = {}) {
  const list = (entries || []).map((e, i) => validateEntry(e, entries.length === 1 ? null : i));
  if (!list.length) return [];

  const conn = sql || getConn();
  const tenantId = opts.tenantId ?? entries[0]?.tenantId ?? null;

  const itemIds = list.map((e) => e.itemId);
  const deltas = list.map((e) => e.delta);

  // Quantity first. It doubles as the existence + ownership check: an id that
  // does not exist (or belongs to another tenant) matches no row, and we throw
  // rather than leave a ledger row pointing at stock we never moved.
  const updated = tenantId
    ? await conn`
        UPDATE inventory_items ii
        SET quantity = GREATEST(0, ii.quantity + agg.delta)
        FROM (
          SELECT d.item_id, SUM(d.delta) AS delta
          FROM unnest(${itemIds}::int[], ${deltas}::numeric[]) AS d(item_id, delta)
          GROUP BY d.item_id
        ) agg
        WHERE ii.id = agg.item_id AND ii.tenant_id = ${tenantId}
        RETURNING ii.id, ii.quantity
      `
    : await conn`
        UPDATE inventory_items ii
        SET quantity = GREATEST(0, ii.quantity + agg.delta)
        FROM (
          SELECT d.item_id, SUM(d.delta) AS delta
          FROM unnest(${itemIds}::int[], ${deltas}::numeric[]) AS d(item_id, delta)
          GROUP BY d.item_id
        ) agg
        WHERE ii.id = agg.item_id
        RETURNING ii.id, ii.quantity
      `;

  const distinctIds = [...new Set(itemIds)];
  if (updated.length !== distinctIds.length) {
    const found = new Set(updated.map((r) => Number(r.id)));
    const missing = distinctIds.filter((id) => !found.has(id));
    throw new Error(
      `applyStockDelta: inventory item(s) ${missing.join(', ')} not found for this tenant — no stock was moved`
    );
  }

  const reasons = list.map((e) => e.reason);
  const refTypes = list.map((e) => e.refType);
  const refIds = list.map((e) => e.refId);
  const employeeIds = list.map((e) => e.employeeId);

  // tenant_id is omitted on the RLS path so the column DEFAULT
  // (current_setting('app.tenant_id')) fills it, matching every other
  // tenant-scoped insert in the codebase.
  if (tenantId) {
    await conn`
      INSERT INTO portion_ledger (tenant_id, inventory_item_id, delta, reason, ref_type, ref_id, employee_id)
      SELECT ${tenantId}, *
      FROM unnest(
        ${itemIds}::int[], ${deltas}::numeric[], ${reasons}::text[],
        ${refTypes}::text[], ${refIds}::int[], ${employeeIds}::int[]
      )
    `;
  } else {
    await conn`
      INSERT INTO portion_ledger (inventory_item_id, delta, reason, ref_type, ref_id, employee_id)
      SELECT *
      FROM unnest(
        ${itemIds}::int[], ${deltas}::numeric[], ${reasons}::text[],
        ${refTypes}::text[], ${refIds}::int[], ${employeeIds}::int[]
      )
    `;
  }

  const byId = new Map(updated.map((r) => [Number(r.id), Number(r.quantity)]));
  return list.map((e) => ({ itemId: e.itemId, quantity: byId.get(e.itemId) }));
}
