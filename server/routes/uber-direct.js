import { Router } from 'express';
import { all, get, run, getTenantId } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePlanFeature } from '../planLimits.js';
import { getServiceCredentials } from '../helpers/tenantCredentials.js';
import { audit } from '../lib/auditLog.js';
import { dispatchPendingCourier } from './kiosk.js';
import {
  verifyDirectSignature,
  getWebhookSigningKey,
  createQuote,
  createDelivery,
  getDelivery,
  cancelDelivery,
} from '../services/uber-direct.js';

const router = Router();

// The restaurant end of every Direct call comes from the tenant's stored
// credentials — callers only know the customer's half. Uber rejects a quote or
// delivery with no pickup_address outright (`invalid_params`), so filling these
// in here keeps every caller from having to fetch and forward them. An explicit
// value in the body still wins, for a future multi-location tenant.
async function withPickupDetails(tenantId, body) {
  const creds = await getServiceCredentials(tenantId, 'uber_direct', {
    pickup_name: '',
    pickup_address: '',
    pickup_phone_number: '',
  });
  const merged = {
    ...body,
    pickup_name: body.pickup_name || creds.pickup_name || undefined,
    pickup_address: body.pickup_address || creds.pickup_address,
    pickup_phone_number: body.pickup_phone_number || creds.pickup_phone_number,
  };
  if (!merged.pickup_address || !merged.pickup_phone_number) {
    const err = new Error(
      'Restaurant pickup address/phone not configured in Uber Direct credentials'
    );
    err.status = 400;
    throw err;
  }
  return merged;
}

// A rejected webhook is silent by construction: we answer Uber, nobody sees the
// 403, and the delivery record just stops moving. Leaving a row behind gives the
// sentinel's webhook_rejections sensor something to find, and gives whoever gets
// paged the reason without a log tail.
function recordWebhookRejection(tenantId, reason) {
  if (!tenantId) return;
  audit({
    tenantId,
    actorType: 'system',
    action: 'reject',
    resource: 'uber_direct_webhook',
    details: { reason },
  });
}

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
// Body: dropoff_address (Uber-shaped object or string), dropoff_phone_number,
//       manifest_total_value?. Pickup details are filled from tenant creds.
router.post('/quote', requireAuth('manage_delivery'), requirePlanFeature('delivery'), async (req, res) => {
  const tenantId = req.tenant?.id;
  if (!tenantId) return res.status(400).json({ error: 'Tenant context required' });

  try {
    const quote = await createQuote(tenantId, await withPickupDetails(tenantId, req.body));
    res.json(quote);
  } catch (error) {
    console.error('[Uber Direct] Quote failed:', error.message, error.data?.metadata || '');
    res.status(error.status || 500).json({
      error: error.data?.message || error.message || 'Failed to create quote',
      code: error.data?.code,
      // Uber names the offending field(s) here — without it the client can only
      // show "the parameters of your request were invalid", which diagnoses nothing.
      details: error.data?.metadata,
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

  // Checked before dispatch, not after: delivery_orders.order_id is NOT NULL,
  // so booking first would put a real courier on the road with nothing to
  // attach it to — and no way to bill or cancel it from here.
  if (!internalOrderId) {
    return res.status(400).json({
      error: 'order_id required to attach the dispatched delivery to an internal order',
    });
  }

  try {
    const delivery = await createDelivery(
      tenantId,
      await withPickupDetails(tenantId, uberPayload)
    );
    const platform = await ensureDirectPlatform();

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
    console.error('[Uber Direct] Create delivery failed:', error.message, error.data?.metadata || '');
    res.status(error.status || 500).json({
      error: error.data?.message || error.message || 'Failed to create delivery',
      code: error.data?.code,
      details: error.data?.metadata,
    });
  }
});

// ==================== Manual re-dispatch ====================

// POST /api/uber-direct/deliveries/:id/redispatch
// :id is the internal delivery_orders.id. Re-books a courier for an order whose
// automatic dispatch failed, using the pending_dispatch payload the failure
// preserved. This is the human escape hatch: the poll loop gives up after a few
// attempts, and refuses entirely when the first outcome was unknown, because
// neither it nor sentinel can check the Uber dashboard for an already-assigned
// courier. Someone who has looked can.
router.post('/deliveries/:id/redispatch', requireAuth('manage_delivery'), requirePlanFeature('delivery'), async (req, res) => {
  const tenantId = req.tenant?.id;
  if (!tenantId) return res.status(400).json({ error: 'Tenant context required' });

  const row = await get(
    `SELECT do2.id, do2.order_id, do2.platform_status, do2.pending_dispatch
     FROM delivery_orders do2
     JOIN delivery_platforms dp ON do2.platform_id = dp.id
     WHERE do2.id = $1 AND dp.name = 'uber_direct'`,
    [Number(req.params.id) || 0]
  );
  if (!row) return res.status(404).json({ error: 'Delivery not found' });
  if (row.platform_status !== 'dispatch_failed' || !row.pending_dispatch) {
    return res.status(409).json({
      error: 'Only a failed dispatch that still has its payload can be re-booked',
      code: 'not_redispatchable',
      platform_status: row.platform_status,
    });
  }

  const result = await dispatchPendingCourier(row.order_id, tenantId, { force: true });
  if (!result.delivery) {
    return res.status(502).json({
      error: result.delivery_error || 'Courier dispatch failed again',
      code: 'redispatch_failed',
    });
  }
  res.json(result.delivery);
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
          recordWebhookRejection(tenantId, 'missing_signature');
          return res.status(403).json({ error: 'Missing webhook signature' });
        }
        if (!verifyDirectSignature(req.rawBody, signature, signingKey)) {
          console.warn('[Uber Direct] Webhook signature verification failed');
          recordWebhookRejection(tenantId, 'signature_mismatch');
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
