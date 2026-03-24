import { adminSql } from '../../db/index.js';
import { recordPlatformFee } from './platformFee.js';

/**
 * Process a Getnet webhook notification.
 * Getnet sends notifications for payment status changes.
 */
export async function processGetnetWebhook(event) {
  const { payment_id, status, authorization_code } = event;

  if (!payment_id) {
    console.warn('Getnet webhook: missing payment_id');
    return;
  }

  // Look up the transaction by getnet_payment_id
  const txns = await adminSql`
    SELECT gt.id, gt.tenant_id, gt.order_id, gt.amount_centavos, gt.status as current_status
    FROM getnet_transactions gt
    WHERE gt.getnet_payment_id = ${payment_id}
    LIMIT 1
  `;

  if (txns.length === 0) {
    console.warn(`Getnet webhook: no transaction found for payment_id ${payment_id}`);
    return;
  }

  const txn = txns[0];

  // Skip if already in a terminal state
  if (txn.current_status === 'approved' || txn.current_status === 'refunded') {
    return;
  }

  const normalizedStatus = normalizeStatus(status);

  // Update getnet_transactions
  await adminSql`
    UPDATE getnet_transactions
    SET status = ${normalizedStatus},
        authorization_code = COALESCE(${authorization_code || null}, authorization_code),
        updated_at = NOW(),
        captured_at = ${normalizedStatus === 'approved' ? new Date() : null}
    WHERE id = ${txn.id}
  `;

  // Update the order based on status
  if (normalizedStatus === 'approved') {
    await adminSql`
      UPDATE orders
      SET payment_status = 'paid',
          status = 'preparing',
          payment_method = 'getnet_card',
          getnet_authorization_code = ${authorization_code || null},
          paid_at = NOW()
      WHERE id = ${txn.order_id}
    `;

    // Record platform fee
    const amount = txn.amount_centavos / 100;
    const tenantRows = await adminSql`
      SELECT plan FROM tenants WHERE id = ${txn.tenant_id} LIMIT 1
    `;
    const plan = tenantRows[0]?.plan || 'free';
    await recordPlatformFee(txn.tenant_id, txn.order_id, 'getnet', amount, plan);

    // Deduct inventory (fire-and-forget)
    try {
      const items = await adminSql`
        SELECT oi.menu_item_id, oi.quantity
        FROM order_items oi
        WHERE oi.order_id = ${txn.order_id}
      `;
      for (const item of items) {
        await adminSql`
          UPDATE inventory_items ii
          SET quantity = ii.quantity - (
            SELECT COALESCE(SUM(ri.quantity_used * ${item.quantity}), 0)
            FROM recipe_ingredients ri
            WHERE ri.menu_item_id = ${item.menu_item_id}
              AND ri.inventory_item_id = ii.id
          )
          WHERE ii.tenant_id = ${txn.tenant_id}
            AND ii.id IN (
              SELECT ri.inventory_item_id
              FROM recipe_ingredients ri
              WHERE ri.menu_item_id = ${item.menu_item_id}
            )
        `;
      }
    } catch (invErr) {
      console.error('Getnet webhook: inventory deduction error:', invErr.message);
    }
  } else if (normalizedStatus === 'denied' || normalizedStatus === 'cancelled') {
    await adminSql`
      UPDATE orders
      SET payment_status = 'failed'
      WHERE id = ${txn.order_id}
    `;
  }
}

/**
 * Normalize Getnet status strings to internal status.
 */
function normalizeStatus(getnetStatus) {
  if (!getnetStatus) return 'pending';
  const s = getnetStatus.toUpperCase();
  if (s === 'APPROVED' || s === 'CONFIRMED' || s === 'CAPTURED') return 'approved';
  if (s === 'DENIED' || s === 'DECLINED' || s === 'ERROR') return 'denied';
  if (s === 'CANCELLED' || s === 'CANCELED') return 'cancelled';
  if (s === 'PENDING' || s === 'AUTHORIZED') return 'pending';
  if (s === 'REFUNDED') return 'refunded';
  return 'pending';
}
