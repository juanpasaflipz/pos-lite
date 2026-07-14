// Public loyalty-join self-service. Purpose: after a kiosk order is paid,
// the confirmation screen shows a QR that points at
//   https://<tenant>.desktop.kitchen/#/loyalty/join/<token>
// The customer scans it with their phone, enters their number, and either
// (a) links this order to their existing loyalty account or (b) gets enrolled
// on the spot. Either way we credit the just-paid order's stamps and hand
// them a wallet-pass URL.
//
// Token: signed JWT { type:'loyalty_join', tenantId, orderId }, 7-day expiry.
// No DB row needed — the JWT itself is the capability. addStampsForOrder is
// idempotent (stamp_events per order_id), so a customer scanning twice can't
// double-stamp themselves.

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import { adminSql, withTenant, get } from '../db/index.js';
import { JWT_SECRET } from '../lib/constants.js';
import {
  findOrCreateCustomer,
  addStampsForOrder,
  getActiveStampCard,
} from '../helpers/loyalty.js';
import { ensureApplePass } from '../helpers/wallet/enroll.js';
import { isAppleWalletConfigured } from '../helpers/wallet/applePass.js';

const router = Router();

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' },
});
router.use(limiter);

function verifyJoinToken(token) {
  if (!token || typeof token !== 'string') return null;
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (
      decoded?.type === 'loyalty_join' &&
      decoded?.tenantId &&
      decoded?.orderId
    ) {
      return { tenantId: decoded.tenantId, orderId: Number(decoded.orderId) };
    }
  } catch {
    /* expired / tampered */
  }
  return null;
}

// POST /api/loyalty-join/verify — { token } → tenant + order metadata for the
// landing page. Does NOT enroll or read customer data.
router.post('/verify', async (req, res) => {
  const decoded = verifyJoinToken(req.body?.token);
  if (!decoded) {
    return res.status(400).json({ error: 'Enlace inválido o expirado' });
  }
  try {
    const tenants = await adminSql`
      SELECT id, name FROM tenants WHERE id = ${decoded.tenantId} LIMIT 1
    `;
    if (tenants.length === 0) {
      return res.status(404).json({ error: 'Restaurante no encontrado' });
    }
    const orders = await adminSql`
      SELECT id, order_number, total, loyalty_customer_id, customer_call_name
      FROM orders
      WHERE id = ${decoded.orderId} AND tenant_id = ${decoded.tenantId}
      LIMIT 1
    `;
    if (orders.length === 0) {
      return res.status(404).json({ error: 'Orden no encontrada' });
    }
    return res.json({
      tenant_name: tenants[0].name,
      order_number: String(orders[0].order_number),
      order_total: Number(orders[0].total),
      already_linked: !!orders[0].loyalty_customer_id,
    });
  } catch (err) {
    console.error('[loyalty-join/verify] error', err);
    return res.status(500).json({ error: 'No se pudo verificar el enlace' });
  }
});

// POST /api/loyalty-join/enroll — { token, phone, country_code?, sms_opt_in? }
// Idempotent: rerunning with the same token+phone will not double-stamp.
router.post('/enroll', async (req, res) => {
  const decoded = verifyJoinToken(req.body?.token);
  if (!decoded) {
    return res.status(400).json({ error: 'Enlace inválido o expirado' });
  }
  const rawPhone = typeof req.body?.phone === 'string' ? req.body.phone : '';
  const digits = rawPhone.replace(/\D/g, '');
  if (digits.length < 10) {
    return res.status(400).json({ error: 'Teléfono inválido' });
  }
  const countryCode = typeof req.body?.country_code === 'string' ? req.body.country_code : 'MX';
  const smsOptIn = req.body?.sms_opt_in !== false;

  try {
    const tenants = await adminSql`
      SELECT id, name, subdomain FROM tenants WHERE id = ${decoded.tenantId} LIMIT 1
    `;
    if (tenants.length === 0) {
      return res.status(404).json({ error: 'Restaurante no encontrado' });
    }
    const tenant = tenants[0];

    const orderRows = await adminSql`
      SELECT id, loyalty_customer_id, customer_call_name FROM orders
      WHERE id = ${decoded.orderId} AND tenant_id = ${decoded.tenantId}
      LIMIT 1
    `;
    if (orderRows.length === 0) {
      return res.status(404).json({ error: 'Orden no encontrada' });
    }
    const order = orderRows[0];

    const result = await withTenant(decoded.tenantId, async () => {
      const { customer } = await findOrCreateCustomer(
        digits.slice(-10),
        order.customer_call_name || 'Cliente',
        null,
        smsOptIn,
        tenant.name,
        countryCode,
        // Skip the welcome SMS — the landing page will already display the
        // wallet button in the same tap. A redundant SMS just adds noise.
        { sendWelcomeSms: false },
      );

      // addStampsForOrder is a no-op if stamp_events already has this order,
      // so double-scans don't double-credit.
      const already = await get(
        'SELECT 1 FROM stamp_events WHERE order_id = $1 LIMIT 1',
        [order.id],
      );
      let stampOutcome = null;
      if (!already) {
        stampOutcome = await addStampsForOrder(
          customer.id,
          order.id,
          null,
          tenant.name,
          { sendStampEarnedSms: false, sendCardCompletedSms: false },
        );
      } else if (!order.loyalty_customer_id) {
        // Order already had stamp_events (rare — someone else claimed the
        // token first?), but no customer link. Attach the customer anyway
        // so the order's history isn't orphaned.
        await get(
          'UPDATE orders SET loyalty_customer_id = $1 WHERE id = $2 RETURNING id',
          [customer.id, order.id],
        );
      }

      const card = await getActiveStampCard(customer.id);

      let walletUrl = null;
      if (isAppleWalletConfigured()) {
        const enroll = await ensureApplePass(customer.id);
        const host = tenant.subdomain
          ? `${tenant.subdomain}.desktop.kitchen`
          : req.get('host');
        walletUrl = `https://${host}/api/wallet/p/${enroll.pass.enroll_token}`;
      }

      return {
        first_name: (customer.name || '').split(/\s+/)[0] || 'Cliente',
        stamps_earned: card.stamps_earned,
        stamps_required: card.stamps_required,
        card_completed: !!stampOutcome?.cardCompleted,
        wallet_url: walletUrl,
      };
    });

    res.json(result);
  } catch (err) {
    console.error('[loyalty-join/enroll] error', err);
    res.status(500).json({ error: 'No pudimos registrarte. Intenta de nuevo.' });
  }
});

export default router;
