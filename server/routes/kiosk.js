import { Router } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import rateLimit from 'express-rate-limit';
import { adminSql } from '../db/index.js';
import { JWT_SECRET } from '../lib/constants.js';
import { getTenant } from '../tenants.js';
import { deductInventoryForOrder } from '../helpers/inventory.js';
import { generateInvoiceToken } from '../helpers/facturapi.js';
import {
  ensureFreshToken,
  createPointOrder,
  getPointOrder,
  mapPointOrderStatus,
} from '../services/mercadopago.js';

const router = Router();
const TAX_RATE = 0.16;

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

async function markKioskOrderPaid(orderId, tenantId) {
  await adminSql`
    UPDATE orders
    SET payment_status = 'paid',
        status = 'preparing',
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
    const { items, payment_choice = 'counter_cash' } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Cart is empty' });
    }

    const employeeId = await resolveKioskEmployee(tenantId, req.kiosk);
    if (!employeeId) {
      return res.status(400).json({ error: 'No active employee available for kiosk orders' });
    }

    const menuIds = items.map((item) => Number(item.menu_item_id)).filter(Number.isInteger);
    if (menuIds.length !== items.length) {
      return res.status(400).json({ error: 'Invalid menu item' });
    }

    const menuRows = await adminSql.unsafe(`
      SELECT id, name, price
      FROM menu_items
      WHERE tenant_id = $1 AND active = true AND id = ANY($2::int[])
    `, [tenantId, menuIds]);
    const menuById = new Map(menuRows.map((row) => [Number(row.id), row]));

    const orderItems = [];
    let total = 0;
    for (const item of items) {
      const menuItem = menuById.get(Number(item.menu_item_id));
      const quantity = Math.max(1, Math.min(20, Number(item.quantity) || 0));
      if (!menuItem) return res.status(404).json({ error: `Menu item ${item.menu_item_id} not found` });

      const unitPrice = Number(menuItem.price);
      total += unitPrice * quantity;
      orderItems.push({
        menu_item_id: Number(menuItem.id),
        item_name: menuItem.name,
        quantity,
        unit_price: unitPrice,
      });
    }

    total = Math.round(total * 100) / 100;
    const tax = Math.round((total - total / (1 + TAX_RATE)) * 100) / 100;
    const subtotal = Math.round((total - tax) * 100) / 100;
    const orderNumber = await nextOrderNumber(tenantId);
    const paymentStatus = 'unpaid';
    const paymentMethod = payment_choice === 'counter_cash' ? null : 'card';

    const [order] = await adminSql`
      INSERT INTO orders (
        tenant_id, order_number, employee_id, status, subtotal, tax, total,
        payment_status, payment_method, source
      )
      VALUES (
        ${tenantId}, ${orderNumber}, ${employeeId}, 'pending', ${subtotal}, ${tax}, ${total},
        ${paymentStatus}, ${paymentMethod}, 'customer_kiosk'
      )
      RETURNING id, order_number, subtotal, tax, total, payment_status, status
    `;

    const values = orderItems.map((_, i) => {
      const o = i * 7;
      return `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7})`;
    }).join(',');
    const params = orderItems.flatMap((item) => [
      tenantId, order.id, item.menu_item_id, item.item_name, item.quantity, item.unit_price, null,
    ]);
    await adminSql.unsafe(`
      INSERT INTO order_items (
        tenant_id, order_id, menu_item_id, item_name, quantity, unit_price, notes
      )
      VALUES ${values}
    `, params);

    res.status(201).json({ ...order, source: 'customer_kiosk', items: orderItems });
  } catch (err) {
    console.error('[kiosk/orders] error', err);
    res.status(500).json({ error: 'Failed to create kiosk order' });
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

export default router;
