import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import crypto from 'node:crypto';
import { all, get, run, getConn } from '../db/index.js';
import { adminSql } from '../db/index.js';
// AI data pipeline removed in pos-lite
const recordOrderItemPairs = () => {};
import { requireAuth } from '../middleware/auth.js';
import { audit } from '../lib/auditLog.js';
import { sendReceiptMessage, sendReceiptLoyaltyMessage } from '../helpers/twilio.js';
import { findOrCreateCustomer, addStampsForOrder } from '../helpers/loyalty.js';

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
       WHERE status IN ('pending', 'confirmed', 'preparing')
         AND created_at >= CURRENT_DATE AND tenant_id = $1`
    : `SELECT COUNT(*) AS queue_size FROM orders
       WHERE status IN ('pending', 'confirmed', 'preparing')
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
  employee_id, subtotal, tax, total, offline_temp_id, tenantId,
  discount_amount = 0, discount_type = null, discount_reason = null, discount_authorized_by = null,
}) {
  await ensureCounterTable();

  const dateStr = new Date().toISOString().split('T')[0];
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

  const [inserted] = await conn.unsafe(`
    INSERT INTO orders (
      tenant_id, order_number, employee_id, status, subtotal, tax, total,
      payment_status, offline_temp_id,
      discount_amount, discount_type, discount_reason, discount_authorized_by
    )
    VALUES ($1, $2, $3, 'pending', $4, $5, $6, 'unpaid', $7, $8, $9, $10, $11)
    RETURNING id, order_number
  `, [
    tid, orderNumber, employee_id, subtotal, tax, total, offline_temp_id || null,
    discount_amount, discount_type, discount_reason, discount_authorized_by,
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
             o.payment_status, o.payment_method, o.paid_at, o.source, o.created_at,
             o.loyalty_customer_id, e.name as employee_name,
             c.name as customer_name
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

    if (payment_status) {
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
             c.name AS customer_name, c.phone AS customer_phone,
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
            o.status = 'pending'
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

// POST /api/orders/:id/claim - cashier pulls a held or stranded kiosk order into
// the register. For draft_kiosk it just flips to pending; for a stranded
// terminal attempt it also wipes the failed card payment state so the cashier
// can charge fresh (cash or a new card swipe).
router.post('/:id/claim', requireAuth('pos_access'), async (req, res) => {
  try {
    const orderId = Number(req.params.id);
    if (!Number.isInteger(orderId)) {
      return res.status(400).json({ error: 'Invalid order id' });
    }
    const employeeId = req.user?.id;
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
      await run(
        `UPDATE orders SET status = 'pending', employee_id = $1 WHERE id = $2`,
        [employeeId, orderId],
      );
      audit(req, 'order.claimed_from_kiosk', { order_id: orderId });
    } else {
      await run(
        `UPDATE orders
         SET payment_status = 'unpaid', payment_method = NULL, employee_id = $1
         WHERE id = $2`,
        [employeeId, orderId],
      );
      audit(req, 'order.rescued_from_terminal', { order_id: orderId });
    }
    res.json({ id: orderId, status: 'pending' });
  } catch (error) {
    console.error('Error claiming kiosk order:', error);
    res.status(500).json({ error: 'Failed to claim order' });
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

// POST /api/orders - create order
router.post('/', orderCreateLimiter, requireAuth('pos_access'), async (req, res) => {
  try {
    const { employee_id, items, offline_temp_id, discount: orderDiscount } = req.body;

    if (!employee_id || !items || items.length === 0) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Idempotent dedup: if offline_temp_id already exists, return existing order
    if (offline_temp_id) {
      const existing = await get(`
        SELECT o.id, o.order_number, o.employee_id, o.status, o.subtotal, o.tax, o.tip, o.total,
               o.payment_status, o.payment_method, o.source, o.created_at
        FROM orders o WHERE o.offline_temp_id = $1
      `, [offline_temp_id]);
      if (existing) {
        const existingItems = await all(`
          SELECT id, order_id, menu_item_id, item_name, quantity, unit_price, notes, combo_instance_id
          FROM order_items WHERE order_id = $1
        `, [existing.id]);
        return res.status(200).json({ ...existing, items: existingItems });
      }
    }

    // Validate item quantities
    for (const item of items) {
      if (!item.quantity || item.quantity <= 0) {
        return res.status(400).json({ error: `Invalid quantity for item ${item.menu_item_id}. Quantity must be greater than 0.` });
      }
    }

    // Verify employee exists
    const employee = await get('SELECT id FROM employees WHERE id = $1', [employee_id]);
    if (!employee) {
      return res.status(404).json({ error: 'Employee not found' });
    }

    // Calculate totals (prices include IVA)
    let itemsTotal = 0;
    const orderItems = [];

    for (const item of items) {
      const menuItem = await get('SELECT id, name, price FROM menu_items WHERE id = $1', [item.menu_item_id]);
      if (!menuItem) {
        return res.status(404).json({ error: `Menu item ${item.menu_item_id} not found` });
      }

      // Calculate modifier price adjustments
      let modifierTotal = 0;
      const resolvedModifiers = [];
      if (item.modifiers && item.modifiers.length > 0) {
        for (const modId of item.modifiers) {
          const mod = await get('SELECT id, name, price_adjustment FROM modifiers WHERE id = $1', [modId]);
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
        const brandItem = await get(
          'SELECT custom_name, custom_price FROM virtual_brand_items WHERE virtual_brand_id = $1 AND menu_item_id = $2',
          [virtualBrandId, item.menu_item_id]
        );
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
    try {
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
    } catch (err) {
      return res.status(err.status || 403).json({ error: err.message });
    }

    // Prices already include IVA — extract tax from the total
    const tax = Math.round((total - total / (1 + TAX_RATE)) * 100) / 100;
    const subtotal = Math.round((total - tax) * 100) / 100;

    // Atomic order number generation + insert (prevents duplicate order numbers under concurrency)
    const conn = getConn();
    const { orderId, orderNumber } = await insertOrderWithNumber(conn, {
      employee_id, subtotal, tax, total, offline_temp_id,
      tenantId: req.tenant?.id,
      discount_amount: orderDiscountAmount,
      discount_type: orderDiscountAmount > 0 ? (orderDiscount?.type || null) : null,
      discount_reason: orderDiscountAmount > 0 ? (orderDiscount?.reason || null) : null,
      discount_authorized_by: orderAuthorizedBy,
    });

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

    res.status(201).json({
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
    });
  } catch (error) {
    console.error('Error creating order:', error);
    res.status(500).json({ error: 'Failed to create order' });
  }
});

// PUT /api/orders/:id/status - update status
router.put('/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const validStatuses = ['pending', 'confirmed', 'preparing', 'ready', 'completed', 'cancelled'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const order = await get('SELECT id, status FROM orders WHERE id = $1', [id]);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Enforce valid status transitions
    const validTransitions = {
      pending:    ['confirmed', 'preparing', 'cancelled'],
      confirmed:  ['preparing', 'cancelled'],
      preparing:  ['ready', 'cancelled'],
      ready:      ['completed', 'cancelled'],
      completed:  [],
      cancelled:  [],
    };

    const allowed = validTransitions[order.status] || [];
    if (!allowed.includes(status)) {
      return res.status(400).json({
        error: `Cannot transition from '${order.status}' to '${status}'`,
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

    res.json({ id, status });
  } catch (error) {
    console.error('Error updating order status:', error);
    res.status(500).json({ error: 'Failed to update order status' });
  }
});

// GET /api/orders/kitchen/active - get pending+preparing orders for kitchen display
router.get('/kitchen/active', async (req, res) => {
  try {
    // Single query: fetch orders + items + modifiers in one round trip
    const rows = await all(`
      SELECT o.id AS order_id, o.order_number, o.status, o.payment_method, o.source, o.created_at,
             o.estimated_ready_minutes, o.table_number,
             e.name AS employee_name,
             oi.id AS item_id, oi.item_name, oi.quantity, oi.notes, oi.combo_instance_id,
             oi.virtual_brand_id, vb.name AS brand_name, vb.primary_color AS brand_color,
             oim.modifier_name, oim.price_adjustment
      FROM orders o
      JOIN employees e ON o.employee_id = e.id
      LEFT JOIN order_items oi ON oi.order_id = o.id
      LEFT JOIN virtual_brands vb ON oi.virtual_brand_id = vb.id
      LEFT JOIN order_item_modifiers oim ON oim.order_item_id = oi.id
      WHERE o.status IN ('pending', 'confirmed', 'preparing')
      ORDER BY o.created_at ASC, oi.id ASC
    `);

    // Assemble nested structure from flat rows
    const orderMap = new Map();
    for (const row of rows) {
      if (!orderMap.has(row.order_id)) {
        orderMap.set(row.order_id, {
          id: row.order_id,
          order_number: row.order_number,
          status: row.status,
          payment_method: row.payment_method,
          source: row.source,
          created_at: row.created_at,
          estimated_ready_minutes: row.estimated_ready_minutes,
          table_number: row.table_number,
          employee_name: row.employee_name,
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
