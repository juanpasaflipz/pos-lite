import { Router } from 'express';
import { all, get, run, getTenantId } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePlanFeature } from '../planLimits.js';
import {
  verifyDirectSignature,
  getWebhookSigningKey,
  createQuote,
  createDelivery,
  getDelivery,
  cancelDelivery,
} from '../services/uber-direct.js';

const router = Router();

async function ensureDirectPlatform() {
  let platform = await get(
    `SELECT * FROM delivery_platforms WHERE name = 'uber_direct'`
  );
  if (!platform) {
    await run(
      `INSERT INTO delivery_platforms (tenant_id, name, display_name, commission_percent, active)
       VALUES ($1, 'uber_direct', 'Uber Direct', 0, true)`,
      [getTenantId()]
    );
    platform = await get(`SELECT * FROM delivery_platforms WHERE name = 'uber_direct'`);
  }
  return platform;
}

// ==================== Quote ====================

// POST /api/uber-direct/quote
// Body: pickup_address, dropoff_address (Uber-shaped objects or strings),
//       pickup_phone_number, dropoff_phone_number, manifest_total_value?
router.post('/quote', requireAuth('manage_delivery'), requirePlanFeature('delivery'), async (req, res) => {
  const tenantId = req.tenant?.id;
  if (!tenantId) return res.status(400).json({ error: 'Tenant context required' });

  try {
    const quote = await createQuote(tenantId, req.body);
    res.json(quote);
  } catch (error) {
    console.error('[Uber Direct] Quote failed:', error.message);
    res.status(error.status || 500).json({
      error: error.data?.message || error.message || 'Failed to create quote',
      code: error.data?.code,
    });
  }
});

// ==================== Create Delivery ====================

// POST /api/uber-direct/deliveries
// Body: full Uber Direct delivery payload + optional internal order_id to link.
router.post('/deliveries', requireAuth('manage_delivery'), requirePlanFeature('delivery'), async (req, res) => {
  const tenantId = req.tenant?.id;
  if (!tenantId) return res.status(400).json({ error: 'Tenant context required' });

  const { order_id: internalOrderId, ...uberPayload } = req.body;

  try {
    const delivery = await createDelivery(tenantId, uberPayload);
    const platform = await ensureDirectPlatform();

    // Link to an existing internal order if provided; otherwise the row is
    // created without order_id (NOT NULL FK is enforced, so reject early).
    if (!internalOrderId) {
      return res.status(400).json({
        error: 'order_id required to attach the dispatched delivery to an internal order',
      });
    }

    const tid = getTenantId();
    const insertResult = await run(`
      INSERT INTO delivery_orders
        (tenant_id, order_id, platform_id, external_order_id, platform_status,
         delivery_fee, customer_name, delivery_address, tracking_url,
         courier_name, courier_phone, courier_vehicle, raw_webhook_data)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    `, [
      tid,
      internalOrderId,
      platform.id,
      delivery.id,
      delivery.status || 'pending',
      (delivery.fee || 0) / 100,
      delivery.dropoff?.name || null,
      delivery.dropoff?.address || null,
      delivery.tracking_url || null,
      delivery.courier?.name || null,
      delivery.courier?.phone_number || null,
      delivery.courier?.vehicle_type || null,
      JSON.stringify(delivery),
    ]);

    await run('UPDATE orders SET delivery_order_id = $1 WHERE id = $2', [
      insertResult.lastInsertRowid, internalOrderId,
    ]);

    res.json({
      delivery_order_id: insertResult.lastInsertRowid,
      external_id: delivery.id,
      tracking_url: delivery.tracking_url,
      status: delivery.status,
      fee: (delivery.fee || 0) / 100,
      dropoff_eta: delivery.dropoff_eta,
    });
  } catch (error) {
    console.error('[Uber Direct] Create delivery failed:', error.message);
    res.status(error.status || 500).json({
      error: error.data?.message || error.message || 'Failed to create delivery',
      code: error.data?.code,
    });
  }
});

// ==================== Get / Refresh ====================

// GET /api/uber-direct/deliveries/:id
// :id is either the internal delivery_orders.id OR the Uber external delivery id.
router.get('/deliveries/:id', requireAuth('manage_delivery'), async (req, res) => {
  const tenantId = req.tenant?.id;
  if (!tenantId) return res.status(400).json({ error: 'Tenant context required' });

  const { id } = req.params;

  const row = await get(
    `SELECT do2.*, dp.name as platform_name
     FROM delivery_orders do2
     JOIN delivery_platforms dp ON do2.platform_id = dp.id
     WHERE (do2.id = $1::int OR do2.external_order_id = $2)
       AND dp.name = 'uber_direct'
     LIMIT 1`,
    [Number(id) || 0, String(id)]
  );
  if (!row) return res.status(404).json({ error: 'Delivery not found' });

  try {
    const delivery = await getDelivery(tenantId, row.external_order_id);

    await run(
      `UPDATE delivery_orders SET
         platform_status = $1,
         tracking_url = COALESCE($2, tracking_url),
         courier_name = COALESCE($3, courier_name),
         courier_phone = COALESCE($4, courier_phone),
         courier_vehicle = COALESCE($5, courier_vehicle),
         raw_webhook_data = $6
       WHERE id = $7`,
      [
        delivery.status,
        delivery.tracking_url,
        delivery.courier?.name,
        delivery.courier?.phone_number,
        delivery.courier?.vehicle_type,
        JSON.stringify(delivery),
        row.id,
      ]
    );

    res.json({
      delivery_order_id: row.id,
      external_id: delivery.id,
      status: delivery.status,
      tracking_url: delivery.tracking_url,
      courier: delivery.courier || null,
      dropoff_eta: delivery.dropoff_eta,
    });
  } catch (error) {
    console.error('[Uber Direct] Get delivery failed:', error.message);
    res.status(error.status || 500).json({
      error: error.data?.message || error.message || 'Failed to fetch delivery',
    });
  }
});

// ==================== Cancel ====================

// POST /api/uber-direct/deliveries/:id/cancel
router.post('/deliveries/:id/cancel', requireAuth('manage_delivery'), async (req, res) => {
  const tenantId = req.tenant?.id;
  if (!tenantId) return res.status(400).json({ error: 'Tenant context required' });

  const { id } = req.params;
  const row = await get(
    `SELECT do2.*, dp.name as platform_name
     FROM delivery_orders do2
     JOIN delivery_platforms dp ON do2.platform_id = dp.id
     WHERE (do2.id = $1::int OR do2.external_order_id = $2)
       AND dp.name = 'uber_direct'
     LIMIT 1`,
    [Number(id) || 0, String(id)]
  );
  if (!row) return res.status(404).json({ error: 'Delivery not found' });

  try {
    await cancelDelivery(tenantId, row.external_order_id);
    await run('UPDATE delivery_orders SET platform_status = $1 WHERE id = $2', [
      'canceled', row.id,
    ]);
    res.json({ delivery_order_id: row.id, status: 'canceled', success: true });
  } catch (error) {
    console.error('[Uber Direct] Cancel failed:', error.message);
    res.status(error.status || 500).json({
      error: error.data?.message || error.message || 'Failed to cancel delivery',
    });
  }
});

// ==================== Webhook ====================

// POST /api/uber-direct/webhook
// Public — signature-verified. Uber sends delivery.state_changed events.
router.post('/webhook', async (req, res) => {
  const tenantId = req.tenant?.id;
  const payload = req.body || {};

  try {
    if (tenantId) {
      const signingKey = await getWebhookSigningKey(tenantId);
      if (signingKey && req.rawBody) {
        const signature =
          req.headers['x-postmates-signature'] ||
          req.headers['x-uber-signature'];
        if (!signature) {
          console.warn('[Uber Direct] Webhook missing signature header');
          return res.status(403).json({ error: 'Missing webhook signature' });
        }
        if (!verifyDirectSignature(req.rawBody, signature, signingKey)) {
          console.warn('[Uber Direct] Webhook signature verification failed');
          return res.status(403).json({ error: 'Invalid webhook signature' });
        }
      }
    }

    const eventType = payload.event_type || payload.kind || '';
    const deliveryId =
      payload.meta?.order_id ||
      payload.data?.id ||
      payload.delivery_id ||
      payload.resource_href?.split('/').pop();
    const newStatus = payload.meta?.status || payload.status || payload.data?.status;

    console.log(`[Uber Direct] Webhook: ${eventType}, delivery: ${deliveryId}, status: ${newStatus}`);

    if (!deliveryId) {
      return res.json({ success: true, message: 'No delivery id — ignored' });
    }

    const row = await get(
      `SELECT id, order_id FROM delivery_orders WHERE external_order_id = $1`,
      [String(deliveryId)]
    );
    if (!row) {
      console.log(`[Uber Direct] Delivery ${deliveryId} not found locally — likely stale`);
      return res.json({ success: true, message: 'Unknown delivery — acknowledged' });
    }

    if (newStatus) {
      await run('UPDATE delivery_orders SET platform_status = $1 WHERE id = $2', [
        newStatus, row.id,
      ]);
    }

    // Terminal states cascade to the internal order
    if (newStatus === 'delivered') {
      await run("UPDATE orders SET status = 'completed' WHERE id = $1", [row.order_id]);
    } else if (newStatus === 'canceled' || newStatus === 'returned') {
      await run("UPDATE orders SET status = 'cancelled' WHERE id = $1", [row.order_id]);
    }

    res.json({ success: true });
  } catch (error) {
    console.error('[Uber Direct] Webhook error:', error);
    res.status(200).json({ success: false, error: 'Internal processing error' });
  }
});

export default router;
