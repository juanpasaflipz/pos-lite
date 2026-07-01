import { Router } from 'express';
import { all, get, adminSql, run } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { getTenant } from '../tenants.js';
import {
  ensureFreshToken,
  getPointOrder,
  mapPointOrderStatus,
} from '../services/mercadopago.js';
import { settlePaymentGroupPaid } from './payments.js';

const router = Router();

// GET /api/payment-groups/:id — group + orders + items for combined receipt reprint
router.get('/:id', requireAuth('pos_access'), async (req, res) => {
  try {
    const groupId = Number(req.params.id);
    const group = await get(
      `SELECT id, subtotal, tax, tip, total, payment_method, status,
              mp_order_id, mp_terminal_id, created_at, paid_at
       FROM payment_groups WHERE id = $1`,
      [groupId]
    );
    if (!group) return res.status(404).json({ error: 'Payment group not found' });

    const orders = await all(
      `SELECT id, order_number, customer_call_name, subtotal, tax, tip, total,
              status, payment_status, order_fulfillment_type
       FROM orders
       WHERE payment_group_id = $1
       ORDER BY id ASC`,
      [groupId]
    );

    const items = await all(
      `SELECT oi.order_id, oi.item_name, oi.quantity, oi.unit_price, oi.notes
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       WHERE o.payment_group_id = $1 AND oi.voided_at IS NULL
       ORDER BY oi.order_id ASC, oi.id ASC`,
      [groupId]
    );

    const itemsByOrder = {};
    for (const it of items) {
      (itemsByOrder[it.order_id] ??= []).push(it);
    }

    res.json({
      group,
      orders: orders.map((o) => ({ ...o, items: itemsByOrder[o.id] || [] })),
    });
  } catch (error) {
    console.error('GET /payment-groups error:', error);
    res.status(500).json({ error: 'Failed to load payment group' });
  }
});

// GET /api/payment-groups/:id/status — live MP status pull for the group.
// Mirrors the single-order live-pull pattern in payments.js: don't trust
// per-tenant MP webhooks for correctness.
router.get('/:id/status', requireAuth('pos_access'), async (req, res) => {
  try {
    const groupId = Number(req.params.id);
    const group = await get(
      `SELECT id, status, mp_order_id, mp_terminal_id, payment_method, total, tip
       FROM payment_groups WHERE id = $1`,
      [groupId]
    );
    if (!group) return res.status(404).json({ error: 'Payment group not found' });

    if (group.status === 'pending' && group.payment_method === 'mp_terminal' && group.mp_order_id) {
      const tenant = await getTenant(req.tenant.id);
      if (tenant?.mp_access_token) {
        try {
          const accessToken = await ensureFreshToken(tenant, adminSql);
          const mpOrder = await getPointOrder(accessToken, group.mp_order_id, group.mp_terminal_id);
          const mapped = mapPointOrderStatus(mpOrder);
          if (mapped === 'paid') {
            await settlePaymentGroupPaid(groupId, req.tenant.id, { mpOrder, mpAccessToken: accessToken });
            group.status = 'paid';
          } else if (mapped === 'failed') {
            await run(`UPDATE payment_groups SET status = 'failed' WHERE id = $1`, [groupId]);
            await run(
              `UPDATE orders SET payment_status = 'failed' WHERE payment_group_id = $1`,
              [groupId]
            );
            group.status = 'failed';
          }
        } catch (pollErr) {
          console.warn('payment-groups status pull failed:', pollErr.message);
        }
      }
    }

    res.json({
      payment_group_id: group.id,
      status: group.status,
      payment_method: group.payment_method,
      total: Number(group.total),
      tip: Number(group.tip),
    });
  } catch (error) {
    console.error('GET /payment-groups/:id/status error:', error);
    res.status(500).json({ error: 'Failed to fetch group status' });
  }
});

export default router;
