/**
 * passSync — the single hook the loyalty helpers call after any stamp/redeem
 * mutation. Fire-and-forget (same contract as the SMS helpers): never throws,
 * never blocks the payment path.
 *
 * RLS caveat: this runs AFTER the request's reserved tenant connection may
 * have been released, so queries here go through adminSql (RLS bypassed).
 * Every query therefore filters tenant_id explicitly. The tenant id is
 * captured from AsyncLocalStorage at call time; when the caller runs outside
 * a tenant context (e.g. a cross-tenant payment webhook promoting a kiosk
 * order), it is resolved from the customer row instead.
 */

import { adminSql, getTenantId } from '../../db/index.js';
import { isAppleWalletConfigured } from './applePass.js';
import { pushPassUpdate } from './appleApns.js';

/**
 * Mark the customer's passes stale and nudge registered Apple devices to
 * re-fetch. Call sites: addStampsForOrder, addBonusStamps, redeemReward.
 * Synchronous return; all work happens off the request path.
 */
export function schedulePassUpdate(customerId) {
  if (!customerId) return;
  const tenantId = getTenantId(); // capture NOW, inside the request context (may be null)

  setImmediate(() => {
    syncCustomerPasses(tenantId, customerId).catch((err) => {
      console.error('[PassSync] update failed:', err.message);
    });
  });
}

async function syncCustomerPasses(tenantId, customerId) {
  // Webhook-context fallback: resolve the tenant from the customer row.
  if (!tenantId) {
    const [row] = await adminSql`
      SELECT tenant_id FROM loyalty_customers WHERE id = ${customerId}
    `;
    tenantId = row?.tenant_id;
    if (!tenantId) return;
  }

  // Bump updated_at → drives Last-Modified + passesUpdatedSince
  const passes = await adminSql`
    UPDATE wallet_passes
    SET updated_at = NOW()
    WHERE tenant_id = ${tenantId} AND customer_id = ${customerId} AND revoked = false
    RETURNING id, platform
  `;
  if (passes.length === 0) return;

  if (!isAppleWalletConfigured()) return;

  const applePassIds = passes.filter((p) => p.platform === 'apple').map((p) => p.id);
  if (applePassIds.length === 0) return;

  const registrations = await adminSql`
    SELECT id, push_token FROM wallet_registrations
    WHERE tenant_id = ${tenantId} AND pass_id IN ${adminSql(applePassIds)}
  `;

  for (const reg of registrations) {
    const result = await pushPassUpdate(reg.push_token);
    if (result.unregistered) {
      await adminSql`
        DELETE FROM wallet_registrations
        WHERE id = ${reg.id} AND tenant_id = ${tenantId}
      `;
    }
  }
}
