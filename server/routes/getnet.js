import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { get, run, all, getTenantId, adminSql } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { requireOwner } from '../middleware/ownerAuth.js';
import { isGetnetConfigured, getAccessToken, clearTokenCache } from '../services/getnet/auth.js';
import { createPayment, refundPayment, tokenizeCard } from '../services/getnet/payments.js';
import { deductInventoryForOrder } from '../helpers/inventory.js';
import { generateInvoiceToken } from '../helpers/facturapi.js';
import { recordPlatformFee, calculateUpgradeSavings, getFeeSummary } from '../services/getnet/platformFee.js';
import { getTenant } from '../tenants.js';

const router = Router();

// Rate limiting: 20 payment attempts per IP per 15 minutes
const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many payment requests. Please try again later.' },
});

/**
 * Helper: get Getnet merchant config for current tenant.
 */
async function getMerchantConfig(tenantId) {
  const rows = await adminSql`
    SELECT * FROM getnet_merchant_configs
    WHERE tenant_id = ${tenantId} AND enabled = true
    LIMIT 1
  `;
  return rows[0] || null;
}

// GET /api/getnet/status — check if Getnet is configured for this tenant
router.get('/status', requireAuth('pos_access'), async (req, res) => {
  try {
    const tenantId = req.tenant?.id;
    const configured = await isGetnetConfigured(tenantId);
    const config = configured ? await getMerchantConfig(tenantId) : null;
    res.json({
      configured,
      enabled: config?.enabled || false,
      tapOnPhoneEnabled: config?.tap_on_phone_enabled || false,
      environment: config?.environment || 'sandbox',
    });
  } catch (error) {
    console.error('Getnet status error:', error);
    res.status(500).json({ error: 'Failed to check Getnet status' });
  }
});

// POST /api/getnet/setup — configure Getnet for tenant (owner only)
router.post('/setup', requireOwner, async (req, res) => {
  try {
    const tenantId = req.owner.tenantId;
    const { merchant_id, terminal_id, environment = 'sandbox', tap_on_phone_enabled = false } = req.body;

    if (!merchant_id) {
      return res.status(400).json({ error: 'merchant_id is required' });
    }

    // Verify credentials work by getting a token
    try {
      await getAccessToken(tenantId, environment);
    } catch (authError) {
      return res.status(400).json({
        error: 'Failed to authenticate with Getnet. Check your client_id and client_secret in Credentials.',
        details: authError.message,
      });
    }

    // Upsert merchant config
    await adminSql`
      INSERT INTO getnet_merchant_configs (tenant_id, merchant_id, terminal_id, environment, tap_on_phone_enabled)
      VALUES (${tenantId}, ${merchant_id}, ${terminal_id || null}, ${environment}, ${tap_on_phone_enabled})
      ON CONFLICT (tenant_id)
      DO UPDATE SET
        merchant_id = EXCLUDED.merchant_id,
        terminal_id = EXCLUDED.terminal_id,
        environment = EXCLUDED.environment,
        tap_on_phone_enabled = EXCLUDED.tap_on_phone_enabled,
        enabled = true,
        updated_at = NOW()
    `;

    // Enable Getnet on tenant record
    await adminSql`UPDATE tenants SET getnet_enabled = true WHERE id = ${tenantId}`;

    res.json({ success: true, message: 'Getnet configured successfully' });
  } catch (error) {
    console.error('Getnet setup error:', error);
    res.status(500).json({ error: 'Failed to configure Getnet' });
  }
});

// DELETE /api/getnet/setup — disable Getnet for tenant (owner only)
router.delete('/setup', requireOwner, async (req, res) => {
  try {
    const tenantId = req.owner.tenantId;

    await adminSql`
      UPDATE getnet_merchant_configs SET enabled = false, updated_at = NOW()
      WHERE tenant_id = ${tenantId}
    `;
    await adminSql`UPDATE tenants SET getnet_enabled = false WHERE id = ${tenantId}`;
    clearTokenCache(tenantId);

    res.json({ success: true });
  } catch (error) {
    console.error('Getnet disable error:', error);
    res.status(500).json({ error: 'Failed to disable Getnet' });
  }
});

// POST /api/getnet/tokenize — tokenize a card number
router.post('/tokenize', paymentLimiter, requireAuth('pos_access'), async (req, res) => {
  try {
    const tenantId = req.tenant?.id;
    const config = await getMerchantConfig(tenantId);
    if (!config) {
      return res.status(400).json({ error: 'Getnet not configured' });
    }

    const { card_number, expiration_month, expiration_year, security_code, holder_name } = req.body;
    if (!card_number || !expiration_month || !expiration_year || !security_code) {
      return res.status(400).json({ error: 'Missing card details' });
    }

    const result = await tokenizeCard(tenantId, config.environment, {
      cardNumber: card_number,
      expirationMonth: expiration_month,
      expirationYear: expiration_year,
      securityCode: security_code,
      holderName: holder_name || 'POS Customer',
    });

    res.json({
      number_token: result.number_token,
      brand: result.brand,
      last_four: result.last_four,
    });
  } catch (error) {
    console.error('Getnet tokenize error:', error);
    res.status(500).json({ error: error.message || 'Failed to tokenize card' });
  }
});

// POST /api/getnet/charge — create a Getnet card payment
router.post('/charge', paymentLimiter, requireAuth('pos_access'), async (req, res) => {
  try {
    const { order_id, card_token, tip = 0 } = req.body;
    if (!order_id || !card_token) {
      return res.status(400).json({ error: 'Missing order_id or card_token' });
    }

    const tenantId = req.tenant?.id;
    const config = await getMerchantConfig(tenantId);
    if (!config) {
      return res.status(400).json({ error: 'Getnet not configured' });
    }

    const order = await get(
      'SELECT id, order_number, total, payment_status FROM orders WHERE id = $1',
      [order_id]
    );
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.payment_status === 'paid') return res.status(400).json({ error: 'Order is already paid' });

    const tipAmount = typeof tip === 'number' ? tip : 0;
    const totalAmount = Number(order.total) + tipAmount;

    const result = await createPayment(tenantId, config.environment, {
      amount: totalAmount,
      orderId: order_id,
      orderNumber: order.order_number,
      cardToken: card_token,
    });

    // Record transaction
    const tid = getTenantId();
    await run(`
      INSERT INTO getnet_transactions (
        tenant_id, order_id, getnet_payment_id, idempotency_key,
        amount_centavos, payment_type, status,
        authorization_code, card_brand, card_last_four, raw_response
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    `, [
      tid, order_id, result.getnet_payment_id, result.idempotency_key,
      result.amount_centavos, 'credit', result.status,
      result.authorization_code, result.card_brand, result.card_last_four,
      JSON.stringify(result.raw_response),
    ]);

    if (result.status === 'APPROVED' || result.status === 'approved') {
      await run(`
        UPDATE orders
        SET getnet_payment_id = $1, getnet_authorization_code = $2,
            payment_status = 'paid', payment_method = 'getnet_card',
            tip = $3, paid_at = NOW()
        WHERE id = $4
      `, [result.getnet_payment_id, result.authorization_code, tipAmount, order_id]);

      await deductInventoryForOrder(order_id);

      // Record platform fee
      const tenant = await getTenant(tenantId);
      await recordPlatformFee(tenantId, order_id, 'getnet', totalAmount, tenant?.plan || 'free');

      // Auto-generate invoice token
      let invoice_token = null;
      try {
        invoice_token = await generateInvoiceToken(tenantId, order_id, 72);
        await run('UPDATE orders SET invoice_token = $1 WHERE id = $2', [invoice_token, order_id]);
      } catch (tokenErr) {
        console.error('Non-fatal: failed to generate invoice token:', tokenErr.message);
      }

      res.json({
        success: true,
        payment_status: 'paid',
        getnet_payment_id: result.getnet_payment_id,
        authorization_code: result.authorization_code,
        card_brand: result.card_brand,
        card_last_four: result.card_last_four,
        invoice_token,
      });
    } else {
      res.status(400).json({
        error: 'Payment was not approved',
        status: result.status,
        getnet_payment_id: result.getnet_payment_id,
      });
    }
  } catch (error) {
    console.error('Getnet charge error:', error);
    res.status(500).json({ error: error.message || 'Failed to process Getnet payment' });
  }
});

// POST /api/getnet/tap-charge — record a Tap on Phone payment
router.post('/tap-charge', paymentLimiter, requireAuth('pos_access'), async (req, res) => {
  try {
    const { order_id, getnet_payment_id, authorization_code, card_brand, card_last_four, tip = 0 } = req.body;
    if (!order_id || !getnet_payment_id) {
      return res.status(400).json({ error: 'Missing order_id or getnet_payment_id' });
    }

    const tenantId = req.tenant?.id;
    const config = await getMerchantConfig(tenantId);
    if (!config || !config.tap_on_phone_enabled) {
      return res.status(400).json({ error: 'Tap on Phone not enabled' });
    }

    const order = await get(
      'SELECT id, order_number, total, payment_status FROM orders WHERE id = $1',
      [order_id]
    );
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.payment_status === 'paid') return res.status(400).json({ error: 'Order is already paid' });

    const tipAmount = typeof tip === 'number' ? tip : 0;
    const totalAmount = Number(order.total) + tipAmount;

    // Record the tap-on-phone transaction
    const tid = getTenantId();
    await run(`
      INSERT INTO getnet_transactions (
        tenant_id, order_id, getnet_payment_id, idempotency_key,
        amount_centavos, payment_type, status,
        authorization_code, card_brand, card_last_four, is_tap_on_phone, captured_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true, NOW())
    `, [
      tid, order_id, getnet_payment_id, crypto.randomUUID?.() || `tap-${Date.now()}`,
      Math.round(totalAmount * 100), 'credit', 'approved',
      authorization_code || null, card_brand || null, card_last_four || null,
    ]);

    await run(`
      UPDATE orders
      SET getnet_payment_id = $1, getnet_authorization_code = $2,
          payment_status = 'paid', payment_method = 'getnet_tap',
          tip = $3, paid_at = NOW()
      WHERE id = $4
    `, [getnet_payment_id, authorization_code || null, tipAmount, order_id]);

    await deductInventoryForOrder(order_id);

    // Record platform fee
    const tenant = await getTenant(tenantId);
    await recordPlatformFee(tenantId, order_id, 'getnet', totalAmount, tenant?.plan || 'free');

    res.json({
      success: true,
      payment_status: 'paid',
      getnet_payment_id,
    });
  } catch (error) {
    console.error('Getnet tap-charge error:', error);
    res.status(500).json({ error: error.message || 'Failed to record tap payment' });
  }
});

// GET /api/getnet/transactions — list Getnet transactions for tenant
router.get('/transactions', requireAuth('pos_access'), async (req, res) => {
  try {
    const { start_date, end_date, limit = 50 } = req.query;
    let query = `
      SELECT gt.*, o.order_number
      FROM getnet_transactions gt
      LEFT JOIN orders o ON gt.order_id = o.id
      WHERE 1=1
    `;
    const params = [];
    let idx = 1;

    if (start_date) {
      query += ` AND gt.created_at::date >= $${idx++}`;
      params.push(start_date);
    }
    if (end_date) {
      query += ` AND gt.created_at::date <= $${idx++}`;
      params.push(end_date);
    }

    query += ` ORDER BY gt.created_at DESC LIMIT $${idx}`;
    params.push(Number(limit));

    const transactions = await all(query, params);
    res.json(transactions);
  } catch (error) {
    console.error('Getnet transactions error:', error);
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

// GET /api/getnet/fees — fee breakdown for tenant
router.get('/fees', requireAuth('pos_access'), async (req, res) => {
  try {
    const tenantId = req.tenant?.id;
    const { start_date, end_date } = req.query;
    const start = start_date || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const end = end_date || new Date().toISOString().slice(0, 10);

    const summary = await getFeeSummary(tenantId, start, end);
    res.json({ summary, start_date: start, end_date: end });
  } catch (error) {
    console.error('Getnet fees error:', error);
    res.status(500).json({ error: 'Failed to fetch fee summary' });
  }
});

// GET /api/getnet/savings — upgrade savings estimate
router.get('/savings', requireAuth('pos_access'), async (req, res) => {
  try {
    const tenantId = req.tenant?.id;
    const days = Number(req.query.days) || 30;
    const savings = await calculateUpgradeSavings(tenantId, days);
    res.json(savings);
  } catch (error) {
    console.error('Getnet savings error:', error);
    res.status(500).json({ error: 'Failed to calculate savings' });
  }
});

export default router;
