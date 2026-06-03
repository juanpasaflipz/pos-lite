import { Router } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { JWT_SECRET } from '../lib/constants.js';
import { all, get, run, adminSql, getTenantId } from '../db/index.js';
import { createPaymentIntent, createRefund, getPaymentIntent } from '../stripe.js';
import { requireAuth } from '../middleware/auth.js';
import { deductInventoryForOrder, restoreInventoryForItems } from '../helpers/inventory.js';
import { generateInvoiceToken } from '../helpers/facturapi.js';
import { getTenant } from '../tenants.js';
import {
  ensureFreshToken,
  getTerminals as mpGetTerminals,
  createPointOrder,
  getPointOrder,
  mapPointOrderStatus,
  cancelPointOrder,
  isQueueStuckError,
  recoverStuckQueue,
  extractMpFees,
} from '../services/mercadopago.js';
import { getServiceCredentials } from '../helpers/tenantCredentials.js';
import {
  createOxxoOrder,
  createSpeiOrder,
  createCardOrder as conektaCardOrder,
  createConektaRefund,
  getConektaOrder,
  getConektaWebhookPublicKey,
  verifyConektaSignature,
} from '../conekta.js';
import { getTenantBySubdomain } from '../tenants.js';
import { refundPayment as getnetRefundPayment } from '../services/getnet/payments.js';
import {
  getClipAuthHeader,
  getClipDefaultTerminalId,
  createPinPadPayment as clipCreatePinPadPayment,
  getPaymentStatus as clipGetPaymentStatus,
  cancelPinPadPayment as clipCancelPinPadPayment,
  mapStatus as mapClipStatus,
} from '../services/clip.js';

const router = Router();

// Rate limiting: 20 payment creation attempts per IP per 15 minutes
const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many payment requests. Please try again later.' },
});

// Rate limiting: 10 refund attempts per IP per 15 minutes
const refundLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many refund requests. Please try again later.' },
});

// POST /api/payments/create-intent - create Stripe PaymentIntent for an order
router.post('/create-intent', paymentLimiter, requireAuth('pos_access'), async (req, res) => {
  try {
    const { order_id, tip = 0 } = req.body;

    if (!order_id) {
      return res.status(400).json({ error: 'Missing order_id' });
    }

    const order = await get(`
      SELECT id, order_number, subtotal, tax, total, payment_status
      FROM orders
      WHERE id = $1
    `, [order_id]);

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    if (order.payment_status === 'paid') {
      return res.status(400).json({ error: 'Order is already paid' });
    }

    const tipAmount = typeof tip === 'number' ? tip : 0;
    const totalAmount = order.total + tipAmount;

    const paymentIntent = await createPaymentIntent(totalAmount, {
      order_id: order_id.toString(),
      order_number: order.order_number.toString(),
    });

    // Update order with payment intent ID
    await run(`
      UPDATE orders
      SET payment_intent_id = $1, tip = $2
      WHERE id = $3
    `, [paymentIntent.id, tipAmount, order_id]);

    res.json({
      clientSecret: paymentIntent.client_secret,
      payment_intent_id: paymentIntent.id,
      amount: totalAmount,
    });
  } catch (error) {
    console.error('Error creating payment intent:', error);
    res.status(500).json({ error: 'Failed to create payment intent' });
  }
});

// POST /api/payments/confirm - confirm card payment
router.post('/confirm', paymentLimiter, requireAuth('pos_access'), async (req, res) => {
  try {
    const { order_id, payment_intent_id } = req.body;

    if (!order_id || !payment_intent_id) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const order = await get('SELECT id, payment_status FROM orders WHERE id = $1', [order_id]);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Verify payment intent status
    const paymentIntent = await getPaymentIntent(payment_intent_id);

    if (paymentIntent.status === 'succeeded') {
      await run(`
        UPDATE orders
        SET payment_status = 'paid', status = 'active', payment_method = 'card'
        WHERE id = $1
      `, [order_id]);

      // Deduct inventory after successful payment
      await deductInventoryForOrder(order_id);

      // Auto-generate invoice token for self-service CFDI
      let invoice_token = null;
      try {
        const tenantId = req.tenant?.id || 'default';
        invoice_token = await generateInvoiceToken(tenantId, order_id, 72);
        await run('UPDATE orders SET invoice_token = $1 WHERE id = $2', [invoice_token, order_id]);
      } catch (tokenErr) {
        console.error('Non-fatal: failed to generate invoice token:', tokenErr.message);
      }

      return res.json({
        success: true,
        message: 'Payment confirmed',
        payment_status: 'paid',
        invoice_token,
      });
    } else if (paymentIntent.status === 'processing') {
      return res.json({
        success: true,
        message: 'Payment is processing',
        payment_status: 'processing',
      });
    } else {
      return res.status(400).json({
        success: false,
        message: 'Payment failed',
        payment_status: 'failed',
      });
    }
  } catch (error) {
    console.error('Error confirming payment:', error);
    res.status(500).json({ error: 'Failed to confirm payment' });
  }
});

// POST /api/payments/cash - process cash payment
router.post('/cash', paymentLimiter, requireAuth('pos_access'), async (req, res) => {
  try {
    const { order_id, tip = 0, amount_received = 0 } = req.body;

    if (!order_id) {
      return res.status(400).json({ error: 'Missing order_id' });
    }

    const order = await get(`
      SELECT id, order_number, subtotal, tax, tip, total, payment_status
      FROM orders
      WHERE id = $1
    `, [order_id]);

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    if (order.payment_status === 'paid') {
      return res.status(400).json({ error: 'Order is already paid' });
    }

    const tipAmount = typeof tip === 'number' ? tip : 0;
    const finalTotal = Number(order.total) + tipAmount;
    const changeDue = amount_received > 0 ? Math.max(0, amount_received - finalTotal) : 0;

    // Mark order as paid with cash
    await run(`
      UPDATE orders
      SET payment_status = 'paid', status = 'active', payment_method = 'cash', tip = $1
      WHERE id = $2
    `, [tipAmount, order_id]);

    // Deduct inventory
    await deductInventoryForOrder(order_id);

    // Auto-generate invoice token for self-service CFDI
    let invoice_token = null;
    try {
      const tenantId = req.tenant?.id || 'default';
      invoice_token = await generateInvoiceToken(tenantId, order_id, 72);
      await run('UPDATE orders SET invoice_token = $1 WHERE id = $2', [invoice_token, order_id]);
    } catch (tokenErr) {
      console.error('Non-fatal: failed to generate invoice token:', tokenErr.message);
    }

    res.json({
      success: true,
      message: 'Cash payment processed',
      order_id,
      order_number: order.order_number,
      total: finalTotal,
      amount_received,
      change_due: Math.round(changeDue * 100) / 100,
      payment_method: 'cash',
      invoice_token,
    });
  } catch (error) {
    console.error('Error processing cash payment:', error);
    res.status(500).json({ error: 'Failed to process cash payment' });
  }
});

// POST /api/payments/cash-tip-adjust - record a cash tip added after the
// order was already closed (customer leaves cash on the table after the
// receipt prints — common in MX dine-in).
//
// Permission: void_orders (same trust gate used for editing paid orders).
// Attribution: bumps orders.tip in place so the original shift's payroll
// absorbs the tip; an audit row in order_tip_adjustments preserves the
// add-time so reports can break out post-close tips later.
router.post('/cash-tip-adjust', requireAuth('void_orders'), async (req, res) => {
  try {
    const { order_id, amount, note } = req.body;

    if (!order_id) {
      return res.status(400).json({ error: 'Missing order_id' });
    }
    const tipAmount = Number(amount);
    if (!Number.isFinite(tipAmount) || tipAmount <= 0) {
      return res.status(400).json({ error: 'Amount must be a positive number' });
    }
    const rounded = Math.round(tipAmount * 100) / 100;

    const order = await get(
      `SELECT id, subtotal, total, tip, payment_status, payment_method
       FROM orders WHERE id = $1`,
      [order_id]
    );
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.payment_status !== 'paid') {
      return res.status(400).json({ error: 'Order is not paid' });
    }
    // Only cash and split-with-cash orders can take a cash tip top-up.
    // Card-only orders should void+rerun through the processor.
    const orderMethod = (order.payment_method || '').toLowerCase();
    if (orderMethod !== 'cash' && orderMethod !== 'split') {
      return res.status(400).json({ error: 'Order has no cash payment leg' });
    }

    // Sanity cap: tip cannot exceed subtotal (covers the 100%-tip edge case
    // and blocks obvious typos like 5000 instead of 50.00).
    const subtotal = Number(order.subtotal) || 0;
    if (rounded > subtotal) {
      return res.status(400).json({
        error: `Tip ${rounded} exceeds order subtotal ${subtotal}`,
      });
    }

    // For splits, find the paid cash leg to credit. If none exists (e.g.
    // split was card+card), reject.
    let cashLegId = null;
    if (orderMethod === 'split') {
      const cashLeg = await get(
        `SELECT id FROM order_payments
         WHERE order_id = $1 AND payment_method = 'cash' AND status = 'paid'
         ORDER BY id ASC LIMIT 1`,
        [order_id]
      );
      if (!cashLeg) {
        return res.status(400).json({ error: 'Split order has no paid cash leg' });
      }
      cashLegId = cashLeg.id;
    }

    // Tenant middleware already wraps the whole request in BEGIN/COMMIT
    // on a reserved connection — a nested BEGIN errors out. If any of these
    // statements throws, the surrounding request transaction will roll back.
    await run(
      `INSERT INTO order_tip_adjustments
         (order_id, amount, payment_method, by_employee_id, note)
       VALUES ($1, $2, 'cash', $3, $4)`,
      [order_id, rounded, req.employee.id, note || null]
    );
    await run(
      `UPDATE orders SET tip = COALESCE(tip, 0) + $1 WHERE id = $2`,
      [rounded, order_id]
    );
    if (cashLegId) {
      await run(
        `UPDATE order_payments SET tip = COALESCE(tip, 0) + $1 WHERE id = $2`,
        [rounded, cashLegId]
      );
    }

    const updated = await get(
      `SELECT id, order_number, total, tip FROM orders WHERE id = $1`,
      [order_id]
    );
    res.json({
      success: true,
      order_id: updated.id,
      order_number: updated.order_number,
      tip_total: Number(updated.tip),
      tip_added: rounded,
    });
  } catch (error) {
    console.error('Error adjusting cash tip:', error);
    res.status(500).json({ error: 'Failed to adjust cash tip' });
  }
});

// POST /api/payments/split/start - register N pending splits on an order
// Returns the order_payments rows the client must collect one-by-one.
router.post('/split/start', paymentLimiter, requireAuth('pos_access'), async (req, res) => {
  try {
    const { order_id, splits } = req.body;

    if (!order_id || !Array.isArray(splits) || splits.length === 0) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    for (const s of splits) {
      if (!s || (s.payment_method !== 'card' && s.payment_method !== 'cash')) {
        return res.status(400).json({ error: 'Each split must have payment_method card or cash' });
      }
      if (typeof s.amount !== 'number' || s.amount <= 0) {
        return res.status(400).json({ error: 'Each split must have a positive amount' });
      }
    }

    const order = await get('SELECT id, total, tip, payment_status FROM orders WHERE id = $1', [order_id]);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.payment_status === 'paid') {
      return res.status(400).json({ error: 'Order is already paid' });
    }

    // Sum check: splits must add up to order total (allow 1 cent tolerance for rounding)
    const splitTotal = splits.reduce((sum, s) => sum + Number(s.amount), 0);
    if (Math.abs(splitTotal - Number(order.total)) > 0.02) {
      return res.status(400).json({
        error: `Split totals (${splitTotal.toFixed(2)}) do not match order total (${Number(order.total).toFixed(2)})`,
      });
    }

    // Wipe any prior pending/failed splits for this order (allow re-start).
    // Keep paid splits (recovery from partial collection).
    await run(
      `DELETE FROM order_payments WHERE order_id = $1 AND status NOT IN ('paid')`,
      [order_id]
    );

    const tid = getTenantId();
    const created = [];
    for (const s of splits) {
      const tipAmount = Number(s.tip) || 0;
      const row = await get(
        `INSERT INTO order_payments (tenant_id, order_id, payment_method, amount, tip, status)
         VALUES ($1, $2, $3, $4, $5, 'pending')
         RETURNING id, payment_method, amount, tip, status`,
        [tid, order_id, s.payment_method, s.amount, tipAmount]
      );
      created.push(row);
    }

    // Leave payment_status='unpaid' so an abandoned split flow remains visible in
    // the unpaid-orders recovery list. The 'split' payment_method is the marker.
    await run(
      `UPDATE orders SET payment_method = 'split' WHERE id = $1`,
      [order_id]
    );

    res.json({ success: true, order_id, splits: created });
  } catch (error) {
    console.error('Error starting split payment:', error);
    res.status(500).json({ error: 'Failed to start split payment' });
  }
});

// POST /api/payments/split/charge-card - push a single split to the MP Point terminal.
router.post('/split/charge-card', paymentLimiter, requireAuth('pos_access'), requirePro, async (req, res) => {
  try {
    const { order_payment_id, terminal_id } = req.body;
    if (!order_payment_id) return res.status(400).json({ error: 'Missing order_payment_id' });

    const split = await get(
      `SELECT op.id, op.order_id, op.payment_method, op.amount, op.tip, op.status, op.payment_intent_id,
              o.order_number, o.payment_status AS order_payment_status
         FROM order_payments op
         JOIN orders o ON o.id = op.order_id
        WHERE op.id = $1`,
      [order_payment_id]
    );
    if (!split) return res.status(404).json({ error: 'Split not found' });
    if (split.payment_method !== 'card') {
      return res.status(400).json({ error: 'Split is not a card payment' });
    }
    if (split.status === 'paid') {
      return res.status(400).json({ error: 'Split is already paid' });
    }
    if (split.order_payment_status === 'paid') {
      return res.status(400).json({ error: 'Order is already paid' });
    }

    const tenant = await getTenant(req.tenant.id);
    if (!tenant?.mp_access_token) {
      return res.status(400).json({ error: 'Mercado Pago not connected' });
    }

    const accessToken = await ensureFreshToken(tenant, adminSql);
    const termId = terminal_id || tenant.mp_default_terminal_id;
    if (!termId) return res.status(400).json({ error: 'No terminal selected' });

    const lock = await findActiveTerminalLock(req.tenant.id, { excludeOrderId: split.order_id });
    if (lock) return res.status(409).json(terminalBusyResponse(lock));

    const chargeAmount = Number(split.amount) + (Number(split.tip) || 0);
    const externalRef = `${req.tenant.id}-${split.order_id}-sp${split.id}`;

    const mpOrder = await createPointOrder(accessToken, {
      amount: chargeAmount,
      externalRef,
      terminalId: termId,
    });

    await run(
      `UPDATE order_payments
          SET payment_intent_id = $1, status = 'pending_terminal'
        WHERE id = $2`,
      [mpOrder.id, split.id]
    );

    res.json({ success: true, order_payment_id: split.id, mp_order_id: mpOrder.id });
  } catch (error) {
    console.error('Split MP charge error:', error);
    res.status(500).json({ error: 'Failed to create terminal payment for split' });
  }
});

// POST /api/payments/split/cancel-card - cancel a pending terminal split.
router.post('/split/cancel-card', requireAuth('pos_access'), requirePro, async (req, res) => {
  try {
    const { order_payment_id } = req.body;
    if (!order_payment_id) return res.status(400).json({ error: 'Missing order_payment_id' });

    const split = await get(
      `SELECT id, payment_intent_id, status FROM order_payments WHERE id = $1`,
      [order_payment_id]
    );
    if (!split) return res.status(404).json({ error: 'Split not found' });
    if (split.status !== 'pending_terminal') {
      return res.status(400).json({ error: 'Split is not awaiting terminal' });
    }

    const tenant = await getTenant(req.tenant.id);
    if (tenant?.mp_access_token && split.payment_intent_id) {
      try {
        const accessToken = await ensureFreshToken(tenant, adminSql);
        await cancelPointOrder(accessToken, tenant.mp_default_terminal_id, split.payment_intent_id);
      } catch (cancelErr) {
        console.warn('Split MP cancel warning:', cancelErr.message);
      }
    }

    await run(
      `UPDATE order_payments SET payment_intent_id = NULL, status = 'pending' WHERE id = $1`,
      [split.id]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Split MP cancel error:', error);
    res.status(500).json({ error: 'Failed to cancel terminal split' });
  }
});

// POST /api/payments/split/record-cash - record a cash split as collected.
router.post('/split/record-cash', requireAuth('pos_access'), async (req, res) => {
  try {
    const { order_payment_id, amount_received } = req.body;
    if (!order_payment_id) return res.status(400).json({ error: 'Missing order_payment_id' });

    const split = await get(
      `SELECT id, payment_method, amount, tip, status FROM order_payments WHERE id = $1`,
      [order_payment_id]
    );
    if (!split) return res.status(404).json({ error: 'Split not found' });
    if (split.payment_method !== 'cash') {
      return res.status(400).json({ error: 'Split is not a cash payment' });
    }
    if (split.status === 'paid') {
      return res.status(400).json({ error: 'Split is already paid' });
    }

    const required = Number(split.amount) + (Number(split.tip) || 0);
    const received = Number(amount_received) || 0;
    if (received + 0.005 < required) {
      return res.status(400).json({
        error: `Amount received (${received.toFixed(2)}) is less than required (${required.toFixed(2)})`,
      });
    }
    const change = Math.round((received - required) * 100) / 100;

    await run(
      `UPDATE order_payments SET status = 'paid' WHERE id = $1`,
      [split.id]
    );

    res.json({ success: true, change_due: change });
  } catch (error) {
    console.error('Split cash record error:', error);
    res.status(500).json({ error: 'Failed to record cash split' });
  }
});

// GET /api/payments/split/:order_id/status - return all splits with live MP polling.
router.get('/split/:order_id/status', requireAuth('pos_access'), async (req, res) => {
  try {
    const { order_id } = req.params;
    const splits = await all(
      `SELECT id, payment_method, amount, tip, status, payment_intent_id
         FROM order_payments
        WHERE order_id = $1
        ORDER BY id ASC`,
      [order_id]
    );

    // Live pull MP for any splits still pending_terminal.
    const pendingMp = splits.filter(s => s.status === 'pending_terminal' && s.payment_intent_id);
    if (pendingMp.length > 0 && req.tenant?.id) {
      try {
        const tenant = await getTenant(req.tenant.id);
        if (tenant?.mp_access_token) {
          const accessToken = await ensureFreshToken(tenant, adminSql);
          for (const s of pendingMp) {
            try {
              const mpOrder = await getPointOrder(accessToken, s.payment_intent_id, tenant.mp_default_terminal_id);
              const mapped = mapPointOrderStatus(mpOrder);
              if (mapped === 'paid') {
                // Reconcile any tip the customer added at the terminal device.
                const payment = mpOrder?.transactions?.payments?.[0];
                const grossAmount = Number(payment?.paid_amount ?? payment?.amount ?? mpOrder?.total_amount ?? 0);
                const requestedAmount = Number(payment?.amount ?? 0);
                const splitBill = Number(s.amount) || 0;
                const splitCashierTip = Number(s.tip) || 0;
                const referenceAmount = requestedAmount > 0 ? requestedAmount : (splitBill + splitCashierTip);
                const customerTerminalTip = Math.max(0, Math.round((grossAmount - referenceAmount) * 100) / 100);
                const totalTip = Math.round((splitCashierTip + customerTerminalTip) * 100) / 100;

                if (customerTerminalTip > 0) {
                  await run(
                    `UPDATE order_payments SET status = 'paid', tip = $1 WHERE id = $2`,
                    [totalTip, s.id]
                  );
                  s.tip = totalTip;
                } else {
                  await run(`UPDATE order_payments SET status = 'paid' WHERE id = $1`, [s.id]);
                }
                s.status = 'paid';
              } else if (mapped === 'failed') {
                await run(`UPDATE order_payments SET status = 'failed' WHERE id = $1`, [s.id]);
                s.status = 'failed';
              }
            } catch (innerErr) {
              console.warn('Split MP status pull failed:', innerErr.message);
            }
          }
        }
      } catch (mpErr) {
        console.warn('Split MP status pull setup failed:', mpErr.message);
      }
    }

    res.json({ order_id: Number(order_id), splits });
  } catch (error) {
    console.error('Error fetching split status:', error);
    res.status(500).json({ error: 'Failed to fetch split status' });
  }
});

// POST /api/payments/split/finalize - verify all splits are paid, then mark order paid.
router.post('/split/finalize', requireAuth('pos_access'), async (req, res) => {
  try {
    const { order_id } = req.body;
    if (!order_id) return res.status(400).json({ error: 'Missing order_id' });

    const order = await get('SELECT id, payment_status FROM orders WHERE id = $1', [order_id]);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.payment_status === 'paid') {
      return res.status(400).json({ error: 'Order is already paid' });
    }

    const splits = await all(
      `SELECT id, status, tip FROM order_payments WHERE order_id = $1`,
      [order_id]
    );
    if (splits.length === 0) {
      return res.status(400).json({ error: 'No splits found for order' });
    }
    const unpaid = splits.filter(s => s.status !== 'paid');
    if (unpaid.length > 0) {
      return res.status(400).json({
        error: `Cannot finalize: ${unpaid.length} split(s) still unpaid`,
        unpaid_ids: unpaid.map(s => s.id),
      });
    }

    const totalTip = splits.reduce((sum, s) => sum + (Number(s.tip) || 0), 0);

    await run(
      `UPDATE orders
          SET payment_status = 'paid', status = 'active',
              payment_method = 'split', tip = $1, paid_at = NOW()
        WHERE id = $2`,
      [totalTip, order_id]
    );

    await deductInventoryForOrder(order_id);

    let invoice_token = null;
    try {
      invoice_token = await generateInvoiceToken(req.tenant?.id || 'default', order_id, 72);
      await run('UPDATE orders SET invoice_token = $1 WHERE id = $2', [invoice_token, order_id]);
    } catch (tokenErr) {
      console.error('Non-fatal: split finalize invoice token failed:', tokenErr.message);
    }

    res.json({ success: true, splits_count: splits.length, tip: totalTip, invoice_token });
  } catch (error) {
    console.error('Error finalizing split payment:', error);
    res.status(500).json({ error: 'Failed to finalize split payment' });
  }
});

// GET /api/payments/split/:order_id - get split details (legacy endpoint, kept for read use)
router.get('/split/:order_id', async (req, res) => {
  try {
    const { order_id } = req.params;
    const payments = await all('SELECT * FROM order_payments WHERE order_id = $1', [order_id]);
    res.json(payments);
  } catch (error) {
    console.error('Error fetching split payments:', error);
    res.status(500).json({ error: 'Failed to fetch split payments' });
  }
});

// POST /api/payments/split - DEPRECATED. The old endpoint marked orders paid without
// actually charging cards or collecting cash. Clients must use the new flow:
//   /split/start → /split/charge-card or /split/record-cash → /split/finalize
router.post('/split', requireAuth('pos_access'), async (_req, res) => {
  res.status(410).json({
    error: 'This endpoint is deprecated. Use /split/start + per-split charge endpoints + /split/finalize.',
  });
});

// POST /api/payments/refund - refund payment (full, partial by items, or partial by amount)
router.post('/refund', refundLimiter, requireAuth('process_refunds'), async (req, res) => {
  try {
    const { order_id, amount, items, reason } = req.body;

    if (!order_id) {
      return res.status(400).json({ error: 'Missing order_id' });
    }

    const order = await get(`
      SELECT id, payment_intent_id, conekta_order_id, getnet_payment_id, payment_status, payment_method, total, tip, refund_total
      FROM orders
      WHERE id = $1
    `, [order_id]);

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    if (order.payment_status !== 'paid' && order.payment_status !== 'completed') {
      return res.status(400).json({ error: 'Order must be paid before refunding' });
    }

    const existingRefundTotal = Number(order.refund_total) || 0;
    const maxRefundable = Number(order.total) + Number(order.tip) - existingRefundTotal;

    // Determine refund type and amount
    let refundAmount;
    let refundType;
    let itemsJson = null;
    let refundItems = [];

    if (items && items.length > 0) {
      // Partial refund by items
      refundType = 'partial_items';
      refundAmount = 0;

      for (const refundItem of items) {
        const orderItem = await get(
          'SELECT id, unit_price, quantity FROM order_items WHERE id = $1 AND order_id = $2',
          [refundItem.order_item_id, order_id]
        );
        if (!orderItem) {
          return res.status(400).json({ error: `Order item ${refundItem.order_item_id} not found` });
        }
        const qty = refundItem.quantity || Number(orderItem.quantity);
        const itemAmount = Number(orderItem.unit_price) * qty;
        refundAmount += itemAmount;
        refundItems.push({
          order_item_id: refundItem.order_item_id,
          quantity: qty,
          amount: Math.round(itemAmount * 100) / 100,
        });
      }

      refundAmount = Math.round(refundAmount * 100) / 100;
      itemsJson = JSON.stringify(refundItems);
    } else if (amount) {
      // Partial refund by amount
      refundType = 'partial_amount';
      refundAmount = Math.round(amount * 100) / 100;
    } else {
      // Full refund of remaining refundable amount
      refundType = 'full';
      refundAmount = Math.round(maxRefundable * 100) / 100;
    }

    if (refundAmount > maxRefundable) {
      return res.status(400).json({
        error: `Refund amount ($${refundAmount}) exceeds maximum refundable ($${maxRefundable.toFixed(2)})`,
      });
    }

    if (refundAmount <= 0) {
      return res.status(400).json({ error: 'Invalid refund amount' });
    }

    // Process refund via the appropriate payment processor
    let stripeRefundId = null;
    let conektaRefundId = null;
    let getnetRefundId = null;

    if (order.conekta_order_id && (order.payment_method === 'card' || order.payment_method === 'oxxo' || order.payment_method === 'spei')) {
      // Conekta refund
      try {
        const refund = await createConektaRefund(order.conekta_order_id, refundAmount);
        conektaRefundId = refund.refund_id;
      } catch (conektaError) {
        console.error('Conekta refund error:', conektaError);
        return res.status(500).json({ error: 'Conekta refund failed. Please try again or contact support.' });
      }
    } else if (order.getnet_payment_id && (order.payment_method === 'getnet_card' || order.payment_method === 'getnet_tap')) {
      // Getnet refund
      try {
        const tenantId = req.tenant?.id;
        const configRows = await adminSql`
          SELECT environment FROM getnet_merchant_configs WHERE tenant_id = ${tenantId} AND enabled = true LIMIT 1
        `;
        const env = configRows[0]?.environment || 'sandbox';
        const refund = await getnetRefundPayment(tenantId, env, order.getnet_payment_id, refundAmount);
        getnetRefundId = refund.refund_id;
      } catch (getnetError) {
        console.error('Getnet refund error:', getnetError);
        return res.status(500).json({ error: 'Getnet refund failed. Please try again or contact support.' });
      }
    } else if (order.payment_intent_id && order.payment_method === 'card') {
      // Stripe refund
      try {
        const refund = await createRefund(order.payment_intent_id, refundAmount);
        stripeRefundId = refund.id;
      } catch (stripeError) {
        console.error('Stripe refund error:', stripeError);
        return res.status(500).json({ error: 'Stripe refund failed. Please try again or contact support.' });
      }
    }

    // Insert refund record
    const employeeId = req.employee?.id || null;
    const refundTid = getTenantId();
    const result = await run(`
      INSERT INTO refunds (tenant_id, order_id, stripe_refund_id, conekta_refund_id, getnet_refund_id, amount, reason, refund_type, refunded_by, items_json, inventory_restored)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    `, [refundTid, order_id, stripeRefundId, conektaRefundId, getnetRefundId, refundAmount, reason || null, refundType, employeeId, itemsJson, refundItems.length > 0]);

    // Update order refund_total
    const newRefundTotal = existingRefundTotal + refundAmount;
    const fullyRefunded = newRefundTotal >= (Number(order.total) + Number(order.tip));

    await run(`
      UPDATE orders
      SET refund_total = $1, payment_status = $2
      WHERE id = $3
    `, [newRefundTotal, fullyRefunded ? 'refunded' : order.payment_status, order_id]);

    // Restore inventory for refunded items
    if (refundItems.length > 0) {
      await restoreInventoryForItems(refundItems);
    }

    res.json({
      success: true,
      refund_id: result.lastInsertRowid,
      stripe_refund_id: stripeRefundId,
      conekta_refund_id: conektaRefundId,
      getnet_refund_id: getnetRefundId,
      amount: refundAmount,
      refund_type: refundType,
      new_refund_total: newRefundTotal,
      fully_refunded: fullyRefunded,
    });
  } catch (error) {
    console.error('Error refunding payment:', error);
    res.status(500).json({ error: 'Failed to refund payment' });
  }
});

// GET /api/payments/refunds/:order_id - get refunds for an order
router.get('/refunds/:order_id', async (req, res) => {
  try {
    const { order_id } = req.params;
    const refunds = await all(`
      SELECT r.*, e.name as refunded_by_name
      FROM refunds r
      LEFT JOIN employees e ON r.refunded_by = e.id
      WHERE r.order_id = $1
      ORDER BY r.created_at DESC
    `, [order_id]);
    res.json(refunds);
  } catch (error) {
    console.error('Error fetching refunds:', error);
    res.status(500).json({ error: 'Failed to fetch refunds' });
  }
});

// GET /api/payments/refunds - all refunds with date filtering
router.get('/refunds', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    let query = `
      SELECT r.*, e.name as refunded_by_name, o.order_number
      FROM refunds r
      LEFT JOIN employees e ON r.refunded_by = e.id
      LEFT JOIN orders o ON r.order_id = o.id
      WHERE 1=1
    `;
    const params = [];
    let paramIdx = 1;

    if (start_date) {
      query += ` AND r.created_at::date >= $${paramIdx++}`;
      params.push(start_date);
    }
    if (end_date) {
      query += ` AND r.created_at::date <= $${paramIdx++}`;
      params.push(end_date);
    }

    query += ' ORDER BY r.created_at DESC LIMIT 200';

    const refunds = await all(query, params);
    res.json(refunds);
  } catch (error) {
    console.error('Error fetching all refunds:', error);
    res.status(500).json({ error: 'Failed to fetch refunds' });
  }
});


// ==================== Conekta Endpoints ====================

// POST /api/payments/conekta/oxxo — create OXXO cash payment reference
router.post('/conekta/oxxo', paymentLimiter, requireAuth('pos_access'), async (req, res) => {
  try {
    const { order_id, tip = 0 } = req.body;
    if (!order_id) return res.status(400).json({ error: 'Missing order_id' });

    const order = await get(
      'SELECT id, order_number, total, payment_status FROM orders WHERE id = $1',
      [order_id]
    );
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.payment_status === 'paid') return res.status(400).json({ error: 'Order is already paid' });

    const tipAmount = typeof tip === 'number' ? tip : 0;
    const totalAmount = Number(order.total) + tipAmount;

    const result = await createOxxoOrder(
      totalAmount,
      { order_id: String(order_id), order_number: String(order.order_number), tenant_id: getTenantId() },
      {},
      72 // 72 hours expiry
    );

    await run(`
      UPDATE orders
      SET conekta_order_id = $1, conekta_charge_id = $2,
          oxxo_reference = $3, oxxo_barcode_url = $4,
          async_payment_expires_at = $5,
          payment_status = 'pending_oxxo', payment_method = 'oxxo', tip = $6
      WHERE id = $7
    `, [
      result.conekta_order_id, result.conekta_charge_id,
      result.reference, result.barcode_url,
      result.expires_at, tipAmount, order_id,
    ]);

    res.json({
      success: true,
      reference: result.reference,
      barcode_url: result.barcode_url,
      expires_at: result.expires_at,
      conekta_order_id: result.conekta_order_id,
      amount: totalAmount,
    });
  } catch (error) {
    console.error('Conekta OXXO error:', error);
    res.status(500).json({ error: error.message || 'Failed to create OXXO payment' });
  }
});

// POST /api/payments/conekta/spei — create SPEI bank transfer reference
router.post('/conekta/spei', paymentLimiter, requireAuth('pos_access'), async (req, res) => {
  try {
    const { order_id, tip = 0 } = req.body;
    if (!order_id) return res.status(400).json({ error: 'Missing order_id' });

    const order = await get(
      'SELECT id, order_number, total, payment_status FROM orders WHERE id = $1',
      [order_id]
    );
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.payment_status === 'paid') return res.status(400).json({ error: 'Order is already paid' });

    const tipAmount = typeof tip === 'number' ? tip : 0;
    const totalAmount = Number(order.total) + tipAmount;

    const result = await createSpeiOrder(
      totalAmount,
      { order_id: String(order_id), order_number: String(order.order_number), tenant_id: getTenantId() },
      {},
      72 // 72 hours expiry
    );

    await run(`
      UPDATE orders
      SET conekta_order_id = $1, conekta_charge_id = $2,
          spei_clabe = $3,
          async_payment_expires_at = $4,
          payment_status = 'pending_spei', payment_method = 'spei', tip = $5
      WHERE id = $6
    `, [
      result.conekta_order_id, result.conekta_charge_id,
      result.clabe,
      result.expires_at, tipAmount, order_id,
    ]);

    res.json({
      success: true,
      clabe: result.clabe,
      bank: result.bank,
      expires_at: result.expires_at,
      conekta_order_id: result.conekta_order_id,
      amount: totalAmount,
    });
  } catch (error) {
    console.error('Conekta SPEI error:', error);
    res.status(500).json({ error: error.message || 'Failed to create SPEI payment' });
  }
});

// POST /api/payments/conekta/card — create Conekta card charge
router.post('/conekta/card', paymentLimiter, requireAuth('pos_access'), async (req, res) => {
  try {
    const { order_id, token_id, tip = 0 } = req.body;
    if (!order_id || !token_id) return res.status(400).json({ error: 'Missing order_id or token_id' });

    const order = await get(
      'SELECT id, order_number, total, payment_status FROM orders WHERE id = $1',
      [order_id]
    );
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.payment_status === 'paid') return res.status(400).json({ error: 'Order is already paid' });

    const tipAmount = typeof tip === 'number' ? tip : 0;
    const totalAmount = Number(order.total) + tipAmount;

    const result = await conektaCardOrder(
      totalAmount,
      token_id,
      { order_id: String(order_id), order_number: String(order.order_number) },
      {}
    );

    if (result.status === 'paid' || result.status === 'pre_authorized') {
      await run(`
        UPDATE orders
        SET conekta_order_id = $1, conekta_charge_id = $2,
            payment_status = 'paid', payment_method = 'card', tip = $3, paid_at = NOW()
        WHERE id = $4
      `, [result.conekta_order_id, result.conekta_charge_id, tipAmount, order_id]);

      await deductInventoryForOrder(order_id);

      res.json({
        success: true,
        payment_status: 'paid',
        conekta_order_id: result.conekta_order_id,
      });
    } else {
      res.status(400).json({ error: 'Card payment failed', status: result.status });
    }
  } catch (error) {
    console.error('Conekta card error:', error);
    res.status(500).json({ error: error.message || 'Failed to process card payment' });
  }
});

// GET /api/payments/conekta/status/:order_id — check async payment status
router.get('/conekta/status/:order_id', requireAuth('pos_access'), async (req, res) => {
  try {
    const { order_id } = req.params;
    const order = await get(
      'SELECT id, conekta_order_id, payment_status FROM orders WHERE id = $1',
      [order_id]
    );
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (!order.conekta_order_id) return res.json({ payment_status: order.payment_status });

    const conektaOrder = await getConektaOrder(order.conekta_order_id);
    res.json({
      payment_status: order.payment_status,
      conekta_status: conektaOrder.payment_status,
      charges: conektaOrder.charges?.data?.map(c => ({
        id: c.id,
        status: c.status,
        paid_at: c.paid_at,
      })) || [],
    });
  } catch (error) {
    console.error('Conekta status check error:', error);
    res.status(500).json({ error: 'Failed to check payment status' });
  }
});

// ==================== Mercado Pago Point Endpoints (Pro+) ====================

/** Middleware: require Pro plan */
function requirePro(req, res, next) {
  const plan = req.tenant?.plan;
  if (plan !== 'pro') {
    return res.status(403).json({ error: 'Mercado Pago Point requires a Pro plan' });
  }
  next();
}

async function markTerminalOrderPaid(orderId, tenantId = 'default', { mpOrder = null, mpAccessToken = null } = {}) {
  const completed = await get(
    `UPDATE orders
     SET payment_status = 'paid',
         status = CASE
           WHEN status IN ('ready', 'completed') THEN status
           ELSE 'preparing'
         END,
         payment_method = 'card',
         paid_at = COALESCE(paid_at, NOW())
     WHERE id = $1
       AND (
         payment_status IS DISTINCT FROM 'paid'
         OR payment_method IS DISTINCT FROM 'card'
         OR status NOT IN ('preparing', 'ready', 'completed')
       )
     RETURNING id, invoice_token`,
    [orderId]
  );

  if (completed) {
    await deductInventoryForOrder(orderId);
  }

  // Persist the MP terminal payment + processor fee for owner-facing reports.
  // Fire-and-record: failures here must not block payment completion.
  if (mpOrder) {
    try {
      await recordMpTerminalPayment(orderId, tenantId, mpOrder, mpAccessToken);
    } catch (feeErr) {
      console.warn('MP order_payments insert failed (non-fatal):', feeErr.message);
    }
  }

  let invoice_token = null;
  try {
    const tokenRow = completed || await get('SELECT invoice_token FROM orders WHERE id = $1', [orderId]);
    invoice_token = tokenRow?.invoice_token || null;
    if (!invoice_token) {
      invoice_token = await generateInvoiceToken(tenantId, orderId, 72);
      await run('UPDATE orders SET invoice_token = $1 WHERE id = $2', [invoice_token, orderId]);
    }
  } catch (tokenErr) {
    console.error('Non-fatal: failed to generate invoice token:', tokenErr.message);
  }

  return invoice_token;
}

/**
 * Returns the order currently holding the MP terminal for this tenant, or null
 * if free. Cross-device coordination: prevents two kiosks (or kiosk + POS) from
 * racing each other to the single shared terminal. The 3-minute window matches
 * the stranded-terminal threshold in /api/orders/kiosk-held — anything older
 * is presumed dead and rescuable, so we don't lock the terminal forever.
 *
 * Checks both order-level (`orders.payment_status`) and split-level
 * (`order_payments.status`) pending_terminal rows.
 */
export async function findActiveTerminalLock(tenantId, { excludeOrderId = null } = {}) {
  const orderRows = excludeOrderId
    ? await adminSql`
        SELECT order_number, source, id
        FROM orders
        WHERE tenant_id = ${tenantId}
          AND payment_status = 'pending_terminal'
          AND created_at > NOW() - INTERVAL '3 minutes'
          AND id != ${excludeOrderId}
        ORDER BY created_at DESC LIMIT 1
      `
    : await adminSql`
        SELECT order_number, source, id
        FROM orders
        WHERE tenant_id = ${tenantId}
          AND payment_status = 'pending_terminal'
          AND created_at > NOW() - INTERVAL '3 minutes'
        ORDER BY created_at DESC LIMIT 1
      `;
  if (orderRows[0]) return orderRows[0];

  const splitRows = excludeOrderId
    ? await adminSql`
        SELECT o.order_number, o.source, op.order_id AS id
        FROM order_payments op
        JOIN orders o ON o.id = op.order_id
        WHERE o.tenant_id = ${tenantId}
          AND op.status = 'pending_terminal'
          AND op.created_at > NOW() - INTERVAL '3 minutes'
          AND op.order_id != ${excludeOrderId}
        ORDER BY op.created_at DESC LIMIT 1
      `
    : await adminSql`
        SELECT o.order_number, o.source, op.order_id AS id
        FROM order_payments op
        JOIN orders o ON o.id = op.order_id
        WHERE o.tenant_id = ${tenantId}
          AND op.status = 'pending_terminal'
          AND op.created_at > NOW() - INTERVAL '3 minutes'
        ORDER BY op.created_at DESC LIMIT 1
      `;
  return splitRows[0] || null;
}

function terminalBusyResponse(lock) {
  return {
    error: `Terminal en uso — orden #${lock.order_number} en proceso. Inténtalo en unos segundos.`,
    code: 'terminal_busy',
    current_order_number: String(lock.order_number),
  };
}

/**
 * Idempotently insert an order_payments row for an MP Point payment, capturing
 * the processor fee + raw response. Owners read this back in FeesTab to see
 * what MP is actually charging them — cashiers never see it.
 */
export async function recordMpTerminalPayment(orderId, tenantId, mpOrder, mpAccessToken) {
  const existing = await get(
    `SELECT id FROM order_payments WHERE order_id = $1 AND payment_method = 'mp_terminal'`,
    [orderId]
  );
  if (existing) return;

  const payment = mpOrder?.transactions?.payments?.[0];
  const grossAmount = Number(payment?.paid_amount ?? payment?.amount ?? mpOrder?.total_amount ?? 0);
  const requestedAmount = Number(payment?.amount ?? 0);

  const orderRow = await get('SELECT total, tip FROM orders WHERE id = $1', [orderId]);
  const orderTotal = Number(orderRow?.total || 0);
  const cashierTip = Number(orderRow?.tip || 0);

  // What we asked MP to charge. Prefer MP's echoed `amount`; fall back to what we sent.
  const referenceAmount = requestedAmount > 0 ? requestedAmount : (orderTotal + cashierTip);
  const customerTerminalTip = Math.max(0, Math.round((grossAmount - referenceAmount) * 100) / 100);
  const totalTip = Math.round((cashierTip + customerTerminalTip) * 100) / 100;
  const billAmount = Math.round((grossAmount - totalTip) * 100) / 100;

  if (customerTerminalTip > 0) {
    await run('UPDATE orders SET tip = $1 WHERE id = $2', [totalTip, orderId]);
  }

  const fees = await extractMpFees(mpAccessToken, mpOrder);

  await run(
    `INSERT INTO order_payments
       (tenant_id, order_id, payment_method, amount, tip, payment_intent_id, status, processor_fee, processor_net, processor_response)
     VALUES ($1, $2, 'mp_terminal', $3, $4, $5, 'paid', $6, $7, $8)`,
    [
      tenantId,
      orderId,
      billAmount,
      totalTip,
      mpOrder?.id ?? null,
      fees.fee,
      fees.net,
      fees.raw ? JSON.stringify(fees.raw) : null,
    ]
  );
}

// GET /api/payments/mp/connect — initiate MP OAuth flow
router.get('/mp/connect', requireAuth('pos_access'), requirePro, async (req, res) => {
  const mpCreds = await getServiceCredentials(req.tenant.id, 'mercadopago', {
    client_id: 'MP_CLIENT_ID',
  });
  const tenantOrigin = `${req.protocol}://${req.get('host')}`;
  const params = new URLSearchParams({
    client_id: mpCreds.client_id || '',
    response_type: 'code',
    platform_id: 'mp',
    redirect_uri: `${tenantOrigin}/api/payments/mp/callback`,
    state: `${req.tenant.id}:${crypto.createHmac('sha256', JWT_SECRET).update(req.tenant.id).digest('hex')}`,
  });
  res.json({ auth_url: `https://auth.mercadopago.com/authorization?${params}` });
});

// GET /api/payments/mp/terminals — list Point terminals in PDV mode
router.get('/mp/terminals', requireAuth('pos_access'), requirePro, async (req, res) => {
  try {
    const tenant = await getTenant(req.tenant.id);
    if (!tenant?.mp_access_token) {
      return res.status(400).json({ error: 'Mercado Pago not connected' });
    }
    const accessToken = await ensureFreshToken(tenant, adminSql);
    const terminals = await mpGetTerminals(accessToken);
    res.json({ terminals });
  } catch (error) {
    console.error('MP getTerminals error:', error);
    res.status(500).json({ error: 'Failed to fetch terminals' });
  }
});

// POST /api/payments/mp/terminals/default — set default terminal
router.post('/mp/terminals/default', requireAuth('pos_access'), requirePro, async (req, res) => {
  try {
    const { terminal_id } = req.body;
    if (!terminal_id) return res.status(400).json({ error: 'Missing terminal_id' });
    await adminSql`UPDATE tenants SET mp_default_terminal_id = ${terminal_id} WHERE id = ${req.tenant.id}`;
    res.json({ success: true });
  } catch (error) {
    console.error('MP setDefaultTerminal error:', error);
    res.status(500).json({ error: 'Failed to set default terminal' });
  }
});

// POST /api/payments/mp/charge — create MP payment intent and push to terminal
router.post('/mp/charge', requireAuth('pos_access'), requirePro, async (req, res) => {
  try {
    const { order_id, terminal_id, tip = 0 } = req.body;
    if (!order_id) return res.status(400).json({ error: 'Missing order_id' });

    const order = await get('SELECT id, total, order_number, payment_status FROM orders WHERE id = $1', [order_id]);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.payment_status === 'paid') return res.status(400).json({ error: 'Order is already paid' });

    const tenant = await getTenant(req.tenant.id);
    if (!tenant?.mp_access_token) {
      return res.status(400).json({ error: 'Mercado Pago not connected' });
    }

    const accessToken = await ensureFreshToken(tenant, adminSql);
    const termId = terminal_id || tenant.mp_default_terminal_id;
    if (!termId) return res.status(400).json({ error: 'No terminal selected' });

    const lock = await findActiveTerminalLock(req.tenant.id, { excludeOrderId: order.id });
    if (lock) return res.status(409).json(terminalBusyResponse(lock));

    const tipAmount = typeof tip === 'number' ? tip : 0;
    const totalAmount = Number(order.total) + tipAmount;
    const externalRef = `${req.tenant.id}-${order.id}`;

    let mpOrder;
    try {
      mpOrder = await createPointOrder(accessToken, {
        amount: totalAmount,
        externalRef,
        terminalId: termId,
      });
    } catch (err) {
      if (!isQueueStuckError(err)) throw err;
      console.warn(`MP queue stuck for tenant ${req.tenant.id} — running auto-recovery`);
      const recovery = await recoverStuckQueue(accessToken, { tenantId: req.tenant.id, sql: adminSql });
      console.log(`Auto-recovery: cleared ${recovery.cleared}/${recovery.attempted} stuck intent(s)`);
      try {
        mpOrder = await createPointOrder(accessToken, {
          amount: totalAmount,
          externalRef,
          terminalId: termId,
        });
      } catch (retryErr) {
        if (isQueueStuckError(retryErr)) {
          return res.status(409).json({
            error: 'queue_stuck',
            message: 'La cola de la terminal sigue bloqueada. Reinicia la terminal e inténtalo de nuevo.',
            recovery,
          });
        }
        throw retryErr;
      }
    }

    await run(
      `UPDATE orders SET mp_order_id = $1, payment_status = 'pending_terminal', tip = $2 WHERE id = $3`,
      [mpOrder.id, tipAmount, order.id]
    );

    res.json({ success: true, mp_order_id: mpOrder.id, payment_intent_id: mpOrder.id });
  } catch (error) {
    console.error('MP charge error:', error);
    res.status(500).json({ error: 'Failed to create terminal payment' });
  }
});

// POST /api/payments/mp/cancel — cancel a pending terminal payment
router.post('/mp/cancel', requireAuth('pos_access'), requirePro, async (req, res) => {
  try {
    const { order_id } = req.body;
    if (!order_id) return res.status(400).json({ error: 'Missing order_id' });

    const order = await get('SELECT id, mp_order_id, payment_status FROM orders WHERE id = $1', [order_id]);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.payment_status !== 'pending_terminal') {
      return res.status(400).json({ error: 'Order is not pending terminal payment' });
    }

    const tenant = await getTenant(req.tenant.id);
    if (!tenant?.mp_access_token) {
      return res.status(400).json({ error: 'Mercado Pago not connected' });
    }

    const accessToken = await ensureFreshToken(tenant, adminSql);
    const termId = tenant.mp_default_terminal_id;
    if (termId && order.mp_order_id) {
      try {
        await cancelPointOrder(accessToken, termId, order.mp_order_id);
      } catch (cancelErr) {
        console.error('MP cancel warning:', cancelErr.message);
      }
    }

    await run(
      `UPDATE orders SET payment_status = 'unpaid', mp_order_id = NULL WHERE id = $1`,
      [order.id]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('MP cancel error:', error);
    res.status(500).json({ error: 'Failed to cancel terminal payment' });
  }
});

// GET /api/payments/mp/status — tenant MP connection status
router.get('/mp/status', requireAuth('pos_access'), async (req, res) => {
  try {
    const tenant = await getTenant(req.tenant.id);
    res.json({
      connected: !!tenant?.mp_user_id,
      mp_user_id: tenant?.mp_user_id || null,
      mp_default_terminal_id: tenant?.mp_default_terminal_id || null,
    });
  } catch (error) {
    console.error('MP status error:', error);
    res.status(500).json({ error: 'Failed to get MP status' });
  }
});

// ==================== Clip PinPad Terminal ====================

// GET /api/payments/clip/status — tenant Clip configuration status
router.get('/clip/status', requireAuth('pos_access'), async (req, res) => {
  try {
    const authHeader = await getClipAuthHeader(req.tenant.id);
    const terminalId = await getClipDefaultTerminalId(req.tenant.id);
    res.json({
      configured: !!authHeader,
      default_terminal_id: terminalId,
    });
  } catch (error) {
    console.error('Clip status error:', error);
    res.status(500).json({ error: 'Failed to get Clip status' });
  }
});

// POST /api/payments/clip/charge — create a PinPad payment intent
router.post('/clip/charge', paymentLimiter, requireAuth('pos_access'), async (req, res) => {
  try {
    const { order_id, terminal_id } = req.body;
    if (!order_id) return res.status(400).json({ error: 'Missing order_id' });

    const order = await get(
      'SELECT id, total, order_number, payment_status FROM orders WHERE id = $1',
      [order_id]
    );
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.payment_status === 'paid') {
      return res.status(400).json({ error: 'Order is already paid' });
    }

    const authHeader = await getClipAuthHeader(req.tenant.id);
    if (!authHeader) {
      return res.status(400).json({ error: 'Clip not configured' });
    }

    const termId = terminal_id || (await getClipDefaultTerminalId(req.tenant.id));
    if (!termId) return res.status(400).json({ error: 'No Clip terminal selected' });

    const externalRef = `${req.tenant.id}-${order.id}`;
    const { payment_id } = await clipCreatePinPadPayment(authHeader, {
      amount: Number(order.total),
      externalRef,
      terminalId: termId,
    });

    await run(
      `UPDATE orders
         SET clip_payment_id = $1,
             clip_terminal_id = $2,
             payment_status = 'pending_terminal'
       WHERE id = $3`,
      [payment_id, termId, order.id]
    );

    res.json({ success: true, clip_payment_id: payment_id });
  } catch (error) {
    console.error('Clip charge error:', error);
    res.status(500).json({ error: 'Failed to create Clip terminal payment' });
  }
});

// POST /api/payments/clip/cancel — cancel a pending PinPad payment
router.post('/clip/cancel', requireAuth('pos_access'), async (req, res) => {
  try {
    const { order_id } = req.body;
    if (!order_id) return res.status(400).json({ error: 'Missing order_id' });

    const order = await get(
      'SELECT id, clip_payment_id, payment_status FROM orders WHERE id = $1',
      [order_id]
    );
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.payment_status !== 'pending_terminal') {
      return res.status(400).json({ error: 'Order is not pending terminal payment' });
    }

    const authHeader = await getClipAuthHeader(req.tenant.id);
    if (authHeader && order.clip_payment_id) {
      try {
        await clipCancelPinPadPayment(authHeader, order.clip_payment_id);
      } catch (cancelErr) {
        console.warn('Clip cancel warning:', cancelErr.message);
      }
    }

    await run(
      `UPDATE orders
         SET payment_status = 'unpaid', clip_payment_id = NULL, clip_terminal_id = NULL
       WHERE id = $1`,
      [order.id]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Clip cancel error:', error);
    res.status(500).json({ error: 'Failed to cancel Clip terminal payment' });
  }
});

// GET /api/payments/:order_id - get payment status
router.get('/:order_id', async (req, res) => {
  try {
    const { order_id } = req.params;

    const order = await get(`
      SELECT id, order_number, payment_intent_id, payment_status, payment_method, status, total, tip, refund_total, mp_order_id, clip_payment_id
      FROM orders
      WHERE id = $1
    `, [order_id]);

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Clip PinPad live status pull: webhooks aren't required for correctness.
    if (order.payment_status === 'pending_terminal' && order.clip_payment_id && req.tenant?.id) {
      try {
        const authHeader = await getClipAuthHeader(req.tenant.id);
        if (authHeader) {
          const result = await clipGetPaymentStatus(authHeader, order.clip_payment_id);
          if (result) {
            const mapped = mapClipStatus(result.status);
            if (mapped === 'paid') {
              await run(
                `UPDATE orders SET payment_status = 'paid', payment_method = 'card', paid_at = NOW() WHERE id = $1`,
                [order.id]
              );
              order.payment_status = 'paid';
              order.payment_method = 'card';
            } else if (mapped === 'failed') {
              await run(
                `UPDATE orders SET payment_status = 'failed' WHERE id = $1`,
                [order.id]
              );
              order.payment_status = 'failed';
            }
          }
        }
      } catch (clipErr) {
        console.warn('Clip live status pull failed:', clipErr.message);
      }
    }

    // MP Point live status pull: webhooks may not be configured per-tenant,
    // so query MP directly when the order is still awaiting the terminal.
    if (order.payment_status === 'pending_terminal' && order.mp_order_id && req.tenant?.id) {
      try {
        const tenant = await getTenant(req.tenant.id);
        if (tenant?.mp_access_token) {
          const accessToken = await ensureFreshToken(tenant, adminSql);
          const mpOrder = await getPointOrder(accessToken, order.mp_order_id, tenant.mp_default_terminal_id);
          const mapped = mapPointOrderStatus(mpOrder);
          if (mapped === 'paid') {
            await markTerminalOrderPaid(order.id, req.tenant.id, { mpOrder, mpAccessToken: accessToken });
            order.payment_status = 'paid';
            order.payment_method = 'card';
          } else if (mapped === 'failed') {
            await run(
              `UPDATE orders SET payment_status = 'failed' WHERE id = $1`,
              [order.id]
            );
            order.payment_status = 'failed';
          }
        }
      } catch (mpErr) {
        console.warn('MP live status pull failed:', mpErr.message);
      }
    }

    if (
      order.payment_status === 'paid' &&
      order.mp_order_id &&
      req.tenant?.id &&
      (order.payment_method !== 'card' || !['active', 'preparing', 'ready', 'completed'].includes(order.status))
    ) {
      await markTerminalOrderPaid(order.id, req.tenant.id);
      order.payment_method = 'card';
      order.status = order.status === 'ready' || order.status === 'completed' ? order.status : 'active';
    }

    if (!order.payment_intent_id) {
      return res.json({
        order_id,
        payment_status: order.payment_status || 'unpaid',
        payment_method: order.payment_method,
        amount: Number(order.total) + Number(order.tip),
        refund_total: Number(order.refund_total) || 0,
      });
    }

    const paymentIntent = await getPaymentIntent(order.payment_intent_id);

    res.json({
      order_id,
      order_number: order.order_number,
      payment_status: paymentIntent.status,
      payment_method: order.payment_method,
      amount: Number(order.total) + Number(order.tip),
      payment_intent_id: order.payment_intent_id,
      refund_total: order.refund_total || 0,
    });
  } catch (error) {
    console.error('Error fetching payment status:', error);
    res.status(500).json({ error: 'Failed to fetch payment status' });
  }
});

// ==================== MP OAuth Callback (mounted before tenant middleware) ====================
export async function mpOAuthCallback(req, res) {
  const { code, state } = req.query;
  if (!code || !state) {
    return res.status(400).send('Missing code or state');
  }

  // Verify HMAC-signed state to prevent tenant ID spoofing
  const sepIdx = state.lastIndexOf(':');
  if (sepIdx === -1) {
    return res.status(400).send('Invalid state parameter');
  }
  const tenantId = state.slice(0, sepIdx);
  const signature = state.slice(sepIdx + 1);
  const expected = crypto.createHmac('sha256', JWT_SECRET).update(tenantId).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))) {
    return res.status(403).send('Invalid state signature');
  }

  try {
    // Resolve MP credentials for this tenant
    const mpCreds = await getServiceCredentials(tenantId, 'mercadopago', {
      client_id: 'MP_CLIENT_ID',
      client_secret: 'MP_CLIENT_SECRET',
    });

    const tenantOrigin = `${req.protocol}://${req.get('host')}`;
    const tokenRes = await fetch('https://api.mercadopago.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_secret: mpCreds.client_secret,
        client_id: mpCreds.client_id,
        grant_type: 'authorization_code',
        code,
        redirect_uri: `${tenantOrigin}/api/payments/mp/callback`,
      }),
    });

    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      console.error('MP OAuth token exchange failed:', text);
      return res.redirect('/#/account?mp=error');
    }

    const data = await tokenRes.json();
    const { access_token, refresh_token, user_id, expires_in } = data;
    const expiresAt = new Date(Date.now() + expires_in * 1000);

    await adminSql`
      UPDATE tenants
      SET mp_access_token = ${access_token},
          mp_refresh_token = ${refresh_token},
          mp_user_id = ${String(user_id)},
          mp_token_expires_at = ${expiresAt}
      WHERE id = ${tenantId}
    `;

    res.redirect('/#/account?mp=connected');
  } catch (error) {
    console.error('MP OAuth callback error:', error);
    res.redirect('/#/account?mp=error');
  }
}

// ==================== MP Webhook (mounted before tenant middleware) ====================
export async function mpWebhook(req, res) {
  // Always respond 200 immediately (MP requires fast acknowledgement)
  res.sendStatus(200);

  try {
    const { action, data } = req.body || {};
    if (!action || !data) return;

    // Verify webhook signature if MP_WEBHOOK_SECRET is configured
    const webhookSecret = process.env.MP_WEBHOOK_SECRET;
    if (webhookSecret) {
      const xSignature = req.headers['x-signature'];
      const xRequestId = req.headers['x-request-id'];
      if (!xSignature || !xRequestId) {
        console.warn('MP webhook: missing x-signature or x-request-id header');
        return;
      }

      const parts = xSignature.split(',');
      let ts, hash;
      for (const part of parts) {
        const [key, ...rest] = part.split('=');
        const value = rest.join('=');
        if (key.trim() === 'ts') ts = value.trim();
        if (key.trim() === 'v1') hash = value.trim();
      }

      if (!ts || !hash) {
        console.warn('MP webhook: malformed x-signature header');
        return;
      }

      const template = `id:${data.id};request-id:${xRequestId};ts:${ts};`;
      const expected = crypto.createHmac('sha256', webhookSecret).update(template).digest('hex');

      if (expected !== hash) {
        console.warn('MP webhook: signature verification failed');
        return;
      }
    } else {
      console.warn('MP webhook: MP_WEBHOOK_SECRET not set — skipping signature verification');
    }

    if (action === 'payment.updated' || action === 'payment') {
      // MP Point webhook: look up by payment intent ID or external_reference
      const paymentId = data.id;
      if (!paymentId) return;

      // Fetch the payment details from MP to get the status
      // We need to find the tenant for this payment
      const order = await adminSql`
        SELECT o.id, o.tenant_id, o.mp_order_id, o.payment_status, o.payment_method, o.status
        FROM orders o
        WHERE o.mp_order_id = ${String(paymentId)}
        LIMIT 1
      `;

      if (order.length === 0) return;
      const ord = order[0];

      if (
        ord.payment_status === 'paid' &&
        ord.payment_method === 'card' &&
        ['preparing', 'ready', 'completed'].includes(ord.status)
      ) return; // already processed

      if (ord.payment_status === 'paid') {
        await markTerminalOrderPaid(ord.id, ord.tenant_id);
        return;
      }

      // Get tenant's token to verify payment status
      const tenant = await getTenant(ord.tenant_id);
      if (!tenant?.mp_access_token) return;

      let accessToken;
      try {
        accessToken = await ensureFreshToken(tenant, adminSql);
      } catch {
        return;
      }

      const mpOrder = await getPointOrder(accessToken, paymentId, tenant.mp_default_terminal_id);
      const mapped = mapPointOrderStatus(mpOrder);

      if (mapped === 'paid') {
        await markTerminalOrderPaid(ord.id, ord.tenant_id, { mpOrder, mpAccessToken: accessToken });
      } else if (mapped === 'failed') {
        await adminSql`
          UPDATE orders
          SET payment_status = 'failed'
          WHERE id = ${ord.id}
        `;
      }
    }
  } catch (error) {
    console.error('MP webhook processing error:', error);
  }
}

// ==================== Conekta Webhook (mounted before tenant middleware) ====================
export async function conektaWebhook(req, res) {
  // Always respond 200 immediately (Conekta requires fast acknowledgement)
  res.sendStatus(200);

  try {
    // Signature verification. Conekta signs the raw JSON body with RSA-SHA256
    // and sends the base64 digest in the `Digest` header. Resolve the
    // verification key per-tenant (by subdomain) with a platform env fallback.
    const tenantHost = (req.hostname || req.headers.host?.split(':')[0] || '').toLowerCase();
    const subdomain = tenantHost.split('.')[0];
    let webhookTenantId = null;
    if (subdomain && subdomain !== 'pos' && subdomain !== 'localhost' && subdomain !== '127') {
      const tenantRow = await getTenantBySubdomain(subdomain).catch(() => null);
      if (tenantRow?.id) webhookTenantId = tenantRow.id;
    }
    const publicKey = await getConektaWebhookPublicKey(webhookTenantId);

    if (publicKey) {
      const signature = req.headers.digest;
      const rawBody = req.rawBody;
      if (!signature || !rawBody) {
        console.warn('Conekta webhook: missing Digest header or raw body — rejecting');
        return;
      }
      if (!verifyConektaSignature(rawBody, signature, publicKey)) {
        console.warn('Conekta webhook: signature verification failed — rejecting');
        return;
      }
    } else {
      console.warn('Conekta webhook: no public key configured (tenant or CONEKTA_WEBHOOK_PUBLIC_KEY) — skipping signature verification');
    }

    const { type, data } = req.body || {};
    if (!type || !data) return;

    const chargeObj = data?.object;
    if (!chargeObj) return;

    // Extract order_id from the Conekta order's metadata or look up by charge/order ID
    const conektaOrderId = chargeObj.order_id || null;
    const conektaChargeId = chargeObj.id || null;

    if (!conektaOrderId && !conektaChargeId) return;

    // Look up the POS order using conekta_order_id or conekta_charge_id
    const orders = await adminSql`
      SELECT id, tenant_id, payment_status
      FROM orders
      WHERE conekta_order_id = ${conektaOrderId || ''}
         OR conekta_charge_id = ${conektaChargeId || ''}
      LIMIT 1
    `;

    if (orders.length === 0) return;
    const ord = orders[0];

    if (type === 'charge.paid' || type === 'order.paid') {
      if (ord.payment_status === 'paid') return; // already processed

      await adminSql`
        UPDATE orders
        SET payment_status = 'paid', status = 'active', paid_at = NOW()
        WHERE id = ${ord.id}
      `;

      // Deduct inventory (fire-and-forget since we're outside tenant context)
      try {
        // Use adminSql for cross-tenant inventory deduction
        const items = await adminSql`
          SELECT oi.menu_item_id, oi.quantity
          FROM order_items oi
          WHERE oi.order_id = ${ord.id}
        `;
        for (const item of items) {
          await adminSql`
            UPDATE inventory_items ii
            SET quantity = ii.quantity - (
              SELECT COALESCE(SUM(mii.quantity_used * ${item.quantity}), 0)
              FROM menu_item_ingredients mii
              WHERE mii.menu_item_id = ${item.menu_item_id}
                AND mii.inventory_item_id = ii.id
            )
            WHERE ii.tenant_id = ${ord.tenant_id}
              AND ii.id IN (
                SELECT mii.inventory_item_id
                FROM menu_item_ingredients mii
                WHERE mii.menu_item_id = ${item.menu_item_id}
              )
          `;
        }
      } catch (invErr) {
        console.error('Conekta webhook: inventory deduction error:', invErr.message);
      }
    } else if (type === 'charge.expired' || type === 'order.expired') {
      if (ord.payment_status === 'paid') return; // don't expire a paid order

      await adminSql`
        UPDATE orders
        SET payment_status = 'expired'
        WHERE id = ${ord.id}
      `;
    }
  } catch (error) {
    console.error('Conekta webhook processing error:', error);
  }
}

export default router;
