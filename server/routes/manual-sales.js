// Manual & imported sales entry.
//
// Purpose: delivery-app revenue (Rappi, DiDi Food, Uber Eats) is real money
// that never touches the POS. Until the partner APIs in delivery.js have
// credentials, this is how that revenue gets into the books. Three paths, in
// descending order of fidelity:
//
//   1. import    — a settlement/sales export from the platform's merchant
//                  portal. One real order per file row, with the platform's
//                  OWN commission figure. Best data; dedupes on the
//                  platform's order id so re-importing an overlapping file is
//                  safe.
//   2. itemized  — one order typed out with real menu items. Feeds top-items,
//                  COGS and recipe-based inventory deduction.
//   3. aggregate — one platform, one day, gross + order count. Fans out into
//                  N real order rows (see migration 0091 for why N rows and
//                  not a multiplier column). Fastest backfill; no item detail,
//                  so no COGS and no inventory deduction.
//
// And one path that is NOT a revenue path:
//
//   4. products  — the platform's per-product daily report (DiDi's "Reporte
//                  diario de productos"). Creates NO orders: the settlement or
//                  operations import above already booked that money, and a
//                  second set of orders would double-count it. What it does is
//                  turn money-per-product into units-per-product and deduct
//                  inventory + record COGS. See migration 0095.
//
// Everything writes through `manual_sales_batches`, so any entry is reversible
// as one unit via DELETE /batches/:id.
//
// These orders are born `status='completed'`, `payment_status='paid'`: they are
// historical, already-fulfilled sales. They must never reach the KDS or print a
// kitchen ticket — no enqueueKitchenTicket() call belongs in this file.

import { Router } from 'express';
import multer from 'multer';
import { all, get, run, getConn, getTenantId } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { audit } from '../lib/auditLog.js';
import {
  deductInventoryForOrder,
  adjustInventoryForMenuQuantities,
  unitCostForMenuItems,
} from '../helpers/inventory.js';
import { matchPlatformItem } from '../lib/platformItemMatch.js';
import {
  TAX_RATE,
  parseAmount,
  parseBusinessDate,
  isValidDate,
  detectMapping,
  parseUpload,
  normalizeRows,
  splitAmount,
  detectProductMapping,
  aggregateProductRows,
  suggestPlatformPrice,
  deriveQuantity,
  normProductName,
} from '../lib/salesImport.js';

const router = Router();

const MAX_AGGREGATE_ORDERS = 2000; // one day of orders for a very busy store
const MAX_IMPORT_ROWS = 5000;
// A daily-summary file expands: one row can become hundreds of orders.
const MAX_IMPORT_ORDERS = 20000;

// Service window used to spread aggregate rows across the day. Without this
// every synthetic order lands on the same hour and /reports/live's hourly
// trend grows a false spike.
const SERVICE_START_HOUR = 11;
const SERVICE_END_HOUR = 22;

const PLATFORM_DEFAULTS = {
  uber_eats: { display_name: 'Uber Eats', commission_percent: 30 },
  rappi:     { display_name: 'Rappi',     commission_percent: 25 },
  didi_food: { display_name: 'DiDi Food', commission_percent: 25 },
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
});

// ==================== DB helpers ====================

export async function resolvePlatform(channel) {
  let platform = await get('SELECT * FROM delivery_platforms WHERE name = $1', [channel]);
  if (!platform) {
    const defaults = PLATFORM_DEFAULTS[channel] || { display_name: channel, commission_percent: 0 };
    const result = await run(
      `INSERT INTO delivery_platforms (tenant_id, name, display_name, commission_percent, active)
       VALUES ($1, $2, $3, $4, true)`,
      [getTenantId(), channel, defaults.display_name, defaults.commission_percent]
    );
    platform = await get('SELECT * FROM delivery_platforms WHERE id = $1', [result.lastInsertRowid]);
  }
  return platform;
}

/**
 * Reserve `count` consecutive order numbers for a specific business date.
 * delivery.js's generateOrderNumber() is hardcoded to today, which would give
 * backdated entries numbers from the wrong day's series.
 */
export async function reserveOrderNumbers(dateStr, count) {
  const conn = getConn();
  const dateNum = parseInt(dateStr.replace(/-/g, ''), 10) * 1000;
  const [row] = await conn.unsafe(`
    SELECT pg_advisory_xact_lock(hashtext($1::text)),
           COALESCE(MAX(order_number), $2::bigint) AS last
    FROM orders
    WHERE created_at::date = $1::date
  `, [dateStr, dateNum]);
  const start = Number(row.last);
  return Array.from({ length: count }, (_, i) => start + i + 1);
}

/** Timestamps spread evenly across the service window of `dateStr`. */
function spreadTimestamps(dateStr, count) {
  const span = SERVICE_END_HOUR - SERVICE_START_HOUR;
  return Array.from({ length: count }, (_, i) => {
    const frac = count === 1 ? 0.5 : i / count;
    const hours = SERVICE_START_HOUR + frac * span;
    const h = Math.floor(hours);
    const m = Math.floor((hours - h) * 60);
    return `${dateStr} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
  });
}

/**
 * Bulk-create paid, completed order rows tied to a batch.
 * @param {Array<{total:number, business_date:string, external_order_id?:string|null, commission?:number|null}>} sales
 * @returns {Promise<Array<{id:number, external_order_id:string|null, commission:number|null}>>}
 */
export async function insertSaleOrders(sales, { batchId, channel, platformId, employeeId, tz }) {
  const conn = getConn();
  const tid = getTenantId();
  const created = [];

  // Group by business date — order numbers are a per-date series.
  const byDate = new Map();
  for (const s of sales) {
    if (!byDate.has(s.business_date)) byDate.set(s.business_date, []);
    byDate.get(s.business_date).push(s);
  }

  for (const [dateStr, daySales] of byDate) {
    const numbers = await reserveOrderNumbers(dateStr, daySales.length);
    const stamps = spreadTimestamps(dateStr, daySales.length);

    const totals = daySales.map((s) => Math.round(s.total * 100) / 100);
    const taxes = totals.map((t) => Math.round((t - t / (1 + TAX_RATE)) * 100) / 100);
    const subtotals = totals.map((t, i) => Math.round((t - taxes[i]) * 100) / 100);

    const rows = await conn.unsafe(`
      INSERT INTO orders (
        tenant_id, order_number, employee_id, status, subtotal, tax, total,
        payment_status, payment_method, source, created_at, completed_at, paid_at,
        manual_batch_id, order_fulfillment_type
      )
      SELECT $1, n.order_number, $2, 'completed', n.subtotal, n.tax, n.total,
             'paid', $3, $3, (n.stamp)::timestamp AT TIME ZONE $4,
             (n.stamp)::timestamp AT TIME ZONE $4, (n.stamp)::timestamp AT TIME ZONE $4,
             $5, 'delivery'
      FROM unnest(
        $6::bigint[], $7::numeric[], $8::numeric[], $9::numeric[], $10::text[]
      ) AS n(order_number, subtotal, tax, total, stamp)
      RETURNING id, order_number
    `, [tid, employeeId, channel, tz, batchId, numbers, subtotals, taxes, totals, stamps]);

    // Join back on order_number — RETURNING row order is not contractually
    // guaranteed to match the input array, and mis-pairing here would attach
    // the wrong external id (breaking future import dedup).
    const byNumber = new Map(rows.map((r) => [Number(r.order_number), r.id]));
    daySales.forEach((s, i) => {
      const id = byNumber.get(numbers[i]);
      if (id) created.push({ id, external_order_id: s.external_order_id ?? null, commission: s.commission ?? null, total: totals[i] });
    });
  }

  if (created.length) {
    // platform_status 'completed', not 'received': these are historical,
    // already-delivered orders and must not surface in
    // GET /api/delivery/orders/active.
    const deliveryRows = await conn.unsafe(`
      INSERT INTO delivery_orders (
        tenant_id, order_id, platform_id, external_order_id, platform_status,
        delivery_fee, platform_commission
      )
      SELECT $1, n.order_id, $2, NULLIF(n.ext, ''), 'completed', 0, n.commission
      FROM unnest($3::int[], $4::text[], $5::numeric[]) AS n(order_id, ext, commission)
      RETURNING id, order_id
    `, [
      tid, platformId,
      created.map((c) => c.id),
      created.map((c) => c.external_order_id || ''),
      created.map((c) => c.commission ?? 0),
    ]);

    const deliveryIdByOrder = new Map(deliveryRows.map((r) => [Number(r.order_id), Number(r.id)]));
    await conn.unsafe(`
      UPDATE orders o SET delivery_order_id = n.delivery_order_id
      FROM unnest($1::int[], $2::int[]) AS n(order_id, delivery_order_id)
      WHERE o.id = n.order_id
    `, [
      created.map((c) => c.id),
      created.map((c) => deliveryIdByOrder.get(Number(c.id)) ?? null),
    ]);
  }

  return created;
}

export async function createBatch(fields) {
  const result = await run(`
    INSERT INTO manual_sales_batches (
      tenant_id, channel, platform_id, entry_mode, business_date, order_count,
      gross_total, commission_total, net_total, commission_percent, source_filename, note, created_by
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
  `, [
    getTenantId(), fields.channel, fields.platform_id, fields.entry_mode, fields.business_date,
    fields.order_count, fields.gross_total, fields.commission_total, fields.net_total,
    fields.commission_percent, fields.source_filename || null, fields.note || null, fields.created_by,
  ]);
  return result.lastInsertRowid;
}

const employeeIdFrom = (req) => req.employee?.id || req.user?.employee_id || req.user?.id || null;

async function fallbackEmployeeId() {
  const row = await get("SELECT id FROM employees WHERE role = 'admin' AND active = true ORDER BY id LIMIT 1")
    || await get('SELECT id FROM employees WHERE active = true ORDER BY id LIMIT 1');
  return row?.id ?? null;
}

// ==================== Routes ====================

// GET /api/manual-sales/channels — platforms available for manual entry
router.get('/channels', requireAuth('manage_delivery'), async (req, res) => {
  try {
    const existing = await all(
      'SELECT id, name, display_name, commission_percent, active FROM delivery_platforms ORDER BY display_name'
    );
    const known = new Set(existing.map((p) => p.name));
    const suggested = Object.entries(PLATFORM_DEFAULTS)
      .filter(([name]) => !known.has(name))
      .map(([name, d]) => ({ id: null, name, display_name: d.display_name, commission_percent: d.commission_percent, active: true }));
    res.json({ platforms: [...existing, ...suggested] });
  } catch (error) {
    console.error('[manual-sales] channels error:', error);
    res.status(500).json({ error: 'Failed to load channels' });
  }
});

// GET /api/manual-sales/batches — recent entries, newest first
router.get('/batches', requireAuth('manage_delivery'), async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const batches = await all(`
      SELECT b.*, dp.display_name AS platform_display_name, e.name AS created_by_name,
             (SELECT COUNT(*)::int FROM orders o WHERE o.manual_batch_id = b.id) AS live_order_count,
             -- A 'products' batch has no orders; these are what it did instead.
             (SELECT COALESCE(SUM(ps.quantity), 0)::int FROM platform_product_sales ps WHERE ps.batch_id = b.id) AS product_units,
             (SELECT COALESCE(SUM(ps.cogs), 0)::numeric FROM platform_product_sales ps WHERE ps.batch_id = b.id) AS product_cogs
      FROM manual_sales_batches b
      LEFT JOIN delivery_platforms dp ON dp.id = b.platform_id
      LEFT JOIN employees e ON e.id = b.created_by
      ORDER BY b.business_date DESC, b.id DESC
      LIMIT $1
    `, [limit]);
    res.json({ batches });
  } catch (error) {
    console.error('[manual-sales] batches error:', error);
    res.status(500).json({ error: 'Failed to load manual sales entries' });
  }
});

// POST /api/manual-sales/aggregate — one platform, one day, gross + order count
router.post('/aggregate', requireAuth('manage_delivery'), async (req, res) => {
  try {
    const { channel, business_date, order_count, gross_total, note } = req.body || {};
    const tz = req.tenant?.timezone || 'UTC';

    if (!channel || typeof channel !== 'string') return res.status(400).json({ error: 'channel is required' });
    if (!isValidDate(business_date)) return res.status(400).json({ error: 'business_date must be YYYY-MM-DD' });

    const count = parseInt(order_count, 10);
    const gross = parseAmount(gross_total);
    if (!Number.isInteger(count) || count < 1) return res.status(400).json({ error: 'order_count must be a positive integer' });
    if (count > MAX_AGGREGATE_ORDERS) return res.status(400).json({ error: `order_count cannot exceed ${MAX_AGGREGATE_ORDERS} per entry` });
    if (!(gross > 0)) return res.status(400).json({ error: 'gross_total must be greater than 0' });

    const platform = await resolvePlatform(channel);
    const employeeId = employeeIdFrom(req) || await fallbackEmployeeId();
    if (!employeeId) return res.status(400).json({ error: 'No active employee to attribute the sale to' });

    const commissionPct = Number(platform.commission_percent) || 0;
    const commissionTotal = Math.round(gross * (commissionPct / 100) * 100) / 100;

    const batchId = await createBatch({
      channel, platform_id: platform.id, entry_mode: 'aggregate', business_date,
      order_count: count, gross_total: gross, commission_total: commissionTotal,
      net_total: Math.round((gross - commissionTotal) * 100) / 100,
      commission_percent: commissionPct, note, created_by: employeeId,
    });

    const perOrder = splitAmount(gross, count);
    const perCommission = splitAmount(commissionTotal, count);
    const sales = perOrder.map((total, i) => ({
      total, business_date, external_order_id: null, commission: perCommission[i],
    }));

    const created = await insertSaleOrders(sales, {
      batchId, channel, platformId: platform.id, employeeId, tz,
    });

    audit({
      tenantId: req.tenant?.id || 'default',
      actorType: 'employee',
      actorId: employeeId != null ? String(employeeId) : null,
      action: 'create',
      resource: 'manual_sales_batch',
      resourceId: String(batchId),
      details: { entry_mode: 'aggregate', channel, business_date, order_count: created.length, gross_total: gross, commission_total: commissionTotal },
      ip: req.ip,
    });

    res.status(201).json({
      success: true, batch_id: batchId, orders_created: created.length,
      gross_total: gross, commission_total: commissionTotal,
      net_total: Math.round((gross - commissionTotal) * 100) / 100,
    });
  } catch (error) {
    console.error('[manual-sales] aggregate error:', error);
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Failed to record manual sales' });
  }
});

// POST /api/manual-sales/itemized — a single order with real menu items
router.post('/itemized', requireAuth('manage_delivery'), async (req, res) => {
  try {
    const { channel, business_date, items, note, customer_name, external_order_id, deduct_inventory = true } = req.body || {};
    const tz = req.tenant?.timezone || 'UTC';

    if (!channel || typeof channel !== 'string') return res.status(400).json({ error: 'channel is required' });
    if (!isValidDate(business_date)) return res.status(400).json({ error: 'business_date must be YYYY-MM-DD' });
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'items must be a non-empty array' });
    if (items.length > 200) return res.status(400).json({ error: 'an order cannot exceed 200 line items' });

    // Resolve every line against the live menu before writing anything.
    const lines = [];
    for (const raw of items) {
      const quantity = parseInt(raw?.quantity, 10) || 1;
      if (quantity < 1) return res.status(400).json({ error: 'item quantity must be at least 1' });

      let menuItem = null;
      if (raw?.menu_item_id) {
        menuItem = await get('SELECT id, name, price FROM menu_items WHERE id = $1', [raw.menu_item_id]);
        if (!menuItem) return res.status(400).json({ error: `menu item ${raw.menu_item_id} not found` });
      }

      const unitPrice = raw?.unit_price != null && parseAmount(raw.unit_price) > 0
        ? Math.round(parseAmount(raw.unit_price) * 100) / 100
        : Math.round((Number(menuItem?.price) || 0) * 100) / 100;

      const name = menuItem?.name || (typeof raw?.item_name === 'string' && raw.item_name.trim()) || null;
      if (!name) return res.status(400).json({ error: 'each item needs a menu_item_id or an item_name' });
      if (!(unitPrice > 0)) return res.status(400).json({ error: `unit price for "${name}" must be greater than 0` });

      lines.push({ menu_item_id: menuItem?.id ?? null, item_name: name, quantity, unit_price: unitPrice, notes: raw?.notes || null });
    }

    const gross = Math.round(lines.reduce((sum, l) => sum + l.unit_price * l.quantity, 0) * 100) / 100;

    const platform = await resolvePlatform(channel);
    const employeeId = employeeIdFrom(req) || await fallbackEmployeeId();
    if (!employeeId) return res.status(400).json({ error: 'No active employee to attribute the sale to' });

    const commissionPct = Number(platform.commission_percent) || 0;
    const commissionTotal = Math.round(gross * (commissionPct / 100) * 100) / 100;

    const batchId = await createBatch({
      channel, platform_id: platform.id, entry_mode: 'itemized', business_date,
      order_count: 1, gross_total: gross, commission_total: commissionTotal,
      net_total: Math.round((gross - commissionTotal) * 100) / 100,
      commission_percent: commissionPct, note, created_by: employeeId,
    });

    const [created] = await insertSaleOrders(
      [{ total: gross, business_date, external_order_id: external_order_id || null, commission: commissionTotal }],
      { batchId, channel, platformId: platform.id, employeeId, tz }
    );

    const conn = getConn();
    const tid = getTenantId();
    await conn.unsafe(`
      INSERT INTO order_items (tenant_id, order_id, menu_item_id, item_name, quantity, unit_price, notes)
      SELECT $1, $2, n.menu_item_id, n.item_name, n.quantity, n.unit_price, NULLIF(n.notes, '')
      FROM unnest($3::int[], $4::text[], $5::int[], $6::numeric[], $7::text[])
        AS n(menu_item_id, item_name, quantity, unit_price, notes)
    `, [
      tid, created.id,
      lines.map((l) => l.menu_item_id),
      lines.map((l) => l.item_name),
      lines.map((l) => l.quantity),
      lines.map((l) => l.unit_price),
      lines.map((l) => l.notes || ''),
    ]);

    if (customer_name) {
      await run('UPDATE delivery_orders SET customer_name = $1 WHERE order_id = $2', [String(customer_name).slice(0, 120), created.id]);
    }

    // Itemized entries carry real menu_item_ids, so recipe-based deduction is
    // meaningful here (aggregate entries have no items and skip it).
    let inventoryDeducted = false;
    if (deduct_inventory !== false && lines.some((l) => l.menu_item_id)) {
      try {
        await deductInventoryForOrder(created.id);
        inventoryDeducted = true;
      } catch (e) {
        console.warn('[manual-sales] inventory deduction skipped:', e.message);
      }
    }

    audit({
      tenantId: req.tenant?.id || 'default',
      actorType: 'employee',
      actorId: employeeId != null ? String(employeeId) : null,
      action: 'create',
      resource: 'manual_sales_batch',
      resourceId: String(batchId),
      details: { entry_mode: 'itemized', channel, business_date, order_id: created.id, items: lines.length, gross_total: gross, inventory_deducted: inventoryDeducted },
      ip: req.ip,
    });

    res.status(201).json({
      success: true, batch_id: batchId, order_id: created.id, items: lines.length,
      gross_total: gross, commission_total: commissionTotal,
      net_total: Math.round((gross - commissionTotal) * 100) / 100,
      inventory_deducted: inventoryDeducted,
    });
  } catch (error) {
    console.error('[manual-sales] itemized error:', error);
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Failed to record manual sale' });
  }
});

// POST /api/manual-sales/import/preview — parse a portal export, write nothing
router.post('/import/preview', requireAuth('manage_delivery'), (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file?.buffer?.length) return res.status(400).json({ error: 'No file uploaded' });

    // A workbook can carry several sheets (Rappi ships five, the first being a
    // glossary). parseUpload auto-picks the likeliest data sheet; the client
    // can override once it sees the list.
    const requestedSheet = typeof req.body?.sheet === 'string' && req.body.sheet ? req.body.sheet : null;
    const { headers, rows, sheets, sheet } = await parseUpload(
      req.file.buffer, req.file.originalname, requestedSheet
    );
    if (!rows.length) return res.status(400).json({ error: 'That file has columns but no data rows.' });
    if (rows.length > MAX_IMPORT_ROWS) {
      return res.status(400).json({ error: `That file has ${rows.length} rows; the limit is ${MAX_IMPORT_ROWS} per import. Split it by week and import each part.` });
    }

    // Client may pass a corrected mapping back into preview to re-check it.
    let mapping = detectMapping(headers);
    if (req.body?.mapping) {
      try {
        const override = typeof req.body.mapping === 'string' ? JSON.parse(req.body.mapping) : req.body.mapping;
        mapping = { ...mapping, ...override };
      } catch { /* ignore malformed override, keep detection */ }
    }

    const fallbackDate = isValidDate(req.body?.business_date) ? req.body.business_date : null;
    const { rows: normalized, skipped } = normalizeRows(rows, mapping, fallbackDate);

    const ids = normalized.map((r) => r.external_order_id).filter(Boolean);
    let duplicates = [];
    if (ids.length) {
      const existing = await all(
        'SELECT external_order_id FROM delivery_orders WHERE external_order_id = ANY($1::text[])',
        [ids]
      );
      duplicates = existing.map((r) => r.external_order_id);
    }
    const dupSet = new Set(duplicates);
    const importable = normalized.filter((r) => !r.external_order_id || !dupSet.has(r.external_order_id));

    // A file with an order-count column is one row per DAY, not per order
    // (DiDi's "Reporte diario de operaciones"). Each row fans out into that
    // many orders so average ticket and orders/day stay truthful.
    const totalOrders = importable.reduce((s, r) => s + (r.order_count || 1), 0);
    const isDaily = !!mapping.order_count && totalOrders > importable.length;

    // A settlement/receipt export is also one row per day, but carries no
    // order count (DiDi's "Recibo — Resumen diario"). Symptom: few rows, every
    // date distinct, no order-id column. Importing it as-is books one giant
    // order per day and the average ticket goes off by ~20x, so say so loudly
    // rather than letting the numbers quietly lie.
    const distinctDates = new Set(importable.map((r) => r.business_date)).size;
    const looksDailyWithoutCounts = !mapping.order_count
      && !mapping.external_order_id
      && importable.length > 0
      && importable.length <= 62
      && distinctDates === importable.length;

    const warnings = [];
    if (!mapping.gross) warnings.push('No gross-sales column was recognized — pick one below or nothing can be imported.');
    if (!mapping.business_date) warnings.push('No date column was recognized — pick one, or set a single business date for the whole file.');
    if (isDaily) {
      warnings.push(`This is a daily summary: ${importable.length} day(s) covering ${totalOrders} orders. Each day will be expanded into its individual orders so average ticket and orders/day stay correct.`);
    } else if (looksDailyWithoutCounts) {
      warnings.push(`This looks like a daily settlement summary: ${importable.length} rows, one per day, with no order count. Imported as-is each day becomes ONE order, so your average ticket will be far too high. Map an order-count column if the file has one — otherwise import the platform's daily OPERATIONS report instead, which carries order counts.`);
    } else if (!mapping.external_order_id) {
      warnings.push('No order-id column was recognized. Without it, re-importing an overlapping file will create duplicate sales.');
    }
    if (mapping.commission_rebate) {
      warnings.push('A commission-rebate column was found; commission is recorded net of it. If the platform rebates all commission during a promo, the true commission here is near zero and your real cost is promo spend.');
    }
    if (!mapping.commission) warnings.push("No commission column was recognized — the platform's configured commission % will be used instead.");
    if (skipped.length) warnings.push(`${skipped.length} row(s) will be skipped (${isDaily ? 'days with no sales, or unreadable values' : 'unreadable amount or date'}).`);
    if (sheets && sheets.length > 1) warnings.push(`This workbook has ${sheets.length} sheets; reading "${sheet}". Switch below if that is the wrong one.`);
    if (duplicates.length) warnings.push(`${duplicates.length} order(s) are already in the system and will be skipped.`);
    if (totalOrders > MAX_IMPORT_ORDERS) warnings.push(`That is ${totalOrders} orders, over the ${MAX_IMPORT_ORDERS} limit for one import. Split the file by week.`);

    res.json({
      headers,
      mapping,
      sheets: sheets || [],
      sheet: sheet || null,
      is_daily: isDaily,
      looks_daily_without_counts: looksDailyWithoutCounts,
      total_orders: totalOrders,
      row_count: rows.length,
      importable_count: importable.length,
      skipped: skipped.slice(0, 25),
      skipped_count: skipped.length,
      duplicate_count: duplicates.length,
      totals: {
        gross: Math.round(importable.reduce((s, r) => s + r.gross, 0) * 100) / 100,
        commission: Math.round(importable.reduce((s, r) => s + (r.commission ?? 0), 0) * 100) / 100,
      },
      date_range: importable.length
        ? { from: importable.reduce((a, r) => (r.business_date < a ? r.business_date : a), importable[0].business_date),
            to: importable.reduce((a, r) => (r.business_date > a ? r.business_date : a), importable[0].business_date) }
        : null,
      sample: importable.slice(0, 12),
      rows: importable,
      warnings,
    });
  } catch (error) {
    console.error('[manual-sales] preview error:', error);
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Failed to read that file' });
  }
});

// POST /api/manual-sales/import/commit — create orders from previewed rows
router.post('/import/commit', requireAuth('manage_delivery'), async (req, res) => {
  try {
    const { channel, rows, source_filename, note } = req.body || {};
    const tz = req.tenant?.timezone || 'UTC';

    if (!channel || typeof channel !== 'string') return res.status(400).json({ error: 'channel is required' });
    if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: 'rows must be a non-empty array' });
    if (rows.length > MAX_IMPORT_ROWS) return res.status(400).json({ error: `cannot import more than ${MAX_IMPORT_ROWS} rows at once` });

    const platform = await resolvePlatform(channel);
    const employeeId = employeeIdFrom(req) || await fallbackEmployeeId();
    if (!employeeId) return res.status(400).json({ error: 'No active employee to attribute the sale to' });

    const commissionPct = Number(platform.commission_percent) || 0;

    // Re-validate and re-check duplicates server-side: the client round-trip
    // is convenience, not a trust boundary, and rows could be stale if two
    // people imported overlapping files.
    const clean = [];
    let expandedOrders = 0;
    for (const r of rows) {
      const gross = parseAmount(r?.gross);
      const date = parseBusinessDate(r?.business_date);
      if (!(gross > 0) || !isValidDate(date)) continue;

      // Trust a parsed 0 as a real 0 (Rappi promo period, DiDi fully-rebated
       // commission), only fall back to the platform default when the client
       // omitted the field entirely.
      const commission = r?.commission != null
        ? Math.round(Math.abs(parseAmount(r.commission)) * 100) / 100
        : Math.round(gross * (commissionPct / 100) * 100) / 100;

      // A daily-summary row stands for N orders. Expand it here rather than
      // writing one fat order: every report that divides by order count
      // (average ticket, orders/day, break-even) would otherwise be wrong by
      // a factor of N.
      const count = Math.max(1, Math.round(Number(r?.order_count) || 1));
      expandedOrders += count;
      if (expandedOrders > MAX_IMPORT_ORDERS) {
        return res.status(400).json({ error: `That file expands to more than ${MAX_IMPORT_ORDERS} orders. Split it by week and import each part.` });
      }

      if (count === 1) {
        const extId = r?.external_order_id ? String(r.external_order_id).trim().slice(0, 120) : null;
        clean.push({ total: Math.round(gross * 100) / 100, business_date: date, external_order_id: extId, commission });
      } else {
        // One platform order id cannot identify N orders, so these carry none.
        const totals = splitAmount(gross, count);
        const comms = splitAmount(commission, count);
        for (let i = 0; i < count; i++) {
          clean.push({ total: totals[i], business_date: date, external_order_id: null, commission: comms[i] });
        }
      }
    }
    if (!clean.length) return res.status(400).json({ error: 'None of the submitted rows had a usable amount and date' });

    const ids = clean.map((r) => r.external_order_id).filter(Boolean);
    let dupSet = new Set();
    if (ids.length) {
      const existing = await all(
        'SELECT external_order_id FROM delivery_orders WHERE external_order_id = ANY($1::text[])',
        [ids]
      );
      dupSet = new Set(existing.map((r) => r.external_order_id));
    }
    // Also dedupe within the submitted payload itself.
    const seen = new Set();
    const toCreate = clean.filter((r) => {
      if (!r.external_order_id) return true;
      if (dupSet.has(r.external_order_id) || seen.has(r.external_order_id)) return false;
      seen.add(r.external_order_id);
      return true;
    });
    const skippedDuplicates = clean.length - toCreate.length;

    if (!toCreate.length) {
      return res.json({ success: true, orders_created: 0, skipped_duplicates: skippedDuplicates, batch_id: null, message: 'Every row was already in the system' });
    }

    const gross = Math.round(toCreate.reduce((s, r) => s + r.total, 0) * 100) / 100;
    const commissionTotal = Math.round(toCreate.reduce((s, r) => s + (r.commission ?? 0), 0) * 100) / 100;
    const dates = toCreate.map((r) => r.business_date).sort();

    const batchId = await createBatch({
      channel, platform_id: platform.id, entry_mode: 'import', business_date: dates[0],
      order_count: toCreate.length, gross_total: gross, commission_total: commissionTotal,
      net_total: Math.round((gross - commissionTotal) * 100) / 100,
      commission_percent: commissionPct,
      source_filename: source_filename ? String(source_filename).slice(0, 255) : null,
      note, created_by: employeeId,
    });

    const created = await insertSaleOrders(toCreate, { batchId, channel, platformId: platform.id, employeeId, tz });

    audit({
      tenantId: req.tenant?.id || 'default',
      actorType: 'employee',
      actorId: employeeId != null ? String(employeeId) : null,
      action: 'create',
      resource: 'manual_sales_batch',
      resourceId: String(batchId),
      details: { entry_mode: 'import', channel, orders_created: created.length, skipped_duplicates: skippedDuplicates, gross_total: gross, source_filename: source_filename || null },
      ip: req.ip,
    });

    res.status(201).json({
      success: true, batch_id: batchId, orders_created: created.length,
      skipped_duplicates: skippedDuplicates, gross_total: gross,
      commission_total: commissionTotal, net_total: Math.round((gross - commissionTotal) * 100) / 100,
      date_range: { from: dates[0], to: dates[dates.length - 1] },
    });
  } catch (error) {
    console.error('[manual-sales] commit error:', error);
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Failed to import sales' });
  }
});

// ==================== Product-level import ====================
//
// Reads a per-product daily report and turns it into inventory consumption and
// COGS. Writes no orders — see the header note and migration 0095.

const MAX_PRODUCT_ROWS = 5000;

/** Persisted mapping for a platform, keyed by normalized product name. */
async function loadItemMap(platformId) {
  const rows = await all(
    `SELECT id, platform_item_name, norm_name, menu_item_id, platform_price, ignored
     FROM platform_item_map WHERE platform_id = $1`,
    [platformId]
  );
  return new Map(rows.map((r) => [r.norm_name, r]));
}

// POST /api/manual-sales/products/preview — parse a product report, write nothing
router.post('/products/preview', requireAuth('manage_delivery'), (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file?.buffer?.length) return res.status(400).json({ error: 'No file uploaded' });
    const channel = typeof req.body?.channel === 'string' ? req.body.channel : null;
    if (!channel) return res.status(400).json({ error: 'channel is required' });

    const requestedSheet = typeof req.body?.sheet === 'string' && req.body.sheet ? req.body.sheet : null;
    const { headers, rows, sheets, sheet } = await parseUpload(
      req.file.buffer, req.file.originalname, requestedSheet
    );
    if (!rows.length) return res.status(400).json({ error: 'That file has columns but no data rows.' });
    if (rows.length > MAX_PRODUCT_ROWS) {
      return res.status(400).json({ error: `That file has ${rows.length} rows; the limit is ${MAX_PRODUCT_ROWS} per import. Split it by month.` });
    }

    let mapping = detectProductMapping(headers);
    if (req.body?.mapping) {
      try {
        const override = typeof req.body.mapping === 'string' ? JSON.parse(req.body.mapping) : req.body.mapping;
        mapping = { ...mapping, ...override };
      } catch { /* ignore malformed override, keep detection */ }
    }

    const fallbackDate = isValidDate(req.body?.business_date) ? req.body.business_date : null;
    const { rows: productDays, skipped } = aggregateProductRows(rows, mapping, fallbackDate);

    const platform = await resolvePlatform(channel);
    const [itemMap, menuItems] = await Promise.all([
      loadItemMap(platform.id),
      all('SELECT id, name, price FROM menu_items WHERE active = true ORDER BY name'),
    ]);

    // Days already imported for this platform. Re-running an overlapping file
    // would deduct the same stock twice, so those days are excluded outright
    // rather than merely warned about.
    const dates = [...new Set(productDays.map((r) => r.business_date))];
    const covered = new Set();
    if (dates.length) {
      const rowsCovered = await all(
        `SELECT DISTINCT business_date::text AS d FROM platform_product_sales
         WHERE platform_id = $1 AND business_date = ANY($2::date[])`,
        [platform.id, dates]
      );
      rowsCovered.forEach((r) => covered.add(r.d));
    }

    // Group by product so price inference sees every day at once — one day's
    // total rarely pins the unit price, several usually do.
    const byProduct = new Map();
    for (const r of productDays) {
      if (!byProduct.has(r.norm_name)) byProduct.set(r.norm_name, []);
      byProduct.get(r.norm_name).push(r);
    }

    const items = [];
    for (const [normName, days] of byProduct) {
      const saved = itemMap.get(normName) || null;
      const suggestion = saved?.menu_item_id
        ? { menu_item_id: Number(saved.menu_item_id), name: null, price: null, confidence: 'saved', candidates: [] }
        : matchPlatformItem(days[0].platform_item_name, menuItems);

      const menuItemId = saved ? (saved.menu_item_id != null ? Number(saved.menu_item_id) : null) : suggestion.menu_item_id;
      const menuItem = menuItemId ? menuItems.find((m) => Number(m.id) === menuItemId) : null;

      // A saved price is the tenant's confirmed answer and always wins.
      const inferred = suggestPlatformPrice(days.map((d) => d.gross), Number(menuItem?.price) || null);
      const platformPrice = saved?.platform_price != null
        ? Number(saved.platform_price)
        : (inferred?.price ?? null);

      const dayRows = days.map((d) => {
        const q = deriveQuantity({ gross: d.gross, quantity: d.quantity, platform_price: platformPrice });
        return {
          business_date: d.business_date,
          gross: d.gross,
          quantity: q.quantity,
          exact: q.exact,
          quantity_source: q.source,
          already_imported: covered.has(d.business_date),
        };
      });

      items.push({
        platform_item_name: days[0].platform_item_name,
        norm_name: normName,
        menu_item_id: menuItemId,
        menu_item_name: menuItem?.name ?? null,
        pos_price: Number(menuItem?.price) || null,
        platform_price: platformPrice,
        price_basis: saved?.platform_price != null ? 'saved' : (inferred?.basis ?? 'none'),
        match_confidence: saved ? 'saved' : suggestion.confidence,
        candidates: suggestion.candidates || [],
        ignored: !!saved?.ignored,
        days: dayRows,
        total_quantity: dayRows.reduce((s, d) => s + (d.already_imported ? 0 : (d.quantity || 0)), 0),
        total_gross: Math.round(dayRows.reduce((s, d) => s + (d.already_imported ? 0 : d.gross), 0) * 100) / 100,
      });
    }

    items.sort((a, b) => b.total_gross - a.total_gross);

    const unresolved = items.filter((i) => !i.ignored && (!i.menu_item_id || !(i.platform_price > 0)));
    const inexact = items.filter((i) => !i.ignored && i.days.some((d) => !d.already_imported && d.quantity && !d.exact));
    const noRecipe = items.filter((i) => !i.ignored && i.menu_item_id).map((i) => i.menu_item_id);
    const recipeCosts = await unitCostForMenuItems(noRecipe);

    const warnings = [];
    if (!mapping.item_name) warnings.push('No product-name column was recognized — pick one below or nothing can be imported.');
    if (!mapping.gross && !mapping.quantity) warnings.push('Neither a sales column nor a quantity column was recognized — pick at least one below.');
    if (!mapping.quantity) {
      warnings.push('This file has no quantity column, so units are worked out as sales ÷ the price on this platform. Check the quantities below before importing — a wrong price deducts the wrong stock.');
    }
    if (covered.size) {
      warnings.push(`${covered.size} day(s) in this file were already imported for ${platform.display_name} and are excluded, so stock is not deducted twice.`);
    }
    if (unresolved.length) {
      warnings.push(`${unresolved.length} product(s) still need a menu item and/or a platform price. They will be skipped until you set them.`);
    }
    if (inexact.length) {
      warnings.push(`${inexact.length} product(s) do not divide evenly into whole units at the price shown — the price is probably wrong, or that day carried a discount.`);
    }
    const missingRecipe = items.filter((i) => !i.ignored && i.menu_item_id && !recipeCosts.has(i.menu_item_id));
    if (missingRecipe.length) {
      warnings.push(`${missingRecipe.length} matched product(s) have no recipe, so they record units but no ingredient deduction and no COGS: ${missingRecipe.slice(0, 5).map((i) => i.menu_item_name).join(', ')}.`);
    }
    if (skipped.length) {
      const names = [...new Set(skipped.map((s) => s.item_name).filter(Boolean))];
      warnings.push(`${skipped.length} row(s) skipped with no sales and no quantity${names.length ? ` (${names.slice(0, 4).join(', ')}${names.length > 4 ? '…' : ''}) — free modifiers bill at 0.00 and carry no units` : ''}.`);
    }
    if (sheets && sheets.length > 1) warnings.push(`This workbook has ${sheets.length} sheets; reading "${sheet}". Switch below if that is the wrong one.`);

    res.json({
      headers,
      mapping,
      sheets: sheets || [],
      sheet: sheet || null,
      platform: { id: platform.id, name: platform.name, display_name: platform.display_name },
      items: items.map((i) => ({ ...i, unit_cost: recipeCosts.get(i.menu_item_id) ?? null })),
      row_count: rows.length,
      product_count: items.length,
      unresolved_count: unresolved.length,
      already_imported_dates: [...covered].sort(),
      skipped_count: skipped.length,
      date_range: productDays.length
        ? { from: productDays.reduce((a, r) => (r.business_date < a ? r.business_date : a), productDays[0].business_date),
            to: productDays.reduce((a, r) => (r.business_date > a ? r.business_date : a), productDays[0].business_date) }
        : null,
      warnings,
    });
  } catch (error) {
    console.error('[manual-sales] product preview error:', error);
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Failed to read that file' });
  }
});

// POST /api/manual-sales/products/commit — record consumption + COGS, deduct stock
router.post('/products/commit', requireAuth('manage_delivery'), async (req, res) => {
  try {
    const { channel, items, source_filename, note, deduct_inventory = true } = req.body || {};
    if (!channel || typeof channel !== 'string') return res.status(400).json({ error: 'channel is required' });
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'items must be a non-empty array' });
    if (items.length > MAX_PRODUCT_ROWS) return res.status(400).json({ error: `cannot import more than ${MAX_PRODUCT_ROWS} products at once` });

    const platform = await resolvePlatform(channel);
    const employeeId = employeeIdFrom(req) || await fallbackEmployeeId();
    if (!employeeId) return res.status(400).json({ error: 'No active employee to attribute the entry to' });

    // Persist every decision the tenant made, including "ignore this one", so
    // the next import of the same report needs no confirmation at all.
    const conn = getConn();
    const tid = getTenantId();
    for (const it of items) {
      const rawName = typeof it?.platform_item_name === 'string' ? it.platform_item_name.trim() : '';
      if (!rawName) continue;
      const key = normProductName(rawName);
      if (!key) continue;
      const price = it?.platform_price != null && parseAmount(it.platform_price) > 0
        ? Math.round(parseAmount(it.platform_price) * 100) / 100
        : null;
      await conn.unsafe(`
        INSERT INTO platform_item_map (tenant_id, platform_id, platform_item_name, norm_name, menu_item_id, platform_price, ignored)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (tenant_id, platform_id, norm_name) DO UPDATE
          SET platform_item_name = EXCLUDED.platform_item_name,
              menu_item_id = EXCLUDED.menu_item_id,
              platform_price = EXCLUDED.platform_price,
              ignored = EXCLUDED.ignored,
              updated_at = NOW()
      `, [tid, platform.id, rawName.slice(0, 200), key, it?.menu_item_id ?? null, price, !!it?.ignored]);
    }

    // Re-derive which days are already covered; the client's preview could be
    // stale if someone else imported in between.
    const allDates = [...new Set(items.flatMap((it) => (it?.days || []).map((d) => d?.business_date)).filter(isValidDate))];
    const covered = new Set();
    if (allDates.length) {
      const rowsCovered = await all(
        `SELECT DISTINCT business_date::text AS d FROM platform_product_sales
         WHERE platform_id = $1 AND business_date = ANY($2::date[])`,
        [platform.id, allDates]
      );
      rowsCovered.forEach((r) => covered.add(r.d));
    }

    const menuIds = items.map((it) => it?.menu_item_id).filter(Boolean).map(Number);
    const recipeCosts = await unitCostForMenuItems(menuIds);

    const lines = [];
    let skippedUnresolved = 0;
    let skippedCovered = 0;
    for (const it of items) {
      if (it?.ignored) continue;
      const menuItemId = it?.menu_item_id != null ? Number(it.menu_item_id) : null;
      const rawName = typeof it?.platform_item_name === 'string' ? it.platform_item_name.trim() : '';
      if (!rawName) continue;

      for (const d of it?.days || []) {
        const date = parseBusinessDate(d?.business_date);
        if (!isValidDate(date)) continue;
        if (covered.has(date)) { skippedCovered++; continue; }
        const qty = Math.round(Number(d?.quantity) || 0);
        if (qty < 1) { skippedUnresolved++; continue; }

        const unitCost = menuItemId != null ? (recipeCosts.get(menuItemId) ?? null) : null;
        lines.push({
          business_date: date,
          platform_item_name: rawName.slice(0, 200),
          menu_item_id: menuItemId,
          quantity: qty,
          gross: Math.round((parseAmount(d?.gross) || 0) * 100) / 100,
          unit_cost: unitCost,
          cogs: unitCost != null ? Math.round(unitCost * qty * 100) / 100 : null,
        });
      }
    }

    if (!lines.length) {
      return res.status(400).json({
        error: skippedCovered
          ? 'Every day in that file was already imported for this platform.'
          : 'No product had both a resolved quantity and a usable date.',
      });
    }

    const totalGross = Math.round(lines.reduce((s, l) => s + l.gross, 0) * 100) / 100;
    const totalCogs = Math.round(lines.reduce((s, l) => s + (l.cogs || 0), 0) * 100) / 100;
    const totalUnits = lines.reduce((s, l) => s + l.quantity, 0);
    const dates = lines.map((l) => l.business_date).sort();

    // order_count 0 and net_total 0 are deliberate: this batch created no
    // orders and booked no revenue. gross_total is carried for reconciliation
    // against the settlement import, not as income.
    const batchId = await createBatch({
      channel, platform_id: platform.id, entry_mode: 'products', business_date: dates[0],
      order_count: 0, gross_total: totalGross, commission_total: 0, net_total: 0,
      commission_percent: 0,
      source_filename: source_filename ? String(source_filename).slice(0, 255) : null,
      note, created_by: employeeId,
    });

    await conn.unsafe(`
      INSERT INTO platform_product_sales (
        tenant_id, batch_id, platform_id, business_date, platform_item_name,
        menu_item_id, quantity, gross, unit_cost, cogs
      )
      SELECT $1, $2, $3, n.business_date::date, n.platform_item_name,
             n.menu_item_id, n.quantity, n.gross, n.unit_cost, n.cogs
      FROM unnest(
        $4::text[], $5::text[], $6::int[], $7::numeric[], $8::numeric[], $9::numeric[], $10::numeric[]
      ) AS n(business_date, platform_item_name, menu_item_id, quantity, gross, unit_cost, cogs)
    `, [
      tid, batchId, platform.id,
      lines.map((l) => l.business_date),
      lines.map((l) => l.platform_item_name),
      lines.map((l) => l.menu_item_id),
      lines.map((l) => l.quantity),
      lines.map((l) => l.gross),
      lines.map((l) => l.unit_cost),
      lines.map((l) => l.cogs),
    ]);

    let inventoryDeducted = false;
    if (deduct_inventory !== false) {
      await adjustInventoryForMenuQuantities(
        lines.filter((l) => l.menu_item_id).map((l) => ({ menu_item_id: l.menu_item_id, quantity: l.quantity })),
        -1
      );
      inventoryDeducted = true;
    }

    audit({
      tenantId: req.tenant?.id || 'default',
      actorType: 'employee',
      actorId: employeeId != null ? String(employeeId) : null,
      action: 'create',
      resource: 'manual_sales_batch',
      resourceId: String(batchId),
      details: {
        entry_mode: 'products', channel, lines: lines.length, units: totalUnits,
        gross_total: totalGross, cogs_total: totalCogs,
        inventory_deducted: inventoryDeducted, source_filename: source_filename || null,
      },
      ip: req.ip,
    });

    res.status(201).json({
      success: true, batch_id: batchId, lines: lines.length, units: totalUnits,
      gross_total: totalGross, cogs_total: totalCogs,
      skipped_unresolved: skippedUnresolved, skipped_already_imported: skippedCovered,
      inventory_deducted: inventoryDeducted,
      date_range: { from: dates[0], to: dates[dates.length - 1] },
    });
  } catch (error) {
    console.error('[manual-sales] product commit error:', error);
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Failed to import products' });
  }
});

// GET /api/manual-sales/product-map?channel=didi_food — the learned mapping
router.get('/product-map', requireAuth('manage_delivery'), async (req, res) => {
  try {
    const channel = typeof req.query.channel === 'string' ? req.query.channel : null;
    if (!channel) return res.status(400).json({ error: 'channel is required' });
    const platform = await get('SELECT id FROM delivery_platforms WHERE name = $1', [channel]);
    if (!platform) return res.json({ mappings: [] });

    const mappings = await all(`
      SELECT m.id, m.platform_item_name, m.menu_item_id, m.platform_price, m.ignored,
             mi.name AS menu_item_name, mi.price AS pos_price
      FROM platform_item_map m
      LEFT JOIN menu_items mi ON mi.id = m.menu_item_id
      WHERE m.platform_id = $1
      ORDER BY m.platform_item_name
    `, [platform.id]);
    res.json({ mappings });
  } catch (error) {
    console.error('[manual-sales] product-map error:', error);
    res.status(500).json({ error: 'Failed to load product mapping' });
  }
});

// DELETE /api/manual-sales/product-map/:id — forget one learned mapping
router.delete('/product-map/:id', requireAuth('manage_delivery'), async (req, res) => {
  try {
    const row = await get('SELECT id FROM platform_item_map WHERE id = $1', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Mapping not found' });
    await run('DELETE FROM platform_item_map WHERE id = $1', [row.id]);
    res.json({ success: true, id: Number(row.id) });
  } catch (error) {
    console.error('[manual-sales] product-map delete error:', error);
    res.status(500).json({ error: 'Failed to remove that mapping' });
  }
});

// GET /api/manual-sales/product-sales — what the product imports recorded
router.get('/product-sales', requireAuth('manage_delivery'), async (req, res) => {
  try {
    const from = isValidDate(req.query.from) ? req.query.from : null;
    const to = isValidDate(req.query.to) ? req.query.to : null;
    const rows = await all(`
      SELECT ps.menu_item_id, ps.platform_item_name,
             MIN(mi.name) AS menu_item_name,
             MIN(dp.display_name) AS platform_display_name,
             SUM(ps.quantity)::numeric AS units,
             SUM(ps.gross)::numeric AS gross,
             SUM(COALESCE(ps.cogs, 0))::numeric AS cogs
      FROM platform_product_sales ps
      LEFT JOIN menu_items mi ON mi.id = ps.menu_item_id
      LEFT JOIN delivery_platforms dp ON dp.id = ps.platform_id
      WHERE ($1::date IS NULL OR ps.business_date >= $1::date)
        AND ($2::date IS NULL OR ps.business_date <= $2::date)
      GROUP BY ps.menu_item_id, ps.platform_item_name
      ORDER BY SUM(ps.gross) DESC
      LIMIT 200
    `, [from, to]);
    res.json({ rows });
  } catch (error) {
    console.error('[manual-sales] product-sales error:', error);
    res.status(500).json({ error: 'Failed to load product sales' });
  }
});

// DELETE /api/manual-sales/batches/:id — reverse an entry completely
router.delete('/batches/:id', requireAuth('manage_delivery'), async (req, res) => {
  const conn = getConn();
  try {
    const batch = await get('SELECT * FROM manual_sales_batches WHERE id = $1', [req.params.id]);
    if (!batch) return res.status(404).json({ error: 'Entry not found' });

    const actorId = employeeIdFrom(req);
    const orders = await all('SELECT id FROM orders WHERE manual_batch_id = $1', [batch.id]);
    const ids = orders.map((o) => o.id);

    // A products batch created no orders — what it did was move stock, so
    // undoing it means putting the ingredients back. Restore BEFORE the delete:
    // platform_product_sales cascades off the batch row and the quantities go
    // with it.
    const productLines = await all(
      'SELECT menu_item_id, quantity FROM platform_product_sales WHERE batch_id = $1 AND menu_item_id IS NOT NULL',
      [batch.id]
    );
    if (productLines.length) {
      await adjustInventoryForMenuQuantities(
        productLines.map((l) => ({ menu_item_id: Number(l.menu_item_id), quantity: Number(l.quantity) })),
        1
      );
    }

    if (ids.length) {
      // Same cascade order as DELETE /api/orders/:id — FK constraints block a
      // bare DELETE FROM orders.
      await conn.unsafe(`DELETE FROM order_item_modifiers WHERE order_item_id IN (SELECT id FROM order_items WHERE order_id = ANY($1::int[]))`, [ids]);
      await conn.unsafe(`DELETE FROM order_payment_items WHERE payment_id IN (SELECT id FROM order_payments WHERE order_id = ANY($1::int[])) OR order_item_id IN (SELECT id FROM order_items WHERE order_id = ANY($1::int[]))`, [ids]);
      await conn.unsafe(`DELETE FROM order_payments WHERE order_id = ANY($1::int[])`, [ids]);
      await conn.unsafe(`DELETE FROM refunds WHERE order_id = ANY($1::int[])`, [ids]);
      await conn.unsafe(`UPDATE orders SET delivery_order_id = NULL WHERE id = ANY($1::int[])`, [ids]);
      await conn.unsafe(`DELETE FROM delivery_orders WHERE order_id = ANY($1::int[])`, [ids]);
      await conn.unsafe(`UPDATE stamp_events SET order_id = NULL WHERE order_id = ANY($1::int[])`, [ids]);
      await conn.unsafe(`DELETE FROM order_items WHERE order_id = ANY($1::int[])`, [ids]);
      await conn.unsafe(`DELETE FROM orders WHERE id = ANY($1::int[])`, [ids]);
    }

    await conn.unsafe('DELETE FROM manual_sales_batches WHERE id = $1', [batch.id]);

    audit({
      tenantId: req.tenant?.id || 'default',
      actorType: 'employee',
      actorId: actorId != null ? String(actorId) : null,
      action: 'delete',
      resource: 'manual_sales_batch',
      resourceId: String(batch.id),
      details: {
        entry_mode: batch.entry_mode, channel: batch.channel, orders_deleted: ids.length,
        product_lines_reversed: productLines.length, gross_total: batch.gross_total,
      },
      ip: req.ip,
    });

    res.json({
      success: true, batch_id: Number(batch.id),
      orders_deleted: ids.length, product_lines_reversed: productLines.length,
    });
  } catch (error) {
    console.error('[manual-sales] delete error:', error);
    res.status(500).json({ error: 'Failed to reverse that entry' });
  }
});

export default router;
