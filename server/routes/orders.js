import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import crypto from 'node:crypto';
import { all, get, run, getConn } from '../db/index.js';
import { adminSql } from '../db/index.js';
// AI data pipeline removed in pos-lite
const recordOrderItemPairs = () => {};
import { requireAuth } from '../middleware/auth.js';
import { audit } from '../lib/auditLog.js';
import { sendReceiptMessage, sendReceiptLoyaltyMessage, sendOrderReadyMessage } from '../helpers/twilio.js';
import { findOrCreateCustomer, addStampsForOrder, getConfigValue } from '../helpers/loyalty.js';
import { tzDate } from '../lib/tz.js';

const router = Router();

// Rate limiting: 30 order creation attempts per IP per 15 minutes
const orderCreateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many order requests. Please try again later.' },
});

const TAX_RATE = 0.16; // 16% IVA (Mexico) — prices already include tax

async function notifyKioskOrderReady(orderId, restaurantName = 'us') {
  try {
    const smsEnabled = await getConfigValue('sms_enabled', 'true');
    if (smsEnabled !== 'true') return;

    const order = await get(`
      SELECT o.id, o.order_number, o.source,
             c.id AS customer_id, c.phone, c.name, c.country_code, c.sms_opt_in
      FROM orders o
      JOIN loyalty_customers c ON c.id = o.loyalty_customer_id
      WHERE o.id = $1
    `, [orderId]);

    if (order?.source !== 'customer_kiosk' || !order.sms_opt_in || !order.phone) return;

    const sid = await sendOrderReadyMessage(
      order.phone,
      order.name,
      order.order_number,
      order.customer_id,
      restaurantName,
      order.country_code || 'MX',
    );

    if (!sid) {
      console.warn(`[order-ready-sms] skipped or failed for order ${orderId}`);
    }
  } catch (err) {
    console.error('[order-ready-sms] warning:', err.message);
  }
}

/**
 * Calculate estimated prep time for an order.
 *
 * Strategy:
 *   1. Use the MAX item prep time (kitchen works in parallel)
 *   2. Add queue buffer: ~1.5 min per active order ahead
 *   3. If historical data exists (30+ completed orders), blend with actual averages
 *
 * Returns { low, high } range in minutes.
 */
async function estimatePrepTime(conn, itemMenuIds, tenantId) {
  // 1. Get max prep_time_minutes from items in this order
  const prepRows = await conn.unsafe(`
    SELECT COALESCE(MAX(prep_time_minutes), 5) AS max_prep
    FROM menu_items
    WHERE id = ANY($1::int[])
  `, [itemMenuIds]);
  const maxPrep = prepRows[0]?.max_prep || 5;

  // 2. Count active orders in queue (today only, to ignore stale test data)
  const queueQuery = tenantId
    ? `SELECT COUNT(*) AS queue_size FROM orders
       WHERE status IN ('pending', 'confirmed', 'preparing', 'active')
         AND created_at >= CURRENT_DATE AND tenant_id = $1`
    : `SELECT COUNT(*) AS queue_size FROM orders
       WHERE status IN ('pending', 'confirmed', 'preparing', 'active')
         AND created_at >= CURRENT_DATE`;
  const queueRows = await conn.unsafe(queueQuery, tenantId ? [tenantId] : []);
  const queueSize = Math.max(0, (parseInt(queueRows[0]?.queue_size) || 0) - 1); // exclude this order
  const queueBuffer = Math.round(queueSize * 1.5);

  // 3. Check historical average (completed orders with ready_at)
  let historicalAvg = null;
  const histQuery = tenantId
    ? `SELECT COUNT(*) AS cnt,
              AVG(EXTRACT(EPOCH FROM (ready_at - created_at)) / 60) AS avg_minutes
       FROM (SELECT ready_at, created_at FROM orders
             WHERE ready_at IS NOT NULL AND status IN ('ready', 'completed')
               AND tenant_id = $1
             ORDER BY created_at DESC LIMIT 200) sub`
    : `SELECT COUNT(*) AS cnt,
              AVG(EXTRACT(EPOCH FROM (ready_at - created_at)) / 60) AS avg_minutes
       FROM (SELECT ready_at, created_at FROM orders
             WHERE ready_at IS NOT NULL AND status IN ('ready', 'completed')
             ORDER BY created_at DESC LIMIT 200) sub`;
  const histRows = await conn.unsafe(histQuery, tenantId ? [tenantId] : []);
  if (histRows[0] && parseInt(histRows[0].cnt) >= 30) {
    historicalAvg = parseFloat(histRows[0].avg_minutes);
  }

  // 4. Blend: if historical data exists, weight 60% historical / 40% item-based
  let basePrepMinutes;
  if (historicalAvg && historicalAvg > 0) {
    basePrepMinutes = Math.round(historicalAvg * 0.6 + maxPrep * 0.4);
  } else {
    basePrepMinutes = maxPrep;
  }

  const totalMinutes = basePrepMinutes + queueBuffer;

  // Return a range: -1 / +2 for leeway (minimum 2 minutes)
  const low = Math.max(2, totalMinutes - 1);
  const high = totalMinutes + 2;

  return { low, high, estimate: totalMinutes };
}

/**
 * Ensure the daily_order_counter table exists (idempotent).
 * Uses adminSql because app_user can't CREATE TABLE.
 */
let counterTableReady = false;
async function ensureCounterTable() {
  if (counterTableReady) return;
  await adminSql.unsafe(`
    CREATE TABLE IF NOT EXISTS daily_order_counter (
      tenant_id TEXT NOT NULL,
      date_key DATE NOT NULL,
      last_seq INT NOT NULL DEFAULT 0,
      PRIMARY KEY (tenant_id, date_key)
    )
  `);
  // Grant access to app_user for the counter table
  await adminSql.unsafe(`GRANT SELECT, INSERT, UPDATE ON daily_order_counter TO app_user`).catch(() => {});
  counterTableReady = true;
}

/**
 * Generate a unique order number and insert the order atomically.
 *
 * Uses a counter table with ON CONFLICT DO UPDATE — a single atomic
 * statement that serializes on the PK, so no two concurrent requests
 * can ever get the same sequence number.
 */
async function insertOrderWithNumber(conn, {
  employee_id, subtotal, tax, total, offline_temp_id, tenantId, tenantTz,
  discount_amount = 0, discount_type = null, discount_reason = null, discount_authorized_by = null,
  order_fulfillment_type = 'to_go',
  customer_call_name = null,
}) {
  await ensureCounterTable();

  // date_key follows the merchant's local day, not UTC — otherwise the daily
  // sequence in Mexico City rolls over at 6pm local instead of midnight and
  // owners see order #YYYYMMDD001 dated to tomorrow before they close.
  const dateStr = tzDate(new Date(), tenantTz);
  const datePrefix = parseInt(dateStr.replace(/-/g, '')) * 1000;
  const tid = tenantId || 'default';

  // Atomic increment — ON CONFLICT serializes on the PK
  const [counter] = await conn.unsafe(`
    INSERT INTO daily_order_counter (tenant_id, date_key, last_seq)
    VALUES ($1, $2::date, 1)
    ON CONFLICT (tenant_id, date_key) DO UPDATE SET last_seq = daily_order_counter.last_seq + 1
    RETURNING last_seq
  `, [tid, dateStr]);

  const orderNumber = datePrefix + counter.last_seq;

  // Validate fulfillment type — kiosk uses this same enum, and unknown
  // values should fall back to 'to_go' rather than corrupt the row.
  const fulfillment = order_fulfillment_type === 'for_here' ? 'for_here' : 'to_go';

  const [inserted] = await conn.unsafe(`
    INSERT INTO orders (
      tenant_id, order_number, employee_id, status, subtotal, tax, total,
      payment_status, offline_temp_id,
      discount_amount, discount_type, discount_reason, discount_authorized_by,
      order_fulfillment_type, customer_call_name
    )
    VALUES ($1, $2, $3, 'active', $4, $5, $6, 'unpaid', $7, $8, $9, $10, $11, $12, $13)
    RETURNING id, order_number
  `, [
    tid, orderNumber, employee_id, subtotal, tax, total, offline_temp_id || null,
    discount_amount, discount_type, discount_reason, discount_authorized_by,
    fulfillment, customer_call_name,
  ]);

  return { orderId: inserted.id, orderNumber: inserted.order_number };
}

/**
 * Verify the actor (or their manager-approver) is authorized to apply a discount.
 * Returns the authorizing employee_id, or throws an Error with .status set.
 */
async function authorizeDiscount({ actorEmployee, authorizedByEmployeeId }) {
  // Actor has permission directly
  const actorPerm = await get(
    'SELECT granted FROM role_permissions WHERE role = $1 AND permission = $2',
    [actorEmployee.role, 'apply_discounts']
  );
  if (actorPerm?.granted) return actorEmployee.id;

  // Otherwise an approver must have been supplied (set by /manager-approve)
  if (!authorizedByEmployeeId) {
    const err = new Error('Manager approval required to apply discount');
    err.status = 403;
    throw err;
  }

  const approver = await get(
    'SELECT id, role, active FROM employees WHERE id = $1',
    [authorizedByEmployeeId]
  );
  if (!approver || !approver.active) {
    const err = new Error('Invalid approver');
    err.status = 403;
    throw err;
  }
  const approverPerm = await get(
    'SELECT granted FROM role_permissions WHERE role = $1 AND permission = $2',
    [approver.role, 'apply_discounts']
  );
  if (!approverPerm?.granted) {
    const err = new Error('Approver lacks apply_discounts permission');
    err.status = 403;
    throw err;
  }
  return approver.id;
}

/**
 * Resolve a discount payload to an absolute dollar amount, capped at the line/order base.
 * Discount payload: { type: 'percent'|'amount'|'comp', value: number, reason: string, authorized_by_employee_id?: number }
 */
function resolveDiscountAmount(discount, base) {
  if (!discount) return 0;
  const baseRounded = Math.round(base * 100) / 100;
  if (discount.type === 'comp') return baseRounded;
  if (discount.type === 'percent') {
    const pct = Math.max(0, Math.min(100, Number(discount.value) || 0));
    return Math.round(baseRounded * (pct / 100) * 100) / 100;
  }
  if (discount.type === 'amount') {
    const amt = Math.max(0, Number(discount.value) || 0);
    return Math.min(baseRounded, Math.round(amt * 100) / 100);
  }
  return 0;
}

// GET /api/orders - list orders (optional ?status, ?date filters)
router.get('/', async (req, res) => {
  try {
    const { status, date, payment_status } = req.query;
    let query = `
      SELECT o.id, o.order_number, o.employee_id, o.status, o.subtotal, o.tax, o.tip, o.total,
             o.payment_status, o.payment_method, o.paid_at, o.source, o.order_fulfillment_type, o.created_at,
             o.loyalty_customer_id, e.name as employee_name,
             COALESCE(c.name, o.customer_call_name) as customer_name
      FROM orders o
      JOIN employees e ON o.employee_id = e.id
      LEFT JOIN loyalty_customers c ON c.id = o.loyalty_customer_id
      WHERE 1=1
    `;
    const params = [];
    let paramIdx = 1;

    if (status) {
      query += ` AND o.status = $${paramIdx++}`;
      params.push(status);
    }

    if (payment_status === 'unpaid') {
      // "unpaid" here means "needs payment" — matches isPaid() on the client
      // (src/lib/orderUrgency.ts). Covers pending_terminal (stranded kiosk
      // terminal), pending_oxxo, pending_spei, pending, failed, and NULL —
      // without these, kiosk orders showing as COBRAR on /pos would vanish
      // from admin/orders?lane=unpaid.
      query += ` AND (o.payment_status IS NULL OR o.payment_status NOT IN ('paid', 'completed'))`;
    } else if (payment_status) {
      query += ` AND o.payment_status = $${paramIdx++}`;
      params.push(payment_status);
    }

    if (date) {
      query += ` AND o.created_at::date = $${paramIdx++}`;
      params.push(date);
    }

    query += ' ORDER BY o.created_at DESC LIMIT 100';

    const orders = await all(query, params);
    res.json(orders);
  } catch (error) {
    console.error('Error fetching orders:', error);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// GET /api/orders/kiosk-held - orders waiting for cashier intervention:
//   - status='draft_kiosk' → customer chose "pay at register" on the kiosk
//   - payment_status='pending_terminal' older than 3 minutes → terminal flow
//     stalled (likely terminal offline or customer walked away); cashier needs
//     to rescue manually so the order doesn't get orphaned.
router.get('/kiosk-held', requireAuth('pos_access'), async (req, res) => {
  try {
    const orders = await all(`
      SELECT o.id, o.order_number, o.total, o.created_at,
             o.loyalty_customer_id, o.status, o.payment_status,
             CASE
               WHEN o.status = 'draft_kiosk' THEN 'held'
               ELSE 'stranded_terminal'
             END AS kind,
             COALESCE(c.name, o.customer_call_name) AS customer_name, c.phone AS customer_phone,
             COALESCE(
               (SELECT json_agg(json_build_object(
                 'menu_item_id', oi.menu_item_id,
                 'item_name', oi.item_name,
                 'quantity', oi.quantity,
                 'unit_price', oi.unit_price,
                 'modifiers', COALESCE(
                   (SELECT json_agg(json_build_object(
                     'id', oim.modifier_id,
                     'name', oim.modifier_name,
                     'price_adjustment', oim.price_adjustment
                   ) ORDER BY oim.id)
                    FROM order_item_modifiers oim
                    WHERE oim.order_item_id = oi.id),
                   '[]'::json
                 )
               ) ORDER BY oi.id)
                FROM order_items oi
                WHERE oi.order_id = o.id),
               '[]'::json
             ) AS items
      FROM orders o
      LEFT JOIN loyalty_customers c ON c.id = o.loyalty_customer_id
      WHERE o.source = 'customer_kiosk'
        AND (
          o.status = 'draft_kiosk'
          OR (
            o.status IN ('pending', 'active')
            AND o.payment_status = 'pending_terminal'
            AND o.created_at < NOW() - INTERVAL '3 minutes'
          )
        )
      ORDER BY o.created_at DESC
      LIMIT 50
    `);
    res.json(orders);
  } catch (error) {
    console.error('Error fetching kiosk-held orders:', error);
    res.status(500).json({ error: 'Failed to fetch held orders' });
  }
});

// POST /api/orders/:id/claim - cashier pulls a held or stranded kiosk order
// into the register.
//
// For draft_kiosk (cash-at-counter handoff): the held-list response already
// includes the order's items, and the client loads them into the cashier's
// cart. We DROP the draft here — the cashier's normal "Cobrar" path will
// create a single fresh order and fire the KDS once on payment. Promoting
// the draft to 'active' here (the original behavior) fired the KDS ticket
// *before* payment AND duplicated it once the cashier's new order landed.
//
// For stranded_terminal (card payment timed out): the order is real, already
// on the KDS, and the customer is still expecting their food — we keep the
// order and just clear the failed terminal state so the cashier can charge
// fresh (cash or a new swipe).
router.post('/:id/claim', requireAuth('pos_access'), async (req, res) => {
  try {
    const orderId = Number(req.params.id);
    if (!Number.isInteger(orderId)) {
      return res.status(400).json({ error: 'Invalid order id' });
    }
    const employeeId = req.employee?.id;
    if (!employeeId) {
      return res.status(401).json({ error: 'Authenticated employee required' });
    }
    const existing = await get(
      `SELECT id, status, payment_status, source FROM orders WHERE id = $1`,
      [orderId],
    );
    if (!existing) return res.status(404).json({ error: 'Order not found' });

    const isHeld = existing.status === 'draft_kiosk';
    const isStrandedTerminal =
      existing.source === 'customer_kiosk'
      && existing.status === 'pending'
      && existing.payment_status === 'pending_terminal';

    if (!isHeld && !isStrandedTerminal) {
      return res.status(409).json({ error: 'Order is not claimable from kiosk' });
    }

    if (isHeld) {
      // Cascade order children before the order row (FK constraints). Same
      // pattern as DELETE /api/orders/:id. Drafts shouldn't have payments
      // or refunds, but delivery drafts do have a delivery_orders row with
      // pending_dispatch — clear it so we don't dispatch a courier later.
      await run(
        `DELETE FROM order_item_modifiers WHERE order_item_id IN (SELECT id FROM order_items WHERE order_id = $1)`,
        [orderId],
      );
      await run(`DELETE FROM delivery_orders WHERE order_id = $1`, [orderId]);
      await run(`DELETE FROM order_items WHERE order_id = $1`, [orderId]);
      await run(`DELETE FROM orders WHERE id = $1`, [orderId]);
      audit(req, 'order.discarded_from_kiosk_claim', { order_id: orderId });
      return res.json({ id: orderId, status: 'discarded' });
    }

    await run(
      `UPDATE orders
       SET payment_status = 'unpaid', payment_method = NULL, employee_id = $1
       WHERE id = $2`,
      [employeeId, orderId],
    );
    audit(req, 'order.rescued_from_terminal', { order_id: orderId });
    res.json({ id: orderId, status: 'active' });
  } catch (error) {
    console.error('Error claiming kiosk order:', error);
    res.status(500).json({ error: 'Failed to claim order' });
  }
});

// GET /api/orders/today-count - cheap aggregate for the POS header strip.
// Counts orders created today for the current tenant, excluding cancelled.
// RLS scopes by tenant automatically.
router.get('/today-count', async (req, res) => {
  try {
    const row = await get(
      `SELECT COUNT(*)::int AS count
       FROM orders
       WHERE created_at >= CURRENT_DATE
         AND status <> 'cancelled'`
    );
    res.json({ count: row?.count ?? 0 });
  } catch (error) {
    console.error('Error fetching today order count:', error);
    res.status(500).json({ error: 'Failed to fetch today order count' });
  }
});

// GET /api/orders/lookup?q=<query> - tenant-wide search across ALL orders
// (any status, any payment_status, any date) by order_number or customer name.
// Use case: cashier needs to find an order that's fallen off the live strip or
// the 100-row Historial — e.g. a customer comes back the next day claiming
// they paid but it never marked, or a kiosk order that's "missing." Returns
// the same shape as GET /api/orders so the existing UI can render it.
// IMPORTANT: must be declared before the '/:id' route to avoid being matched
// as an order id.
router.get('/lookup', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json([]);
    const like = `%${q}%`;
    const orders = await all(`
      SELECT o.id, o.order_number, o.employee_id, o.status, o.subtotal, o.tax, o.tip, o.total,
             o.payment_status, o.payment_method, o.paid_at, o.source, o.order_fulfillment_type, o.created_at,
             o.loyalty_customer_id, e.name as employee_name,
             COALESCE(c.name, o.customer_call_name) as customer_name
      FROM orders o
      JOIN employees e ON o.employee_id = e.id
      LEFT JOIN loyalty_customers c ON c.id = o.loyalty_customer_id
      WHERE CAST(o.order_number AS TEXT) ILIKE $1
         OR COALESCE(c.name, '') ILIKE $1
         OR COALESCE(o.customer_call_name, '') ILIKE $1
      ORDER BY o.created_at DESC
      LIMIT 25
    `, [like]);
    res.json(orders);
  } catch (error) {
    console.error('Error looking up orders:', error);
    res.status(500).json({ error: 'Failed to lookup orders' });
  }
});

// GET /api/orders/:id - single order with items
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const order = await get(`
      SELECT o.id, o.order_number, o.employee_id, o.status, o.subtotal, o.tax, o.tip, o.total,
             o.payment_intent_id, o.payment_status, o.payment_method, o.source, o.created_at, o.completed_at,
             o.discount_amount, o.discount_type, o.discount_reason, o.discount_authorized_by,
             e.name as employee_name
      FROM orders o
      JOIN employees e ON o.employee_id = e.id
      WHERE o.id = $1
    `, [id]);

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const items = await all(`
      SELECT oi.id, oi.order_id, oi.menu_item_id, oi.item_name, oi.quantity, oi.unit_price, oi.notes, oi.combo_instance_id,
             oi.discount_amount, oi.discount_type, oi.discount_reason, oi.discount_authorized_by,
             oi.added_at, oi.voided_at, oi.void_reason, oi.qty_changed_at, oi.original_quantity,
             oim.id AS mod_id, oim.modifier_id, oim.modifier_name, oim.price_adjustment
      FROM order_items oi
      LEFT JOIN order_item_modifiers oim ON oim.order_item_id = oi.id
      WHERE oi.order_id = $1
    `, [id]);

    // Assemble items with modifiers from flat rows
    const itemMap = new Map();
    for (const row of items) {
      if (!itemMap.has(row.id)) {
        itemMap.set(row.id, {
          id: row.id, order_id: row.order_id, menu_item_id: row.menu_item_id,
          item_name: row.item_name, quantity: row.quantity, unit_price: row.unit_price,
          notes: row.notes, combo_instance_id: row.combo_instance_id,
          discount_amount: row.discount_amount, discount_type: row.discount_type,
          discount_reason: row.discount_reason, discount_authorized_by: row.discount_authorized_by,
          added_at: row.added_at, voided_at: row.voided_at, void_reason: row.void_reason,
          qty_changed_at: row.qty_changed_at, original_quantity: row.original_quantity,
          modifiers: [],
        });
      }
      if (row.mod_id) {
        itemMap.get(row.id).modifiers.push({
          id: row.mod_id, modifier_id: row.modifier_id,
          modifier_name: row.modifier_name, price_adjustment: row.price_adjustment,
        });
      }
    }

    res.json({ ...order, items: [...itemMap.values()] });
  } catch (error) {
    console.error('Error fetching order:', error);
    res.status(500).json({ error: 'Failed to fetch order' });
  }
});

async function fetchExistingByOfflineTempId(offline_temp_id) {
  const existing = await get(`
    SELECT o.id, o.order_number, o.employee_id, o.status, o.subtotal, o.tax, o.tip, o.total,
           o.payment_status, o.payment_method, o.source, o.created_at
    FROM orders o WHERE o.offline_temp_id = $1
  `, [offline_temp_id]);
  if (!existing) return null;
  const existingItems = await all(`
    SELECT id, order_id, menu_item_id, item_name, quantity, unit_price, notes, combo_instance_id
    FROM order_items WHERE order_id = $1
  `, [existing.id]);
  return { ...existing, items: existingItems };
}

/**
 * Core order creation: validates input, resolves items/modifiers/discounts,
 * inserts the order + child rows, and returns the response payload.
 *
 * Used by POST /api/orders and POST /api/orders/sync. Both run inside the
 * tenant middleware's BEGIN/COMMIT, so any throw causes a full rollback.
 *
 * Returns { status: 'created', body } for a new order, or
 * { status: 'duplicate', body } when offline_temp_id already exists.
 */
async function buildOrderFromRequest(req) {
  const { employee_id, items, offline_temp_id, discount: orderDiscount, order_fulfillment_type } = req.body;
  // Cashier-entered "Juan", "Mesa 3", "Pickup Order" — short label that fronts the
  // KDS ticket and the admin/orders board so staff can find the order at a glance.
  // Falls back to NULL when blank so the COALESCE chain (loyalty → call_name →
  // delivery customer) still resolves cleanly.
  const rawCallName = req.body?.customer_call_name;
  const customer_call_name = typeof rawCallName === 'string' && rawCallName.trim()
    ? rawCallName.trim().slice(0, 60)
    : null;

  if (!employee_id || !items || items.length === 0) {
    const err = new Error('Missing required fields');
    err.status = 400;
    throw err;
  }

  // Idempotent dedup: if offline_temp_id already exists, return existing order.
  // The unique index on (tenant_id, offline_temp_id) also guards against the
  // race where two concurrent requests both pass this SELECT — the second
  // INSERT will hit 23505 and we recover below.
  if (offline_temp_id) {
    const existing = await fetchExistingByOfflineTempId(offline_temp_id);
    if (existing) return { status: 'duplicate', body: existing };
  }

  // Validate item quantities
  for (const item of items) {
    if (!item.quantity || item.quantity <= 0) {
      const err = new Error(`Invalid quantity for item ${item.menu_item_id}. Quantity must be greater than 0.`);
      err.status = 400;
      throw err;
    }
  }

  // Verify employee exists
  const employee = await get('SELECT id FROM employees WHERE id = $1', [employee_id]);
  if (!employee) {
    const err = new Error('Employee not found');
    err.status = 404;
    throw err;
  }

  // Calculate totals (prices include IVA)
  let itemsTotal = 0;
  const orderItems = [];

  // Batched prefetch: collect every menu_item / modifier / brand-pair we need
  // and resolve them in three queries up front. Replaces an N+1 inside the
  // per-item loop that, for an 8-item × 4-modifier order, ran 41+ sequential
  // SELECTs inside the held tenant connection.
  const menuItemIds = [...new Set(items.map((i) => i.menu_item_id))];
  const modifierIds = [...new Set(items.flatMap((i) => i.modifiers || []))];
  const brandPairs = items.filter((i) => i.virtual_brand_id);

  const menuItemRows = menuItemIds.length
    ? await all('SELECT id, name, price FROM menu_items WHERE id = ANY($1::int[])', [menuItemIds])
    : [];
  const menuItemMap = new Map(menuItemRows.map((r) => [r.id, r]));

  const modifierRows = modifierIds.length
    ? await all('SELECT id, name, price_adjustment FROM modifiers WHERE id = ANY($1::int[])', [modifierIds])
    : [];
  const modifierMap = new Map(modifierRows.map((r) => [r.id, r]));

  const brandKey = (vbId, miId) => `${vbId}:${miId}`;
  let brandMap = new Map();
  if (brandPairs.length > 0) {
    const vbIds = brandPairs.map((i) => i.virtual_brand_id);
    const miIds = brandPairs.map((i) => i.menu_item_id);
    const brandRows = await all(
      `SELECT vbi.virtual_brand_id, vbi.menu_item_id, vbi.custom_name, vbi.custom_price
       FROM virtual_brand_items vbi
       JOIN unnest($1::int[], $2::int[]) AS pairs(vb_id, mi_id)
         ON vbi.virtual_brand_id = pairs.vb_id AND vbi.menu_item_id = pairs.mi_id`,
      [vbIds, miIds]
    );
    brandMap = new Map(brandRows.map((r) => [brandKey(r.virtual_brand_id, r.menu_item_id), r]));
  }

  for (const item of items) {
    const menuItem = menuItemMap.get(item.menu_item_id);
    if (!menuItem) {
      const err = new Error(`Menu item ${item.menu_item_id} not found`);
      err.status = 404;
      throw err;
    }

    // Calculate modifier price adjustments
    let modifierTotal = 0;
    const resolvedModifiers = [];
    if (item.modifiers && item.modifiers.length > 0) {
      for (const modId of item.modifiers) {
        const mod = modifierMap.get(modId);
        if (mod) {
          modifierTotal += Number(mod.price_adjustment);
          resolvedModifiers.push(mod);
        }
      }
    }

    // Resolve brand-specific name/price if virtual_brand_id present
    let itemName = menuItem.name;
    let basePrice = Number(menuItem.price);
    const virtualBrandId = item.virtual_brand_id || null;

    if (virtualBrandId) {
      const brandItem = brandMap.get(brandKey(virtualBrandId, item.menu_item_id));
      if (brandItem) {
        if (brandItem.custom_name) itemName = brandItem.custom_name;
        if (brandItem.custom_price != null) basePrice = Number(brandItem.custom_price);
      }
    }

    const unitPrice = basePrice + modifierTotal;
    const lineBase = unitPrice * item.quantity;

    // Per-line discount
    let lineDiscountAmount = 0;
    let lineDiscountType = null;
    let lineDiscountReason = null;
    if (item.discount) {
      lineDiscountAmount = resolveDiscountAmount(item.discount, lineBase);
      lineDiscountType = item.discount.type;
      lineDiscountReason = item.discount.reason || null;
    }

    const lineTotal = lineBase - lineDiscountAmount;
    itemsTotal += lineTotal;

    orderItems.push({
      menu_item_id: item.menu_item_id,
      item_name: itemName,
      quantity: item.quantity,
      unit_price: unitPrice,
      notes: item.notes || null,
      combo_instance_id: item.combo_instance_id || null,
      modifiers: resolvedModifiers,
      virtual_brand_id: virtualBrandId,
      discount_amount: lineDiscountAmount,
      discount_type: lineDiscountType,
      discount_reason: lineDiscountReason,
      _lineHasDiscount: lineDiscountAmount > 0,
    });
  }

  // Order-level discount applied on top of line-level discounts
  const orderDiscountAmount = resolveDiscountAmount(orderDiscount, itemsTotal);
  const total = Math.round((itemsTotal - orderDiscountAmount) * 100) / 100;

  // Authorize discounts (line-level or order-level)
  const anyLineDiscount = orderItems.some((it) => it._lineHasDiscount);
  let lineAuthorizedBy = null;
  let orderAuthorizedBy = null;
  if (anyLineDiscount) {
    lineAuthorizedBy = await authorizeDiscount({
      actorEmployee: req.employee,
      authorizedByEmployeeId: items.find((i) => i.discount)?.discount?.authorized_by_employee_id || null,
    });
  }
  if (orderDiscountAmount > 0) {
    orderAuthorizedBy = await authorizeDiscount({
      actorEmployee: req.employee,
      authorizedByEmployeeId: orderDiscount?.authorized_by_employee_id || null,
    });
  }

  // Prices already include IVA — extract tax from the total
  const tax = Math.round((total - total / (1 + TAX_RATE)) * 100) / 100;
  const subtotal = Math.round((total - tax) * 100) / 100;

  // Atomic order number generation + insert. Two concurrent requests with the
  // same offline_temp_id can both pass the dedup SELECT above; the unique
  // index then rejects the second INSERT with 23505. Wrap in a SAVEPOINT so
  // we can recover — otherwise the outer transaction (set up by the tenant
  // middleware) is poisoned and any subsequent SELECT also fails.
  const conn = getConn();
  let orderId, orderNumber;
  await conn.unsafe('SAVEPOINT order_insert');
  try {
    ({ orderId, orderNumber } = await insertOrderWithNumber(conn, {
      employee_id, subtotal, tax, total, offline_temp_id,
      tenantId: req.tenant?.id,
      tenantTz: req.tenant?.timezone,
      discount_amount: orderDiscountAmount,
      discount_type: orderDiscountAmount > 0 ? (orderDiscount?.type || null) : null,
      discount_reason: orderDiscountAmount > 0 ? (orderDiscount?.reason || null) : null,
      discount_authorized_by: orderAuthorizedBy,
      order_fulfillment_type,
      customer_call_name,
    }));
    await conn.unsafe('RELEASE SAVEPOINT order_insert');
  } catch (err) {
    await conn.unsafe('ROLLBACK TO SAVEPOINT order_insert').catch(() => {});
    if (err.code === '23505' && offline_temp_id) {
      const existing = await fetchExistingByOfflineTempId(offline_temp_id);
      if (existing) return { status: 'duplicate', body: existing };
    }
    throw err;
  }

  // Calculate estimated prep time
  const itemMenuIds = orderItems.map(i => i.menu_item_id);
  const prepEstimate = await estimatePrepTime(conn, itemMenuIds, req.tenant?.id);
  await conn.unsafe(
    `UPDATE orders SET estimated_ready_minutes = $1 WHERE id = $2`,
    [prepEstimate.estimate, orderId]
  );

  // Batch insert all order items (1 query instead of N)
  const tenantId = req.tenant?.id || null;
  const itemColCount = 13;
  const itemValues = orderItems.map((_, i) => {
    const o = i * itemColCount;
    return `($${o+1},$${o+2},$${o+3},$${o+4},$${o+5},$${o+6},$${o+7},$${o+8},$${o+9},$${o+10},$${o+11},$${o+12},$${o+13})`;
  }).join(',');
  const itemParams = orderItems.flatMap(item => [
    tenantId, orderId, item.menu_item_id, item.item_name,
    item.quantity, item.unit_price, item.notes, item.combo_instance_id, item.virtual_brand_id || null,
    item.discount_amount || 0,
    item.discount_type,
    item.discount_reason,
    item._lineHasDiscount ? lineAuthorizedBy : null,
  ]);

  const insertedItems = await conn.unsafe(`
    INSERT INTO order_items (
      tenant_id, order_id, menu_item_id, item_name, quantity, unit_price,
      notes, combo_instance_id, virtual_brand_id,
      discount_amount, discount_type, discount_reason, discount_authorized_by
    )
    VALUES ${itemValues}
    RETURNING id
  `, itemParams);

  // Correlate by index — Postgres preserves VALUES order in RETURNING
  for (let i = 0; i < orderItems.length; i++) {
    orderItems[i]._orderItemId = insertedItems[i].id;
  }

  // Batch insert all modifiers (1 query instead of M)
  const allMods = orderItems.flatMap(item =>
    (item.modifiers || []).map(mod => ({
      orderItemId: item._orderItemId,
      id: mod.id,
      name: mod.name,
      price_adjustment: mod.price_adjustment,
    }))
  );

  if (allMods.length > 0) {
    const modColCount = 5;
    const modValues = allMods.map((_, i) => {
      const o = i * modColCount;
      return `($${o+1},$${o+2},$${o+3},$${o+4},$${o+5})`;
    }).join(',');
    const modParams = allMods.flatMap(m => [
      tenantId, m.orderItemId, m.id, m.name, m.price_adjustment,
    ]);
    await conn.unsafe(`
      INSERT INTO order_item_modifiers (tenant_id, order_item_id, modifier_id, modifier_name, price_adjustment)
      VALUES ${modValues}
    `, modParams);
  }

  // Fire-and-forget: record item pairs for AI analysis
  setImmediate(() => recordOrderItemPairs(orderId, tenantId));

  audit({
    tenantId: req.tenant?.id || 'default',
    actorType: 'employee',
    actorId: String(employee_id),
    action: 'create',
    resource: 'order',
    resourceId: String(orderId),
    ip: req.ip,
  });

  return {
    status: 'created',
    body: {
      id: orderId,
      order_number: orderNumber,
      employee_id,
      status: 'pending',
      subtotal,
      tax,
      tip: 0,
      total,
      payment_status: 'unpaid',
      items: orderItems,
      discount_amount: orderDiscountAmount,
      discount_type: orderDiscountAmount > 0 ? (orderDiscount?.type || null) : null,
      discount_reason: orderDiscountAmount > 0 ? (orderDiscount?.reason || null) : null,
      discount_authorized_by: orderAuthorizedBy,
      estimated_ready_minutes: prepEstimate.estimate,
      estimated_ready_range: { low: prepEstimate.low, high: prepEstimate.high },
    },
  };
}

function handleOrderError(error, res) {
  if (error?.status) {
    return res.status(error.status).json({ error: error.message });
  }
  console.error('Error creating order:', error);
  return res.status(500).json({ error: 'Failed to create order' });
}

// POST /api/orders - create order
router.post('/', orderCreateLimiter, requireAuth('pos_access'), async (req, res) => {
  try {
    const result = await buildOrderFromRequest(req);
    const status = result.status === 'duplicate' ? 200 : 201;
    res.status(status).json(result.body);
  } catch (error) {
    handleOrderError(error, res);
  }
});

// POST /api/orders/sync — atomic offline sync: create order + cash payment
// in one transaction. Replaces the two-call createOrder + cashPayment flow
// that could leave an unpaid orphan if the second request failed.
router.post('/sync', orderCreateLimiter, requireAuth('pos_access'), async (req, res) => {
  try {
    const { tip = 0, amount_received = 0 } = req.body || {};
    if (typeof tip !== 'number' || tip < 0) {
      return res.status(400).json({ error: 'Invalid tip' });
    }

    const result = await buildOrderFromRequest(req);

    // If we returned the existing dupe, don't double-pay it. The caller
    // already saw 'synced' from the prior attempt; surface what we have.
    if (result.status === 'duplicate') {
      return res.status(200).json(result.body);
    }

    const orderId = result.body.id;
    const conn = getConn();
    const finalTotal = Number(result.body.total) + Number(tip);
    const changeDue = amount_received > 0 ? Math.max(0, amount_received - finalTotal) : 0;

    await conn.unsafe(`
      UPDATE orders
      SET payment_status = 'paid',
          status = 'active',
          payment_method = 'cash',
          tip = $1,
          paid_at = NOW()
      WHERE id = $2
    `, [Number(tip), orderId]);

    res.status(201).json({
      ...result.body,
      tip: Number(tip),
      total: Math.round(finalTotal * 100) / 100,
      payment_status: 'paid',
      payment_method: 'cash',
      status: 'preparing',
      change_due: Math.round(changeDue * 100) / 100,
    });
  } catch (error) {
    handleOrderError(error, res);
  }
});

// PUT /api/orders/:id/status - update status
router.put('/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const validStatuses = ['pending', 'confirmed', 'preparing', 'active', 'ready', 'completed', 'cancelled'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const order = await get(
      'SELECT id, status, source, payment_status FROM orders WHERE id = $1',
      [id]
    );
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // 'active' is the canonical in-flight status. pending/confirmed/preparing
    // are accepted as input from older deployed clients and treated as
    // equivalent to 'active'. All four can transition straight to ready.
    const validTransitions = {
      active:     ['ready', 'cancelled'],
      pending:    ['confirmed', 'preparing', 'active', 'ready', 'cancelled'],
      confirmed:  ['preparing', 'active', 'ready', 'cancelled'],
      preparing:  ['active', 'ready', 'cancelled'],
      ready:      ['completed', 'cancelled'],
      // Kiosk "pay at register" hold — cashier can cancel without claiming.
      draft_kiosk: ['active', 'cancelled'],
      completed:  [],
      cancelled:  [],
    };

    const allowed = validTransitions[order.status] || [];
    if (!allowed.includes(status)) {
      return res.status(400).json({
        error: `Cannot transition from '${order.status}' to '${status}'`,
      });
    }

    // Block completion of unpaid POS orders. Today (2026-06-24) three orders
    // shipped food and got marked completed while the MP terminal had charged
    // the card off-flow — pos-lite never saw the payment. Force a Cobrar
    // step before a register order can leave the open-orders strip.
    if (
      status === 'completed' &&
      order.source === 'pos' &&
      order.payment_status !== 'paid' &&
      order.payment_status !== 'comped' &&
      order.payment_status !== 'refunded'
    ) {
      return res.status(409).json({
        error: 'unpaid_order',
        message: 'Cobra el pedido antes de completarlo.',
      });
    }

    const now = new Date().toISOString();
    const completedAt = status === 'completed' ? now : null;
    const readyAt = status === 'ready' ? now : null;

    if (readyAt) {
      await run(`
        UPDATE orders
        SET status = $1, completed_at = $2, ready_at = $3
        WHERE id = $4
      `, [status, completedAt, readyAt, id]);
    } else {
      await run(`
        UPDATE orders
        SET status = $1, completed_at = $2
        WHERE id = $3
      `, [status, completedAt, id]);
    }

    if (status === 'ready') {
      await notifyKioskOrderReady(id, req.tenant?.name || req.tenant?.subdomain || 'Tu restaurante');
    }

    res.json({ id, status });
  } catch (error) {
    console.error('Error updating order status:', error);
    res.status(500).json({ error: 'Failed to update order status' });
  }
});

// GET /api/orders/kitchen/active - get active orders for kitchen display.
// Pass ?include_ready=1 to also include 'ready' orders (cashier order board).
router.get('/kitchen/active', async (req, res) => {
  try {
    // Stamp first_kds_seen_at on any active orders the KDS hasn't seen yet.
    // Single UPDATE — costs effectively nothing once the index is warm,
    // and gives us the audit trail to answer "did the kitchen see X?"
    await run(`
      UPDATE orders
      SET first_kds_seen_at = NOW()
      WHERE status IN ('pending', 'confirmed', 'preparing', 'active')
        AND first_kds_seen_at IS NULL
    `);

    const includeReady = req.query.include_ready === '1' || req.query.include_ready === 'true';
    // 'active' is the canonical in-flight status post-collapse; the others are
    // included so unmigrated rows or older clients still surface on the KDS.
    const statuses = includeReady
      ? ['pending', 'confirmed', 'preparing', 'active', 'ready']
      : ['pending', 'confirmed', 'preparing', 'active'];

    // Single query: fetch orders + items + modifiers in one round trip.
    // Customer name resolution order: loyalty customer → kiosk/QR call-name →
    // delivery platform customer name (Uber/Rappi/DiDi). Same field powers
    // both the KDS ticket header and the cashier's live-orders strip.
    const rows = await all(`
      SELECT o.id AS order_id, o.order_number, o.status, o.payment_method, o.source, o.order_fulfillment_type, o.created_at,
             o.estimated_ready_minutes, o.table_number, o.first_kds_seen_at, o.payment_status, o.paid_at, o.total,
             e.name AS employee_name,
             COALESCE(lc.name, o.customer_call_name, do_row.customer_name) AS customer_name,
             dp.name AS delivery_platform,
             do_row.tracking_url AS tracking_url,
             oi.id AS item_id, oi.item_name, oi.quantity, oi.notes, oi.combo_instance_id,
             oi.virtual_brand_id, vb.name AS brand_name, vb.primary_color AS brand_color,
             oi.added_at, oi.voided_at, oi.void_reason, oi.qty_changed_at, oi.original_quantity,
             oim.modifier_name, oim.price_adjustment
      FROM orders o
      JOIN employees e ON o.employee_id = e.id
      LEFT JOIN loyalty_customers lc ON lc.id = o.loyalty_customer_id
      LEFT JOIN delivery_orders do_row ON do_row.order_id = o.id
      LEFT JOIN delivery_platforms dp ON dp.id = do_row.platform_id
      LEFT JOIN order_items oi ON oi.order_id = o.id
        -- Drop voided items from KDS after 90s so kitchen sees the strike
        -- briefly then it disappears, instead of cluttering forever.
        AND (oi.voided_at IS NULL OR oi.voided_at > NOW() - INTERVAL '90 seconds')
      LEFT JOIN virtual_brands vb ON oi.virtual_brand_id = vb.id
      LEFT JOIN order_item_modifiers oim ON oim.order_item_id = oi.id
      WHERE o.status = ANY($1::text[])
      ORDER BY o.created_at ASC, oi.id ASC
    `, [statuses]);

    // Assemble nested structure from flat rows
    const orderMap = new Map();
    for (const row of rows) {
      if (!orderMap.has(row.order_id)) {
        orderMap.set(row.order_id, {
          id: row.order_id,
          order_number: row.order_number,
          status: row.status,
          payment_method: row.payment_method,
          payment_status: row.payment_status,
          paid_at: row.paid_at,
          total: row.total,
          source: row.source,
          order_fulfillment_type: row.order_fulfillment_type,
          created_at: row.created_at,
          estimated_ready_minutes: row.estimated_ready_minutes,
          table_number: row.table_number,
          first_kds_seen_at: row.first_kds_seen_at,
          employee_name: row.employee_name,
          customer_name: row.customer_name,
          delivery_platform: row.delivery_platform,
          tracking_url: row.tracking_url,
          items: new Map(),
        });
      }
      const order = orderMap.get(row.order_id);

      if (row.item_id && !order.items.has(row.item_id)) {
        order.items.set(row.item_id, {
          id: row.item_id,
          item_name: row.item_name,
          quantity: row.quantity,
          notes: row.notes,
          combo_instance_id: row.combo_instance_id,
          virtual_brand_id: row.virtual_brand_id,
          brand_name: row.brand_name,
          brand_color: row.brand_color,
          added_at: row.added_at,
          voided_at: row.voided_at,
          void_reason: row.void_reason,
          qty_changed_at: row.qty_changed_at,
          original_quantity: row.original_quantity,
          modifiers: [],
        });
      }

      if (row.item_id && row.modifier_name) {
        order.items.get(row.item_id).modifiers.push({
          modifier_name: row.modifier_name,
          price_adjustment: row.price_adjustment,
        });
      }
    }

    // Convert Maps to arrays
    const result = [];
    for (const order of orderMap.values()) {
      result.push({ ...order, items: [...order.items.values()] });
    }

    res.json(result);
  } catch (error) {
    console.error('Error fetching kitchen orders:', error);
    res.status(500).json({ error: 'Failed to fetch kitchen orders' });
  }
});

// PATCH /api/orders/:id/payment - confirm payment on an existing order
router.patch('/:id/payment', requireAuth('pos_access'), async (req, res) => {
  try {
    const { id } = req.params;
    const { payment_method, reference } = req.body;

    const validMethods = ['cash', 'card', 'transfer'];
    if (!validMethods.includes(payment_method)) {
      return res.status(400).json({ error: 'Invalid payment_method. Must be cash, card, or transfer.' });
    }

    const order = await get(
      'SELECT id, status, payment_status, total FROM orders WHERE id = $1',
      [id]
    );

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    if (order.payment_status === 'paid' || order.payment_status === 'completed') {
      return res.status(400).json({ error: 'Order is already paid' });
    }

    const now = new Date().toISOString();

    await run(`
      UPDATE orders
      SET payment_status = 'paid', payment_method = $1, paid_at = $2
      WHERE id = $3
    `, [payment_method, now, id]);

    const updated = await get(`
      SELECT o.id, o.order_number, o.employee_id, o.status, o.subtotal, o.tax, o.tip, o.total,
             o.payment_status, o.payment_method, o.paid_at, o.source, o.created_at, o.completed_at,
             e.name as employee_name
      FROM orders o
      JOIN employees e ON o.employee_id = e.id
      WHERE o.id = $1
    `, [id]);

    res.json({ success: true, order: updated });
  } catch (error) {
    console.error('Error confirming payment:', error);
    res.status(500).json({ error: 'Failed to confirm payment' });
  }
});

// POST /api/orders/:id/sms-receipt — send a public receipt link via SMS,
// and optionally enroll the customer in loyalty + award a stamp for this order.
router.post('/:id/sms-receipt', requireAuth('pos_access'), async (req, res) => {
  try {
    const { id } = req.params;
    const {
      phone,
      country_code = 'MX',
      enroll_loyalty = false,
      customer_name = '',
    } = req.body || {};

    if (!phone || typeof phone !== 'string') {
      return res.status(400).json({ error: 'phone is required' });
    }

    const tenantId = req.tenant?.id;
    if (!tenantId) {
      return res.status(400).json({ error: 'Tenant not resolved' });
    }

    const order = await get(
      'SELECT id, order_number, total, payment_status, loyalty_customer_id FROM orders WHERE id = $1',
      [id],
    );
    if (!order) return res.status(404).json({ error: 'Order not found' });

    // Loyalty enrollment + stamp (skipped if already stamped on this order).
    let loyaltyResult = null;
    if (enroll_loyalty && !order.loyalty_customer_id) {
      const restaurantName = req.tenant?.name || 'us';
      try {
        const { customer } = await findOrCreateCustomer(
          phone,
          (customer_name || '').trim() || 'Cliente',
          null,
          true,
          restaurantName,
          country_code,
          { sendWelcomeSms: false },
        );
        const stampOutcome = await addStampsForOrder(customer.id, order.id, null, restaurantName, { sendSms: false });
        loyaltyResult = {
          customer_id: customer.id,
          stamps_earned: stampOutcome.stampCard?.stamps_earned,
          stamps_required: stampOutcome.stampCard?.stamps_required,
          card_completed: stampOutcome.cardCompleted,
          referral_code: customer.referral_code,
        };
      } catch (err) {
        console.error('[sms-receipt] loyalty enrollment failed (continuing with receipt):', err.message);
      }
    }

    // Reuse an unexpired token for this order so re-sends don't pile up rows.
    let tokenRow = await adminSql`
      SELECT token FROM receipt_tokens
      WHERE order_id = ${order.id} AND tenant_id = ${tenantId} AND expires_at > NOW()
      ORDER BY id DESC LIMIT 1
    `.then(rows => rows[0]);

    let token;
    if (tokenRow) {
      token = tokenRow.token;
    } else {
      token = crypto.randomBytes(8).toString('hex');
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      await adminSql`
        INSERT INTO receipt_tokens (token, tenant_id, order_id, expires_at)
        VALUES (${token}, ${tenantId}, ${order.id}, ${expiresAt})
      `;
    }

    const host = req.get('host');
    const protocol = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
    const url = `${protocol}://${host}/#/r/${token}`;

    const restaurantName = req.tenant?.name || req.tenant?.subdomain || 'Recibo';
    const totalFormatted = `$${Number(order.total).toFixed(2)} MXN`;

    const sid = loyaltyResult
      ? await sendReceiptLoyaltyMessage(
          phone,
          order.order_number,
          totalFormatted,
          url,
          {
            customerId: loyaltyResult.customer_id,
            stampsEarned: loyaltyResult.stamps_earned,
            stampsRequired: loyaltyResult.stamps_required,
            cardCompleted: loyaltyResult.card_completed,
            referralCode: loyaltyResult.referral_code,
          },
          restaurantName,
          country_code,
        )
      : await sendReceiptMessage(
          phone,
          order.order_number,
          totalFormatted,
          url,
          restaurantName,
          country_code,
        );

    if (!sid) {
      return res.status(502).json({ error: 'SMS send failed. Check Twilio credentials and try again.' });
    }

    audit({
      tenantId: tenantId,
      actorType: 'employee',
      actorId: req.employee?.id,
      action: 'sms_receipt_sent',
      resource: 'order',
      resourceId: String(order.id),
      details: { phone_last4: phone.slice(-4), enrolled: !!loyaltyResult },
      ip: req.ip,
    });
    res.json({ success: true, token, url, message_sid: sid, loyalty: loyaltyResult });
  } catch (error) {
    console.error('Error sending SMS receipt:', error);
    res.status(500).json({ error: 'Failed to send SMS receipt' });
  }
});

// ---------- Edit-existing-order helpers ----------

// Statuses past which the order is closed and edits are rejected outright.
const EDIT_BLOCKED_STATUSES = new Set(['completed', 'cancelled']);

/**
 * Gate an edit on an already-sent order.
 * - Unpaid: pos_access (already enforced by route middleware) is enough.
 * - Paid:   actor must have void_orders, OR an approver with void_orders
 *           must be supplied (mirrors the discount authorization pattern).
 */
async function authorizeOrderEdit({ actorEmployee, authorizedByEmployeeId, isPaid }) {
  if (!isPaid) return actorEmployee.id;

  const actorPerm = await get(
    'SELECT granted FROM role_permissions WHERE role = $1 AND permission = $2',
    [actorEmployee.role, 'void_orders']
  );
  if (actorPerm?.granted) return actorEmployee.id;

  if (!authorizedByEmployeeId) {
    const err = new Error('Manager approval required to edit a paid order');
    err.status = 403;
    throw err;
  }
  const approver = await get(
    'SELECT id, role, active FROM employees WHERE id = $1',
    [authorizedByEmployeeId]
  );
  if (!approver || !approver.active) {
    const err = new Error('Invalid approver');
    err.status = 403;
    throw err;
  }
  const approverPerm = await get(
    'SELECT granted FROM role_permissions WHERE role = $1 AND permission = $2',
    [approver.role, 'void_orders']
  );
  if (!approverPerm?.granted) {
    const err = new Error('Approver lacks void_orders permission');
    err.status = 403;
    throw err;
  }
  return approver.id;
}

/**
 * Recompute order subtotal/tax/total from the live (non-voided) item rows.
 * Mirrors the IVA-inclusive math used in buildOrderFromRequest. If the new
 * total exceeds what was already paid, flip a paid order to 'partial' so the
 * cashier sees they need to collect the delta via the existing payment flow.
 */
async function recomputeOrderTotals(conn, orderId) {
  const items = await conn.unsafe(`
    SELECT quantity, unit_price, COALESCE(discount_amount, 0) AS discount_amount
    FROM order_items
    WHERE order_id = $1 AND voided_at IS NULL
  `, [orderId]);

  let itemsTotal = 0;
  for (const it of items) {
    itemsTotal += Number(it.unit_price) * it.quantity - Number(it.discount_amount);
  }

  const [order] = await conn.unsafe(
    `SELECT COALESCE(discount_amount, 0) AS order_discount,
            COALESCE(total, 0) AS prev_total,
            payment_status
     FROM orders WHERE id = $1`,
    [orderId]
  );
  const total = Math.max(0, Math.round((itemsTotal - Number(order.order_discount)) * 100) / 100);
  const tax = Math.round((total - total / (1 + TAX_RATE)) * 100) / 100;
  const subtotal = Math.round((total - tax) * 100) / 100;

  let newPaymentStatus = order.payment_status;
  if (order.payment_status === 'paid' && total > Number(order.prev_total)) {
    newPaymentStatus = 'partial';
  }

  await conn.unsafe(
    `UPDATE orders SET subtotal = $1, tax = $2, total = $3, payment_status = $4 WHERE id = $5`,
    [subtotal, tax, total, newPaymentStatus, orderId]
  );

  return { subtotal, tax, total, payment_status: newPaymentStatus, prev_total: Number(order.prev_total) };
}

/**
 * Resolve a single append-item payload to the row shape we insert. Reuses
 * the same modifier/virtual-brand resolution rules as order creation but
 * runs one item at a time — the edit path is low-volume.
 */
async function resolveAppendItem(item, conn) {
  if (!item.quantity || item.quantity <= 0) {
    const err = new Error(`Invalid quantity for item ${item.menu_item_id}`);
    err.status = 400;
    throw err;
  }
  const [menuItem] = await conn.unsafe(
    'SELECT id, name, price FROM menu_items WHERE id = $1',
    [item.menu_item_id]
  );
  if (!menuItem) {
    const err = new Error(`Menu item ${item.menu_item_id} not found`);
    err.status = 404;
    throw err;
  }

  let modifierTotal = 0;
  const resolvedModifiers = [];
  if (item.modifiers && item.modifiers.length > 0) {
    const modRows = await conn.unsafe(
      'SELECT id, name, price_adjustment FROM modifiers WHERE id = ANY($1::int[])',
      [item.modifiers]
    );
    for (const mod of modRows) {
      modifierTotal += Number(mod.price_adjustment);
      resolvedModifiers.push(mod);
    }
  }

  let itemName = menuItem.name;
  let basePrice = Number(menuItem.price);
  const virtualBrandId = item.virtual_brand_id || null;
  if (virtualBrandId) {
    const [brandItem] = await conn.unsafe(
      `SELECT custom_name, custom_price FROM virtual_brand_items
       WHERE virtual_brand_id = $1 AND menu_item_id = $2`,
      [virtualBrandId, item.menu_item_id]
    );
    if (brandItem) {
      if (brandItem.custom_name) itemName = brandItem.custom_name;
      if (brandItem.custom_price != null) basePrice = Number(brandItem.custom_price);
    }
  }

  const unitPrice = basePrice + modifierTotal;
  return {
    menu_item_id: item.menu_item_id,
    item_name: itemName,
    quantity: item.quantity,
    unit_price: unitPrice,
    notes: item.notes || null,
    combo_instance_id: item.combo_instance_id || null,
    virtual_brand_id: virtualBrandId,
    modifiers: resolvedModifiers,
  };
}

// ---------- Edit-existing-order endpoints ----------

// POST /api/orders/:id/items — append items to a sent (non-completed) order.
// Body: { items: [...], authorized_by_employee_id?: number }
router.post('/:id/items', requireAuth('pos_access'), async (req, res) => {
  const { id } = req.params;
  const { items, authorized_by_employee_id } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'items array is required' });
  }

  const conn = getConn();
  try {
    const order = await get(
      'SELECT id, status, payment_status FROM orders WHERE id = $1',
      [id]
    );
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (EDIT_BLOCKED_STATUSES.has(order.status)) {
      return res.status(400).json({ error: `Cannot edit ${order.status} order` });
    }

    const isPaid = order.payment_status === 'paid' || order.payment_status === 'completed';
    const authorizedBy = await authorizeOrderEdit({
      actorEmployee: req.employee,
      authorizedByEmployeeId: authorized_by_employee_id,
      isPaid,
    });

    const tenantId = req.tenant?.id || null;
    const resolved = [];
    for (const raw of items) {
      resolved.push(await resolveAppendItem(raw, conn));
    }

    const insertedIds = [];
    for (const r of resolved) {
      const [row] = await conn.unsafe(`
        INSERT INTO order_items (
          tenant_id, order_id, menu_item_id, item_name, quantity, unit_price,
          notes, combo_instance_id, virtual_brand_id, added_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
        RETURNING id
      `, [
        tenantId, id, r.menu_item_id, r.item_name, r.quantity, r.unit_price,
        r.notes, r.combo_instance_id, r.virtual_brand_id,
      ]);
      insertedIds.push(row.id);

      if (r.modifiers.length > 0) {
        for (const mod of r.modifiers) {
          await conn.unsafe(`
            INSERT INTO order_item_modifiers (tenant_id, order_item_id, modifier_id, modifier_name, price_adjustment)
            VALUES ($1, $2, $3, $4, $5)
          `, [tenantId, row.id, mod.id, mod.name, mod.price_adjustment]);
        }
      }
    }

    const totals = await recomputeOrderTotals(conn, id);

    audit({
      tenantId: req.tenant?.id || 'default',
      actorType: 'employee',
      actorId: String(req.employee.id),
      action: 'update',
      resource: 'order',
      resourceId: String(id),
      details: {
        edit: 'items_appended',
        item_ids: insertedIds,
        authorized_by: authorizedBy,
        new_total: totals.total,
      },
      ip: req.ip,
    });

    res.json({ success: true, order_id: Number(id), inserted_item_ids: insertedIds, ...totals });
  } catch (error) {
    if (error?.status) return res.status(error.status).json({ error: error.message });
    console.error('Error appending order items:', error);
    res.status(500).json({ error: 'Failed to append items' });
  }
});

// PATCH /api/orders/:id/items/:itemId — change quantity on a sent order line.
// Body: { quantity: number, authorized_by_employee_id?: number }
router.patch('/:id/items/:itemId', requireAuth('pos_access'), async (req, res) => {
  const { id, itemId } = req.params;
  const { quantity, authorized_by_employee_id } = req.body || {};
  if (!Number.isInteger(quantity) || quantity <= 0) {
    return res.status(400).json({ error: 'quantity must be a positive integer' });
  }

  const conn = getConn();
  try {
    const order = await get(
      'SELECT id, status, payment_status FROM orders WHERE id = $1',
      [id]
    );
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (EDIT_BLOCKED_STATUSES.has(order.status)) {
      return res.status(400).json({ error: `Cannot edit ${order.status} order` });
    }

    const item = await get(
      'SELECT id, quantity, original_quantity, voided_at FROM order_items WHERE id = $1 AND order_id = $2',
      [itemId, id]
    );
    if (!item) return res.status(404).json({ error: 'Item not found on order' });
    if (item.voided_at) return res.status(400).json({ error: 'Item is voided' });

    const isPaid = order.payment_status === 'paid' || order.payment_status === 'completed';
    await authorizeOrderEdit({
      actorEmployee: req.employee,
      authorizedByEmployeeId: authorized_by_employee_id,
      isPaid,
    });

    // Preserve the very first quantity so KDS can show "was 2, now 5".
    const preserveOriginal = item.original_quantity == null;
    await conn.unsafe(`
      UPDATE order_items
      SET quantity = $1,
          qty_changed_at = NOW(),
          original_quantity = ${preserveOriginal ? '$3' : 'original_quantity'}
      WHERE id = $2
    `, preserveOriginal ? [quantity, itemId, item.quantity] : [quantity, itemId]);

    const totals = await recomputeOrderTotals(conn, id);

    audit({
      tenantId: req.tenant?.id || 'default',
      actorType: 'employee',
      actorId: String(req.employee.id),
      action: 'update',
      resource: 'order_item',
      resourceId: String(itemId),
      details: {
        edit: 'quantity_changed',
        from: item.quantity,
        to: quantity,
        order_id: Number(id),
        new_total: totals.total,
      },
      ip: req.ip,
    });

    res.json({ success: true, item_id: Number(itemId), quantity, ...totals });
  } catch (error) {
    if (error?.status) return res.status(error.status).json({ error: error.message });
    console.error('Error updating order item quantity:', error);
    res.status(500).json({ error: 'Failed to update quantity' });
  }
});

// DELETE /api/orders/:id/items/:itemId — soft-void a line on a sent order.
// Body: { void_reason: string, authorized_by_employee_id?: number }
router.delete('/:id/items/:itemId', requireAuth('pos_access'), async (req, res) => {
  const { id, itemId } = req.params;
  const { void_reason, authorized_by_employee_id } = req.body || {};
  if (!void_reason || typeof void_reason !== 'string' || void_reason.trim().length < 2) {
    return res.status(400).json({ error: 'void_reason is required' });
  }

  const conn = getConn();
  try {
    const order = await get(
      'SELECT id, status, payment_status FROM orders WHERE id = $1',
      [id]
    );
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (EDIT_BLOCKED_STATUSES.has(order.status)) {
      return res.status(400).json({ error: `Cannot edit ${order.status} order` });
    }

    const item = await get(
      'SELECT id, voided_at FROM order_items WHERE id = $1 AND order_id = $2',
      [itemId, id]
    );
    if (!item) return res.status(404).json({ error: 'Item not found on order' });
    if (item.voided_at) return res.status(400).json({ error: 'Item already voided' });

    const isPaid = order.payment_status === 'paid' || order.payment_status === 'completed';
    const authorizedBy = await authorizeOrderEdit({
      actorEmployee: req.employee,
      authorizedByEmployeeId: authorized_by_employee_id,
      isPaid,
    });

    await conn.unsafe(`
      UPDATE order_items
      SET voided_at = NOW(), voided_by = $1, void_reason = $2
      WHERE id = $3
    `, [authorizedBy, void_reason.trim(), itemId]);

    // Block last-item void — an order with zero live items should be cancelled,
    // not silently zeroed out. The cashier can use the existing cancel flow.
    const [{ live_count }] = await conn.unsafe(
      `SELECT COUNT(*)::int AS live_count FROM order_items WHERE order_id = $1 AND voided_at IS NULL`,
      [id]
    );
    if (live_count === 0) {
      // Roll back the void so the order keeps at least one live line.
      await conn.unsafe(`UPDATE order_items SET voided_at = NULL, voided_by = NULL, void_reason = NULL WHERE id = $1`, [itemId]);
      return res.status(400).json({ error: 'Cannot void the last item on an order. Cancel the order instead.' });
    }

    const totals = await recomputeOrderTotals(conn, id);

    audit({
      tenantId: req.tenant?.id || 'default',
      actorType: 'employee',
      actorId: String(req.employee.id),
      action: 'update',
      resource: 'order_item',
      resourceId: String(itemId),
      details: {
        edit: 'voided',
        reason: void_reason.trim(),
        authorized_by: authorizedBy,
        order_id: Number(id),
        new_total: totals.total,
      },
      ip: req.ip,
    });

    res.json({ success: true, item_id: Number(itemId), voided: true, ...totals });
  } catch (error) {
    if (error?.status) return res.status(error.status).json({ error: error.message });
    console.error('Error voiding order item:', error);
    res.status(500).json({ error: 'Failed to void item' });
  }
});

// POST /api/orders/:id/discount — apply (or clear) an order-level discount on
// an existing order. Cashier action with the same authorize-or-manager-PIN
// gate as cart-creation discounts. Paid orders are rejected — refund instead.
//
// Body: {
//   discount: { type: 'percent'|'amount'|'comp', value: number, reason: string } | null,
//   authorized_by_employee_id?: number
// }
// Sending `discount: null` clears any existing order-level discount.
router.post('/:id/discount', requireAuth('pos_access'), async (req, res) => {
  const { id } = req.params;
  const { discount, authorized_by_employee_id } = req.body || {};
  const conn = getConn();
  try {
    const orderRow = await get(
      `SELECT id, payment_status FROM orders WHERE id = $1`,
      [id]
    );
    if (!orderRow) return res.status(404).json({ error: 'Order not found' });
    if (orderRow.payment_status === 'paid') {
      return res.status(409).json({
        error: 'Order is already paid — use refund instead of applying a retroactive discount',
      });
    }

    // Clear-path: discount === null wipes order-level discount, no auth needed
    // beyond pos_access (matches how voiding the last item is gated).
    if (discount === null || discount === undefined) {
      await conn.unsafe(
        `UPDATE orders SET discount_amount = 0, discount_type = NULL, discount_reason = NULL, discount_authorized_by = NULL WHERE id = $1`,
        [id]
      );
      const totals = await recomputeOrderTotals(conn, id);
      audit({
        tenantId: req.tenant?.id || 'default',
        actorType: 'employee',
        actorId: String(req.employee.id),
        action: 'update',
        resource: 'order',
        resourceId: String(id),
        details: { edit: 'discount_cleared', new_total: totals.total },
        ip: req.ip,
      });
      return res.json({ success: true, order_id: Number(id), discount: null, ...totals });
    }

    if (!discount.type || !['percent', 'amount', 'comp'].includes(discount.type)) {
      return res.status(400).json({ error: 'discount.type must be percent, amount, or comp' });
    }
    if (typeof discount.reason !== 'string' || discount.reason.trim().length === 0) {
      return res.status(400).json({ error: 'discount.reason is required' });
    }

    let authorizedBy;
    try {
      authorizedBy = await authorizeDiscount({
        actorEmployee: req.employee,
        authorizedByEmployeeId: authorized_by_employee_id,
      });
    } catch (err) {
      return res.status(err.status || 403).json({ error: err.message });
    }

    // Resolve discount against the pre-discount line total (live items only).
    const items = await all(
      `SELECT unit_price, quantity, COALESCE(discount_amount, 0) AS discount_amount
       FROM order_items WHERE order_id = $1 AND voided_at IS NULL`,
      [id]
    );
    let lineTotal = 0;
    for (const it of items) {
      lineTotal += Number(it.unit_price) * Number(it.quantity) - Number(it.discount_amount);
    }
    const discountAmount = resolveDiscountAmount(discount, lineTotal);

    await conn.unsafe(
      `UPDATE orders
       SET discount_amount = $1, discount_type = $2, discount_reason = $3, discount_authorized_by = $4
       WHERE id = $5`,
      [discountAmount, discount.type, discount.reason.trim().slice(0, 200), authorizedBy, id]
    );
    const totals = await recomputeOrderTotals(conn, id);

    audit({
      tenantId: req.tenant?.id || 'default',
      actorType: 'employee',
      actorId: String(req.employee.id),
      action: 'update',
      resource: 'order',
      resourceId: String(id),
      details: {
        edit: 'discount_applied',
        discount_type: discount.type,
        discount_value: discount.value,
        discount_amount: discountAmount,
        reason: discount.reason.trim(),
        authorized_by: authorizedBy,
        new_total: totals.total,
      },
      ip: req.ip,
    });

    res.json({
      success: true,
      order_id: Number(id),
      discount: {
        type: discount.type,
        value: discount.value,
        reason: discount.reason.trim(),
        amount: discountAmount,
        authorized_by: authorizedBy,
      },
      ...totals,
    });
  } catch (error) {
    console.error('Error applying order discount:', error);
    res.status(500).json({ error: 'Failed to apply discount' });
  }
});

// DELETE /api/orders/:id — delete one order and all its child rows (test cleanup)
router.delete('/:id', requireAuth('void_orders'), async (req, res) => {
  const { id } = req.params;
  const conn = getConn();
  try {
    await conn.unsafe(
      `DELETE FROM order_item_modifiers WHERE order_item_id IN (SELECT id FROM order_items WHERE order_id = $1)`,
      [id]
    );
    await conn.unsafe(
      `DELETE FROM order_payment_items WHERE payment_id IN (SELECT id FROM order_payments WHERE order_id = $1) OR order_item_id IN (SELECT id FROM order_items WHERE order_id = $1)`,
      [id]
    );
    await conn.unsafe(`DELETE FROM order_payments WHERE order_id = $1`, [id]);
    await conn.unsafe(`DELETE FROM refunds WHERE order_id = $1`, [id]);
    await conn.unsafe(`DELETE FROM delivery_orders WHERE order_id = $1`, [id]);
    await conn.unsafe(`UPDATE stamp_events SET order_id = NULL WHERE order_id = $1`, [id]);
    await conn.unsafe(`DELETE FROM order_items WHERE order_id = $1`, [id]);
    const deleted = await conn.unsafe(`DELETE FROM orders WHERE id = $1 RETURNING id`, [id]);

    if (deleted.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }
    audit('order.deleted', req, { order_id: id });
    res.json({ success: true, deleted_id: id });
  } catch (error) {
    console.error('Error deleting order:', error);
    res.status(500).json({ error: 'Failed to delete order' });
  }
});

// POST /api/orders/purge-unpaid — bulk delete all unpaid/pending_terminal orders (test cleanup)
router.post('/purge-unpaid', requireAuth('void_orders'), async (req, res) => {
  const conn = getConn();
  try {
    const unpaid = await conn.unsafe(
      `SELECT id FROM orders WHERE payment_status IN ('unpaid', 'pending_terminal')`
    );
    const ids = unpaid.map(r => r.id);

    if (ids.length === 0) {
      return res.json({ success: true, deleted_count: 0 });
    }

    await conn.unsafe(
      `DELETE FROM order_item_modifiers WHERE order_item_id IN (SELECT id FROM order_items WHERE order_id = ANY($1::int[]))`,
      [ids]
    );
    await conn.unsafe(
      `DELETE FROM order_payment_items WHERE payment_id IN (SELECT id FROM order_payments WHERE order_id = ANY($1::int[])) OR order_item_id IN (SELECT id FROM order_items WHERE order_id = ANY($1::int[]))`,
      [ids]
    );
    await conn.unsafe(`DELETE FROM order_payments WHERE order_id = ANY($1::int[])`, [ids]);
    await conn.unsafe(`DELETE FROM refunds WHERE order_id = ANY($1::int[])`, [ids]);
    await conn.unsafe(`DELETE FROM delivery_orders WHERE order_id = ANY($1::int[])`, [ids]);
    await conn.unsafe(`UPDATE stamp_events SET order_id = NULL WHERE order_id = ANY($1::int[])`, [ids]);
    await conn.unsafe(`DELETE FROM order_items WHERE order_id = ANY($1::int[])`, [ids]);
    const deleted = await conn.unsafe(`DELETE FROM orders WHERE id = ANY($1::int[]) RETURNING id`, [ids]);

    audit('orders.purged_unpaid', req, { deleted_count: deleted.length });
    res.json({ success: true, deleted_count: deleted.length });
  } catch (error) {
    console.error('Error purging unpaid orders:', error);
    res.status(500).json({ error: 'Failed to purge unpaid orders' });
  }
});

export { insertOrderWithNumber, estimatePrepTime };
export default router;
