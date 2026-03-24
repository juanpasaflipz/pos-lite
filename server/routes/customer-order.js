// Customer QR ordering API — public endpoints
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { all, get, run, getConn, getTenantId } from '../db/index.js';
import { insertOrderWithNumber, estimatePrepTime } from './orders.js';
import { audit } from '../lib/auditLog.js';
import { cleanBoardSettings } from '../lib/boardSettings.js';
import { createPaymentIntent, getPaymentIntent } from '../stripe.js';

const router = Router();

const TAX_RATE = 0.16; // 16% IVA (Mexico) — prices already include tax

// Rate limiting: 5 orders per IP per 15 minutes
const customerOrderLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many orders. Please try again later.' },
});

// Rate limiting: 60 status checks per IP per minute
const statusLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' },
});

/**
 * Find a system employee to attribute QR orders to.
 * Picks first active admin, or any active employee as fallback.
 */
async function findSystemEmployee() {
  return (
    await get("SELECT id FROM employees WHERE role = 'admin' AND active = true ORDER BY id LIMIT 1") ||
    await get("SELECT id FROM employees WHERE active = true ORDER BY id LIMIT 1")
  );
}

// GET /api/customer-order/settings — public, returns payment requirement
router.get('/settings', async (_req, res) => {
  try {
    const brand = await get(`
      SELECT board_settings FROM virtual_brands WHERE active = true ORDER BY id LIMIT 1
    `);

    const settings = cleanBoardSettings(brand?.board_settings);
    const requirePayment = !!settings.qrRequirePayment;

    res.json({ requirePayment });
  } catch (error) {
    console.error('Error fetching customer order settings:', error);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// GET /api/customer-order/menu — public, returns menu for QR ordering
// Falls back to regular menu if no virtual brands are configured
router.get('/menu', async (req, res) => {
  try {
    const useRegularMenu = req.query.source === 'kiosk';

    // Try virtual brands first (skip for kiosk — kiosk uses the full regular menu)
    const brands = useRegularMenu ? [] : await all(`
      SELECT id, name, slug, logo_url, primary_color
      FROM virtual_brands
      WHERE display_type IN ('menu_board', 'both')
        AND active = true
      ORDER BY id
    `);

    if (brands.length > 0) {
      // Use virtual brand menu (same as menu-board/data but simplified)
      const brandIds = brands.map(b => b.id);
      const placeholders = brandIds.map((_, i) => `$${i + 1}`).join(',');

      const rows = await all(`
        SELECT
          vbi.virtual_brand_id,
          mi.id as item_id,
          COALESCE(vbi.custom_name, mi.name) as name,
          COALESCE(vbi.custom_price, mi.price) as price,
          mi.description,
          mi.image_url,
          COALESCE(vbi.show_image, true) as show_image,
          mi.category_id,
          mc.name as category_name,
          mc.sort_order as category_sort
        FROM virtual_brand_items vbi
        JOIN menu_items mi ON mi.id = vbi.menu_item_id
        JOIN menu_categories mc ON mc.id = mi.category_id
        WHERE vbi.virtual_brand_id IN (${placeholders})
          AND vbi.active = true
          AND mi.active = true
          AND mc.active = true
        ORDER BY mc.sort_order, mi.id
      `, brandIds);

      const brandMap = new Map();
      for (const brand of brands) {
        brandMap.set(brand.id, {
          id: brand.id,
          name: brand.name,
          categories: [],
          theme: { primaryColor: brand.primary_color },
          _catMap: new Map(),
        });
      }

      for (const row of rows) {
        const brand = brandMap.get(row.virtual_brand_id);
        if (!brand) continue;
        let cat = brand._catMap.get(row.category_id);
        if (!cat) {
          cat = { id: row.category_id, name: row.category_name, items: [] };
          brand._catMap.set(row.category_id, cat);
          brand.categories.push(cat);
        }
        cat.items.push({
          id: row.item_id,
          name: row.name,
          price: row.price,
          description: row.description,
          imageUrl: row.show_image ? row.image_url : null,
        });
      }

      const result = [...brandMap.values()].map(b => { delete b._catMap; return b; });
      return res.json({ brands: result });
    }

    // Fallback: regular menu (menu_categories + menu_items)
    const categories = await all(`
      SELECT id, name, sort_order
      FROM menu_categories
      WHERE active = true
      ORDER BY sort_order, id
    `);

    if (categories.length === 0) {
      return res.json({ brands: [] });
    }

    const items = await all(`
      SELECT id, category_id, name, price, description, image_url
      FROM menu_items
      WHERE active = true
      ORDER BY name
    `);

    const catMap = new Map();
    for (const cat of categories) {
      catMap.set(cat.id, { id: cat.id, name: cat.name, items: [] });
    }
    for (const item of items) {
      const cat = catMap.get(item.category_id);
      if (cat) {
        cat.items.push({
          id: item.id,
          name: item.name,
          price: item.price,
          description: item.description,
          imageUrl: item.image_url,
        });
      }
    }

    // Filter out empty categories
    const filledCategories = [...catMap.values()].filter(c => c.items.length > 0);

    res.json({
      brands: [{
        id: 0,
        name: 'Menu',
        categories: filledCategories,
        theme: { primaryColor: null },
      }],
    });
  } catch (error) {
    console.error('Error fetching customer order menu:', error);
    res.status(500).json({ error: 'Failed to load menu' });
  }
});

// POST /api/customer-order — public, rate-limited, creates an order
router.post('/', customerOrderLimiter, async (req, res) => {
  try {
    const { items, table_number } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Items are required' });
    }

    if (items.length > 50) {
      return res.status(400).json({ error: 'Too many items in order' });
    }

    // Sanitize table_number
    const sanitizedTable = typeof table_number === 'string'
      ? table_number.trim().slice(0, 20) || null
      : null;

    // Find system employee for FK
    const employee = await findSystemEmployee();
    if (!employee) {
      return res.status(503).json({ error: 'Restaurant is not accepting orders at this time' });
    }

    // Validate items and calculate totals
    let itemsTotal = 0;
    const orderItems = [];

    for (const item of items) {
      if (!item.menu_item_id || !item.quantity || item.quantity <= 0 || item.quantity > 99) {
        return res.status(400).json({ error: `Invalid item: menu_item_id and quantity (1-99) required` });
      }

      const menuItem = await get('SELECT id, name, price FROM menu_items WHERE id = $1', [item.menu_item_id]);
      if (!menuItem) {
        return res.status(404).json({ error: `Menu item ${item.menu_item_id} not found` });
      }

      // Resolve modifiers
      let modifierTotal = 0;
      const resolvedModifiers = [];
      if (item.modifiers && Array.isArray(item.modifiers) && item.modifiers.length > 0) {
        if (item.modifiers.length > 20) {
          return res.status(400).json({ error: 'Too many modifiers per item' });
        }
        for (const modId of item.modifiers) {
          const mod = await get('SELECT id, name, price_adjustment FROM modifiers WHERE id = $1', [modId]);
          if (mod) {
            modifierTotal += Number(mod.price_adjustment);
            resolvedModifiers.push(mod);
          }
        }
      }

      const unitPrice = Number(menuItem.price) + modifierTotal;
      const itemTotal = unitPrice * item.quantity;
      itemsTotal += itemTotal;

      orderItems.push({
        menu_item_id: item.menu_item_id,
        item_name: menuItem.name,
        quantity: item.quantity,
        unit_price: unitPrice,
        notes: typeof item.notes === 'string' ? item.notes.slice(0, 500) : null,
        combo_instance_id: null,
        modifiers: resolvedModifiers,
      });
    }

    // Prices already include IVA — extract tax from the total
    const total = itemsTotal;
    const tax = Math.round((total - total / (1 + TAX_RATE)) * 100) / 100;
    const subtotal = Math.round((total - tax) * 100) / 100;

    const tenantId = getTenantId();
    const conn = getConn();

    // Insert order with source = 'qr_order'
    const { orderId, orderNumber } = await insertOrderWithNumber(conn, {
      employee_id: employee.id,
      subtotal,
      tax,
      total,
      tenantId,
    });

    // Set source and table_number
    await conn.unsafe(
      `UPDATE orders SET source = 'qr_order', table_number = $1 WHERE id = $2`,
      [sanitizedTable, orderId]
    );

    // Calculate estimated prep time
    const itemMenuIds = orderItems.map(i => i.menu_item_id);
    const prepEstimate = await estimatePrepTime(conn, itemMenuIds, tenantId);
    await conn.unsafe(
      `UPDATE orders SET estimated_ready_minutes = $1 WHERE id = $2`,
      [prepEstimate.estimate, orderId]
    );

    // Batch insert order items
    const itemColCount = 8;
    const itemValues = orderItems.map((_, i) => {
      const o = i * itemColCount;
      return `($${o+1},$${o+2},$${o+3},$${o+4},$${o+5},$${o+6},$${o+7},$${o+8})`;
    }).join(',');
    const itemParams = orderItems.flatMap(item => [
      tenantId, orderId, item.menu_item_id, item.item_name,
      item.quantity, item.unit_price, item.notes, item.combo_instance_id,
    ]);

    const insertedItems = await conn.unsafe(`
      INSERT INTO order_items (tenant_id, order_id, menu_item_id, item_name, quantity, unit_price, notes, combo_instance_id)
      VALUES ${itemValues}
      RETURNING id
    `, itemParams);

    // Correlate by index
    for (let i = 0; i < orderItems.length; i++) {
      orderItems[i]._orderItemId = insertedItems[i].id;
    }

    // Batch insert modifiers
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

    audit({
      tenantId: tenantId || 'default',
      actorType: 'customer',
      actorId: 'qr_order',
      action: 'create',
      resource: 'order',
      resourceId: String(orderId),
      ip: req.ip,
    });

    res.status(201).json({
      order_id: orderId,
      order_number: orderNumber,
      estimated_ready_minutes: prepEstimate.estimate,
      estimated_ready_range: { low: prepEstimate.low, high: prepEstimate.high },
    });
  } catch (error) {
    console.error('Error creating customer order:', error);
    res.status(500).json({ error: 'Failed to create order' });
  }
});

// GET /api/customer-order/:orderId/status — public, rate-limited
router.get('/:orderId/status', statusLimiter, async (req, res) => {
  try {
    const { orderId } = req.params;

    const order = await get(`
      SELECT id, order_number, status, table_number, estimated_ready_minutes,
             created_at, ready_at, total
      FROM orders
      WHERE id = $1 AND source = 'qr_order'
    `, [orderId]);

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    res.json({
      order_id: order.id,
      order_number: order.order_number,
      status: order.status,
      table_number: order.table_number,
      estimated_ready_minutes: order.estimated_ready_minutes,
      created_at: order.created_at,
      ready_at: order.ready_at,
      total: order.total,
    });
  } catch (error) {
    console.error('Error fetching order status:', error);
    res.status(500).json({ error: 'Failed to fetch order status' });
  }
});

// POST /api/customer-order/:orderId/payment-intent — creates Stripe PaymentIntent for QR order
router.post('/:orderId/payment-intent', statusLimiter, async (req, res) => {
  try {
    const { orderId } = req.params;

    const order = await get(`
      SELECT id, total, payment_status, source
      FROM orders
      WHERE id = $1 AND source = 'qr_order'
    `, [orderId]);

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    if (order.payment_status === 'paid' || order.payment_status === 'completed') {
      return res.status(400).json({ error: 'Order is already paid' });
    }

    const paymentIntent = await createPaymentIntent(order.total, {
      order_id: String(order.id),
      source: 'qr_order',
    });

    // Store payment_intent_id on order
    const conn = getConn();
    await conn.unsafe(
      `UPDATE orders SET payment_intent_id = $1, payment_status = 'processing' WHERE id = $2`,
      [paymentIntent.id, orderId]
    );

    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (error) {
    console.error('Error creating payment intent:', error);
    res.status(500).json({ error: 'Failed to create payment' });
  }
});

// POST /api/customer-order/:orderId/confirm-payment — confirms payment after Stripe success
router.post('/:orderId/confirm-payment', statusLimiter, async (req, res) => {
  try {
    const { orderId } = req.params;

    const order = await get(`
      SELECT id, payment_intent_id, payment_status, source, status
      FROM orders
      WHERE id = $1 AND source = 'qr_order'
    `, [orderId]);

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    if (!order.payment_intent_id) {
      return res.status(400).json({ error: 'No payment intent found for this order' });
    }

    if (order.payment_status === 'paid' || order.payment_status === 'completed') {
      return res.json({ success: true, already_paid: true });
    }

    // Verify with Stripe
    const intent = await getPaymentIntent(order.payment_intent_id);
    if (intent.status !== 'succeeded') {
      return res.status(400).json({ error: 'Payment has not been completed' });
    }

    // Update order: mark paid, advance status to preparing
    const conn = getConn();
    const now = new Date().toISOString();
    await conn.unsafe(`
      UPDATE orders
      SET payment_status = 'paid',
          payment_method = 'card',
          paid_at = $1,
          status = CASE WHEN status = 'pending' THEN 'confirmed' ELSE status END
      WHERE id = $2
    `, [now, orderId]);

    audit({
      tenantId: getTenantId() || 'default',
      actorType: 'customer',
      actorId: 'qr_order',
      action: 'payment',
      resource: 'order',
      resourceId: String(orderId),
      ip: req.ip,
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Error confirming payment:', error);
    res.status(500).json({ error: 'Failed to confirm payment' });
  }
});

export default router;