import { Router } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import rateLimit from 'express-rate-limit';
import { adminSql, withTenant, get } from '../db/index.js';
import { JWT_SECRET } from '../lib/constants.js';
import { getTenant } from '../tenants.js';
import { getPlanLimits, planUpgradeError, effectivePlan } from '../planLimits.js';
import { tzDate } from '../lib/tz.js';
import { deductInventoryForOrder } from '../helpers/inventory.js';
import { generateInvoiceToken } from '../helpers/facturapi.js';
import {
  normalizePhone,
  findOrCreateCustomer,
  getActiveStampCard,
  addStampsForOrder,
} from '../helpers/loyalty.js';
import { isAppleWalletConfigured } from '../helpers/wallet/applePass.js';
import { ensureApplePass } from '../helpers/wallet/enroll.js';
import { ensureCounterTable } from '../lib/orderCounter.js';
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
  getTerminals as mpGetTerminals,
  mapPointOrderStatus,
  MP_POINT_MIN_AMOUNT,
  parseMpError,
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

// Binding a kiosk device is a rare, one-time setup action, so the limit can be
// aggressive. /bind does a cross-tenant PIN search over admin/manager PINs, so a
// loose limit is a cross-tenant brute-force surface. 8 attempts / 15 min per IP
// keeps a 4-digit space at ~300+ hours to exhaust while never inconveniencing a
// legitimate one-off setup.
const bindLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many bind attempts. Try again later.' },
});

// POST /api/kiosk/bind
// Body: { pin, device_name? }
// Returns: { tenant_id, tenant_name, kiosk_token, device_id? }
//
// Cross-tenant PIN search restricted to admin/manager roles only.
// Issues a 30-day kiosk token that scopes subsequent requests to the matched tenant.
//
// If device_name is provided, upserts a kiosk_devices row and includes deviceId
// in the token so super-admin can flip that ONE device's kiosk_mode_override
// (Samsung pilot for the burrito-builder wizard). Bind without device_name
// still works — the token has no deviceId and effective mode falls through to
// tenant.kiosk_mode. Existing iPad tokens keep working unchanged.
router.post('/bind', bindLimiter, async (req, res) => {
  try {
    const { pin, device_name } = req.body || {};
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

    let deviceId = null;
    if (typeof device_name === 'string' && device_name.trim()) {
      const name = device_name.trim().slice(0, 80);
      // Upsert on (tenant_id, name) among non-revoked rows. Two devices with
      // the same name on the same tenant collapse into one row so a re-bind
      // (APK reinstall) doesn't leak orphan rows.
      const existing = await adminSql`
        SELECT id FROM kiosk_devices
        WHERE tenant_id = ${matched.tenant_id} AND name = ${name} AND revoked_at IS NULL
        LIMIT 1
      `;
      if (existing.length) {
        deviceId = existing[0].id;
        await adminSql`
          UPDATE kiosk_devices
          SET bound_employee_id = ${matched.id}, last_seen_at = NOW()
          WHERE id = ${deviceId}
        `;
      } else {
        const [row] = await adminSql`
          INSERT INTO kiosk_devices (tenant_id, name, bound_employee_id, last_seen_at)
          VALUES (${matched.tenant_id}, ${name}, ${matched.id}, NOW())
          RETURNING id
        `;
        deviceId = row.id;
      }
    }

    const kioskToken = jwt.sign(
      {
        tenantId: matched.tenant_id,
        type: 'kiosk',
        boundEmployeeId: matched.id,
        ...(deviceId ? { deviceId } : {}),
      },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      tenant_id: matched.tenant_id,
      tenant_name: matched.tenant_name,
      kiosk_token: kioskToken,
      ...(deviceId ? { device_id: deviceId } : {}),
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
    req.kioskDeviceId = decoded.deviceId || null;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired kiosk token' });
  }
}

// Kiosk is a Pro feature (repackaged 2026-07-23). /api/kiosk mounts BEFORE
// tenantMiddleware (bind is cross-tenant), so req.tenant does NOT exist here
// — resolve the tenant from the verified kiosk token's tenantId and compute
// the EFFECTIVE plan (paid Pro or active signup trial both read 'pro').
// Endpoints that only finish an in-flight payment (status poll, terminal
// charge, terminal list) are deliberately NOT gated, so a customer standing
// at the terminal when the trial expires can still complete their payment.
// Everything that starts/extends an order or serves kiosk UX data is gated —
// the kiosk app shows its "no disponible" screen on the first 403 (see
// kiosk/src/lib/kioskApi.ts planLockHandler).
async function requireKioskPlan(req, res, next) {
  try {
    const tenant = await getTenant(req.kioskTenantId);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
    const plan = effectivePlan(tenant);
    if (!getPlanLimits(plan).kiosk?.functional) {
      return res.status(403).json(planUpgradeError('kiosk', plan));
    }
    next();
  } catch (err) {
    console.error('[kiosk] plan check failed:', err.message);
    res.status(500).json({ error: 'Plan check failed' });
  }
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

// Bumps the daily counter and returns the next YYYYMMDDNNN order number.
// Must run against a `sql` handle bound to the same transaction as the
// subsequent order INSERT — otherwise a failed insert leaves the counter
// advanced and the number is permanently lost (produces gaps in the daily
// sequence, e.g. #YYYYMMDD013 that never existed).
async function nextOrderNumber(sql, tenantId, tenantTz) {
  await ensureCounterTable();
  const dateStr = tzDate(new Date(), tenantTz);
  const datePrefix = parseInt(dateStr.replace(/-/g, ''), 10) * 1000;
  const [counter] = await sql.unsafe(`
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

  // Menu items normally require active=true, but builder-menu items are
  // deliberately active=false (they're keyed via kiosk_builder_map and only
  // exposed through the wizard flow). Widen the filter to accept either — the
  // kiosk_builder_map membership acts as an allowlist so no other hidden item
  // can leak into a cart. Modifier validation below still enforces that every
  // chosen modifier belongs to a group attached to the item.
  const menuRows = await adminSql.unsafe(`
    SELECT id, name, price
    FROM menu_items
    WHERE tenant_id = $1 AND id = ANY($2::int[])
      AND (active = true OR id IN (SELECT menu_item_id FROM kiosk_builder_map WHERE tenant_id = $1))
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
async function insertKioskOrderItems(sql, tenantId, orderId, orderItems) {
  const lines = [];
  for (const item of orderItems) {
    const [row] = await sql`
      INSERT INTO order_items (tenant_id, order_id, menu_item_id, item_name, quantity, unit_price, notes)
      VALUES (${tenantId}, ${orderId}, ${item.menu_item_id}, ${item.item_name}, ${item.quantity}, ${item.unit_price}, ${null})
      RETURNING id
    `;
    lines.push({ ...item, order_item_id: row.id });

    for (const mod of item.modifiers) {
      await sql`
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
// Body: { admin_secret, tenant_id, device_name? }  (admin_secret via X-Admin-Secret header also accepted)
// device_name is optional but required if super-admin needs to attach a
// per-device kiosk_mode_override later (the Samsung wizard pilot flow).
router.post('/admin/bind', bindLimiter, async (req, res) => {
  if (!checkAdminSecret(req)) {
    return res.status(401).json({ error: 'Invalid admin secret' });
  }
  const { tenant_id, device_name } = req.body || {};
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

    let deviceId = null;
    if (typeof device_name === 'string' && device_name.trim()) {
      const name = device_name.trim().slice(0, 80);
      const existing = await adminSql`
        SELECT id FROM kiosk_devices
        WHERE tenant_id = ${tenant.id} AND name = ${name} AND revoked_at IS NULL
        LIMIT 1
      `;
      if (existing.length) {
        deviceId = existing[0].id;
        await adminSql`
          UPDATE kiosk_devices SET last_seen_at = NOW() WHERE id = ${deviceId}
        `;
      } else {
        const [row] = await adminSql`
          INSERT INTO kiosk_devices (tenant_id, name, last_seen_at)
          VALUES (${tenant.id}, ${name}, NOW())
          RETURNING id
        `;
        deviceId = row.id;
      }
    }

    const kioskToken = jwt.sign(
      {
        tenantId: tenant.id,
        type: 'kiosk',
        boundVia: 'admin_secret',
        ...(deviceId ? { deviceId } : {}),
      },
      JWT_SECRET,
      { expiresIn: '30d' }
    );
    res.json({
      tenant_id: tenant.id,
      tenant_name: tenant.name,
      kiosk_token: kioskToken,
      ...(deviceId ? { device_id: deviceId } : {}),
    });
  } catch (err) {
    console.error('[kiosk/admin/bind] error', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/kiosk/heartbeat — device liveness + which build it is running.
//
// Deliberately NOT plan-gated: a plan-locked kiosk parked on the unavailable
// screen should still report in, otherwise it looks like a dead tablet. Also
// cheap by design (one UPDATE, no reads) because every kiosk calls it on boot
// and every 15 minutes after.
router.post('/heartbeat', verifyKioskToken, async (req, res) => {
  const deviceId = req.kioskDeviceId;
  // Kiosks bound before device naming existed have no device row to update.
  // Their build still reaches us via the X-App-Version comparison client-side;
  // there is just nowhere to record it.
  if (!deviceId) return res.json({ recorded: false });

  const clientVersion = typeof req.body?.client_version === 'string'
    ? req.body.client_version.slice(0, 40)
    : null;
  const clientPlatform = typeof req.body?.client_platform === 'string'
    ? req.body.client_platform.slice(0, 20)
    : null;

  try {
    await adminSql`
      UPDATE kiosk_devices
      SET last_seen_at = NOW(),
          client_version = COALESCE(${clientVersion}, client_version),
          client_platform = COALESCE(${clientPlatform}, client_platform)
      WHERE id = ${deviceId} AND tenant_id = ${req.kioskTenantId}
    `;
    res.json({ recorded: true });
  } catch (err) {
    console.error('[Kiosk] heartbeat failed:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/kiosk/orders — create an order from a bound customer tablet
router.post('/orders', verifyKioskToken, requireKioskPlan, async (req, res) => {
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
    const tenantTz = (await getTenant(tenantId))?.timezone;
    const paymentStatus = 'unpaid';
    const paymentMethod = payment_choice === 'counter_cash' ? null : 'card';
    const fulfillmentType = normalizeKioskFulfillmentType(fulfillment_type);

    const order = await adminSql.begin(async (sql) => {
      const orderNumber = await nextOrderNumber(sql, tenantId, tenantTz);
      const [row] = await sql`
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
      await insertKioskOrderItems(sql, tenantId, row.id, orderItems);
      return row;
    });

    res.status(201).json({ ...order, source: 'customer_kiosk', items: orderItems });
  } catch (err) {
    console.error('[kiosk/orders] error', err);
    res.status(500).json({ error: 'Failed to create kiosk order' });
  }
});

// POST /api/kiosk/orders/hold — park a kiosk cart server-side (status='draft_kiosk')
// so the POS can claim it and the customer can come back to add more items.
// Identified customer (token) or anonymous (call name) are both accepted.
router.post('/orders/hold', verifyKioskToken, requireKioskPlan, async (req, res) => {
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
    const tenantTz = (await getTenant(tenantId))?.timezone;
    const fulfillmentType = normalizeKioskFulfillmentType(fulfillment_type);

    const order = await adminSql.begin(async (sql) => {
      const orderNumber = await nextOrderNumber(sql, tenantId, tenantTz);

      // Supersede any existing held drafts for this customer — only one active hold at a time.
      // Loyalty: keyed by loyalty_customer_id. Anonymous: keyed by call_name within last 30 min
      // so a stale "Juan" from yesterday doesn't get wiped by today's "Juan".
      const supersedeFilter = loyaltyCustomerId
        ? sql`o.loyalty_customer_id = ${loyaltyCustomerId}`
        : sql`o.loyalty_customer_id IS NULL
                     AND LOWER(o.customer_call_name) = LOWER(${callName})
                     AND o.created_at > NOW() - INTERVAL '30 minutes'`;

      // Never nuke a draft that already has an MP charge in flight or settled.
      // 2026-06-24: order 6269 was deleted by this supersede after MP had
      // already approved a $688 charge — the kiosk re-submitted /orders/hold
      // before the pending_terminal → paid promotion poll fired. The card
      // cleared but pos-lite had no order to attach it to.
      const safeToSupersede = sql`
        o.status = 'draft_kiosk'
          AND o.mp_order_id IS NULL
          AND o.payment_status NOT IN ('pending_terminal', 'paid')
      `;

      await sql`
        DELETE FROM order_item_modifiers
        WHERE tenant_id = ${tenantId}
          AND order_item_id IN (
            SELECT oi.id FROM order_items oi
            JOIN orders o ON o.id = oi.order_id
            WHERE o.tenant_id = ${tenantId}
              AND ${safeToSupersede}
              AND ${supersedeFilter}
          )
      `;
      await sql`
        DELETE FROM order_items
        WHERE tenant_id = ${tenantId}
          AND order_id IN (
            SELECT o.id FROM orders o
            WHERE o.tenant_id = ${tenantId}
              AND ${safeToSupersede}
              AND ${supersedeFilter}
          )
      `;
      await sql`
        DELETE FROM orders o
        WHERE o.tenant_id = ${tenantId}
          AND ${safeToSupersede}
          AND ${supersedeFilter}
      `;

      const [row] = await sql`
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
      await insertKioskOrderItems(sql, tenantId, row.id, orderItems);
      return row;
    });

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
router.post('/orders/:id/append-items', verifyKioskToken, requireKioskPlan, async (req, res) => {
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
    //      prefix-matches the persisted customer_call_name.
    //  (c) Loyalty-name match — order has a loyalty profile but customer is
    //      coming back without their phone; typed name prefix-matches the
    //      profile's first token or full name.
    // Mirrors the unaccent + prefix semantics of the /orders/open lookup so a
    // customer who finds their tab as "Test" → "TEST2" can also append to it.
    const stripAccents = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const lowClaimed = stripAccents(claimedName.toLowerCase().replace(/[%_]/g, ''));
    const startsWithClaimed = (stored) => !!lowClaimed
      && stripAccents(String(stored || '').toLowerCase()).startsWith(lowClaimed);
    const loyaltyFirst = String(order.loyalty_name || '').trim().split(/\s+/)[0] || '';
    const matchesLoyaltyId = !!loyaltyCustomerId && order.loyalty_customer_id === loyaltyCustomerId;
    const matchesAnonName = !loyaltyCustomerId
      && order.loyalty_customer_id == null
      && startsWithClaimed(order.customer_call_name);
    const matchesLoyaltyName = !loyaltyCustomerId
      && order.loyalty_customer_id != null
      && (startsWithClaimed(loyaltyFirst) || startsWithClaimed(order.loyalty_name));
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

// POST /api/kiosk/orders/send-to-kitchen — create a kiosk order as a HELD draft
// (status='draft_kiosk'). The KDS does NOT see this order yet. The kiosk routes
// the customer to /pay-existing where one of two things promotes it:
//   - Card on terminal: markKioskOrderPaid flips draft_kiosk → active on
//     payment success (so the kitchen ticket appears the instant the card
//     clears).
//   - Cash at counter:  the customer walks to the cashier; the cashier sees
//     the order in /api/orders/kiosk-held, takes cash, claims it via
//     POST /api/orders/:id/claim which promotes draft_kiosk → active.
// Either way the kitchen never sees an unpaid ticket. Unlike /hold this does
// NOT supersede prior orders — same customer can legitimately have a paid
// earlier order and a new pending one (second round of micheladas).
router.post('/orders/send-to-kitchen', verifyKioskToken, requireKioskPlan, async (req, res) => {
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
    const tenantTz = (await getTenant(tenantId))?.timezone;
    const fulfillmentType = normalizeKioskFulfillmentType(fulfillment_type);

    const order = await adminSql.begin(async (sql) => {
      const orderNumber = await nextOrderNumber(sql, tenantId, tenantTz);
      const [row] = await sql`
        INSERT INTO orders (
          tenant_id, order_number, employee_id, status, subtotal, tax, total,
          payment_status, source, loyalty_customer_id, customer_call_name, order_fulfillment_type
        )
        VALUES (
          ${tenantId}, ${orderNumber}, ${employeeId}, 'draft_kiosk', ${subtotal}, ${tax}, ${total},
          'unpaid', 'customer_kiosk', ${loyaltyCustomerId}, ${callName}, ${fulfillmentType}
        )
        RETURNING id, order_number, subtotal, tax, total, status, payment_status, customer_call_name, order_fulfillment_type
      `;
      await insertKioskOrderItems(sql, tenantId, row.id, orderItems);
      return row;
    });

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
router.post('/delivery/quote', verifyKioskToken, requireKioskPlan, async (req, res) => {
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
//
// Creates an internal order as status='draft_kiosk' (no kitchen ticket) and a
// delivery_orders row with platform_status='pending_payment' that stashes the
// Uber dispatch payload. The courier is NOT booked yet — that happens once
// the card terminal confirms the payment (see dispatchPendingCourier() called
// from the /orders/:id/status poll). This keeps the merchant from paying for
// couriers on unpaid orders.
//
// Cash payment isn't supported for delivery from the kiosk: by the time the
// customer walks to the cashier they're not at home to receive the courier.
// The /pay-existing screen hides the cash button when fulfillment is delivery.
router.post('/orders/send-to-delivery', verifyKioskToken, requireKioskPlan, async (req, res) => {
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
    const tenantTz = (await getTenant(tenantId))?.timezone;

    // Stash the dispatch payload so dispatchPendingCourier() can re-hydrate it
    // after the card terminal confirms the payment. Manifest items are derived
    // from the order at dispatch time (read off order_items) rather than
    // duplicated here, so item edits between draft and dispatch (rare, but
    // possible via cashier claim) flow through.
    const pendingDispatch = {
      quote_id: quote_id || null,
      pickup_name: creds.pickup_name,
      pickup_address: creds.pickup_address,
      pickup_phone_number: creds.pickup_phone_number,
      dropoff_name: callName || 'Customer',
      dropoff_address,
      dropoff_phone_number,
      dropoff_notes: dropoff_notes || null,
    };

    const order = await adminSql.begin(async (sql) => {
      const orderNumber = await nextOrderNumber(sql, tenantId, tenantTz);
      const [row] = await sql`
        INSERT INTO orders (
          tenant_id, order_number, employee_id, status, subtotal, tax, total,
          payment_status, source, loyalty_customer_id, customer_call_name, order_fulfillment_type
        )
        VALUES (
          ${tenantId}, ${orderNumber}, ${employeeId}, 'draft_kiosk', ${subtotal}, ${tax}, ${total},
          'unpaid', 'customer_kiosk', ${loyaltyCustomerId}, ${callName}, 'delivery'
        )
        RETURNING id, order_number, subtotal, tax, total, status, payment_status, customer_call_name, order_fulfillment_type
      `;
      await insertKioskOrderItems(sql, tenantId, row.id, orderItems);

      const [platform] = await sql`
        SELECT id FROM delivery_platforms WHERE tenant_id = ${tenantId} AND name = 'uber_direct'
      `;
      let platformId = platform?.id;
      if (!platformId) {
        const [created] = await sql`
          INSERT INTO delivery_platforms (tenant_id, name, display_name, commission_percent, active)
          VALUES (${tenantId}, 'uber_direct', 'Uber Direct', 0, true)
          RETURNING id
        `;
        platformId = created.id;
      }

      const [deliveryRow] = await sql`
        INSERT INTO delivery_orders (
          tenant_id, order_id, platform_id, external_order_id, platform_status,
          delivery_fee, customer_name, delivery_address, pending_dispatch
        ) VALUES (
          ${tenantId}, ${row.id}, ${platformId},
          NULL, 'pending_payment',
          0, ${callName}, ${dropoff_address},
          ${pendingDispatch}
        )
        RETURNING id
      `;

      await sql`
        UPDATE orders SET delivery_order_id = ${deliveryRow.id} WHERE id = ${row.id}
      `;
      return row;
    });

    // Courier is NOT booked yet. The kiosk routes to /pay-existing where the
    // customer pays by card; the /orders/:id/status poll dispatches the
    // courier on payment success and surfaces tracking info on the next tick.
    res.status(201).json({
      ...order,
      items: orderItems,
      delivery: null,
      delivery_error: null,
    });
  } catch (err) {
    console.error('[kiosk/orders/send-to-delivery] error', err);
    res.status(500).json({ error: 'Failed to create delivery order' });
  }
});

// Bounds on retrying a dispatch that failed *after* the customer already paid.
// The payload survives a failure (see below), so without a cap the status poll
// would re-hit Uber on every tick.
const MAX_DISPATCH_ATTEMPTS = 3;
const DISPATCH_RETRY_COOLDOWN_MS = 60_000;

// Why a failed dispatch may be retried automatically. A 4xx means Uber rejected
// the booking outright — declined card, bad address — so nothing was created and
// re-sending is safe. A timeout or 5xx leaves it unknown whether a courier was
// assigned, and a second one is a second real charge, so those are parked for a
// human (sentinel S4 raises them) instead of retried.
function retryBlockReason(payload) {
  if (payload.retry_safe === false) {
    return 'dispatch outcome unknown — needs manual review';
  }
  const attempts = Number(payload.attempts || 0);
  if (attempts >= MAX_DISPATCH_ATTEMPTS) {
    return `${attempts} attempts exhausted`;
  }
  const lastAt = payload.last_attempt_at ? Date.parse(payload.last_attempt_at) : 0;
  if (lastAt && Date.now() - lastAt < DISPATCH_RETRY_COOLDOWN_MS) {
    return 'cooling down between attempts';
  }
  return null;
}

// Internal helper: book the deferred Uber Direct courier for `orderId` after
// the customer has paid by card. Idempotent — if the row is already dispatched
// we just return whatever's already there. A failed attempt keeps its
// pending_dispatch payload so the next poll (or sentinel P5) can re-book;
// clearing it used to strand a paid order with no way to dispatch at all.
// `force` skips the auto-retry guards for an operator who has decided to
// re-book by hand — the cap and the retry-safety check exist to stop the poll
// loop from spending money unattended, not to overrule a human looking at the
// Uber dashboard. Returns { delivery, delivery_error }. Never throws.
export async function dispatchPendingCourier(orderId, tenantId, { force = false } = {}) {
  try {
    const [row] = await adminSql`
      SELECT id, platform_status, pending_dispatch, external_order_id, tracking_url,
             delivery_fee
      FROM delivery_orders
      WHERE tenant_id = ${tenantId} AND order_id = ${orderId}
    `;
    if (!row) return { delivery: null, delivery_error: null };

    const payload = row.pending_dispatch || {};
    const isRetry = row.platform_status === 'dispatch_failed' && !!row.pending_dispatch;

    // Already dispatched, never deferred, or a legacy failure whose payload was
    // discarded before this path preserved it — return the existing shape.
    if (row.platform_status !== 'pending_payment' && !isRetry) {
      return {
        delivery: row.external_order_id
          ? {
              delivery_order_id: row.id,
              external_id: row.external_order_id,
              tracking_url: row.tracking_url,
              status: row.platform_status,
              fee: Number(row.delivery_fee || 0),
              dropoff_eta: null,
            }
          : null,
        delivery_error: row.platform_status === 'dispatch_failed'
          ? 'Courier dispatch previously failed'
          : null,
      };
    }

    // A prior attempt failed and the payload survived. Re-book only when it's
    // safe and we haven't burned through the attempt budget.
    if (isRetry && !force) {
      const blocked = retryBlockReason(payload);
      if (blocked) {
        return {
          delivery: null,
          delivery_error: payload.last_error
            ? `${payload.last_error} (${blocked})`
            : `Courier dispatch failed (${blocked})`,
        };
      }
    }

    const items = await adminSql`
      SELECT item_name, quantity, unit_price
      FROM order_items
      WHERE tenant_id = ${tenantId} AND order_id = ${orderId} AND voided_at IS NULL
    `;
    const [orderHead] = await adminSql`
      SELECT total FROM orders WHERE tenant_id = ${tenantId} AND id = ${orderId}
    `;
    const manifestItems = items.map((it) => ({
      name: it.item_name,
      quantity: it.quantity,
      price: Math.round(Number(it.unit_price || 0) * 100),
    }));

    let delivery = null;
    let deliveryError = null;
    let retrySafe = false;
    try {
      delivery = await uberDirectCreateDelivery(tenantId, {
        quote_id: payload.quote_id || undefined,
        pickup_name: payload.pickup_name,
        pickup_address: payload.pickup_address,
        pickup_phone_number: payload.pickup_phone_number,
        dropoff_name: payload.dropoff_name,
        dropoff_address: payload.dropoff_address,
        dropoff_phone_number: payload.dropoff_phone_number,
        dropoff_notes: payload.dropoff_notes || undefined,
        manifest_items: manifestItems,
        manifest_total_value: Math.round(Number(orderHead?.total || 0) * 100),
        external_id: String(orderId),
      });
    } catch (err) {
      deliveryError = err.data?.message || err.message || 'Failed to dispatch courier';
      // Only a definitive rejection proves no courier was created — see
      // retryBlockReason() for why anything else is parked rather than retried.
      retrySafe = err.status >= 400 && err.status < 500;
      console.error(
        `[kiosk/dispatchPendingCourier] dispatch failed (status=${err.status ?? 'none'}, ` +
        `retry_safe=${retrySafe}):`, deliveryError
      );
    }

    if (delivery) {
      await adminSql`
        UPDATE delivery_orders
        SET external_order_id = ${delivery.id || null},
            platform_status = ${delivery.status || 'pending'},
            delivery_fee = ${(delivery.fee || 0) / 100},
            tracking_url = ${delivery.tracking_url || null},
            courier_name = ${delivery.courier?.name || null},
            courier_phone = ${delivery.courier?.phone_number || null},
            courier_vehicle = ${delivery.courier?.vehicle_type || null},
            raw_webhook_data = ${JSON.stringify(delivery)},
            pending_dispatch = NULL
        WHERE tenant_id = ${tenantId} AND id = ${row.id}
      `;
    } else {
      // Keep the payload — it's the only copy of the dropoff details, and the
      // customer has already paid. Attempt bookkeeping rides along in the same
      // JSONB so this needs no extra column.
      const nextPayload = {
        ...payload,
        attempts: Number(payload.attempts || 0) + 1,
        last_error: deliveryError,
        last_attempt_at: new Date().toISOString(),
        retry_safe: retrySafe,
      };
      await adminSql`
        UPDATE delivery_orders
        SET platform_status = 'dispatch_failed',
            pending_dispatch = ${nextPayload}
        WHERE tenant_id = ${tenantId} AND id = ${row.id}
      `;
    }

    return {
      delivery: delivery
        ? {
            delivery_order_id: row.id,
            external_id: delivery.id,
            tracking_url: delivery.tracking_url,
            status: delivery.status,
            fee: (delivery.fee || 0) / 100,
            dropoff_eta: delivery.dropoff_eta,
          }
        : null,
      delivery_error: deliveryError,
    };
  } catch (err) {
    console.error('[kiosk/dispatchPendingCourier] unexpected:', err);
    return { delivery: null, delivery_error: 'Internal dispatch error' };
  }
}

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
router.get('/orders/open', verifyKioskToken, requireKioskPlan, async (req, res) => {
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
    // Strip LIKE wildcards so user input is treated as literal text in the
    // prefix match below. Names don't contain % or _, so this is defensive.
    const lowName = rawName.slice(0, 40).toLowerCase().replace(/[%_]/g, '');
    // Prefix match (stored starts with input) so "Test" finds "TEST2" and
    // "Juan" finds "Juan Pérez". Disambiguator UI + 6h window + LIMIT 5
    // contain the false-positive surface.
    const matchFilter = loyaltyCustomerId
      ? adminSql`o.loyalty_customer_id = ${loyaltyCustomerId}`
      : adminSql`(
          (o.loyalty_customer_id IS NULL
             AND unaccent(LOWER(o.customer_call_name)) LIKE unaccent(${lowName}) || '%')
          OR
          (o.loyalty_customer_id IS NOT NULL
             AND lc.id IS NOT NULL
             AND (
               unaccent(LOWER(SPLIT_PART(lc.name, ' ', 1))) LIKE unaccent(${lowName}) || '%'
               OR unaccent(LOWER(lc.name)) LIKE unaccent(${lowName}) || '%'
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
router.get('/orders/active', verifyKioskToken, requireKioskPlan, async (req, res) => {
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
router.post('/orders/:id/resume', verifyKioskToken, requireKioskPlan, async (req, res) => {
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

// GET /api/kiosk/mp/terminals — list MP Point devices in PDV mode.
// Used by the kiosk settings screen so an admin can pair this specific kiosk
// to its own terminal (e.g., two kiosks at the counter, two terminals).
router.get('/mp/terminals', verifyKioskToken, async (req, res) => {
  const tenantId = req.kioskTenantId;
  try {
    const tenant = await getTenant(tenantId);
    if (tenant?.plan !== 'pro') return res.status(403).json({ error: 'Mercado Pago Point requires Pro' });
    if (!tenant?.mp_access_token) return res.status(400).json({ error: 'Mercado Pago not connected' });
    const accessToken = await ensureFreshToken(tenant, adminSql);
    const terminals = await mpGetTerminals(accessToken);
    // No tenant-level fallback: each kiosk device must pair to its nearest
    // terminal. Unpaired = charge attempts fail with a "pair this kiosk"
    // prompt instead of silently routing to the wrong terminal.
    res.json({
      terminals,
      default_terminal_id: null,
    });
  } catch (err) {
    console.error('[kiosk/mp/terminals] error', err);
    res.status(500).json({ error: 'Failed to fetch terminals' });
  }
});

// POST /api/kiosk/orders/:id/mp-charge — push kiosk order to a Mercado Pago terminal.
// Body: { terminal_id? } — when present, charges the device this kiosk is paired
// to. Falls back to the tenant default for un-bound kiosks.
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

    const requested = typeof req.body?.terminal_id === 'string' ? req.body.terminal_id.trim() : '';
    const termId = requested;
    if (!termId) return res.status(400).json({ error: 'Pair this kiosk to a terminal first', code: 'terminal_unpaired' });

    const lock = await findActiveTerminalLock(tenantId, {
      excludeOrderId: order.id,
      terminalId: termId,
    });
    if (lock) {
      return res.status(409).json({
        error: `Terminal en uso — orden #${lock.order_number} en proceso. Inténtalo en unos segundos.`,
        code: 'terminal_busy',
        current_order_number: String(lock.order_number),
      });
    }

    const chargeAmount = Number(order.total);
    if (chargeAmount < MP_POINT_MIN_AMOUNT) {
      return res.status(400).json({
        error: `El monto mínimo para terminal es $${MP_POINT_MIN_AMOUNT.toFixed(2)} MXN. Paga en caja.`,
        code: 'amount_below_min',
        min_amount: MP_POINT_MIN_AMOUNT,
      });
    }

    const accessToken = await ensureFreshToken(tenant, adminSql);
    const mpOrder = await createPointOrder(accessToken, {
      amount: chargeAmount,
      externalRef: `${tenantId}-${order.id}`,
      terminalId: termId,
    });

    await adminSql`
      UPDATE orders
      SET mp_order_id = ${mpOrder.id},
          mp_terminal_id = ${termId},
          payment_status = 'pending_terminal',
          payment_method = 'card'
      WHERE tenant_id = ${tenantId} AND id = ${order.id}
    `;

    res.json({ success: true, mp_order_id: mpOrder.id, payment_status: 'pending_terminal' });
  } catch (err) {
    console.error('[kiosk/mp-charge] error', err);
    const { status, payload } = parseMpError(err);
    res.status(status).json(payload);
  }
});

// GET /api/kiosk/orders/:id/status — poll payment state for kiosk order
router.get('/orders/:id/status', verifyKioskToken, async (req, res) => {
  const tenantId = req.kioskTenantId;
  const orderId = Number(req.params.id);
  try {
    const [order] = await adminSql`
      SELECT id, order_number, total, payment_status, mp_order_id, mp_terminal_id, invoice_token
      FROM orders
      WHERE tenant_id = ${tenantId} AND id = ${orderId} AND source = 'customer_kiosk'
    `;
    if (!order) return res.status(404).json({ error: 'Order not found' });

    let paymentStatus = order.payment_status;
    let invoiceToken = order.invoice_token || null;
    let justPaid = false;

    if (paymentStatus === 'pending_terminal' && order.mp_order_id) {
      const tenant = await getTenant(tenantId);
      if (tenant?.mp_access_token) {
        const accessToken = await ensureFreshToken(tenant, adminSql);
        // Use the terminal stamped on the order (legacy MP payment-intents
        // require it; new /v1/orders ignores it). Fall back to the tenant
        // default for any pre-migration rows.
        const lookupTerminal = order.mp_terminal_id || tenant.mp_default_terminal_id;
        const mpOrder = await getPointOrder(accessToken, order.mp_order_id, lookupTerminal);
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
          justPaid = true;
        } else if (mapped === 'failed') {
          await adminSql`
            UPDATE orders SET payment_status = 'failed', status = 'cancelled'
            WHERE tenant_id = ${tenantId} AND id = ${order.id}
          `;
          paymentStatus = 'failed';
        }
      }
    }

    // Delivery orders defer the Uber Direct courier booking until the card
    // clears. Run on the tick that flips us to paid AND on subsequent polls
    // while a retryable failure is on the row — dispatchPendingCourier owns
    // the attempt cap and cooldown, so calling it every tick is cheap and
    // a transient rejection re-books while the customer is still standing there.
    let delivery = null;
    let deliveryError = null;
    if (paymentStatus === 'paid') {
      const result = await dispatchPendingCourier(order.id, tenantId);
      delivery = result.delivery;
      deliveryError = result.delivery_error;
    }

    res.json({
      id: order.id,
      order_number: order.order_number,
      total: Number(order.total),
      payment_status: paymentStatus,
      invoice_token: invoiceToken,
      delivery,
      delivery_error: deliveryError,
      just_paid: justPaid,
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
router.post('/identify', verifyKioskToken, requireKioskPlan, async (req, res) => {
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

// POST /api/kiosk/orders/:orderId/loyalty-join-url — mints a signed public
// URL the kiosk embeds in a post-payment QR. Anyone with the URL can enroll
// their phone against this order (idempotent — see loyalty-join-public.js).
// Used on the confirmation screen for un-identified customers.
router.post('/orders/:orderId/loyalty-join-url', verifyKioskToken, requireKioskPlan, async (req, res) => {
  const tenantId = req.kioskTenantId;
  const orderId = Number(req.params.orderId);
  if (!Number.isFinite(orderId)) {
    return res.status(400).json({ error: 'orderId inválido' });
  }
  try {
    const [order] = await adminSql`
      SELECT id FROM orders WHERE id = ${orderId} AND tenant_id = ${tenantId} LIMIT 1
    `;
    if (!order) return res.status(404).json({ error: 'Orden no encontrada' });

    const token = jwt.sign(
      { type: 'loyalty_join', tenantId, orderId },
      JWT_SECRET,
      { expiresIn: '7d' },
    );

    const tenant = await getTenant(tenantId);
    const host = tenant?.subdomain
      ? `${tenant.subdomain}.desktop.kitchen`
      : req.get('host');
    res.json({ join_url: `https://${host}/#/loyalty/join/${token}` });
  } catch (err) {
    console.error('[kiosk/loyalty-join-url] error', err);
    res.status(500).json({ error: 'No se pudo generar el enlace' });
  }
});

// POST /api/kiosk/wallet-enroll — Apple Wallet pass QR for the identified
// customer, shown on the order-confirmation screen.
//
// Body: { customer_token } (the JWT issued by /identify)
// Returns { available:false } when the platform has no Apple cert configured,
// else { available:true, enroll_url } — a capability URL the customer scans
// with their phone camera.
//
// enroll_url is built from the TENANT's subdomain, not req.get('host'):
// kiosks talk to the platform host (VITE_API_BASE=pos.desktop.kitchen), but
// the pass download must resolve tenant + RLS via the tenant's own subdomain.
router.post('/wallet-enroll', verifyKioskToken, requireKioskPlan, async (req, res) => {
  const tenantId = req.kioskTenantId;
  try {
    if (!isAppleWalletConfigured()) {
      return res.json({ available: false });
    }

    const customerId = verifyCustomerToken(req.body?.customer_token, tenantId);
    if (!customerId) {
      return res.status(401).json({ error: 'Sesión de cliente inválida' });
    }

    const tenant = await getTenant(tenantId);
    const host = tenant?.subdomain
      ? `${tenant.subdomain}.desktop.kitchen`
      : req.get('host');

    const { pass, registered } = await withTenant(tenantId, async () => {
      const result = await ensureApplePass(customerId);
      // If any device already holds this pass, the kiosk skips the QR —
      // repeat customers shouldn't be nagged to re-add a card they carry.
      const reg = await get(
        'SELECT COUNT(*)::int AS n FROM wallet_registrations WHERE pass_id = $1',
        [result.pass.id]
      );
      return { ...result, registered: (reg?.n || 0) > 0 };
    });

    res.json({
      available: true,
      registered,
      enroll_url: `https://${host}/api/wallet/p/${pass.enroll_token}`,
    });
  } catch (err) {
    console.error('[kiosk/wallet-enroll] error', err);
    res.status(500).json({ error: 'No se pudo generar la tarjeta digital' });
  }
});

// GET /api/kiosk/modifier-map — full {menu_item_id: ModifierGroup[]} map for the kiosk
// so the customer-facing modal opens instantly without per-tap network calls.
router.get('/modifier-map', verifyKioskToken, requireKioskPlan, async (req, res) => {
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

// GET /api/kiosk/config — returns { mode: 'grid' | 'wizard' } for this device.
// Effective mode = device override (if any) ?? tenant.kiosk_mode ?? 'grid'.
// Polled by the kiosk on attract cycle so a super-admin flip propagates within
// one cycle without requiring a rebind or APK reinstall.
router.get('/config', verifyKioskToken, async (req, res) => {
  const tenantId = req.kioskTenantId;
  try {
    let deviceOverride = null;
    if (req.kioskDeviceId) {
      const rows = await adminSql`
        SELECT kiosk_mode_override FROM kiosk_devices
        WHERE id = ${req.kioskDeviceId} AND tenant_id = ${tenantId} AND revoked_at IS NULL
      `;
      if (rows.length) deviceOverride = rows[0].kiosk_mode_override;
    }
    const [tenantRow] = await adminSql`
      SELECT kiosk_mode FROM tenants WHERE id = ${tenantId}
    `;
    const tenantMode = tenantRow?.kiosk_mode || 'grid';
    const mode = deviceOverride || tenantMode;
    res.json({ mode, device_override: deviceOverride, tenant_mode: tenantMode });
  } catch (err) {
    console.error('[kiosk/config] error', err);
    res.status(500).json({ error: 'Failed to load kiosk config' });
  }
});

// GET /api/kiosk/builder-menu — items + groups + options for the burrito-builder
// wizard, keyed by slug via kiosk_builder_map. Gated on effective mode = wizard
// (matches /config resolution) so this endpoint 404s for grid-mode devices and
// can't be scraped. Uses adminSql to bypass the active=true filter, because
// Phase 1 seeded every builder item as active=false to keep them off grid/QR/POS.
router.get('/builder-menu', verifyKioskToken, requireKioskPlan, async (req, res) => {
  const tenantId = req.kioskTenantId;
  try {
    // Effective mode check — same logic as /config, inlined so we don't need a
    // second network round-trip from the client.
    let effectiveMode = 'grid';
    if (req.kioskDeviceId) {
      const rows = await adminSql`
        SELECT kiosk_mode_override FROM kiosk_devices
        WHERE id = ${req.kioskDeviceId} AND tenant_id = ${tenantId} AND revoked_at IS NULL
      `;
      if (rows.length && rows[0].kiosk_mode_override) effectiveMode = rows[0].kiosk_mode_override;
    }
    if (effectiveMode !== 'wizard') {
      const [tenantRow] = await adminSql`SELECT kiosk_mode FROM tenants WHERE id = ${tenantId}`;
      effectiveMode = tenantRow?.kiosk_mode || 'grid';
    }
    if (effectiveMode !== 'wizard') {
      return res.status(404).json({ error: 'Builder menu not enabled for this device' });
    }

    const slugMap = await adminSql`
      SELECT slug, menu_item_id FROM kiosk_builder_map WHERE tenant_id = ${tenantId}
    `;
    if (slugMap.length === 0) {
      return res.status(404).json({ error: 'No builder items configured for this tenant' });
    }
    const itemIds = slugMap.map((r) => Number(r.menu_item_id));
    const slugByItemId = new Map(slugMap.map((r) => [Number(r.menu_item_id), r.slug]));

    const items = await adminSql`
      SELECT id, name, name_en, price, description, description_en, sort_order
      FROM menu_items
      WHERE tenant_id = ${tenantId} AND id = ANY(${itemIds})
      ORDER BY sort_order, id
    `;

    // Groups + options in one query, joined via menu_item_modifier_groups.
    // The `Group__slug` naming convention from the Phase 1 seed lets the
    // client split display name from internal slug.
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
        AND mimg.menu_item_id = ANY(${itemIds})
      ORDER BY mimg.menu_item_id, mg.sort_order, m.sort_order
    `;

    // Split "Estilo__asada" → { kind: 'Estilo', slug: 'asada' }
    function splitGroupName(raw) {
      const i = raw.indexOf('__');
      if (i < 0) return { kind: raw, slug: null };
      return { kind: raw.slice(0, i), slug: raw.slice(i + 2) };
    }

    const groupCache = new Map();
    const groupsByItem = new Map();
    for (const row of rows) {
      const itemId = Number(row.menu_item_id);
      if (!groupsByItem.has(itemId)) groupsByItem.set(itemId, []);
      const cacheKey = `${itemId}:${row.group_id}`;
      let group = groupCache.get(cacheKey);
      if (!group) {
        const { kind, slug } = splitGroupName(row.group_name);
        group = {
          id: Number(row.group_id),
          kind,           // 'Estilo' | 'Segunda proteína' | 'Quitar' | 'Extras' | '¿Con birria o cochinita?'
          slug,           // 'asada' | 'pollo' | ... | 'rollbertos'
          name: row.group_name,
          selection_type: row.selection_type,
          required: !!row.required,
          min_selections: row.min_selections,
          max_selections: row.max_selections,
          options: [],
        };
        groupCache.set(cacheKey, group);
        groupsByItem.get(itemId).push(group);
      }
      group.options.push({
        id: Number(row.modifier_id),
        name: row.modifier_name,
        price_adjustment: Number(row.price_adjustment),
      });
    }

    const payload = items.map((it) => ({
      id: Number(it.id),
      slug: slugByItemId.get(Number(it.id)) || null,
      name: it.name,
      name_en: it.name_en || null,
      description: it.description || null,
      description_en: it.description_en || null,
      price: Number(it.price),
      groups: groupsByItem.get(Number(it.id)) || [],
    }));

    // Sides + drinks for the "¿Deseas agregar algo?" step (prototype v12, D5).
    // Curated per tenant in kiosk_addon_map rather than read from a category —
    // see migration 0096 for why. These are ordinary active menu items, so the
    // client adds them as their own cart lines through the normal path; an
    // item deactivated in Menu Management drops out here automatically.
    const addonRows = await adminSql`
      SELECT kam.section, kam.sort_order, mi.id, mi.name, mi.name_en, mi.price, mi.image_url
      FROM kiosk_addon_map kam
      JOIN menu_items mi
        ON mi.id = kam.menu_item_id AND mi.tenant_id = kam.tenant_id AND mi.active = true
      WHERE kam.tenant_id = ${tenantId}
      ORDER BY kam.section, kam.sort_order, mi.name
    `;
    const addons = { sides: [], drinks: [] };
    for (const row of addonRows) {
      const bucket = row.section === 'side' ? addons.sides : addons.drinks;
      bucket.push({
        id: Number(row.id),
        name: row.name,
        name_en: row.name_en || null,
        price: Number(row.price),
        image_url: row.image_url || null,
      });
    }

    res.json({ items: payload, addons });
  } catch (err) {
    console.error('[kiosk/builder-menu] error', err);
    res.status(500).json({ error: 'Failed to load builder menu' });
  }
});

// GET /api/kiosk/popular — time-of-day popular items (anonymous customers)
router.get('/popular', verifyKioskToken, requireKioskPlan, async (req, res) => {
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
router.post('/suggestion-event', verifyKioskToken, requireKioskPlan, async (req, res) => {
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
