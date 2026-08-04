import { adminSql } from '../../db/index.js';
import { recordPlatformFee } from './platformFee.js';
import { deductInventoryForOrder } from '../../helpers/inventory.js';

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

  // Update the order based on status.
  // adminSql bypasses RLS — the explicit tenant_id predicate (from the
  // getnet_transactions row we just resolved) is the only isolation guard here.
  if (normalizedStatus === 'approved') {
    await adminSql`
      UPDATE orders
      SET payment_status = 'paid',
          status = 'active',
          payment_method = 'getnet_card',
          getnet_authorization_code = ${authorization_code || null},
          paid_at = NOW()
      WHERE id = ${txn.order_id} AND tenant_id = ${txn.tenant_id}
    `;

    // Record platform fee
    const amount = txn.amount_centavos / 100;
    const tenantRows = await adminSql`
      SELECT plan FROM tenants WHERE id = ${txn.tenant_id} LIMIT 1
    `;
    const plan = tenantRows[0]?.plan || 'free';
    await recordPlatformFee(txn.tenant_id, txn.order_id, 'getnet', amount, plan);

    // Deduct inventory (fire-and-forget).
    //
    // This used to be its own inline per-item UPDATE — a second implementation
    // of the deduction the rest of the codebase does through
    // deductInventoryForOrder(). That copy never learned about voided lines and
    // would not have learned about two-stage tenants either, so it was the one
    // path that could still double-deduct a component after P2. Consolidated.
    try {
      await deductInventoryForOrder(txn.order_id);
    } catch (invErr) {
      console.error('Getnet webhook: inventory deduction error:', invErr.message);
    }
  } else if (normalizedStatus === 'denied' || normalizedStatus === 'cancelled') {
    await adminSql`
      UPDATE orders
      SET payment_status = 'failed'
      WHERE id = ${txn.order_id} AND tenant_id = ${txn.tenant_id}
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
