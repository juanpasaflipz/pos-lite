import { fetchWithTimeout } from '../lib/http.js';
import { Router } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { JWT_SECRET } from '../lib/constants.js';
import { all, get, run, adminSql, getTenantId, withTenant } from '../db/index.js';
import { createPaymentIntent, createRefund, getPaymentIntent } from '../stripe.js';
import { requireAuth } from '../middleware/auth.js';
import { audit } from '../lib/auditLog.js';
import {
  deductInventoryForOrder,
  restoreInventoryForItems,
  restoreComponentsForOrderLines,
} from '../helpers/inventory.js';
import { generateInvoiceToken } from '../helpers/facturapi.js';
import { enqueueCustomerTicket } from '../lib/printQueue.js';
import { getTenant } from '../tenants.js';
import {
  ensureFreshToken,
  getTerminals as mpGetTerminals,
  getAllDevices as mpGetAllDevices,
  setDeviceOperatingMode as mpSetDeviceOperatingMode,
  createPointOrder,
  getPointOrder,
  mapPointOrderStatus,
  cancelPointOrder,
  isQueueStuckError,
  recoverStuckQueue,
  extractMpFees,
  MP_POINT_MIN_AMOUNT,
  parseMpError,
} from '../services/mercadopago.js';
import { getServiceCredentials } from '../helpers/tenantCredentials.js';
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

// Per-order throttle for MP Point live status pulls. The PaymentModal polls
// GET /payments/:order_id every ~2s while awaiting the terminal; that would
// hit MP 30x/min per pending payment and burn through the per-token 429
// budget. Skip the live pull when we last asked <5s ago and return the
// cached mapped status.
const mpStatusCache = new Map(); // order_id -> { ts, mapped }
const MP_STATUS_CACHE_MS = 5000;

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
      await enqueueCustomerTicket(order_id);

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

    // Mark order as paid with cash. paid_at is what every sales report uses
    // as the time-of-truth (COALESCE(paid_at, created_at)); skipping it here
    // silently drops cash tickets from cash/card breakdowns and hourly views.
    await run(`
      UPDATE orders
      SET payment_status = 'paid', status = 'active', payment_method = 'cash', tip = $1, paid_at = NOW()
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
    await enqueueCustomerTicket(order_id);

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

// POST /api/payments/external-terminal — settle an order charged on a
// NON-integrated bank terminal (Inbursa, BBVA, ...; see external-terminals.js).
// The bank device has no API: the cashier keys total+tip into it by hand and
// only after the terminal approves taps "pago aprobado" in the POS, which
// calls this. Mirrors /cash exactly (paid_at is the reports time-of-truth,
// inventory deducts, CFDI token mints, customer ticket enqueues) but records
// payment_method = 'external_terminal' + which device took it, so reports
// split these sales per terminal and estimate fees from its fee_percent.
router.post('/external-terminal', paymentLimiter, requireAuth('pos_access'), async (req, res) => {
  try {
    const { order_id, terminal_id, tip = 0 } = req.body;

    if (!order_id) return res.status(400).json({ error: 'Missing order_id' });
    if (!terminal_id) return res.status(400).json({ error: 'Missing terminal_id' });

    // RLS scopes the lookup to the tenant; inactive terminals can't take new charges.
    const terminal = await get(`
      SELECT id, name FROM external_terminals WHERE id = $1 AND active = true
    `, [terminal_id]);
    if (!terminal) return res.status(404).json({ error: 'Terminal not found or inactive' });

    const order = await get(`
      SELECT id, order_number, total, payment_status
      FROM orders
      WHERE id = $1
    `, [order_id]);

    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.payment_status === 'paid') {
      return res.status(400).json({ error: 'Order is already paid' });
    }

    const tipAmount = typeof tip === 'number' && Number.isFinite(tip) && tip >= 0 ? tip : 0;
    const finalTotal = Number(order.total) + tipAmount;

    await run(`
      UPDATE orders
      SET payment_status = 'paid', status = 'active',
          payment_method = 'external_terminal', external_terminal_id = $1,
          tip = $2, paid_at = NOW()
      WHERE id = $3
    `, [terminal.id, tipAmount, order_id]);

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
    await enqueueCustomerTicket(order_id);

    res.json({
      success: true,
      order_id,
      order_number: order.order_number,
      total: finalTotal,
      payment_method: 'external_terminal',
      terminal_name: terminal.name,
      invoice_token,
    });
  } catch (error) {
    console.error('Error processing external terminal payment:', error);
    res.status(500).json({ error: 'Failed to process external terminal payment' });
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
    const termId = terminal_id;
    if (!termId) return res.status(400).json({ error: 'Pair this workstation to a terminal first', code: 'terminal_unpaired' });

    const lock = await findActiveTerminalLock(req.tenant.id, { excludeOrderId: split.order_id });
    if (lock) return res.status(409).json(terminalBusyResponse(lock));

    const chargeAmount = Number(split.amount) + (Number(split.tip) || 0);
    const externalRef = `${req.tenant.id}-${split.order_id}-sp${split.id}`;

    if (chargeAmount < MP_POINT_MIN_AMOUNT) {
      return res.status(400).json({
        error: `El monto mínimo para terminal es $${MP_POINT_MIN_AMOUNT.toFixed(2)} MXN. Ajusta este split o cobra en efectivo.`,
        code: 'amount_below_min',
        min_amount: MP_POINT_MIN_AMOUNT,
      });
    }

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
    const { status, payload } = parseMpError(error);
    res.status(status).json(payload);
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

// POST /api/payments/split/abandon - tear the split back down to a normal payment.
// The escape hatch for a split that can't be collected (unresponsive terminal,
// customer changes their mind): drops the uncollected legs and clears the 'split'
// marker so the order can be charged in full from the regular payment modal.
// Refuses once any leg is paid — that money has to be reconciled, not discarded.
router.post('/split/abandon', requireAuth('pos_access'), async (req, res) => {
  try {
    const { order_id } = req.body;
    if (!order_id) return res.status(400).json({ error: 'Missing order_id' });

    const order = await get('SELECT id, payment_status FROM orders WHERE id = $1', [order_id]);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.payment_status === 'paid') {
      return res.status(400).json({ error: 'Order is already paid' });
    }

    const splits = await all(
      `SELECT id, status, payment_intent_id FROM order_payments WHERE order_id = $1`,
      [order_id]
    );
    if (splits.some(s => s.status === 'paid')) {
      return res.status(400).json({
        error: 'Some splits are already collected. Finish or refund them before charging in full.',
        code: 'splits_collected',
      });
    }

    // Never leave a live intent on the terminal behind an abandoned split.
    const live = splits.filter(s => s.status === 'pending_terminal' && s.payment_intent_id);
    if (live.length > 0) {
      const tenant = await getTenant(req.tenant.id);
      if (tenant?.mp_access_token) {
        try {
          const accessToken = await ensureFreshToken(tenant, adminSql);
          for (const s of live) {
            try {
              await cancelPointOrder(accessToken, tenant.mp_default_terminal_id, s.payment_intent_id);
            } catch (cancelErr) {
              console.warn('Split abandon MP cancel warning:', cancelErr.message);
            }
          }
        } catch (tokenErr) {
          console.warn('Split abandon token refresh warning:', tokenErr.message);
        }
      }
    }

    await run(`DELETE FROM order_payments WHERE order_id = $1 AND status <> 'paid'`, [order_id]);
    await run(
      `UPDATE orders SET payment_method = NULL, payment_status = 'unpaid' WHERE id = $1`,
      [order_id]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Split abandon error:', error);
    res.status(500).json({ error: 'Failed to cancel split payment' });
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
    await enqueueCustomerTicket(order_id);

    res.json({ success: true, splits_count: splits.length, tip: totalTip, invoice_token });
  } catch (error) {
    console.error('Error finalizing split payment:', error);
    res.status(500).json({ error: 'Failed to finalize split payment' });
  }
});

// GET /api/payments/split/:order_id - get split details (legacy endpoint, kept for read use)
router.get('/split/:order_id', requireAuth(), async (req, res) => {
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
router.post('/refund', refundLimiter, requireAuth('process_refunds', { allowApproval: true }), async (req, res) => {
  try {
    const { order_id, amount, items, reason } = req.body;

    if (!order_id) {
      return res.status(400).json({ error: 'Missing order_id' });
    }

    // Lock the order row for the duration of the tenant transaction so
    // concurrent /refund calls (double-tap, client retry) serialize and can't
    // both authorize a refund against the same remaining balance.
    const order = await get(`
      SELECT id, payment_intent_id, conekta_order_id, getnet_payment_id, payment_status, payment_method, total, tip, refund_total
      FROM orders
      WHERE id = $1
      FOR UPDATE
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
      // Conekta integration removed (2026-07-16). Legacy Conekta-paid orders must be
      // refunded from the Conekta dashboard; conekta_order_id / refunds.conekta_refund_id
      // columns are kept for historical rows only.
      return res.status(400).json({ error: 'Conekta payments are no longer supported. Refund this order from the Conekta dashboard.' });
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

    // Restore inventory for refunded items.
    //
    // Two-stage tenants give back the refunded lines' ledger NET, so a line
    // refunded twice hands back only what it still owed. They also restore on a
    // FULL refund, which the ingredients path never did — with deduction at
    // ring-up, a fully refunded order that returned nothing would walk the
    // portion count down permanently. Amount-only refunds name no lines, so
    // neither mode can restore anything for them.
    if ((req.tenant?.inventory_mode || 'ingredients') === 'two_stage') {
      let restoreIds = refundItems.map((it) => Number(it.order_item_id));
      if (refundType === 'full') {
        const live = await all(
          'SELECT id FROM order_items WHERE order_id = $1 AND voided_at IS NULL',
          [order_id]
        );
        restoreIds = live.map((it) => Number(it.id));
      }
      if (restoreIds.length > 0) {
        await restoreComponentsForOrderLines(null, {
          orderItemIds: restoreIds,
          employeeId,
          reason: 'refund_restore',
        });
      }
    } else if (refundItems.length > 0) {
      await restoreInventoryForItems(refundItems);
    }

    audit({
      tenantId: req.tenant?.id || 'default',
      actorType: 'employee',
      actorId: employeeId != null ? String(employeeId) : null,
      action: 'refund',
      resource: 'order',
      resourceId: String(order_id),
      details: {
        amount: refundAmount,
        refund_type: refundType,
        fully_refunded: fullyRefunded,
        ...(req.approver && {
          approved_by_employee_id: req.approver.id,
          approved_by_name: req.approver.name,
        }),
      },
      ip: req.ip,
    });

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
router.get('/refunds/:order_id', requireAuth(), async (req, res) => {
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
router.get('/refunds', requireAuth(), async (req, res) => {
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
    // Only on the actual paid transition — this function is re-entered on
    // every status poll, and completed is null on those, so no duplicate
    // ticket per poll.
    await enqueueCustomerTicket(orderId);
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
 * racing each other to the same terminal. The 3-minute window matches
 * the stranded-terminal threshold in /api/orders/kiosk-held — anything older
 * is presumed dead and rescuable, so we don't lock the terminal forever.
 *
 * Checks both order-level (`orders.payment_status`) and split-level
 * (`order_payments.status`) pending_terminal rows.
 *
 * When `terminalId` is provided, the lock is scoped to that specific MP device
 * so two kiosks paired to different terminals don't collide. Splits don't
 * carry a per-row terminal id (the POS picks one at charge time), so scoping
 * is best-effort there — we still consider any in-flight split as a tenant-
 * wide lock to avoid double-firing the POS terminal.
 */
export async function findActiveTerminalLock(
  tenantId,
  { excludeOrderId = null, terminalId = null } = {}
) {
  const orderRows = terminalId
    ? (excludeOrderId
        ? await adminSql`
            SELECT order_number, source, id
            FROM orders
            WHERE tenant_id = ${tenantId}
              AND payment_status = 'pending_terminal'
              AND mp_terminal_id = ${terminalId}
              AND created_at > NOW() - INTERVAL '3 minutes'
              AND id != ${excludeOrderId}
            ORDER BY created_at DESC LIMIT 1
          `
        : await adminSql`
            SELECT order_number, source, id
            FROM orders
            WHERE tenant_id = ${tenantId}
              AND payment_status = 'pending_terminal'
              AND mp_terminal_id = ${terminalId}
              AND created_at > NOW() - INTERVAL '3 minutes'
            ORDER BY created_at DESC LIMIT 1
          `)
    : (excludeOrderId
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
          `);
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

// GET /api/payments/mp/devices — list ALL Point devices (any operating mode).
// Used during terminal setup: new devices ship in STANDALONE mode and don't
// appear in /mp/terminals until activated.
router.get('/mp/devices', requireAuth('pos_access'), requirePro, async (req, res) => {
  try {
    const tenant = await getTenant(req.tenant.id);
    if (!tenant?.mp_access_token) {
      return res.status(400).json({ error: 'Mercado Pago not connected' });
    }
    const accessToken = await ensureFreshToken(tenant, adminSql);
    const devices = await mpGetAllDevices(accessToken);
    res.json({ devices });
  } catch (error) {
    console.error('MP getAllDevices error:', error);
    res.status(500).json({ error: 'Failed to fetch devices' });
  }
});

// POST /api/payments/mp/devices/operating-mode — switch a device between
// STANDALONE and PDV (integrated) mode. The terminal must be restarted
// afterwards for the change to take effect.
router.post('/mp/devices/operating-mode', requireAuth('pos_access'), requirePro, async (req, res) => {
  try {
    const { device_id, operating_mode = 'PDV' } = req.body;
    if (!device_id) return res.status(400).json({ error: 'Missing device_id' });
    if (!['PDV', 'STANDALONE'].includes(operating_mode)) {
      return res.status(400).json({ error: 'Invalid operating_mode' });
    }

    const tenant = await getTenant(req.tenant.id);
    if (!tenant?.mp_access_token) {
      return res.status(400).json({ error: 'Mercado Pago not connected' });
    }
    const accessToken = await ensureFreshToken(tenant, adminSql);
    const result = await mpSetDeviceOperatingMode(accessToken, device_id, operating_mode);
    res.json({ success: true, operating_mode: result?.operating_mode || operating_mode });
  } catch (error) {
    console.error('MP setDeviceOperatingMode error:', error);
    res.status(500).json({ error: 'Failed to update device operating mode' });
  }
});

// POST /api/payments/mp/terminals/default — set default terminal (POS side).
// Used by AccountScreen for the counter/register terminal.
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

// POST /api/payments/mp/terminals/kiosk-default — set kiosk-side default terminal.
// Distinct from the POS default so unpaired kiosk devices land on the
// customer-side terminal instead of the counter one. Accepts terminal_id: ''
// (or null) to clear back to the POS default fallback.
router.post('/mp/terminals/kiosk-default', requireAuth('pos_access'), requirePro, async (req, res) => {
  try {
    const raw = req.body?.terminal_id;
    const terminal_id = typeof raw === 'string' && raw.trim() ? raw.trim() : null;
    await adminSql`UPDATE tenants SET mp_default_kiosk_terminal_id = ${terminal_id} WHERE id = ${req.tenant.id}`;
    res.json({ success: true });
  } catch (error) {
    console.error('MP setKioskDefaultTerminal error:', error);
    res.status(500).json({ error: 'Failed to set kiosk default terminal' });
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
    const termId = terminal_id;
    if (!termId) return res.status(400).json({ error: 'Pair this workstation to a terminal first', code: 'terminal_unpaired' });

    const lock = await findActiveTerminalLock(req.tenant.id, {
      excludeOrderId: order.id,
      terminalId: termId,
    });
    if (lock) return res.status(409).json(terminalBusyResponse(lock));

    const tipAmount = typeof tip === 'number' ? tip : 0;
    const totalAmount = Number(order.total) + tipAmount;
    const externalRef = `${req.tenant.id}-${order.id}`;

    if (totalAmount < MP_POINT_MIN_AMOUNT) {
      return res.status(400).json({
        error: `El monto mínimo para terminal es $${MP_POINT_MIN_AMOUNT.toFixed(2)} MXN. Cobra en efectivo o ajusta el total.`,
        code: 'amount_below_min',
        min_amount: MP_POINT_MIN_AMOUNT,
      });
    }

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
      `UPDATE orders SET mp_order_id = $1, payment_status = 'pending_terminal', tip = $2, mp_terminal_id = $3 WHERE id = $4`,
      [mpOrder.id, tipAmount, termId, order.id]
    );

    res.json({ success: true, mp_order_id: mpOrder.id, payment_intent_id: mpOrder.id, terminal_id: termId });
  } catch (error) {
    console.error('MP charge error:', error);
    const { status, payload } = parseMpError(error);
    res.status(status).json(payload);
  }
});

// POST /api/payments/mp/cancel — cancel a pending terminal payment
router.post('/mp/cancel', requireAuth('pos_access'), requirePro, async (req, res) => {
  try {
    const { order_id, terminal_id } = req.body;
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
    // Cancel on the terminal the charge was actually sent to — per-workstation
    // bindings mean it is not necessarily the tenant default.
    const termId = terminal_id || tenant.mp_default_terminal_id;

    // Race guard: if the customer's card cleared just as the cashier tapped
    // Cancel, void here would strand the payment (paid at terminal, unpaid in DB).
    if (order.mp_order_id) {
      try {
        const mpOrder = await getPointOrder(accessToken, order.mp_order_id, termId);
        if (mapPointOrderStatus(mpOrder) === 'paid') {
          await markTerminalOrderPaid(order.id, req.tenant.id, {
            mpOrder,
            mpAccessToken: accessToken,
          });
          return res.json({ success: true, cancelled: false, paid: true });
        }
      } catch (pollErr) {
        console.warn('MP cancel pre-poll failed (continuing with cancel):', pollErr.message);
      }
    }

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

    res.json({ success: true, cancelled: true });
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
      mp_default_kiosk_terminal_id: tenant?.mp_default_kiosk_terminal_id || null,
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

// ==================== Cobrar Juntas (Pay Together) ====================
//
// One CC swipe (or one cash tender) closes N open tickets at once.
// Motivation: cashiers used to void + re-ring when a customer wanted to pay
// multiple open checks together, which left orphan "ready + unpaid" rows in
// the DB (see 2026-06-30 pilot audit). Each ticket keeps its own KDS
// lifecycle, loyalty attribution, and refund path — this only consolidates
// the payment leg.
//
// Split math: shares are proportional to each order's total (subtotal + tax).
// Rounding delta lands on the largest ticket so the sum matches to the cent.

function splitProportionally(orders, tipAmount) {
  const totals = orders.map((o) => Number(o.total) || 0);
  const grandTotal = totals.reduce((a, b) => a + b, 0);
  const largestIdx = totals.reduce((maxI, v, i, arr) => (v > arr[maxI] ? i : maxI), 0);

  const tipCents = Math.round((Number(tipAmount) || 0) * 100);
  const rawTipCents = totals.map((t) =>
    grandTotal > 0 ? Math.round((t / grandTotal) * tipCents) : 0
  );
  const tipDelta = tipCents - rawTipCents.reduce((a, b) => a + b, 0);
  rawTipCents[largestIdx] += tipDelta;

  return orders.map((o, i) => ({
    order_id: o.id,
    subtotal: Number(o.subtotal) || 0,
    tax: Number(o.tax) || 0,
    total: Number(o.total) || 0,
    tip_share: Math.round(rawTipCents[i]) / 100,
    charge_share: (Number(o.total) || 0) + Math.round(rawTipCents[i]) / 100,
  }));
}

router.post('/pay-together', paymentLimiter, requireAuth('pos_access'), async (req, res) => {
  try {
    const { order_ids, payment_method, tip = 0, mp_terminal_id, cash_received } = req.body || {};

    if (!Array.isArray(order_ids) || order_ids.length < 2) {
      return res.status(400).json({ error: 'Provide at least 2 order_ids' });
    }
    const uniqueIds = [...new Set(order_ids.map(Number))].filter(Number.isInteger);
    if (uniqueIds.length !== order_ids.length) {
      return res.status(400).json({ error: 'order_ids must be unique integers' });
    }
    if (!['cash', 'mp_terminal'].includes(payment_method)) {
      return res.status(400).json({ error: 'payment_method must be cash or mp_terminal' });
    }
    const tipAmount = Math.max(0, Number(tip) || 0);

    const orders = await all(
      `SELECT id, order_number, subtotal, tax, tip, total, status, payment_status, source, loyalty_customer_id
       FROM orders
       WHERE id = ANY($1::int[])
       ORDER BY id ASC`,
      [uniqueIds]
    );
    if (orders.length !== uniqueIds.length) {
      return res.status(404).json({ error: 'One or more orders not found' });
    }
    for (const o of orders) {
      if (o.status === 'draft_kiosk') {
        return res.status(400).json({ error: `Order #${o.order_number} is a kiosk draft — claim it first` });
      }
      if (!['unpaid', 'failed'].includes(o.payment_status)) {
        return res.status(400).json({ error: `Order #${o.order_number} is not unpaid (${o.payment_status})` });
      }
    }

    const shares = splitProportionally(orders, tipAmount);
    const subtotalSum = orders.reduce((a, o) => a + Number(o.subtotal || 0), 0);
    const taxSum = orders.reduce((a, o) => a + Number(o.tax || 0), 0);
    const totalSum = orders.reduce((a, o) => a + Number(o.total || 0), 0);
    const combinedCharge = Math.round((totalSum + tipAmount) * 100) / 100;

    const tenantId = req.tenant.id;

    // --- Cash path: everything closes in the request transaction ---
    if (payment_method === 'cash') {
      const group = await get(
        `INSERT INTO payment_groups
           (employee_id, subtotal, tax, tip, total, payment_method, status, paid_at)
         VALUES ($1, $2, $3, $4, $5, 'cash', 'paid', NOW())
         RETURNING id, created_at, paid_at`,
        [req.employee.id, subtotalSum, taxSum, tipAmount, combinedCharge]
      );

      for (const s of shares) {
        await run(
          `INSERT INTO order_payments
             (order_id, payment_method, amount, tip, status)
           VALUES ($1, 'cash', $2, $3, 'paid')`,
          [s.order_id, s.total, s.tip_share]
        );
        // Deliberately does NOT touch `status` or `completed_at`. Paying is not
        // finishing: a kiosk ticket fires to the kitchen before the customer
        // pays, so closing the order here erased it from the KDS while the food
        // was still being cooked. Every other tender in this file leaves the
        // order in flight — including this route's own card branch — and the
        // kitchen completes it via ready → autoCompleteReadyOrders.
        //
        // Leaving status alone rather than forcing 'active' is what lets an
        // order the kitchen already marked 'ready' stay ready instead of being
        // shoved back onto the rail as in-progress.
        await run(
          `UPDATE orders
             SET payment_status = 'paid',
                 payment_method = 'cash',
                 payment_group_id = $1,
                 tip = $2,
                 paid_at = COALESCE(paid_at, NOW())
           WHERE id = $3`,
          [group.id, s.tip_share, s.order_id]
        );
      }

      // Non-blocking side effects (inventory, invoice tokens). Loyalty stamps
      // per-order via the existing hook path in orders.js is not fired here —
      // opt-in flow: cashier links customer per ticket at ring time.
      for (const s of shares) {
        try { await deductInventoryForOrder(s.order_id); } catch (e) {
          console.warn('pay-together inventory deduct failed:', e.message);
        }
      }
      for (const s of shares) {
        try {
          const token = await generateInvoiceToken(tenantId, s.order_id, 72);
          await run('UPDATE orders SET invoice_token = $1 WHERE id = $2', [token, s.order_id]);
        } catch (tokErr) {
          console.warn('pay-together invoice token failed:', tokErr.message);
        }
      }
      // One auto customer ticket per order in the group (opt-in toggle applies,
      // same as every other completion path). Never throws.
      for (const s of shares) {
        await enqueueCustomerTicket(s.order_id);
      }

      const changeDue = cash_received > 0 ? Math.max(0, Number(cash_received) - combinedCharge) : 0;
      return res.json({
        payment_group_id: group.id,
        status: 'paid',
        payment_method: 'cash',
        total: combinedCharge,
        change_due: Math.round(changeDue * 100) / 100,
        orders: shares,
      });
    }

    // --- MP Terminal path ---
    const tenant = await getTenant(tenantId);
    if (tenant?.plan !== 'pro') {
      return res.status(403).json({ error: 'Mercado Pago Point requires a Pro plan' });
    }
    if (!tenant?.mp_access_token) {
      return res.status(400).json({ error: 'Mercado Pago not connected' });
    }
    const accessToken = await ensureFreshToken(tenant, adminSql);
    const termId = mp_terminal_id;
    if (!termId) return res.status(400).json({ error: 'Pair this workstation to a terminal first', code: 'terminal_unpaired' });

    if (combinedCharge < MP_POINT_MIN_AMOUNT) {
      return res.status(400).json({
        error: `El monto mínimo para terminal es $${MP_POINT_MIN_AMOUNT.toFixed(2)} MXN. Cobra en efectivo o ajusta el total.`,
        code: 'amount_below_min',
        min_amount: MP_POINT_MIN_AMOUNT,
      });
    }

    const lock = await findActiveTerminalLock(tenantId, { terminalId: termId });
    if (lock && !uniqueIds.includes(lock.id)) {
      return res.status(409).json(terminalBusyResponse(lock));
    }

    const groupPending = await get(
      `INSERT INTO payment_groups
         (employee_id, subtotal, tax, tip, total, payment_method, mp_terminal_id, status)
       VALUES ($1, $2, $3, $4, $5, 'mp_terminal', $6, 'pending')
       RETURNING id`,
      [req.employee.id, subtotalSum, taxSum, tipAmount, combinedCharge, termId]
    );

    const externalRef = `${tenantId}-pg-${groupPending.id}`;
    let mpOrder;
    try {
      mpOrder = await createPointOrder(accessToken, {
        amount: combinedCharge,
        externalRef,
        terminalId: termId,
      });
    } catch (err) {
      if (!isQueueStuckError(err)) throw err;
      const recovery = await recoverStuckQueue(accessToken, { tenantId, sql: adminSql });
      console.log(`pay-together auto-recovery: cleared ${recovery.cleared}/${recovery.attempted}`);
      try {
        mpOrder = await createPointOrder(accessToken, {
          amount: combinedCharge, externalRef, terminalId: termId,
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
      `UPDATE payment_groups SET mp_order_id = $1, payment_intent_id = $1 WHERE id = $2`,
      [mpOrder.id, groupPending.id]
    );
    for (const s of shares) {
      await run(
        `UPDATE orders
           SET mp_order_id = $1,
               mp_terminal_id = $2,
               payment_status = 'pending_terminal',
               payment_group_id = $3,
               tip = $4
         WHERE id = $5`,
        [mpOrder.id, termId, groupPending.id, s.tip_share, s.order_id]
      );
    }

    res.json({
      payment_group_id: groupPending.id,
      status: 'pending_terminal',
      payment_method: 'mp_terminal',
      mp_order_id: mpOrder.id,
      mp_terminal_id: termId,
      total: combinedCharge,
      orders: shares,
    });
  } catch (error) {
    console.error('pay-together error:', error);
    const { status, payload } = parseMpError(error);
    res.status(status).json(payload);
  }
});

// POST /api/payments/pay-together/:id/cancel — cancel a pending grouped
// terminal payment (single Cancelar tap in the confirm modal).
router.post('/pay-together/:id/cancel', requireAuth('pos_access'), async (req, res) => {
  try {
    const groupId = Number(req.params.id);
    const group = await get(
      `SELECT id, mp_order_id, mp_terminal_id, payment_method, status
       FROM payment_groups WHERE id = $1`,
      [groupId]
    );
    if (!group) return res.status(404).json({ error: 'Payment group not found' });
    if (group.status === 'paid') return res.status(400).json({ error: 'Group already paid' });

    if (group.payment_method === 'mp_terminal' && group.mp_order_id) {
      const tenant = await getTenant(req.tenant.id);
      const accessToken = tenant?.mp_access_token ? await ensureFreshToken(tenant, adminSql) : null;
      if (accessToken && group.mp_terminal_id) {
        // Race guard mirrors the single-order flow: recheck MP before cancelling
        try {
          const mpOrder = await getPointOrder(accessToken, group.mp_order_id, group.mp_terminal_id);
          if (mapPointOrderStatus(mpOrder) === 'paid') {
            await settlePaymentGroupPaid(groupId, req.tenant.id, { mpOrder, mpAccessToken: accessToken });
            return res.json({ success: true, cancelled: false, paid: true });
          }
        } catch (pollErr) {
          console.warn('pay-together cancel pre-poll failed:', pollErr.message);
        }
        try {
          await cancelPointOrder(accessToken, group.mp_terminal_id, group.mp_order_id);
        } catch (cancelErr) {
          console.warn('pay-together MP cancel warning:', cancelErr.message);
        }
      }
    }

    await run(
      `UPDATE orders
         SET payment_status = 'unpaid', mp_order_id = NULL, mp_terminal_id = NULL, payment_group_id = NULL, tip = 0
       WHERE payment_group_id = $1`,
      [groupId]
    );
    await run(`UPDATE payment_groups SET status = 'cancelled' WHERE id = $1`, [groupId]);

    res.json({ success: true, cancelled: true });
  } catch (error) {
    console.error('pay-together cancel error:', error);
    res.status(500).json({ error: 'Failed to cancel grouped payment' });
  }
});

/**
 * Mark all orders in a group as paid + record processor fee once, then flip
 * the group row to paid. Idempotent — safe to call from status-poll, webhook,
 * or the cancel-race-guard path.
 */
export async function settlePaymentGroupPaid(groupId, tenantId, { mpOrder = null, mpAccessToken = null } = {}) {
  const group = await get(
    `SELECT id, status, mp_order_id FROM payment_groups WHERE id = $1`,
    [groupId]
  );
  if (!group || group.status === 'paid') return;

  const orderRows = await all(
    `SELECT id, tip FROM orders WHERE payment_group_id = $1`,
    [groupId]
  );

  for (const o of orderRows) {
    await run(
      `UPDATE orders
         SET payment_status = 'paid',
             status = CASE WHEN status IN ('ready', 'completed') THEN status ELSE 'completed' END,
             payment_method = 'card',
             paid_at = COALESCE(paid_at, NOW()),
             completed_at = COALESCE(completed_at, NOW())
       WHERE id = $1
         AND (payment_status IS DISTINCT FROM 'paid' OR payment_method IS DISTINCT FROM 'card')`,
      [o.id]
    );
    try { await deductInventoryForOrder(o.id); } catch (e) {
      console.warn('settlePaymentGroupPaid inventory failed:', e.message);
    }
    // Auto customer ticket (opt-in toggle applies) — pay-together card orders
    // previously never printed one. Guarded by the group.status !== 'paid'
    // early return above, so one settle = one ticket per order.
    await enqueueCustomerTicket(o.id);
  }

  // One order_payments row per order, sharing the same mp_order_id.
  // Fee is reported by MP for the combined charge only; we attribute the
  // entire fee to the largest ticket (v1) rather than pro-rate it — the
  // group total is the reconcilable unit for owner reports anyway.
  if (mpOrder && orderRows.length) {
    try {
      const fees = mpAccessToken ? await extractMpFees(mpAccessToken, mpOrder) : { fee: null, net: null, raw: null };
      const largest = orderRows.reduce((maxO, o) => (Number(o.tip) > Number(maxO.tip) ? o : maxO), orderRows[0]);
      for (const o of orderRows) {
        const existing = await get(
          `SELECT id FROM order_payments WHERE order_id = $1 AND payment_method = 'mp_terminal'`,
          [o.id]
        );
        if (existing) continue;
        const orderRow = await get(`SELECT total, tip FROM orders WHERE id = $1`, [o.id]);
        const feeCredit = o.id === largest.id ? fees.fee : null;
        const netCredit = o.id === largest.id ? fees.net : null;
        await run(
          `INSERT INTO order_payments
             (order_id, payment_method, amount, tip, payment_intent_id, status, processor_fee, processor_net, processor_response)
           VALUES ($1, 'mp_terminal', $2, $3, $4, 'paid', $5, $6, $7)`,
          [
            o.id,
            Number(orderRow?.total || 0),
            Number(orderRow?.tip || 0),
            mpOrder.id,
            feeCredit,
            netCredit,
            o.id === largest.id && fees.raw ? JSON.stringify(fees.raw) : null,
          ]
        );
      }
    } catch (feeErr) {
      console.warn('settlePaymentGroupPaid fee record failed:', feeErr.message);
    }
  }

  await run(`UPDATE payment_groups SET status = 'paid', paid_at = COALESCE(paid_at, NOW()) WHERE id = $1`, [groupId]);
}

// GET /api/payments/:order_id - get payment status
router.get('/:order_id', requireAuth(), async (req, res) => {
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
              // Guarded transition (mirrors markTerminalOrderPaid): two
              // concurrent polls must not double-run the side effects.
              const completed = await get(
                `UPDATE orders SET payment_status = 'paid', payment_method = 'card', paid_at = COALESCE(paid_at, NOW())
                 WHERE id = $1 AND payment_status IS DISTINCT FROM 'paid'
                 RETURNING id`,
                [order.id]
              );
              if (completed) {
                await deductInventoryForOrder(order.id);
                // Same auto customer ticket every other completion path gets —
                // Clip card payments were the one paid path that never printed.
                await enqueueCustomerTicket(order.id);
              }
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
    // Cached per-order at MP_STATUS_CACHE_MS so a 2s client poll doesn't
    // hammer MP and blow the per-token 429 budget.
    if (order.payment_status === 'pending_terminal' && order.mp_order_id && req.tenant?.id) {
      const cached = mpStatusCache.get(order.id);
      if (!cached || Date.now() - cached.ts > MP_STATUS_CACHE_MS) {
        try {
          const tenant = await getTenant(req.tenant.id);
          if (tenant?.mp_access_token) {
            const accessToken = await ensureFreshToken(tenant, adminSql);
            const mpOrder = await getPointOrder(accessToken, order.mp_order_id, tenant.mp_default_terminal_id);
            const mapped = mapPointOrderStatus(mpOrder);
            mpStatusCache.set(order.id, { ts: Date.now(), mapped });
            if (mapped === 'paid') {
              await markTerminalOrderPaid(order.id, req.tenant.id, { mpOrder, mpAccessToken: accessToken });
              order.payment_status = 'paid';
              order.payment_method = 'card';
              mpStatusCache.delete(order.id);
            } else if (mapped === 'failed') {
              await run(
                `UPDATE orders SET payment_status = 'failed' WHERE id = $1`,
                [order.id]
              );
              order.payment_status = 'failed';
              mpStatusCache.delete(order.id);
            }
          }
        } catch (mpErr) {
          console.warn('MP live status pull failed:', mpErr.message);
        }
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
    const tokenRes = await fetchWithTimeout('https://api.mercadopago.com/oauth/token', {
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

      // Constant-time compare — a plain !== on the hex digest leaks match
      // progress via timing. Guard length first so timingSafeEqual can't throw
      // on a malformed / short signature value.
      const expectedBuf = Buffer.from(expected, 'hex');
      const hashBuf = Buffer.from(hash, 'hex');
      if (expectedBuf.length !== hashBuf.length || !crypto.timingSafeEqual(expectedBuf, hashBuf)) {
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
        // withTenant: the webhook runs before tenantMiddleware, so without it
        // enqueueCustomerTicket sees no tenant context and silently skips the
        // auto customer ticket whenever the webhook beats the POS status poll.
        await withTenant(ord.tenant_id, () => markTerminalOrderPaid(ord.id, ord.tenant_id));
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
        await withTenant(ord.tenant_id, () => markTerminalOrderPaid(ord.id, ord.tenant_id, { mpOrder, mpAccessToken: accessToken }));
      } else if (mapped === 'failed') {
        // adminSql bypasses RLS — the explicit tenant_id predicate is the only isolation guard here
        await adminSql`
          UPDATE orders
          SET payment_status = 'failed'
          WHERE id = ${ord.id} AND tenant_id = ${ord.tenant_id}
        `;
      }
    }
  } catch (error) {
    console.error('MP webhook processing error:', error);
  }
}

export default router;
