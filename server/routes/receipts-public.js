import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { adminSql } from '../db/index.js';

const router = Router();

// Same posture as cfdi-public: low rate limit because a leaked token can
// fan out widely. Brute force is also infeasible (16-char hex = 2^64).
const publicLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: 'Too many requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

router.use(publicLimiter);

// GET /api/public/receipts/:token — no auth. Returns order, items, tenant
// branding for a printable receipt page.
router.get('/:token', async (req, res) => {
  try {
    const tokenStr = String(req.params.token || '').trim();
    if (!tokenStr) return res.status(400).json({ error: 'Token required' });

    const tokenRow = await adminSql`
      SELECT * FROM receipt_tokens WHERE token = ${tokenStr}
    `.then(rows => rows[0]);

    if (!tokenRow) return res.status(404).json({ error: 'Invalid receipt link' });
    if (new Date(tokenRow.expires_at) < new Date()) {
      return res.status(410).json({ error: 'This receipt link has expired' });
    }

    const tenant = await adminSql`
      SELECT id, name, subdomain, branding_json FROM tenants WHERE id = ${tokenRow.tenant_id}
    `.then(rows => rows[0]);
    if (!tenant) return res.status(404).json({ error: 'Restaurant not found' });

    const order = await adminSql`
      SELECT id, order_number, subtotal, tax, tip, total, payment_status,
             payment_method, created_at, paid_at
      FROM orders
      WHERE id = ${tokenRow.order_id} AND tenant_id = ${tokenRow.tenant_id}
    `.then(rows => rows[0]);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const items = await adminSql`
      SELECT id, item_name, quantity, unit_price, notes
      FROM order_items
      WHERE order_id = ${order.id}
      ORDER BY id ASC
    `;

    res.json({
      tenant: {
        name: tenant.name,
        branding: tenant.branding_json || null,
      },
      order: { ...order, items },
    });
  } catch (error) {
    console.error('Error resolving receipt token:', error);
    res.status(500).json({ error: 'Failed to load receipt' });
  }
});

export default router;
