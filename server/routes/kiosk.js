import { Router } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import rateLimit from 'express-rate-limit';
import { adminSql, withTenant, get } from '../db/index.js';
import { JWT_SECRET } from '../lib/constants.js';
import { getTenant } from '../tenants.js';
import { deductInventoryForOrder } from '../helpers/inventory.js';
import { generateInvoiceToken } from '../helpers/facturapi.js';
import {
  normalizePhone,
  findOrCreateCustomer,
  getActiveStampCard,
  addStampsForOrder,
} from '../helpers/loyalty.js';
import {
  buildTasteProfile,
  getRepeatOrder,
  getActiveMenu,
  buildBusinessFeed,
  getPopularItems,
  getDayContext,
  synthesizeAISuggestions,
  composeSuggestions,
} from '../helpers/kioskSuggestions.js';
import {
  ensureFreshToken,
  createPointOrder,
  getPointOrder,
  mapPointOrderStatus,
} from '../services/mercadopago.js';
import { recordMpTerminalPayment, findActiveTerminalLock } from './payments.js';
import {
  createQuote as uberDirectCreateQuote,
  createDelivery as uberDirectCreateDelivery,
} from '../services/uber-direct.js';
import { getServiceCredentials } from '../helpers/tenantCredentials.js';

const router = Router();
const TAX_RATE = 0.16;

function normalizeKioskFulfillmentType(value) {
  return value === 'for_here' || value === 'to_go' || value === 'delivery'
    ? value
    : 'to_go';
}

const bindLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many bind attempts. Try again in a minute.' },
});

// POST /api/kiosk/bind
// Body: { pin }
// Returns: { tenant_id, tenant_name, kiosk_token }
//
// Cross-tenant PIN search restricted to admin/manager roles only.
// Issues a 30-day kiosk token that scopes subsequent requests to the matched tenant.
router.post('/bind', bindLimiter, async (req, res) => {
  try {
    const { pin } = req.body || {};
    if (!pin || typeof pin !== 'string' || pin.length < 4) {
      return res.status(400).json({ error: 'PIN required (min 4 digits)' });
    }

    const candidates = await adminSql`
      SELECT e.id, e.tenant_id, e.role, e.pin, t.name AS tenant_name
      FROM employees e
      JOIN tenants t ON t.id = e.tenant_id
      WHERE e.active = true AND e.role IN ('admin', 'manager')
    `;

    let matched = null;
    for (const c of candidates) {
      const ok = await bcrypt.compare(pin, c.pin);
      if (ok) {
        matched = c;
        break;
      }
    }

    if (!matched) {
      return res.status(401).json({ error: 'Invalid PIN or insufficient permissions' });
    }

    const kioskToken = jwt.sign(
      {
        tenantId: matched.tenant_id,
        type: 'kiosk',
        boundEmployeeId: matched.id,
      },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      tenant_id: matched.tenant_id,
      tenant_name: matched.tenant_name,
      kiosk_token: kioskToken,
    });
  } catch (err) {
    console.error('[kiosk/bind] error', err);
    res.status(500).json({ error: 'Server error' });
  }
});

function checkAdminSecret(req) {
  const provided = req.headers['x-admin-secret'] || req.body?.admin_secret;
  if (!process.env.ADMIN_SECRET) return false;
  return typeof provided === 'string' && provided === process.env.ADMIN_SECRET;
}

function verifyKioskToken(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const tenantId = req.headers['x-tenant-id'] || req.body?.tenant_id;

  if (!token || !tenantId || typeof tenantId !== 'string') {
    return res.status(401).json({ error: 'Kiosk token and tenant required' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded?.type !== 'kiosk' || decoded?.tenantId !== tenantId) {
      return res.status(403).json({ error: 'Invalid kiosk token' });
    }
    req.kiosk = decoded;
    req.kioskTenantId = tenantId;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired kiosk token' });
  }
}

async function ensureCounterTable() {
  await adminSql.unsafe(`
    CREATE TABLE IF NOT EXISTS daily_order_counter (
      tenant_id TEXT NOT NULL,
      date_key DATE NOT NULL,
      last_seq INT NOT NULL DEFAULT 0,
      PRIMARY KEY (tenant_id, date_key)
    )
  `);
}

// ==================== Customer suggestions / loyalty ====================

// Short-lived token issued at /identify so order creation can attach the
// customer without re-sending their phone number. Scoped to one tenant.
function issueCustomerToken(tenantId, loyaltyCustomerId) {
  return jwt.sign(
    { tenantId, loyaltyCustomerId, type: 'kiosk_customer' },
    JWT_SECRET,
    { expiresIn: '30m' }
  );
}

function verifyCustomerToken(token, tenantId) {
  if (!token || typeof token !== 'string') return null;
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (
      decoded?.type === 'kiosk_customer' &&
      decoded?.tenantId === tenantId &&
      decoded?.loyaltyCustomerId
    ) {
      return Number(decoded.loyaltyCustomerId);
    }
  } catch {
    /* expired / tampered — treated as anonymous */
  }
  return null;
}

// Append-only learning log: which suggestions were shown and which converted.
// Runtime-created (no RLS) and accessed with explicit tenant filtering, like
// daily_order_counter above.
async function ensureSuggestionTable() {
  await adminSql.unsafe(`
    CREATE TABLE IF NOT EXISTS kiosk_suggestion_events (
      id BIGSERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      loyalty_customer_id INTEGER,
      menu_item_id INTEGER,
      lane TEXT NOT NULL,
      source TEXT,
      event_type TEXT NOT NULL,
      reason TEXT,
      order_id INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await adminSql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_kiosk_suggestion_events_tenant
    ON kiosk_suggestion_events (tenant_id, created_at DESC)
  `);
  await adminSql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_orders_loyalty_customer
    ON orders (tenant_id, loyalty_customer_id)
  `);
}

// Best-effort telemetry — never allowed to break the ordering flow.
async function logSuggestionEvents(tenantId, rows) {
  if (!rows || !rows.length) return;
  try {
    await ensureSuggestionTable();
    const placeholders = rows
      .map((_, i) => {
        const o = i * 7;
        return `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7})`;
      })
      .join(',');
    const params = rows.flatMap((r) => [
      tenantId,
      r.loyalty_customer_id ?? null,
      r.menu_item_id ?? null,
      r.lane,
      r.source ?? null,
      r.event_type,
      r.reason ?? null,
    ]);
    await adminSql.unsafe(
      `INSERT INTO kiosk_suggestion_events
         (tenant_id, loyalty_customer_id, menu_item_id, lane, source, event_type, reason)
       VALUES ${placeholders}`,
      params
    );
  } catch (err) {
    console.error('[kiosk/suggestion-event] log failed:', err.message);
  }
}

// Award loyalty stamps for a paid kiosk order. Idempotent: a stamp_event keyed
// to the order is the guard against double-stamping.
async function awardKioskOrderStamps(orderId, tenantId) {
  try {
    const [order] = await adminSql`
      SELECT loyalty_customer_id FROM orders
      WHERE id = ${orderId} AND tenant_id = ${tenantId}
    `;
    if (!order?.loyalty_customer_id) return;

    const [already] = await adminSql`
      SELECT 1 FROM stamp_events WHERE order_id = ${orderId} LIMIT 1
    `;
    if (already) return;

    const tenant = await getTenant(tenantId);
    await withTenant(tenantId, () =>
      addStampsForOrder(order.loyalty_customer_id, orderId, null, tenant?.name || 'us')
    );
  } catch (err) {
    console.error('[kiosk/award-stamps] warning:', err.message);
  }
}

async function nextOrderNumber(tenantId) {
  await ensureCounterTable();
  const dateStr = new Date().toISOString().split('T')[0];
  const datePrefix = parseInt(dateStr.replace(/-/g, ''), 10) * 1000;
  const [counter] = await adminSql.unsafe(`
    INSERT INTO daily_order_counter (tenant_id, date_key, last_seq)
    VALUES ($1, $2::date, 1)
    ON CONFLICT (tenant_id, date_key) DO UPDATE SET last_seq = daily_order_counter.last_seq + 1
    RETURNING last_seq
  `, [tenantId, dateStr]);
  return datePrefix + Number(counter.last_seq);
}

async function resolveKioskEmployee(tenantId, kioskTokenPayload) {
  if (kioskTokenPayload?.boundEmployeeId) {
    const [employee] = await adminSql`
      SELECT id FROM employees
      WHERE tenant_id = ${tenantId} AND id = ${kioskTokenPayload.boundEmployeeId} AND active = true
    `;
    if (employee) return employee.id;
  }

  const [fallback] = await adminSql`
    SELECT id FROM employees
    WHERE tenant_id = ${tenantId} AND active = true
    ORDER BY
      CASE role
        WHEN 'cashier' THEN 1
        WHEN 'manager' THEN 2
        WHEN 'admin' THEN 3
        ELSE 4
      END,
      id ASC
    LIMIT 1
  `;
  return fallback?.id || null;
}

/**
 * Build validated order line items from a kiosk cart payload, including
 * modifier price adjustments. Returns { orderItems, total } where each
 * orderItem carries its modifier list to be persisted into
 * order_item_modifiers after the parent order_items row is inserted.
 * Throws an Error with .status for client-facing failures.
 */
async function buildKioskOrderItems(tenantId, items) {
  const menuIds = items.map((item) => Number(item.menu_item_id)).filter(Number.isInteger);
  if (menuIds.length !== items.length) {
    const err = new Error('Invalid menu item');
    err.status = 400;
    throw err;
  }

  const menuRows = await adminSql.unsafe(`
    SELECT id, name, price
    FROM menu_items
    WHERE tenant_id = $1 AND active = true AND id = ANY($2::int[])
  `, [tenantId, menuIds]);
  const menuById = new Map(menuRows.map((row) => [Number(row.id), row]));

  // Collect every modifier id across all lines, look them up once.
  const allModifierIds = [];
  for (const item of items) {
    if (Array.isArray(item.modifier_ids)) {
      for (const id of item.modifier_ids) {
        const n = Number(id);
        if (Number.isInteger(n)) allModifierIds.push(n);
      }
    }
  }
  let modifierById = new Map();
  if (allModifierIds.length) {
    const modRows = await adminSql.unsafe(`
      SELECT id, name, price_adjustment, group_id
      FROM modifiers
      WHERE tenant_id = $1 AND id = ANY($2::int[]) AND active = true
    `, [tenantId, Array.from(new Set(allModifierIds))]);
    modifierById = new Map(modRows.map((row) => [Number(row.id), {
      id: Number(row.id),
      name: row.name,
      price_adjustment: Number(row.price_adjustment),
      group_id: Number(row.group_id),
    }]));
  }

  // Load the modifier groups attached to each requested menu item so we can
  // enforce required / min / max constraints and reject modifiers that don't
  // belong to a group attached to that item.
  const groupRows = await adminSql.unsafe(`
    SELECT mimg.menu_item_id, mg.id, mg.name, mg.selection_type, mg.required, mg.min_selections, mg.max_selections
    FROM menu_item_modifier_groups mimg
    JOIN modifier_groups mg ON mg.id = mimg.modifier_group_id AND mg.tenant_id = $1 AND mg.active = true
    WHERE mimg.tenant_id = $1 AND mimg.menu_item_id = ANY($2::int[])
  `, [tenantId, menuIds]);
  const groupsByItemId = new Map();
  for (const row of groupRows) {
    const itemId = Number(row.menu_item_id);
    if (!groupsByItemId.has(itemId)) groupsByItemId.set(itemId, []);
    groupsByItemId.get(itemId).push({
      id: Number(row.id),
      name: row.name,
      selection_type: row.selection_type,
      required: !!row.required,
      min_selections: Number(row.min_selections) || 0,
      max_selections: Number(row.max_selections) || 1,
    });
  }

  const orderItems = [];
  let total = 0;
  for (const item of items) {
    const menuItem = menuById.get(Number(item.menu_item_id));
    if (!menuItem) {
      const err = new Error(`Menu item ${item.menu_item_id} not found`);
      err.status = 404;
      throw err;
    }
    const quantity = Math.max(1, Math.min(20, Number(item.quantity) || 0));

    const attachedGroups = groupsByItemId.get(Number(menuItem.id)) || [];
    const attachedGroupIds = new Set(attachedGroups.map((g) => g.id));

    const lineModifiers = [];
    const countsByGroup = new Map();
    if (Array.isArray(item.modifier_ids)) {
      for (const rawId of item.modifier_ids) {
        const m = modifierById.get(Number(rawId));
        if (!m) {
          const err = new Error(`Modifier ${rawId} not found or inactive`);
          err.status = 400;
          throw err;
        }
        if (!attachedGroupIds.has(m.group_id)) {
          const err = new Error(`Modifier "${m.name}" is not available for "${menuItem.name}"`);
          err.status = 400;
          throw err;
        }
        lineModifiers.push(m);
        countsByGroup.set(m.group_id, (countsByGroup.get(m.group_id) || 0) + 1);
      }
    }

    for (const group of attachedGroups) {
      const count = countsByGroup.get(group.id) || 0;
      if (group.required && count === 0) {
        const err = new Error(`"${group.name}" requires a selection`);
        err.status = 400;
        throw err;
      }
      if (count > 0 && count < group.min_selections) {
        const err = new Error(`"${group.name}" requires at least ${group.min_selections} selection(s)`);
        err.status = 400;
        throw err;
      }
      if (count > group.max_selections) {
        const err = new Error(`"${group.name}" allows at most ${group.max_selections} selection(s)`);
        err.status = 400;
        throw err;
      }
    }

    const modifierTotal = lineModifiers.reduce((sum, m) => sum + m.price_adjustment, 0);
    const unitPrice = Math.round((Number(menuItem.price) + modifierTotal) * 100) / 100;
    total += unitPrice * quantity;

    orderItems.push({
      menu_item_id: Number(menuItem.id),
      item_name: menuItem.name,
      quantity,
      unit_price: unitPrice,
      modifiers: lineModifiers,
    });
  }

  total = Math.round(total * 100) / 100;
  return { orderItems, total };
}

/**
 * Insert order_items + their order_item_modifiers for a kiosk order.
 * Returns the inserted order_items rows in input order.
 */
async function insertKioskOrderItems(tenantId, orderId, orderItems) {
  const lines = [];
  for (const item of orderItems) {
    const [row] = await adminSql`
      INSERT INTO order_items (tenant_id, order_id, menu_item_id, item_name, quantity, unit_price, notes)
      VALUES (${tenantId}, ${orderId}, ${item.menu_item_id}, ${item.item_name}, ${item.quantity}, ${item.unit_price}, ${null})
      RETURNING id
    `;
    lines.push({ ...item, order_item_id: row.id });

    for (const mod of item.modifiers) {
      await adminSql`
        INSERT INTO order_item_modifiers (tenant_id, order_item_id, modifier_id, modifier_name, price_adjustment)
        VALUES (${tenantId}, ${row.id}, ${mod.id}, ${mod.name}, ${mod.price_adjustment})
      `;
    }
  }
  return lines;
}

async function markKioskOrderPaid(orderId, tenantId) {
  await adminSql`
    UPDATE orders
    SET payment_status = 'paid',
        status = 'active',
        payment_method = 'card',
        paid_at = NOW()
    WHERE id = ${orderId} AND tenant_id = ${tenantId}
  `;

  await deductInventoryForOrder(orderId);

  let invoiceToken = null;
  try {
    invoiceToken = await generateInvoiceToken(tenantId, orderId, 72);
    await adminSql`UPDATE orders SET invoice_token = ${invoiceToken} WHERE id = ${orderId} AND tenant_id = ${tenantId}`;
  } catch (err) {
    console.error('[kiosk/order-paid] invoice token warning', err.message);
  }

  // Award loyalty stamps if this kiosk order is tied to a customer.
  await awardKioskOrderStamps(orderId, tenantId);

  return invoiceToken;
}

// GET /api/kiosk/admin/tenants — list tenants (super-admin only, used in bind flow)
router.get('/admin/tenants', async (req, res) => {
  if (!checkAdminSecret(req)) {
    return res.status(401).json({ error: 'Invalid admin secret' });
  }
  try {
    const rows = await adminSql`
      SELECT id, name, subdomain
      FROM tenants
      WHERE active = true
      ORDER BY name ASC
    `;
    res.json(rows);
  } catch (err) {
    console.error('[kiosk/admin/tenants] error', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/kiosk/admin/bind — bind kiosk via ADMIN_SECRET + chosen tenant_id
// Body: { admin_secret, tenant_id }  (or admin_secret via X-Admin-Secret header)
router.post('/admin/bind', bindLimiter, async (req, res) => {
  if (!checkAdminSecret(req)) {
    return res.status(401).json({ error: 'Invalid admin secret' });
  }
  const { tenant_id } = req.body || {};
  if (!tenant_id || typeof tenant_id !== 'string') {
    return res.status(400).json({ error: 'tenant_id required' });
  }
  try {
    const [tenant] = await adminSql`
      SELECT id, name FROM tenants WHERE id = ${tenant_id} AND active = true
    `;
    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }
    const kioskToken = jwt.sign(
      { tenantId: tenant.id, type: 'kiosk', boundVia: 'admin_secret' },
      JWT_SECRET,
      { expiresIn: '30d' }
    );
    res.json({
      tenant_id: tenant.id,
      tenant_name: tenant.name,
      kiosk_token: kioskToken,
    });
  } catch (err) {
    console.error('[kiosk/admin/bind] error', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/kiosk/orders — create an order from a bound customer tablet
router.post('/orders', verifyKioskToken, async (req, res) => {
  const tenantId = req.kioskTenantId;
  try {
    const { items, payment_choice = 'counter_cash', customer_token, customer_call_name, fulfillment_type } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Cart is empty' });
    }

    // Optional: a /identify customer token links this order to a loyalty member.
    const loyaltyCustomerId = verifyCustomerToken(customer_token, tenantId);

    // Anonymous customers can leave a name for callout. Identified customers
    // already have a loyalty name, so we ignore call_name when a token verified.
    const callName = loyaltyCustomerId
      ? null
      : (typeof customer_call_name === 'string' ? customer_call_name.trim().slice(0, 40) || null : null);

    const employeeId = await resolveKioskEmployee(tenantId, req.kiosk);
    if (!employeeId) {
      return res.status(400).json({ error: 'No active employee available for kiosk orders' });
    }

    let orderItems, total;
    try {
      ({ orderItems, total } = await buildKioskOrderItems(tenantId, items));
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message });
    }

    const tax = Math.round((total - total / (1 + TAX_RATE)) * 100) / 100;
    const subtotal = Math.round((total - tax) * 100) / 100;
    const orderNumber = await nextOrderNumber(tenantId);
    const paymentStatus = 'unpaid';
    const paymentMethod = payment_choice === 'counter_cash' ? null : 'card';
    const fulfillmentType = normalizeKioskFulfillmentType(fulfillment_type);

    const [order] = await adminSql`
      INSERT INTO orders (
        tenant_id, order_number, employee_id, status, subtotal, tax, total,
        payment_status, payment_method, source, loyalty_customer_id, customer_call_name, order_fulfillment_type
      )
      VALUES (
        ${tenantId}, ${orderNumber}, ${employeeId}, 'pending', ${subtotal}, ${tax}, ${total},
        ${paymentStatus}, ${paymentMethod}, 'customer_kiosk', ${loyaltyCustomerId}, ${callName}, ${fulfillmentType}
      )
      RETURNING id, order_number, subtotal, tax, total, payment_status, status, order_fulfillment_type
    `;

    await insertKioskOrderItems(tenantId, order.id, orderItems);

    res.status(201).json({ ...order, source: 'customer_kiosk', items: orderItems });
  } catch (err) {
    console.error('[kiosk/orders] error', err);
    res.status(500).json({ error: 'Failed to create kiosk order' });
  }
});

// POST /api/kiosk/orders/hold — park a kiosk cart server-side (status='draft_kiosk')
// so the POS can claim it and the customer can come back to add more items.
// Identified customer (token) or anonymous (call name) are both accepted.
router.post('/orders/hold', verifyKioskToken, async (req, res) => {
  const tenantId = req.kioskTenantId;
  try {
    const { items, customer_token, customer_call_name, fulfillment_type } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Cart is empty' });
    }

    const loyaltyCustomerId = verifyCustomerToken(customer_token, tenantId);
    const callName = loyaltyCustomerId
      ? null
      : (typeof customer_call_name === 'string' ? customer_call_name.trim().slice(0, 40) || null : null);

    if (!loyaltyCustomerId && !callName) {
      return res.status(400).json({ error: 'Customer identification or call name required' });
    }

    const employeeId = await resolveKioskEmployee(tenantId, req.kiosk);
    if (!employeeId) {
      return res.status(400).json({ error: 'No active employee available for kiosk orders' });
    }

    let orderItems, total;
    try {
      ({ orderItems, total } = await buildKioskOrderItems(tenantId, items));
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message });
    }

    const tax = Math.round((total - total / (1 + TAX_RATE)) * 100) / 100;
    const subtotal = Math.round((total - tax) * 100) / 100;
    const orderNumber = await nextOrderNumber(tenantId);
    const fulfillmentType = normalizeKioskFulfillmentType(fulfillment_type);

    // Supersede any existing held drafts for this customer — only one active hold at a time.
    // Loyalty: keyed by loyalty_customer_id. Anonymous: keyed by call_name within last 30 min
    // so a stale "Juan" from yesterday doesn't get wiped by today's "Juan".
    const supersedeFilter = loyaltyCustomerId
      ? adminSql`o.loyalty_customer_id = ${loyaltyCustomerId}`
      : adminSql`o.loyalty_customer_id IS NULL
                   AND LOWER(o.customer_call_name) = LOWER(${callName})
                   AND o.created_at > NOW() - INTERVAL '30 minutes'`;

    await adminSql`
      DELETE FROM order_item_modifiers
      WHERE tenant_id = ${tenantId}
        AND order_item_id IN (
          SELECT oi.id FROM order_items oi
          JOIN orders o ON o.id = oi.order_id
          WHERE o.tenant_id = ${tenantId}
            AND o.status = 'draft_kiosk'
            AND ${supersedeFilter}
        )
    `;
    await adminSql`
      DELETE FROM order_items
      WHERE tenant_id = ${tenantId}
        AND order_id IN (
          SELECT o.id FROM orders o
          WHERE o.tenant_id = ${tenantId}
            AND o.status = 'draft_kiosk'
            AND ${supersedeFilter}
        )
    `;
    await adminSql`
      DELETE FROM orders o
      WHERE o.tenant_id = ${tenantId}
        AND o.status = 'draft_kiosk'
        AND ${supersedeFilter}
    `;

    const [order] = await adminSql`
      INSERT INTO orders (
        tenant_id, order_number, employee_id, status, subtotal, tax, total,
        payment_status, source, loyalty_customer_id, customer_call_name, order_fulfillment_type
      )
      VALUES (
        ${tenantId}, ${orderNumber}, ${employeeId}, 'draft_kiosk', ${subtotal}, ${tax}, ${total},
        'unpaid', 'customer_kiosk', ${loyaltyCustomerId}, ${callName}, ${fulfillmentType}
      )
      RETURNING id, order_number, subtotal, tax, total, status, order_fulfillment_type
    `;

    await insertKioskOrderItems(tenantId, order.id, orderItems);

    res.status(201).json({ ...order, items: orderItems });
  } catch (err) {
    console.error('[kiosk/orders/hold] error', err);
    res.status(500).json({ error: 'Failed to hold kiosk order' });
  }
});

// POST /api/kiosk/orders/:id/append-items — customer-initiated "Agregar a mi
// orden" path. The order must belong to this tenant, originate from the kiosk
// (source='customer_kiosk'), still be active (not completed/cancelled), and
// match the requesting customer (loyalty_customer_id OR case-insensitive
// customer_call_name). This last check is the ownership boundary — without it
// anyone who knew an order number could amend someone else's tab.
router.post('/orders/:id/append-items', verifyKioskToken, async (req, res) => {
  const tenantId = req.kioskTenantId;
  const orderId = Number(req.params.id);
  try {
    const { items, customer_token, customer_call_name } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Cart is empty' });
    }
    if (!Number.isInteger(orderId) || orderId <= 0) {
      return res.status(400).json({ error: 'Invalid order id' });
    }

    const loyaltyCustomerId = verifyCustomerToken(customer_token, tenantId);
    const claimedName = typeof customer_call_name === 'string'
      ? customer_call_name.trim().slice(0, 40)
      : '';

    const [order] = await adminSql`
      SELECT o.id, o.status, o.payment_status, o.source,
             o.loyalty_customer_id, o.customer_call_name,
             lc.name AS loyalty_name
      FROM orders o
      LEFT JOIN loyalty_customers lc ON lc.id = o.loyalty_customer_id
      WHERE o.tenant_id = ${tenantId} AND o.id = ${orderId}
    `;
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.source !== 'customer_kiosk') {
      return res.status(403).json({ error: 'Order was not placed at the kiosk' });
    }
    if (order.status === 'completed' || order.status === 'cancelled') {
      return res.status(400).json({ error: `Cannot edit ${order.status} order` });
    }

    // Ownership: any of these constitutes proof of ownership.
    //  (a) Same loyalty session token as the order was placed under.
    //  (b) Anonymous match — order has no loyalty profile and typed name
    //      matches the persisted customer_call_name.
    //  (c) Loyalty-name match — order has a loyalty profile but customer is
    //      coming back without their phone; typed name matches the profile's
    //      first token or full name (same rule as the open-orders lookup).
    const lowClaimed = claimedName.toLowerCase();
    const loyaltyFirst = String(order.loyalty_name || '').trim().split(/\s+/)[0] || '';
    const matchesLoyaltyId = !!loyaltyCustomerId && order.loyalty_customer_id === loyaltyCustomerId;
    const matchesAnonName = !loyaltyCustomerId
      && order.loyalty_customer_id == null
      && !!claimedName
      && String(order.customer_call_name || '').toLowerCase() === lowClaimed;
    const matchesLoyaltyName = !loyaltyCustomerId
      && order.loyalty_customer_id != null
      && !!claimedName
      && (
        loyaltyFirst.toLowerCase() === lowClaimed
        || String(order.loyalty_name || '').toLowerCase() === lowClaimed
      );
    if (!matchesLoyaltyId && !matchesAnonName && !matchesLoyaltyName) {
      return res.status(403).json({ error: 'This order does not match your name or account' });
    }

    let orderItems;
    try {
      ({ orderItems } = await buildKioskOrderItems(tenantId, items));
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message });
    }

    // Insert each new line with added_at=NOW() so the KDS and cashier panel
    // render the NUEVO badge on the kitchen ticket.
    const insertedIds = [];
    for (const item of orderItems) {
      const [row] = await adminSql`
        INSERT INTO order_items (
          tenant_id, order_id, menu_item_id, item_name, quantity, unit_price, notes, added_at
        )
        VALUES (
          ${tenantId}, ${orderId}, ${item.menu_item_id}, ${item.item_name},
          ${item.quantity}, ${item.unit_price}, ${null}, NOW()
        )
        RETURNING id
      `;
      insertedIds.push(row.id);
      for (const mod of item.modifiers) {
        await adminSql`
          INSERT INTO order_item_modifiers (tenant_id, order_item_id, modifier_id, modifier_name, price_adjustment)
          VALUES (${tenantId}, ${row.id}, ${mod.id}, ${mod.name}, ${mod.price_adjustment})
        `;
      }
    }

    // Recompute order totals from live (non-voided) items, mirroring the
    // IVA-inclusive math used at order creation.
    const liveItems = await adminSql`
      SELECT quantity, unit_price, COALESCE(discount_amount, 0) AS discount_amount
      FROM order_items
      WHERE tenant_id = ${tenantId} AND order_id = ${orderId} AND voided_at IS NULL
    `;
    let itemsTotal = 0;
    for (const it of liveItems) {
      itemsTotal += Number(it.unit_price) * it.quantity - Number(it.discount_amount);
    }
    const [orderHead] = await adminSql`
      SELECT COALESCE(discount_amount, 0) AS order_discount
      FROM orders WHERE tenant_id = ${tenantId} AND id = ${orderId}
    `;
    const total = Math.max(0, Math.round((itemsTotal - Number(orderHead.order_discount)) * 100) / 100);
    const tax = Math.round((total - total / (1 + TAX_RATE)) * 100) / 100;
    const subtotal = Math.round((total - tax) * 100) / 100;
    await adminSql`
      UPDATE orders SET subtotal = ${subtotal}, tax = ${tax}, total = ${total}
      WHERE tenant_id = ${tenantId} AND id = ${orderId}
    `;

    res.json({
      success: true,
      order_id: orderId,
      inserted_item_ids: insertedIds,
      subtotal,
      tax,
      total,
    });
  } catch (err) {
    console.error('[kiosk/orders/append-items] error', err);
    res.status(500).json({ error: 'Failed to append items' });
  }
});

// POST /api/kiosk/orders/send-to-kitchen — fire a Para Comer Aquí order straight
// to the kitchen (status='confirmed', payment_status='unpaid'). Customer eats
// first, comes back to pay later via the Pagar mi cuenta flow. Unlike /hold,
// this does NOT supersede prior orders — the same customer could legitimately
// have a paid order from earlier and a new pending order in the same visit
// (e.g., a second round of micheladas).
router.post('/orders/send-to-kitchen', verifyKioskToken, async (req, res) => {
  const tenantId = req.kioskTenantId;
  try {
    const { items, customer_token, customer_call_name, fulfillment_type } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Cart is empty' });
    }

    const loyaltyCustomerId = verifyCustomerToken(customer_token, tenantId);
    const callName = loyaltyCustomerId
      ? null
      : (typeof customer_call_name === 'string' ? customer_call_name.trim().slice(0, 40) || null : null);

    // Dine-in must be identifiable — the name is the bridge customers use to
    // come back and pay or add items later.
    if (!loyaltyCustomerId && !callName) {
      return res.status(400).json({ error: 'Customer identification or call name required' });
    }

    const employeeId = await resolveKioskEmployee(tenantId, req.kiosk);
    if (!employeeId) {
      return res.status(400).json({ error: 'No active employee available for kiosk orders' });
    }

    let orderItems, total;
    try {
      ({ orderItems, total } = await buildKioskOrderItems(tenantId, items));
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message });
    }

    const tax = Math.round((total - total / (1 + TAX_RATE)) * 100) / 100;
    const subtotal = Math.round((total - tax) * 100) / 100;
    const orderNumber = await nextOrderNumber(tenantId);
    const fulfillmentType = normalizeKioskFulfillmentType(fulfillment_type);

    const [order] = await adminSql`
      INSERT INTO orders (
        tenant_id, order_number, employee_id, status, subtotal, tax, total,
        payment_status, source, loyalty_customer_id, customer_call_name, order_fulfillment_type
      )
      VALUES (
        ${tenantId}, ${orderNumber}, ${employeeId}, 'active', ${subtotal}, ${tax}, ${total},
        'unpaid', 'customer_kiosk', ${loyaltyCustomerId}, ${callName}, ${fulfillmentType}
      )
      RETURNING id, order_number, subtotal, tax, total, status, payment_status, customer_call_name, order_fulfillment_type
    `;

    await insertKioskOrderItems(tenantId, order.id, orderItems);

    res.status(201).json({ ...order, items: orderItems });
  } catch (err) {
    console.error('[kiosk/orders/send-to-kitchen] error', err);
    res.status(500).json({ error: 'Failed to send order to kitchen' });
  }
});

// ==================== Uber Direct (kiosk-scoped wrappers) ====================
// The /api/uber-direct/* routes require an employee JWT. The kiosk only has a
// kiosk_token, so these thin wrappers let the kiosk request a quote and book
// a courier without leaking employee auth into the customer surface.

// POST /api/kiosk/delivery/quote
// Body: { dropoff_address, dropoff_phone_number, manifest_total_value? }
// Returns Uber Direct quote { id, fee, currency, duration, dropoff_eta, expires }
router.post('/delivery/quote', verifyKioskToken, async (req, res) => {
  const tenantId = req.kioskTenantId;
  try {
    const { dropoff_address, dropoff_phone_number, manifest_total_value } = req.body || {};
    if (!dropoff_address || !dropoff_phone_number) {
      return res.status(400).json({ error: 'dropoff_address and dropoff_phone_number required' });
    }

    const creds = await getServiceCredentials(tenantId, 'uber_direct', {
      pickup_address: '',
      pickup_phone_number: '',
    });
    if (!creds.pickup_address || !creds.pickup_phone_number) {
      return res.status(400).json({ error: 'Restaurant pickup address/phone not configured in Uber Direct credentials' });
    }

    const quote = await uberDirectCreateQuote(tenantId, {
      pickup_address: creds.pickup_address,
      pickup_phone_number: creds.pickup_phone_number,
      dropoff_address,
      dropoff_phone_number,
      manifest_total_value: Math.round(Number(manifest_total_value || 0) * 100),
    });

    res.json({
      quote_id: quote.id,
      fee: (quote.fee || 0) / 100,
      currency: quote.currency_type || quote.currency || 'MXN',
      duration_min: Math.round((quote.duration || 0)),
      dropoff_eta: quote.dropoff_eta,
      expires: quote.expires,
    });
  } catch (err) {
    console.error('[kiosk/delivery/quote] error', err.message);
    res.status(err.status || 500).json({
      error: err.data?.message || err.message || 'Failed to create quote',
    });
  }
});

// POST /api/kiosk/orders/send-to-delivery
// Body: { items, customer_token?, customer_call_name, dropoff_address,
//         dropoff_phone_number, dropoff_name?, dropoff_notes?, quote_id? }
// Creates an internal order, then dispatches an Uber courier. Returns both.
router.post('/orders/send-to-delivery', verifyKioskToken, async (req, res) => {
  const tenantId = req.kioskTenantId;
  try {
    const {
      items,
      customer_token,
      customer_call_name,
      dropoff_address,
      dropoff_phone_number,
      dropoff_name,
      dropoff_notes,
      quote_id,
    } = req.body || {};

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Cart is empty' });
    }
    if (!dropoff_address || !dropoff_phone_number) {
      return res.status(400).json({ error: 'dropoff_address and dropoff_phone_number required' });
    }

    const loyaltyCustomerId = verifyCustomerToken(customer_token, tenantId);
    const callName = loyaltyCustomerId
      ? (dropoff_name?.slice(0, 40) || null)
      : (typeof customer_call_name === 'string'
          ? customer_call_name.trim().slice(0, 40) || null
          : (dropoff_name?.slice(0, 40) || null));

    if (!loyaltyCustomerId && !callName) {
      return res.status(400).json({ error: 'Customer name required for delivery' });
    }

    const creds = await getServiceCredentials(tenantId, 'uber_direct', {
      pickup_name: '',
      pickup_address: '',
      pickup_phone_number: '',
    });
    if (!creds.pickup_address || !creds.pickup_phone_number || !creds.pickup_name) {
      return res.status(400).json({ error: 'Restaurant pickup details not configured' });
    }

    const employeeId = await resolveKioskEmployee(tenantId, req.kiosk);
    if (!employeeId) {
      return res.status(400).json({ error: 'No active employee available for kiosk orders' });
    }

    let orderItems, total;
    try {
      ({ orderItems, total } = await buildKioskOrderItems(tenantId, items));
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message });
    }

    const tax = Math.round((total - total / (1 + TAX_RATE)) * 100) / 100;
    const subtotal = Math.round((total - tax) * 100) / 100;
    const orderNumber = await nextOrderNumber(tenantId);

    const [order] = await adminSql`
      INSERT INTO orders (
        tenant_id, order_number, employee_id, status, subtotal, tax, total,
        payment_status, source, loyalty_customer_id, customer_call_name, order_fulfillment_type
      )
      VALUES (
        ${tenantId}, ${orderNumber}, ${employeeId}, 'active', ${subtotal}, ${tax}, ${total},
        'unpaid', 'customer_kiosk', ${loyaltyCustomerId}, ${callName}, 'delivery'
      )
      RETURNING id, order_number, subtotal, tax, total, status, payment_status, customer_call_name, order_fulfillment_type
    `;

    await insertKioskOrderItems(tenantId, order.id, orderItems);

    // Build the manifest from cart items so Uber's courier app shows what's
    // being picked up.
    const manifestItems = orderItems.map((item) => ({
      name: item.item_name,
      quantity: item.quantity,
      price: Math.round((item.unit_price || 0) * 100),
    }));

    let delivery = null;
    let deliveryError = null;
    try {
      delivery = await uberDirectCreateDelivery(tenantId, {
        quote_id: quote_id || undefined,
        pickup_name: creds.pickup_name,
        pickup_address: creds.pickup_address,
        pickup_phone_number: creds.pickup_phone_number,
        dropoff_name: callName || 'Customer',
        dropoff_address,
        dropoff_phone_number,
        dropoff_notes: dropoff_notes || undefined,
        manifest_items: manifestItems,
        manifest_total_value: Math.round(total * 100),
        external_id: String(order.id),
      });
    } catch (err) {
      deliveryError = err.data?.message || err.message || 'Failed to dispatch courier';
      console.error('[kiosk/orders/send-to-delivery] dispatch failed:', deliveryError);
    }

    // Always create the delivery_orders row — even on dispatch failure so the
    // order is visible in the Delivery screen and an operator can retry.
    const [platform] = await adminSql`
      SELECT id FROM delivery_platforms WHERE tenant_id = ${tenantId} AND name = 'uber_direct'
    `;
    let platformId = platform?.id;
    if (!platformId) {
      const [created] = await adminSql`
        INSERT INTO delivery_platforms (tenant_id, name, display_name, commission_percent, active)
        VALUES (${tenantId}, 'uber_direct', 'Uber Direct', 0, true)
        RETURNING id
      `;
      platformId = created.id;
    }

    const [deliveryRow] = await adminSql`
      INSERT INTO delivery_orders (
        tenant_id, order_id, platform_id, external_order_id, platform_status,
        delivery_fee, customer_name, delivery_address, tracking_url,
        courier_name, courier_phone, courier_vehicle, raw_webhook_data
      ) VALUES (
        ${tenantId}, ${order.id}, ${platformId},
        ${delivery?.id || null},
        ${delivery?.status || (deliveryError ? 'dispatch_failed' : 'pending')},
        ${(delivery?.fee || 0) / 100},
        ${callName},
        ${dropoff_address},
        ${delivery?.tracking_url || null},
        ${delivery?.courier?.name || null},
        ${delivery?.courier?.phone_number || null},
        ${delivery?.courier?.vehicle_type || null},
        ${delivery ? JSON.stringify(delivery) : null}
      )
      RETURNING id
    `;

    await adminSql`
      UPDATE orders SET delivery_order_id = ${deliveryRow.id} WHERE id = ${order.id}
    `;

    res.status(201).json({
      ...order,
      items: orderItems,
      delivery: delivery
        ? {
            delivery_order_id: deliveryRow.id,
            external_id: delivery.id,
            tracking_url: delivery.tracking_url,
            status: delivery.status,
            fee: (delivery.fee || 0) / 100,
            dropoff_eta: delivery.dropoff_eta,
          }
        : null,
      delivery_error: deliveryError,
    });
  } catch (err) {
    console.error('[kiosk/orders/send-to-delivery] error', err);
    res.status(500).json({ error: 'Failed to create delivery order' });
  }
});

// GET /api/kiosk/orders/open?name=Juan&mode=pay  OR  ?customer_token=...
// Returns open unpaid orders matching this customer/name. Used by:
//   - Welcome banner (with customer_token from prior session)
//   - Pagar mi cuenta flow (mode='pay') → fetches order to charge.
//     Includes counter-rung dine-in tabs (any source) so a customer can pay
//     at the kiosk even if the cashier opened the tab.
//   - Agregar a mi orden flow (mode='agregar', default) → appends more items.
//     Restricted to source='customer_kiosk' because the append-items endpoint
//     refuses non-kiosk orders (counter cashier owns those tabs).
// 6-hour rolling window prevents day-old name collisions ("Juan from yesterday").
// Name match uses unaccent() so "Jose" finds "José".
router.get('/orders/open', verifyKioskToken, async (req, res) => {
  const tenantId = req.kioskTenantId;
  try {
    const rawName = typeof req.query.name === 'string' ? req.query.name.trim() : '';
    const customerToken = typeof req.query.customer_token === 'string' ? req.query.customer_token : null;
    const mode = req.query.mode === 'pay' ? 'pay' : 'agregar';
    const loyaltyCustomerId = verifyCustomerToken(customerToken, tenantId);

    if (!loyaltyCustomerId && !rawName) {
      return res.status(400).json({ error: 'name or customer_token required' });
    }

    // Name-based lookup must match BOTH paths:
    //   - anonymous: customer typed only their name when ordering → matches
    //     orders.customer_call_name
    //   - loyalty:   customer ordered via phone path → customer_call_name is
    //     null on the order, but the loyalty profile's name is what they'll
    //     type when coming back to pay. Match on loyalty_customers.name's
    //     first token OR the full name.
    // Token-based lookup (returning loyalty session on Welcome) is the simple
    // case — direct match on loyalty_customer_id.
    const lowName = rawName.slice(0, 40).toLowerCase();
    const matchFilter = loyaltyCustomerId
      ? adminSql`o.loyalty_customer_id = ${loyaltyCustomerId}`
      : adminSql`(
          (o.loyalty_customer_id IS NULL
             AND unaccent(LOWER(o.customer_call_name)) = unaccent(${lowName}))
          OR
          (o.loyalty_customer_id IS NOT NULL
             AND lc.id IS NOT NULL
             AND (
               unaccent(LOWER(SPLIT_PART(lc.name, ' ', 1))) = unaccent(${lowName})
               OR unaccent(LOWER(lc.name)) = unaccent(${lowName})
             ))
        )`;

    // Pay mode: any dine-in tab (kiosk OR counter-rung) is fair game — worst
    // case is paying the wrong tab, which is reversible.
    // Agregar mode: kiosk-only — append-items 403s on non-kiosk sources.
    const sourceFilter = mode === 'pay'
      ? adminSql`o.order_fulfillment_type = 'for_here'`
      : adminSql`o.source = 'customer_kiosk'`;

    const orders = await adminSql`
      SELECT o.id, o.order_number, o.total, o.subtotal, o.tax,
             o.status, o.payment_status,
             COALESCE(o.customer_call_name, lc.name) AS customer_call_name,
             o.order_fulfillment_type, o.created_at
      FROM orders o
      LEFT JOIN loyalty_customers lc ON lc.id = o.loyalty_customer_id
      WHERE o.tenant_id = ${tenantId}
        AND ${sourceFilter}
        AND o.payment_status IN ('unpaid', 'partial', 'pending_terminal')
        AND o.status NOT IN ('cancelled', 'voided', 'draft_kiosk')
        AND o.created_at > NOW() - INTERVAL '6 hours'
        AND ${matchFilter}
      ORDER BY o.created_at DESC
      LIMIT 5
    `;

    if (orders.length === 0) {
      return res.json({ orders: [] });
    }

    const orderIds = orders.map((o) => Number(o.id));
    const items = await adminSql.unsafe(`
      SELECT
        oi.order_id,
        oi.id AS order_item_id,
        oi.menu_item_id,
        oi.item_name,
        oi.quantity,
        oi.unit_price,
        COALESCE(
          (SELECT json_agg(json_build_object(
            'id', m.modifier_id,
            'name', m.modifier_name,
            'price_adjustment', m.price_adjustment
          ) ORDER BY m.id)
           FROM order_item_modifiers m
           WHERE m.tenant_id = $1 AND m.order_item_id = oi.id),
          '[]'::json
        ) AS modifiers
      FROM order_items oi
      WHERE oi.tenant_id = $1
        AND oi.order_id = ANY($2::int[])
        AND oi.voided_at IS NULL
      ORDER BY oi.id
    `, [tenantId, orderIds]);

    const byOrderId = new Map();
    for (const it of items) {
      const list = byOrderId.get(it.order_id) || [];
      list.push(it);
      byOrderId.set(it.order_id, list);
    }

    res.json({
      orders: orders.map((o) => ({
        id: Number(o.id),
        order_number: o.order_number,
        total: Number(o.total),
        subtotal: Number(o.subtotal),
        tax: Number(o.tax),
        status: o.status,
        payment_status: o.payment_status,
        customer_call_name: o.customer_call_name,
        order_fulfillment_type: o.order_fulfillment_type,
        created_at: o.created_at,
        items: byOrderId.get(o.id) || [],
      })),
    });
  } catch (err) {
    console.error('[kiosk/orders/open] error', err);
    res.status(500).json({ error: 'Failed to fetch open orders' });
  }
});

// GET /api/kiosk/orders/active?customer_token=... — does this customer have a held draft?
router.get('/orders/active', verifyKioskToken, async (req, res) => {
  const tenantId = req.kioskTenantId;
  try {
    const customerToken = req.query.customer_token;
    const loyaltyCustomerId = verifyCustomerToken(customerToken, tenantId);
    if (!loyaltyCustomerId) {
      return res.status(401).json({ error: 'Identified customer required' });
    }
    const [order] = await adminSql`
      SELECT id, order_number, total, created_at
      FROM orders
      WHERE tenant_id = ${tenantId}
        AND loyalty_customer_id = ${loyaltyCustomerId}
        AND status = 'draft_kiosk'
      ORDER BY created_at DESC
      LIMIT 1
    `;
    if (!order) return res.json({ active: null });

    const items = await adminSql`
      SELECT
        oi.id AS order_item_id,
        oi.menu_item_id,
        oi.item_name,
        oi.quantity,
        oi.unit_price,
        COALESCE(
          (SELECT json_agg(json_build_object(
            'id', m.modifier_id,
            'name', m.modifier_name,
            'price_adjustment', m.price_adjustment
          ) ORDER BY m.id)
           FROM order_item_modifiers m
           WHERE m.tenant_id = ${tenantId} AND m.order_item_id = oi.id),
          '[]'::json
        ) AS modifiers
      FROM order_items oi
      WHERE oi.tenant_id = ${tenantId} AND oi.order_id = ${order.id}
      ORDER BY oi.id
    `;
    res.json({ active: { ...order, items } });
  } catch (err) {
    console.error('[kiosk/orders/active] error', err);
    res.status(500).json({ error: 'Failed to fetch active order' });
  }
});

// POST /api/kiosk/orders/:id/resume — restore items to kiosk and delete the draft.
// The kiosk treats the restored items as a fresh local cart; next hold creates a new draft.
router.post('/orders/:id/resume', verifyKioskToken, async (req, res) => {
  const tenantId = req.kioskTenantId;
  const orderId = Number(req.params.id);
  try {
    const { customer_token } = req.body || {};
    const loyaltyCustomerId = verifyCustomerToken(customer_token, tenantId);
    if (!loyaltyCustomerId) {
      return res.status(401).json({ error: 'Identified customer required' });
    }
    const [order] = await adminSql`
      SELECT id FROM orders
      WHERE tenant_id = ${tenantId}
        AND id = ${orderId}
        AND loyalty_customer_id = ${loyaltyCustomerId}
        AND status = 'draft_kiosk'
    `;
    if (!order) return res.status(404).json({ error: 'No held order to resume' });

    const items = await adminSql`
      SELECT
        oi.menu_item_id,
        oi.item_name,
        oi.quantity,
        oi.unit_price,
        COALESCE(
          (SELECT json_agg(json_build_object(
            'id', m.modifier_id,
            'name', m.modifier_name,
            'price_adjustment', m.price_adjustment
          ) ORDER BY m.id)
           FROM order_item_modifiers m
           WHERE m.tenant_id = ${tenantId} AND m.order_item_id = oi.id),
          '[]'::json
        ) AS modifiers
      FROM order_items oi
      WHERE oi.tenant_id = ${tenantId} AND oi.order_id = ${orderId}
      ORDER BY oi.id
    `;

    await adminSql`
      DELETE FROM order_item_modifiers
      WHERE tenant_id = ${tenantId}
        AND order_item_id IN (SELECT id FROM order_items WHERE tenant_id = ${tenantId} AND order_id = ${orderId})
    `;
    await adminSql`DELETE FROM order_items WHERE tenant_id = ${tenantId} AND order_id = ${orderId}`;
    await adminSql`DELETE FROM orders WHERE tenant_id = ${tenantId} AND id = ${orderId}`;

    res.json({ items });
  } catch (err) {
    console.error('[kiosk/orders/resume] error', err);
    res.status(500).json({ error: 'Failed to resume order' });
  }
});

// POST /api/kiosk/orders/:id/mp-charge — push kiosk order to default Mercado Pago terminal
router.post('/orders/:id/mp-charge', verifyKioskToken, async (req, res) => {
  const tenantId = req.kioskTenantId;
  const orderId = Number(req.params.id);
  try {
    const [order] = await adminSql`
      SELECT id, order_number, total, payment_status
      FROM orders
      WHERE tenant_id = ${tenantId} AND id = ${orderId} AND source = 'customer_kiosk'
    `;
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.payment_status === 'paid') return res.status(400).json({ error: 'Order is already paid' });

    const tenant = await getTenant(tenantId);
    if (tenant?.plan !== 'pro') return res.status(403).json({ error: 'Mercado Pago Point requires Pro' });
    if (!tenant?.mp_access_token) return res.status(400).json({ error: 'Mercado Pago not connected' });
    if (!tenant?.mp_default_terminal_id) return res.status(400).json({ error: 'No default terminal selected' });

    const lock = await findActiveTerminalLock(tenantId, { excludeOrderId: order.id });
    if (lock) {
      return res.status(409).json({
        error: `Terminal en uso — orden #${lock.order_number} en proceso. Inténtalo en unos segundos.`,
        code: 'terminal_busy',
        current_order_number: String(lock.order_number),
      });
    }

    const accessToken = await ensureFreshToken(tenant, adminSql);
    const mpOrder = await createPointOrder(accessToken, {
      amount: Number(order.total),
      externalRef: `${tenantId}-${order.id}`,
      terminalId: tenant.mp_default_terminal_id,
    });

    await adminSql`
      UPDATE orders
      SET mp_order_id = ${mpOrder.id}, payment_status = 'pending_terminal', payment_method = 'card'
      WHERE tenant_id = ${tenantId} AND id = ${order.id}
    `;

    res.json({ success: true, mp_order_id: mpOrder.id, payment_status: 'pending_terminal' });
  } catch (err) {
    console.error('[kiosk/mp-charge] error', err);
    res.status(500).json({ error: 'Failed to send payment to terminal' });
  }
});

// GET /api/kiosk/orders/:id/status — poll payment state for kiosk order
router.get('/orders/:id/status', verifyKioskToken, async (req, res) => {
  const tenantId = req.kioskTenantId;
  const orderId = Number(req.params.id);
  try {
    const [order] = await adminSql`
      SELECT id, order_number, total, payment_status, mp_order_id, invoice_token
      FROM orders
      WHERE tenant_id = ${tenantId} AND id = ${orderId} AND source = 'customer_kiosk'
    `;
    if (!order) return res.status(404).json({ error: 'Order not found' });

    let paymentStatus = order.payment_status;
    let invoiceToken = order.invoice_token || null;

    if (paymentStatus === 'pending_terminal' && order.mp_order_id) {
      const tenant = await getTenant(tenantId);
      if (tenant?.mp_access_token) {
        const accessToken = await ensureFreshToken(tenant, adminSql);
        const mpOrder = await getPointOrder(accessToken, order.mp_order_id, tenant.mp_default_terminal_id);
        const mapped = mapPointOrderStatus(mpOrder);
        if (mapped === 'paid') {
          // Reconcile any tip the customer added on the MP terminal screen
          // and record the order_payments row (with processor fees) before
          // flipping order.payment_status to 'paid'. Mirrors the POS flow.
          try {
            await recordMpTerminalPayment(order.id, tenantId, mpOrder, accessToken);
          } catch (err) {
            console.error('[kiosk/status] mp terminal reconcile failed', err);
          }
          invoiceToken = await markKioskOrderPaid(order.id, tenantId);
          paymentStatus = 'paid';
        } else if (mapped === 'failed') {
          await adminSql`
            UPDATE orders SET payment_status = 'failed', status = 'cancelled'
            WHERE tenant_id = ${tenantId} AND id = ${order.id}
          `;
          paymentStatus = 'failed';
        }
      }
    }

    res.json({
      id: order.id,
      order_number: order.order_number,
      total: Number(order.total),
      payment_status: paymentStatus,
      invoice_token: invoiceToken,
    });
  } catch (err) {
    console.error('[kiosk/status] error', err);
    res.status(500).json({ error: 'Failed to check order status' });
  }
});

// POST /api/kiosk/identify — recognize a customer by phone, return their
// loyalty status + personalized menu suggestions.
//
// Body: { phone, country_code?, name?, sms_opt_in? }
//   - known phone        → returns customer + suggestions
//   - unknown + name     → enrolls a new loyalty customer
//   - unknown, no name   → { found: false } so the kiosk can ask for a name
router.post('/identify', verifyKioskToken, async (req, res) => {
  const tenantId = req.kioskTenantId;
  try {
    const { phone, country_code = 'MX', name, sms_opt_in = true } = req.body || {};
    if (!phone || typeof phone !== 'string') {
      return res.status(400).json({ error: 'Teléfono requerido' });
    }

    const cc = String(country_code || 'MX').toUpperCase();
    const normalized = normalizePhone(phone, cc);
    if (normalized.length < 10) {
      return res.status(400).json({ error: 'Número de teléfono inválido' });
    }

    const tenant = await getTenant(tenantId);
    const timezone = tenant?.timezone || 'UTC';
    const isPro = tenant?.plan === 'pro';
    const restaurantName = tenant?.name || 'la tienda';

    // All DB work runs in a single tenant-scoped (RLS) transaction.
    const data = await withTenant(tenantId, async () => {
      let customer = await get(
        'SELECT * FROM loyalty_customers WHERE phone = $1 AND country_code = $2',
        [normalized, cc]
      );
      let created = false;

      if (!customer) {
        if (!name || typeof name !== 'string' || !name.trim()) {
          return { found: false };
        }
        const result = await findOrCreateCustomer(
          normalized,
          name.trim(),
          null,
          !!sms_opt_in,
          restaurantName,
          cc
        );
        customer = result.customer;
        created = result.created;
      }

      const card = await getActiveStampCard(customer.id);
      const profile = await buildTasteProfile(customer.id, timezone);
      const repeatOrder = await getRepeatOrder(customer.id);
      const menu = await getActiveMenu();
      const businessFeed = await buildBusinessFeed();
      const popular = await getPopularItems(timezone, 6);
      return { found: true, customer, created, card, profile, repeatOrder, menu, businessFeed, popular };
    });

    if (!data.found) {
      return res.json({ found: false });
    }

    const { customer, created, card, profile, repeatOrder, menu, businessFeed, popular } = data;
    const stamp = card
      ? {
          earned: card.stamps_earned,
          required: card.stamps_required,
          completed: card.completed,
          reward_description: card.reward_description,
        }
      : null;
    const dayCtx = getDayContext(timezone);

    // Claude synthesis runs OUTSIDE the DB transaction (slow network call).
    let aiResult = null;
    if (isPro && process.env.ANTHROPIC_API_KEY && profile.orderCount > 0) {
      aiResult = await synthesizeAISuggestions({
        customer,
        profile,
        repeatOrder,
        menu,
        businessFeed,
        dayCtx,
        stamp,
      });
    }

    const composed = composeSuggestions({ profile, repeatOrder, menu, businessFeed, aiResult });
    const suggestions = {
      usual: composed.usual,
      for_you: composed.for_you,
      house: composed.house,
      popular: popular.map((p) => ({
        menu_item_id: p.id,
        name: p.name,
        price: Number(p.price),
        image_url: p.image_url,
        category: p.category,
        lane: 'popular',
      })),
    };

    // Fire-and-forget: log which suggestions were shown (the learning loop).
    const shown = suggestions.for_you.map((s) => ({
      loyalty_customer_id: customer.id,
      menu_item_id: s.menu_item_id,
      lane: 'for_you',
      source: s.source,
      event_type: 'shown',
      reason: s.reason,
    }));
    if (suggestions.house) {
      shown.push({
        loyalty_customer_id: customer.id,
        menu_item_id: suggestions.house.menu_item_id,
        lane: 'house',
        source: suggestions.house.source,
        event_type: 'shown',
        reason: suggestions.house.reason,
      });
    }
    if (suggestions.usual) {
      shown.push({
        loyalty_customer_id: customer.id,
        lane: 'usual',
        source: 'deterministic',
        event_type: 'shown',
      });
    }
    logSuggestionEvents(tenantId, shown);

    res.json({
      found: true,
      is_new: created,
      customer: {
        id: customer.id,
        name: customer.name,
        first_name: String(customer.name || '').trim().split(/\s+/)[0] || customer.name,
      },
      customer_token: issueCustomerToken(tenantId, customer.id),
      stamp,
      ai_powered: !!aiResult,
      visit_count: profile.orderCount,
      suggestions,
    });
  } catch (err) {
    console.error('[kiosk/identify] error', err);
    res.status(500).json({ error: 'No se pudo identificar al cliente' });
  }
});

// GET /api/kiosk/modifier-map — full {menu_item_id: ModifierGroup[]} map for the kiosk
// so the customer-facing modal opens instantly without per-tap network calls.
router.get('/modifier-map', verifyKioskToken, async (req, res) => {
  const tenantId = req.kioskTenantId;
  try {
    const rows = await adminSql`
      SELECT
        mimg.menu_item_id,
        mg.id AS group_id,
        mg.name AS group_name,
        mg.selection_type,
        mg.required,
        mg.min_selections,
        mg.max_selections,
        mg.sort_order AS group_sort,
        m.id AS modifier_id,
        m.name AS modifier_name,
        m.price_adjustment,
        m.sort_order AS modifier_sort
      FROM menu_item_modifier_groups mimg
      JOIN modifier_groups mg ON mg.id = mimg.modifier_group_id AND mg.tenant_id = ${tenantId}
      JOIN modifiers m ON m.group_id = mg.id AND m.tenant_id = ${tenantId} AND m.active = true
      WHERE mimg.tenant_id = ${tenantId} AND mg.active = true
      ORDER BY mimg.menu_item_id, mg.sort_order, m.sort_order
    `;

    const map = {};
    const groupCache = new Map();
    for (const row of rows) {
      const itemId = Number(row.menu_item_id);
      if (!map[itemId]) map[itemId] = [];
      const cacheKey = `${itemId}:${row.group_id}`;
      let group = groupCache.get(cacheKey);
      if (!group) {
        group = {
          id: Number(row.group_id),
          name: row.group_name,
          selection_type: row.selection_type,
          required: !!row.required,
          min_selections: row.min_selections,
          max_selections: row.max_selections,
          modifiers: [],
        };
        groupCache.set(cacheKey, group);
        map[itemId].push(group);
      }
      group.modifiers.push({
        id: Number(row.modifier_id),
        name: row.modifier_name,
        price_adjustment: Number(row.price_adjustment),
      });
    }

    res.json({ map });
  } catch (err) {
    console.error('[kiosk/modifier-map] error', err);
    res.status(500).json({ error: 'Failed to load modifiers' });
  }
});

// GET /api/kiosk/popular — time-of-day popular items (anonymous customers)
router.get('/popular', verifyKioskToken, async (req, res) => {
  const tenantId = req.kioskTenantId;
  try {
    const tenant = await getTenant(tenantId);
    const timezone = tenant?.timezone || 'UTC';
    const popular = await withTenant(tenantId, () => getPopularItems(timezone, 6));
    res.json({
      popular: popular.map((p) => ({
        menu_item_id: p.id,
        name: p.name,
        price: Number(p.price),
        image_url: p.image_url,
        category: p.category,
        lane: 'popular',
      })),
    });
  } catch (err) {
    console.error('[kiosk/popular] error', err);
    res.status(500).json({ error: 'Failed to load popular items' });
  }
});

// POST /api/kiosk/suggestion-event — log a tap/order on a suggestion
// Body: { customer_token?, events: [{ menu_item_id, lane, source, event_type, reason }] }
router.post('/suggestion-event', verifyKioskToken, async (req, res) => {
  const tenantId = req.kioskTenantId;
  try {
    const { customer_token, events } = req.body || {};
    if (!Array.isArray(events) || !events.length) {
      return res.json({ ok: true });
    }
    const customerId = verifyCustomerToken(customer_token, tenantId);
    const rows = events.slice(0, 20).map((e) => ({
      loyalty_customer_id: customerId,
      menu_item_id: Number.isInteger(Number(e?.menu_item_id)) ? Number(e.menu_item_id) : null,
      lane: typeof e?.lane === 'string' ? e.lane.slice(0, 24) : 'unknown',
      source: typeof e?.source === 'string' ? e.source.slice(0, 24) : null,
      event_type: e?.event_type === 'ordered' ? 'ordered' : 'tapped',
      reason: typeof e?.reason === 'string' ? e.reason.slice(0, 200) : null,
    }));
    await logSuggestionEvents(tenantId, rows);
    res.json({ ok: true });
  } catch (err) {
    // Telemetry must never break the kiosk.
    console.error('[kiosk/suggestion-event] error', err.message);
    res.json({ ok: true });
  }
});

export default router;
