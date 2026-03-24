import { Router } from 'express';
import crypto from 'crypto';
import { all, get, run, getConn, getTenantId } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { getPlanLimits, requirePlanFeature } from '../planLimits.js';
import { getServiceCredentials } from '../helpers/tenantCredentials.js';
import {
  verifyWebhookSignature as verifyUberSignature,
  getAccessToken as getUberToken,
  fetchOrder as fetchUberOrder,
  acceptOrder as acceptUberOrder,
  denyOrder as denyUberOrder,
  cancelUberOrder,
} from '../services/uber-eats.js';
import {
  verifyRappiSignature,
  getAccessToken as getRappiToken,
  takeOrder as takeRappiOrder,
  rejectOrder as rejectRappiOrder,
  markReadyForPickup as rappiReadyForPickup,
} from '../services/rappi.js';
import {
  verifyDidiSignature,
  getAccessToken as getDidiToken,
  confirmOrder as confirmDidiOrder,
  cancelDidiOrder,
} from '../services/didi-food.js';

const router = Router();
const TAX_RATE = 0.16; // 16% IVA (Mexico) — prices include tax

// ==================== Platform & Order CRUD ====================

// GET /api/delivery/platforms - list delivery platforms
router.get('/platforms', async (req, res) => {
  try {
    const platforms = await all('SELECT * FROM delivery_platforms ORDER BY display_name');
    res.json(platforms);
  } catch (error) {
    console.error('Error fetching delivery platforms:', error);
    res.status(500).json({ error: 'Failed to fetch delivery platforms' });
  }
});

// PUT /api/delivery/platforms/:id - update delivery platform
router.put('/platforms/:id', requireAuth('manage_delivery'), requirePlanFeature('delivery'), async (req, res) => {
  try {
    const { id } = req.params;
    const { display_name, commission_percent, active, webhook_secret } = req.body;

    const platform = await get('SELECT * FROM delivery_platforms WHERE id = $1', [id]);
    if (!platform) return res.status(404).json({ error: 'Platform not found' });

    await run(
      'UPDATE delivery_platforms SET display_name = $1, commission_percent = $2, active = $3, webhook_secret = $4 WHERE id = $5',
      [
        display_name ?? platform.display_name,
        commission_percent ?? platform.commission_percent,
        active !== undefined ? active : platform.active,
        webhook_secret ?? platform.webhook_secret,
        id,
      ]
    );

    res.json({ id, success: true });
  } catch (error) {
    console.error('Error updating delivery platform:', error);
    res.status(500).json({ error: 'Failed to update delivery platform' });
  }
});

// POST /api/delivery/platforms/batch - batch upsert delivery platforms (onboarding)
router.post('/platforms/batch', requireAuth('manage_delivery'), async (req, res) => {
  try {
    const { platforms } = req.body;
    if (!Array.isArray(platforms) || platforms.length === 0) {
      return res.status(400).json({ error: 'platforms array is required' });
    }

    const tenantId = getTenantId();
    let created = 0;
    let updated = 0;

    for (const p of platforms) {
      if (!p.name || !p.display_name) continue;

      const existing = await get(
        'SELECT id FROM delivery_platforms WHERE name = $1',
        [p.name]
      );

      if (existing) {
        await run(
          `UPDATE delivery_platforms SET display_name = $1, commission_percent = $2, default_markup_percent = $3 WHERE id = $4`,
          [p.display_name, p.commission_percent ?? 0, p.default_markup_percent ?? 0, existing.id]
        );
        updated++;
      } else {
        await run(
          `INSERT INTO delivery_platforms (tenant_id, name, display_name, commission_percent, default_markup_percent, active)
           VALUES ($1, $2, $3, $4, $5, true)`,
          [tenantId, p.name, p.display_name, p.commission_percent ?? 0, p.default_markup_percent ?? 0]
        );
        created++;
      }
    }

    res.json({ success: true, platforms_created: created, platforms_updated: updated });
  } catch (error) {
    console.error('Error batch creating delivery platforms:', error);
    res.status(500).json({ error: 'Failed to batch create delivery platforms' });
  }
});

// GET /api/delivery/orders - list delivery orders
router.get('/orders', async (req, res) => {
  try {
    const { status } = req.query;
    let query = `
      SELECT do2.*, dp.display_name as platform_name, o.order_number, o.status as order_status, o.total
      FROM delivery_orders do2
      JOIN delivery_platforms dp ON do2.platform_id = dp.id
      JOIN orders o ON do2.order_id = o.id
    `;
    const params = [];
    let paramIdx = 1;

    if (status) {
      query += ` WHERE do2.platform_status = $${paramIdx++}`;
      params.push(status);
    }

    query += ' ORDER BY do2.id DESC LIMIT 50';

    const orders = await all(query, params);
    res.json(orders);
  } catch (error) {
    console.error('Error fetching delivery orders:', error);
    res.status(500).json({ error: 'Failed to fetch delivery orders' });
  }
});

// GET /api/delivery/orders/active - active delivery orders for POS alert banner
router.get('/orders/active', async (req, res) => {
  try {
    const orders = await all(
      `SELECT do2.*, dp.display_name as platform_name,
              o.order_number, o.status as order_status, o.total
       FROM delivery_orders do2
       JOIN delivery_platforms dp ON do2.platform_id = dp.id
       JOIN orders o ON do2.order_id = o.id
       WHERE do2.platform_status IN ('received', 'accepted')
         AND o.status NOT IN ('completed', 'cancelled')
       ORDER BY do2.created_at ASC
       LIMIT 20`
    );
    res.json(orders);
  } catch (error) {
    console.error('Error fetching active delivery orders:', error);
    res.status(500).json({ error: 'Failed to fetch active delivery orders' });
  }
});

// PUT /api/delivery/orders/:id/status - update delivery order status
router.put('/orders/:id/status', requireAuth('manage_delivery'), requirePlanFeature('delivery'), async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const order = await get('SELECT * FROM delivery_orders WHERE id = $1', [id]);
    if (!order) return res.status(404).json({ error: 'Delivery order not found' });

    await run('UPDATE delivery_orders SET platform_status = $1 WHERE id = $2', [status, id]);
    res.json({ id, status, success: true });
  } catch (error) {
    console.error('Error updating delivery order status:', error);
    res.status(500).json({ error: 'Failed to update delivery order status' });
  }
});

// ==================== Accept / Deny / Cancel endpoints ====================

// POST /api/delivery/orders/:id/accept - accept a delivery order on the platform
router.post('/orders/:id/accept', requireAuth('manage_delivery'), async (req, res) => {
  try {
    const { id } = req.params;
    const deliveryOrder = await get(
      `SELECT do2.*, dp.name as platform_name
       FROM delivery_orders do2
       JOIN delivery_platforms dp ON do2.platform_id = dp.id
       WHERE do2.id = $1`,
      [id]
    );
    if (!deliveryOrder) return res.status(404).json({ error: 'Delivery order not found' });

    const tenantId = req.tenant?.id;
    if (tenantId) {
      if (deliveryOrder.platform_name === 'uber_eats') {
        const token = await getUberToken(tenantId);
        await acceptUberOrder(token, deliveryOrder.external_order_id, {
          reason: req.body.reason || 'Accepted by POS',
        });
      } else if (deliveryOrder.platform_name === 'rappi') {
        const creds = await getServiceCredentials(tenantId, 'rappi', { store_id: '' });
        const token = await getRappiToken(tenantId);
        await takeRappiOrder(token, creds.store_id, deliveryOrder.external_order_id, req.body.cooking_time);
      } else if (deliveryOrder.platform_name === 'didi_food') {
        const token = await getDidiToken(tenantId);
        await confirmDidiOrder(token, deliveryOrder.external_order_id);
      }
    }

    await run('UPDATE delivery_orders SET platform_status = $1 WHERE id = $2', ['accepted', id]);
    await run('UPDATE orders SET status = $1 WHERE id = $2', ['confirmed', deliveryOrder.order_id]);

    res.json({ id, status: 'accepted', success: true });
  } catch (error) {
    console.error('Error accepting delivery order:', error);
    res.status(500).json({ error: 'Failed to accept delivery order' });
  }
});

// POST /api/delivery/orders/:id/deny - deny a delivery order on the platform
router.post('/orders/:id/deny', requireAuth('manage_delivery'), async (req, res) => {
  try {
    const { id } = req.params;
    const { explanation, code } = req.body;

    const deliveryOrder = await get(
      `SELECT do2.*, dp.name as platform_name
       FROM delivery_orders do2
       JOIN delivery_platforms dp ON do2.platform_id = dp.id
       WHERE do2.id = $1`,
      [id]
    );
    if (!deliveryOrder) return res.status(404).json({ error: 'Delivery order not found' });

    const tenantId = req.tenant?.id;
    if (tenantId) {
      if (deliveryOrder.platform_name === 'uber_eats') {
        const token = await getUberToken(tenantId);
        await denyUberOrder(token, deliveryOrder.external_order_id, { explanation, code });
      } else if (deliveryOrder.platform_name === 'rappi') {
        const creds = await getServiceCredentials(tenantId, 'rappi', { store_id: '' });
        const token = await getRappiToken(tenantId);
        await rejectRappiOrder(
          token, creds.store_id, deliveryOrder.external_order_id,
          code || 'POS_INTERNAL_ERROR', explanation
        );
      } else if (deliveryOrder.platform_name === 'didi_food') {
        const token = await getDidiToken(tenantId);
        await cancelDidiOrder(token, deliveryOrder.external_order_id, explanation);
      }
    }

    await run('UPDATE delivery_orders SET platform_status = $1 WHERE id = $2', ['denied', id]);
    await run('UPDATE orders SET status = $1 WHERE id = $2', ['cancelled', deliveryOrder.order_id]);

    res.json({ id, status: 'denied', success: true });
  } catch (error) {
    console.error('Error denying delivery order:', error);
    res.status(500).json({ error: 'Failed to deny delivery order' });
  }
});

// POST /api/delivery/orders/:id/cancel - cancel an accepted delivery order
router.post('/orders/:id/cancel', requireAuth('manage_delivery'), async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const deliveryOrder = await get(
      `SELECT do2.*, dp.name as platform_name
       FROM delivery_orders do2
       JOIN delivery_platforms dp ON do2.platform_id = dp.id
       WHERE do2.id = $1`,
      [id]
    );
    if (!deliveryOrder) return res.status(404).json({ error: 'Delivery order not found' });

    const tenantId = req.tenant?.id;
    if (tenantId) {
      if (deliveryOrder.platform_name === 'uber_eats') {
        const token = await getUberToken(tenantId);
        await cancelUberOrder(token, deliveryOrder.external_order_id, reason);
      } else if (deliveryOrder.platform_name === 'didi_food') {
        const token = await getDidiToken(tenantId);
        await cancelDidiOrder(token, deliveryOrder.external_order_id, reason);
      }
      // Rappi doesn't support cancel-after-accept via API — order is cancelled locally only
    }

    await run('UPDATE delivery_orders SET platform_status = $1 WHERE id = $2', ['cancelled', id]);
    await run('UPDATE orders SET status = $1 WHERE id = $2', ['cancelled', deliveryOrder.order_id]);

    res.json({ id, status: 'cancelled', success: true });
  } catch (error) {
    console.error('Error cancelling delivery order:', error);
    res.status(500).json({ error: 'Failed to cancel delivery order' });
  }
});

// ==================== Order number generator ====================

async function generateOrderNumber() {
  const conn = getConn();
  const dateStr = new Date().toISOString().split('T')[0];
  const dateNum = parseInt(dateStr.replace(/-/g, '')) * 1000;

  const [row] = await conn.unsafe(`
    SELECT pg_advisory_xact_lock(hashtext($1::text)),
           COALESCE(MAX(order_number), $2::bigint) + 1 AS order_number
    FROM orders
    WHERE created_at::date = $1::date
  `, [dateStr, dateNum]);

  return row.order_number;
}

// ==================== Shared Helpers ====================

const PLATFORM_DEFAULTS = {
  uber_eats: { display_name: 'Uber Eats', commission_percent: 30 },
  rappi:     { display_name: 'Rappi',     commission_percent: 25 },
  didi_food: { display_name: 'DiDi Food', commission_percent: 25 },
};

/**
 * Find or create a delivery_platforms row by name.
 */
async function ensurePlatform(name) {
  let platform = await get(
    'SELECT * FROM delivery_platforms WHERE name = $1', [name]
  );
  if (!platform) {
    const defaults = PLATFORM_DEFAULTS[name] || { display_name: name, commission_percent: 0 };
    const result = await run(
      `INSERT INTO delivery_platforms (tenant_id, name, display_name, commission_percent, active)
       VALUES ($1, $2, $3, $4, true)`,
      [getTenantId(), name, defaults.display_name, defaults.commission_percent]
    );
    platform = await get('SELECT * FROM delivery_platforms WHERE id = $1', [result.lastInsertRowid]);
  }
  return platform;
}

/**
 * Find a system employee to attribute delivery orders to.
 */
async function findSystemEmployee() {
  return (
    await get("SELECT id FROM employees WHERE role = 'admin' AND active = true ORDER BY id LIMIT 1") ||
    await get("SELECT id FROM employees WHERE active = true ORDER BY id LIMIT 1")
  );
}

/**
 * Try to match a delivery item to a local menu item by name (case-insensitive)
 * or by SKU if provided.
 */
async function matchMenuItem(title, sku) {
  if (sku) {
    const byId = await get('SELECT id, name, price FROM menu_items WHERE id = $1', [sku]);
    if (byId) return byId;
  }
  if (!title) return null;
  return get(
    "SELECT id, name, price FROM menu_items WHERE LOWER(name) = LOWER($1) LIMIT 1",
    [title.trim()]
  );
}

/**
 * Process an Uber Eats order: fetch full details, create internal order + delivery_order,
 * and auto-accept on Uber.
 */
async function processUberOrder(tenantId, externalOrderId, rawWebhookData) {
  // Check for duplicate (idempotent)
  const existing = await get(
    "SELECT id FROM delivery_orders WHERE external_order_id = $1",
    [externalOrderId]
  );
  if (existing) {
    console.log(`[Uber Eats] Order ${externalOrderId} already processed (delivery_order ${existing.id})`);
    return { duplicate: true, delivery_order_id: existing.id };
  }

  // Fetch full order from Uber
  const token = await getUberToken(tenantId);
  const uberOrder = await fetchUberOrder(token, externalOrderId);

  const platform = await ensurePlatform('uber_eats');
  const employee = await findSystemEmployee();
  if (!employee) {
    throw new Error('No active employee found to attribute delivery order');
  }

  // Parse cart items from Uber order
  // Uber Eats format: uberOrder.cart.items[] with { title, quantity, price { unit_price { amount_e5 } }, special_instructions }
  // price amounts are in e5 format (100000 = $1.00) or cents depending on API version
  const cart = uberOrder.cart || uberOrder.order || {};
  const uberItems = cart.items || [];

  const orderItems = [];
  let itemsTotal = 0;

  for (const uberItem of uberItems) {
    const quantity = uberItem.quantity || 1;

    // Price resolution: Uber uses various formats
    // - price.unit_price.amount_e5 (e5 = amount * 100000)
    // - price.unit_price.amount (cents)
    // - price.base_unit_price.amount_e5
    // - selected_modifier_groups[].selected_items[].price
    let unitPrice = 0;
    const priceObj = uberItem.price || uberItem.selected_price || {};
    if (priceObj.unit_price?.amount_e5) {
      unitPrice = priceObj.unit_price.amount_e5 / 100000;
    } else if (priceObj.unit_price?.amount) {
      unitPrice = priceObj.unit_price.amount / 100;
    } else if (priceObj.base_unit_price?.amount_e5) {
      unitPrice = priceObj.base_unit_price.amount_e5 / 100000;
    } else if (priceObj.base_unit_price?.amount) {
      unitPrice = priceObj.base_unit_price.amount / 100;
    } else if (typeof uberItem.price === 'number') {
      unitPrice = uberItem.price / 100; // cents
    }

    // Add modifier prices
    const modifierGroups = uberItem.selected_modifier_groups || [];
    for (const group of modifierGroups) {
      for (const mod of (group.selected_items || [])) {
        const modPrice = mod.price?.unit_price?.amount_e5
          ? mod.price.unit_price.amount_e5 / 100000
          : mod.price?.unit_price?.amount
            ? mod.price.unit_price.amount / 100
            : 0;
        unitPrice += modPrice;
      }
    }

    const title = uberItem.title || uberItem.name || 'Uber Eats Item';
    const notes = uberItem.special_instructions || uberItem.special_request || null;

    // Try to match to local menu item
    const localItem = await matchMenuItem(title);

    orderItems.push({
      menu_item_id: localItem?.id || null,
      item_name: localItem?.name || title,
      quantity,
      unit_price: unitPrice > 0 ? unitPrice : (Number(localItem?.price) || 0),
      notes,
    });

    itemsTotal += (unitPrice > 0 ? unitPrice : (Number(localItem?.price) || 0)) * quantity;
  }

  // Calculate tax (prices include IVA)
  const total = itemsTotal;
  const tax = Math.round((total - total / (1 + TAX_RATE)) * 100) / 100;
  const subtotal = Math.round((total - tax) * 100) / 100;
  const orderNumber = await generateOrderNumber();

  // Create internal order
  const tid = getTenantId();
  const orderResult = await run(`
    INSERT INTO orders (tenant_id, order_number, employee_id, status, subtotal, tax, total, payment_status, payment_method, source)
    VALUES ($1, $2, $3, 'confirmed', $4, $5, $6, 'paid', 'uber_eats', 'uber_eats')
  `, [tid, orderNumber, employee.id, subtotal, tax, total]);

  const orderId = orderResult.lastInsertRowid;

  // Insert order items
  for (const item of orderItems) {
    await run(`
      INSERT INTO order_items (tenant_id, order_id, menu_item_id, item_name, quantity, unit_price, notes)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [tid, orderId, item.menu_item_id, item.item_name, item.quantity, item.unit_price, item.notes]);
  }

  // Parse delivery fee and commission from Uber
  const charges = uberOrder.charges || {};
  const deliveryFee = charges.delivery_fee?.amount_e5
    ? charges.delivery_fee.amount_e5 / 100000
    : charges.delivery_fee?.amount
      ? charges.delivery_fee.amount / 100
      : 0;
  const commission = total * (platform.commission_percent / 100);

  // Parse customer info
  const eater = uberOrder.eater || uberOrder.customer || {};
  const customerName = [eater.first_name, eater.last_name].filter(Boolean).join(' ') || null;
  const deliveryAddress = uberOrder.delivery_address?.formatted_address
    || uberOrder.dropoff?.address
    || null;

  // Create delivery_order record
  const deliveryResult = await run(`
    INSERT INTO delivery_orders (tenant_id, order_id, platform_id, external_order_id, platform_status, delivery_fee, platform_commission, customer_name, delivery_address, raw_webhook_data)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
  `, [
    tid,
    orderId,
    platform.id,
    externalOrderId,
    'received',
    deliveryFee,
    commission,
    customerName,
    deliveryAddress,
    rawWebhookData,
  ]);

  // Link delivery order to the internal order
  await run('UPDATE orders SET delivery_order_id = $1 WHERE id = $2', [
    deliveryResult.lastInsertRowid, orderId,
  ]);

  // Auto-accept on Uber Eats
  try {
    await acceptUberOrder(token, externalOrderId, {
      reason: 'Auto-accepted by POS',
      externalRef: String(orderId),
    });
    await run('UPDATE delivery_orders SET platform_status = $1 WHERE id = $2', [
      'accepted', deliveryResult.lastInsertRowid,
    ]);
    console.log(`[Uber Eats] Order ${externalOrderId} auto-accepted (internal order ${orderId})`);
  } catch (acceptErr) {
    console.error(`[Uber Eats] Auto-accept failed for ${externalOrderId}:`, acceptErr.message);
    // Order is still created locally — can be accepted manually from POS
  }

  return {
    order_id: orderId,
    order_number: orderNumber,
    delivery_order_id: deliveryResult.lastInsertRowid,
    items_count: orderItems.length,
    total,
  };
}

// POST /api/delivery/webhook/uber-eats - Uber Eats webhook
router.post('/webhook/uber-eats', async (req, res) => {
  try {
    const payload = req.body;
    const tenantId = req.tenant?.id;

    // Validate webhook signature using raw body
    if (tenantId) {
      const creds = await getServiceCredentials(tenantId, 'uber_eats', {
        client_secret: '',
      });
      if (creds.client_secret && req.rawBody) {
        const signature = req.headers['x-uber-signature'];
        if (!signature) {
          console.warn('[Uber Eats] Webhook missing x-uber-signature header');
          return res.status(403).json({ error: 'Missing webhook signature' });
        }
        if (!verifyUberSignature(req.rawBody, signature, creds.client_secret)) {
          console.warn('[Uber Eats] Webhook signature verification failed');
          return res.status(403).json({ error: 'Invalid webhook signature' });
        }
      }
    }

    // Respond quickly to Uber — they expect 200 within 10 seconds
    const eventType = payload.event_type || payload.type || '';
    const resourceId = payload.meta?.resource_id || payload.order_id || payload.resource_href?.split('/').pop();

    console.log(`[Uber Eats] Webhook: ${eventType}, resource: ${resourceId}`);

    if (!resourceId) {
      console.warn('[Uber Eats] Webhook missing resource_id');
      return res.json({ success: true, message: 'No resource ID — ignored' });
    }

    // Handle different event types
    switch (eventType) {
      case 'orders.notification': {
        // New order notification — fetch, create, and accept
        if (!tenantId) {
          console.warn('[Uber Eats] No tenant context for order processing');
          return res.status(400).json({ error: 'Tenant context required' });
        }

        const result = await processUberOrder(tenantId, resourceId, JSON.stringify(payload));
        console.log('[Uber Eats] Order processed:', result);
        return res.json({ success: true, ...result });
      }

      case 'orders.cancel': {
        // Uber/customer cancelled the order
        const deliveryOrder = await get(
          "SELECT id, order_id FROM delivery_orders WHERE external_order_id = $1",
          [resourceId]
        );
        if (deliveryOrder) {
          await run('UPDATE delivery_orders SET platform_status = $1 WHERE id = $2', [
            'cancelled_by_uber', deliveryOrder.id,
          ]);
          await run('UPDATE orders SET status = $1 WHERE id = $2', [
            'cancelled', deliveryOrder.order_id,
          ]);
          console.log(`[Uber Eats] Order ${resourceId} cancelled by Uber`);
        }
        return res.json({ success: true, message: 'Cancel processed' });
      }

      case 'orders.scheduled': {
        // Scheduled order — process like a new order
        if (tenantId) {
          const result = await processUberOrder(tenantId, resourceId, JSON.stringify(payload));
          console.log('[Uber Eats] Scheduled order processed:', result);
          return res.json({ success: true, ...result });
        }
        return res.json({ success: true, message: 'Scheduled order — no tenant context' });
      }

      default: {
        console.log(`[Uber Eats] Unhandled event type: ${eventType}`);
        return res.json({ success: true, message: `Event ${eventType} acknowledged` });
      }
    }
  } catch (error) {
    console.error('[Uber Eats] Webhook error:', error);
    // Return 200 even on error to prevent Uber from retrying indefinitely
    res.status(200).json({ success: false, error: 'Internal processing error' });
  }
});

// ==================== Rappi Webhook ====================

/**
 * Process a Rappi NEW_ORDER: parse items from webhook payload (full order included),
 * create internal order + delivery_order, and auto-accept on Rappi.
 */
async function processRappiOrder(tenantId, payload, rawWebhookData) {
  const orderDetail = payload.order_detail || {};
  const externalOrderId = String(orderDetail.order_id);

  // Idempotent dedup
  const existing = await get(
    "SELECT id FROM delivery_orders WHERE external_order_id = $1",
    [externalOrderId]
  );
  if (existing) {
    console.log(`[Rappi] Order ${externalOrderId} already processed (delivery_order ${existing.id})`);
    return { duplicate: true, delivery_order_id: existing.id };
  }

  const platform = await ensurePlatform('rappi');
  const employee = await findSystemEmployee();
  if (!employee) {
    throw new Error('No active employee found to attribute delivery order');
  }

  // Parse items — Rappi prices are in centavos (15000 = $150.00 MXN)
  const rappiItems = orderDetail.items || [];
  const orderItems = [];
  let itemsTotal = 0;

  for (const rappiItem of rappiItems) {
    if (rappiItem.type === 'TOPPING') continue; // toppings are subitems, handled below

    const quantity = rappiItem.quantity || 1;
    // Use discounted price if available, otherwise original price
    let unitPrice = (rappiItem.unit_price_with_discount ?? rappiItem.price ?? 0) / 100;

    // Add subitem (topping/modifier) prices
    const subitems = rappiItem.subitems || [];
    for (const sub of subitems) {
      unitPrice += (sub.price || 0) / 100 * (sub.quantity || 1);
    }

    const title = rappiItem.name || 'Rappi Item';
    const notes = rappiItem.comments || null;

    const localItem = await matchMenuItem(title, rappiItem.sku);

    orderItems.push({
      menu_item_id: localItem?.id || null,
      item_name: localItem?.name || title,
      quantity,
      unit_price: unitPrice > 0 ? unitPrice : (Number(localItem?.price) || 0),
      notes,
    });

    itemsTotal += (unitPrice > 0 ? unitPrice : (Number(localItem?.price) || 0)) * quantity;
  }

  // Calculate tax (prices include IVA)
  const total = itemsTotal;
  const tax = Math.round((total - total / (1 + TAX_RATE)) * 100) / 100;
  const subtotal = Math.round((total - tax) * 100) / 100;
  const orderNumber = await generateOrderNumber();

  // Create internal order
  const tid2 = getTenantId();
  const orderResult = await run(`
    INSERT INTO orders (tenant_id, order_number, employee_id, status, subtotal, tax, total, payment_status, payment_method, source)
    VALUES ($1, $2, $3, 'confirmed', $4, $5, $6, 'paid', 'rappi', 'rappi')
  `, [tid2, orderNumber, employee.id, subtotal, tax, total]);

  const orderId = orderResult.lastInsertRowid;

  // Insert order items
  for (const item of orderItems) {
    await run(`
      INSERT INTO order_items (tenant_id, order_id, menu_item_id, item_name, quantity, unit_price, notes)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [tid2, orderId, item.menu_item_id, item.item_name, item.quantity, item.unit_price, item.notes]);
  }

  // Parse delivery fee and commission
  const totals = orderDetail.totals || {};
  const deliveryFee = (totals.charges?.shipping || 0) / 100;
  const commission = total * (platform.commission_percent / 100);

  // Parse customer info
  const customer = payload.customer || {};
  const customerName = [customer.first_name, customer.last_name].filter(Boolean).join(' ') || null;
  const deliveryInfo = orderDetail.delivery_information || {};
  const deliveryAddress = deliveryInfo.complete_address || null;

  // Create delivery_order record
  const deliveryResult = await run(`
    INSERT INTO delivery_orders (tenant_id, order_id, platform_id, external_order_id, platform_status, delivery_fee, platform_commission, customer_name, delivery_address, raw_webhook_data)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
  `, [
    tid2,
    orderId,
    platform.id,
    externalOrderId,
    'received',
    deliveryFee,
    commission,
    customerName,
    deliveryAddress,
    rawWebhookData,
  ]);

  // Link delivery order to the internal order
  await run('UPDATE orders SET delivery_order_id = $1 WHERE id = $2', [
    deliveryResult.lastInsertRowid, orderId,
  ]);

  // Auto-accept on Rappi (must happen within 6 minutes)
  try {
    const creds = await getServiceCredentials(tenantId, 'rappi', { store_id: '' });
    if (creds.store_id) {
      const token = await getRappiToken(tenantId);
      const cookingTime = orderDetail.cooking_time || 20;
      await takeRappiOrder(token, creds.store_id, externalOrderId, cookingTime);
      await run('UPDATE delivery_orders SET platform_status = $1 WHERE id = $2', [
        'accepted', deliveryResult.lastInsertRowid,
      ]);
      console.log(`[Rappi] Order ${externalOrderId} auto-accepted (internal order ${orderId})`);
    }
  } catch (acceptErr) {
    console.error(`[Rappi] Auto-accept failed for ${externalOrderId}:`, acceptErr.message);
  }

  return {
    order_id: orderId,
    order_number: orderNumber,
    delivery_order_id: deliveryResult.lastInsertRowid,
    items_count: orderItems.length,
    total,
  };
}

// POST /api/delivery/webhook/rappi - Rappi webhook
router.post('/webhook/rappi', async (req, res) => {
  try {
    const payload = req.body;
    const tenantId = req.tenant?.id;

    // Validate webhook signature (Rappi-Signature: t=<ts>,sign=<hmac>)
    if (tenantId) {
      const creds = await getServiceCredentials(tenantId, 'rappi', {
        webhook_secret: '',
      });
      if (creds.webhook_secret && req.rawBody) {
        const sigHeader = req.headers['rappi-signature'] || req.headers['x-rappi-signature'];
        if (!sigHeader) {
          console.warn('[Rappi] Webhook missing Rappi-Signature header');
          return res.status(403).json({ error: 'Missing webhook signature' });
        }
        if (!verifyRappiSignature(req.rawBody, sigHeader, creds.webhook_secret)) {
          console.warn('[Rappi] Webhook signature verification failed');
          return res.status(403).json({ error: 'Invalid webhook signature' });
        }
      }
    }

    // Determine event type — Rappi sends different structures per event
    // NEW_ORDER has order_detail, PING has store_id only, cancels have event field
    const eventType = payload.event || (payload.order_detail ? 'NEW_ORDER' : null)
      || (payload.store_id && !payload.order_detail && !payload.event ? 'PING' : 'UNKNOWN');

    console.log(`[Rappi] Webhook: ${eventType}, order: ${payload.order_detail?.order_id || 'N/A'}`);

    switch (eventType) {
      case 'PING': {
        // Rappi sends PING every 3 min — must respond with status OK or store goes offline
        return res.json({ status: 'OK', description: 'POS online' });
      }

      case 'NEW_ORDER': {
        if (!tenantId) {
          console.warn('[Rappi] No tenant context for order processing');
          return res.status(400).json({ error: 'Tenant context required' });
        }

        const result = await processRappiOrder(tenantId, payload, JSON.stringify(payload));
        console.log('[Rappi] Order processed:', result);
        return res.json({ success: true, ...result });
      }

      case 'canceled_with_charge':
      case 'canceled_without_charge':
      case 'ORDER_EVENT_CANCEL': {
        const cancelOrderId = String(payload.order_id);
        const deliveryOrder = await get(
          "SELECT id, order_id FROM delivery_orders WHERE external_order_id = $1",
          [cancelOrderId]
        );
        if (deliveryOrder) {
          await run('UPDATE delivery_orders SET platform_status = $1 WHERE id = $2', [
            'cancelled_by_rappi', deliveryOrder.id,
          ]);
          await run('UPDATE orders SET status = $1 WHERE id = $2', [
            'cancelled', deliveryOrder.order_id,
          ]);
          console.log(`[Rappi] Order ${cancelOrderId} cancelled by Rappi`);
        }
        return res.json({ success: true, message: 'Cancel processed' });
      }

      case 'taken_visible_order':
      case 'ORDER_OTHER_EVENT': {
        // Courier assigned or other status update — log for now
        console.log(`[Rappi] Status event: ${payload.event} for order ${payload.order_id}`);
        return res.json({ success: true, message: 'Event acknowledged' });
      }

      default: {
        console.log(`[Rappi] Unhandled event: ${eventType}`);
        return res.json({ success: true, message: `Event ${eventType} acknowledged` });
      }
    }
  } catch (error) {
    console.error('[Rappi] Webhook error:', error);
    res.status(200).json({ success: false, error: 'Internal processing error' });
  }
});

// ==================== DiDi Food Webhook ====================

/**
 * Process a DiDi Food new order callback.
 * DiDi's exact payload schema isn't public — this handles common patterns
 * with flexible field resolution, and stores the raw webhook for debugging.
 */
async function processDidiOrder(tenantId, payload, rawWebhookData) {
  // DiDi uses order_id at top level or nested in order/data object
  const orderData = payload.order || payload.data?.order || payload.data || payload;
  const externalOrderId = String(
    orderData.order_id || payload.order_id || orderData.id || ''
  );

  if (!externalOrderId) {
    throw new Error('DiDi Food webhook missing order_id');
  }

  // Idempotent dedup
  const existing = await get(
    "SELECT id FROM delivery_orders WHERE external_order_id = $1",
    [externalOrderId]
  );
  if (existing) {
    console.log(`[DiDi Food] Order ${externalOrderId} already processed (delivery_order ${existing.id})`);
    return { duplicate: true, delivery_order_id: existing.id };
  }

  const platform = await ensurePlatform('didi_food');
  const employee = await findSystemEmployee();
  if (!employee) {
    throw new Error('No active employee found to attribute delivery order');
  }

  // Parse items — DiDi prices are likely in centavos (like Rappi) or decimal
  const didiItems = orderData.items || orderData.order_items || orderData.products || [];
  const orderItems = [];
  let itemsTotal = 0;

  for (const didiItem of didiItems) {
    const quantity = didiItem.quantity || didiItem.count || 1;

    // Price resolution — handle both centavos and decimal formats
    let rawPrice = didiItem.price || didiItem.unit_price || didiItem.total_price || 0;
    // If price looks like centavos (>1000 for a single item), divide by 100
    let unitPrice = typeof rawPrice === 'number' && rawPrice > 1000
      ? rawPrice / 100
      : rawPrice;

    // Add modifier/addon prices
    const addons = didiItem.addons || didiItem.options || didiItem.modifiers || [];
    for (const addon of addons) {
      let addonPrice = addon.price || addon.unit_price || 0;
      if (typeof addonPrice === 'number' && addonPrice > 1000) addonPrice /= 100;
      unitPrice += addonPrice * (addon.quantity || 1);
    }

    const title = didiItem.name || didiItem.item_name || didiItem.product_name || 'DiDi Food Item';
    const notes = didiItem.remark || didiItem.note || didiItem.special_instructions || null;
    const sku = didiItem.sku || didiItem.app_item_id || didiItem.item_id || null;

    const localItem = await matchMenuItem(title, sku);

    orderItems.push({
      menu_item_id: localItem?.id || null,
      item_name: localItem?.name || title,
      quantity,
      unit_price: unitPrice > 0 ? unitPrice : (Number(localItem?.price) || 0),
      notes,
    });

    itemsTotal += (unitPrice > 0 ? unitPrice : (Number(localItem?.price) || 0)) * quantity;
  }

  // Calculate tax (prices include IVA)
  const total = itemsTotal;
  const tax = Math.round((total - total / (1 + TAX_RATE)) * 100) / 100;
  const subtotal = Math.round((total - tax) * 100) / 100;
  const orderNumber = await generateOrderNumber();

  // Create internal order
  const tid3 = getTenantId();
  const orderResult = await run(`
    INSERT INTO orders (tenant_id, order_number, employee_id, status, subtotal, tax, total, payment_status, payment_method, source)
    VALUES ($1, $2, $3, 'confirmed', $4, $5, $6, 'paid', 'didi_food', 'didi_food')
  `, [tid3, orderNumber, employee.id, subtotal, tax, total]);

  const orderId = orderResult.lastInsertRowid;

  // Insert order items
  for (const item of orderItems) {
    await run(`
      INSERT INTO order_items (tenant_id, order_id, menu_item_id, item_name, quantity, unit_price, notes)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [tid3, orderId, item.menu_item_id, item.item_name, item.quantity, item.unit_price, item.notes]);
  }

  // Parse delivery fee and commission
  const deliveryFee = (orderData.delivery_fee || orderData.shipping_fee || 0);
  const normalizedFee = deliveryFee > 1000 ? deliveryFee / 100 : deliveryFee;
  const commission = total * (platform.commission_percent / 100);

  // Parse customer info
  const customer = orderData.customer || orderData.user || payload.customer || {};
  const customerName = customer.name || customer.full_name
    || [customer.first_name, customer.last_name].filter(Boolean).join(' ')
    || null;
  const deliveryAddress = orderData.delivery_address || orderData.address
    || customer.address || null;

  // Create delivery_order record
  const deliveryResult = await run(`
    INSERT INTO delivery_orders (tenant_id, order_id, platform_id, external_order_id, platform_status, delivery_fee, platform_commission, customer_name, delivery_address, raw_webhook_data)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
  `, [
    tid3,
    orderId,
    platform.id,
    externalOrderId,
    'received',
    normalizedFee,
    commission,
    customerName,
    typeof deliveryAddress === 'object' ? JSON.stringify(deliveryAddress) : deliveryAddress,
    rawWebhookData,
  ]);

  // Link delivery order to the internal order
  await run('UPDATE orders SET delivery_order_id = $1 WHERE id = $2', [
    deliveryResult.lastInsertRowid, orderId,
  ]);

  // Auto-confirm on DiDi Food
  try {
    const token = await getDidiToken(tenantId);
    await confirmDidiOrder(token, externalOrderId);
    await run('UPDATE delivery_orders SET platform_status = $1 WHERE id = $2', [
      'accepted', deliveryResult.lastInsertRowid,
    ]);
    console.log(`[DiDi Food] Order ${externalOrderId} auto-confirmed (internal order ${orderId})`);
  } catch (acceptErr) {
    console.error(`[DiDi Food] Auto-confirm failed for ${externalOrderId}:`, acceptErr.message);
  }

  return {
    order_id: orderId,
    order_number: orderNumber,
    delivery_order_id: deliveryResult.lastInsertRowid,
    items_count: orderItems.length,
    total,
  };
}

// POST /api/delivery/webhook/didi - DiDi Food webhook
router.post('/webhook/didi', async (req, res) => {
  try {
    const payload = req.body;
    const tenantId = req.tenant?.id;

    // Validate webhook signature
    if (tenantId) {
      const creds = await getServiceCredentials(tenantId, 'didi_food', {
        webhook_secret: '',
        app_secret: '',
      });
      const secret = creds.webhook_secret || creds.app_secret;
      if (secret && req.rawBody) {
        const signature = req.headers['x-didi-signature']
          || req.headers['x-webhook-signature']
          || req.headers['didi-signature'];
        if (!signature) {
          console.warn('[DiDi Food] Webhook missing signature header');
          return res.status(403).json({ error: 'Missing webhook signature' });
        }
        if (!verifyDidiSignature(req.rawBody, signature, secret)) {
          console.warn('[DiDi Food] Webhook signature verification failed');
          return res.status(403).json({ error: 'Invalid webhook signature' });
        }
      }
    }

    // Determine event type — DiDi sends event_type or type at top level
    const eventType = (
      payload.event_type || payload.type || payload.event
      || payload.data?.event_type || payload.data?.type
      || ''
    ).toLowerCase();

    const orderId = payload.order_id || payload.data?.order_id
      || payload.order?.order_id || '';

    console.log(`[DiDi Food] Webhook: ${eventType || 'unknown'}, order: ${orderId || 'N/A'}`);

    // Route by event type
    if (eventType.includes('new_order') || eventType.includes('order_create') || eventType === 'new_order') {
      if (!tenantId) {
        console.warn('[DiDi Food] No tenant context for order processing');
        return res.status(400).json({ error: 'Tenant context required' });
      }

      const result = await processDidiOrder(tenantId, payload, JSON.stringify(payload));
      console.log('[DiDi Food] Order processed:', result);
      return res.json({ success: true, ...result });
    }

    if (eventType.includes('cancel') || eventType.includes('order_cancel')) {
      const cancelId = String(orderId);
      if (cancelId) {
        const deliveryOrder = await get(
          "SELECT id, order_id FROM delivery_orders WHERE external_order_id = $1",
          [cancelId]
        );
        if (deliveryOrder) {
          const cancelSource = payload.cancel_source || payload.cancelled_by || 'platform';
          await run('UPDATE delivery_orders SET platform_status = $1 WHERE id = $2', [
            `cancelled_by_${cancelSource}`, deliveryOrder.id,
          ]);
          await run('UPDATE orders SET status = $1 WHERE id = $2', [
            'cancelled', deliveryOrder.order_id,
          ]);
          console.log(`[DiDi Food] Order ${cancelId} cancelled (source: ${cancelSource})`);
        }
      }
      return res.json({ success: true, message: 'Cancel processed' });
    }

    if (eventType.includes('complete') || eventType.includes('order_complete')) {
      const completeId = String(orderId);
      if (completeId) {
        const deliveryOrder = await get(
          "SELECT id, order_id FROM delivery_orders WHERE external_order_id = $1",
          [completeId]
        );
        if (deliveryOrder) {
          await run('UPDATE delivery_orders SET platform_status = $1 WHERE id = $2', [
            'completed', deliveryOrder.id,
          ]);
          await run('UPDATE orders SET status = $1 WHERE id = $2', [
            'completed', deliveryOrder.order_id,
          ]);
          console.log(`[DiDi Food] Order ${completeId} completed`);
        }
      }
      return res.json({ success: true, message: 'Completion processed' });
    }

    if (eventType.includes('delivery') || eventType.includes('status')) {
      console.log(`[DiDi Food] Delivery status update for order ${orderId}: ${eventType}`);
      return res.json({ success: true, message: 'Status update acknowledged' });
    }

    if (eventType.includes('refund') || eventType.includes('order_refund')) {
      console.log(`[DiDi Food] Refund event for order ${orderId}`);
      return res.json({ success: true, message: 'Refund acknowledged' });
    }

    // Unknown event — acknowledge to prevent retries
    console.log(`[DiDi Food] Unhandled event: ${eventType || 'unknown'}`, JSON.stringify(payload).slice(0, 300));
    return res.json({ success: true, message: `Event acknowledged` });
  } catch (error) {
    console.error('[DiDi Food] Webhook error:', error);
    res.status(200).json({ success: false, error: 'Internal processing error' });
  }
});

export default router;
