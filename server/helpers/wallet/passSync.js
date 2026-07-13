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
import { isGoogleWalletConfigured, updateLoyaltyObjectBalance } from './googleWallet.js';

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

/**
 * Refresh EVERY pass of the current tenant — used after wallet-related
 * loyalty_config changes (colors, labels, geofence, reward text) so existing
 * cards pick up the new look without waiting for the next stamp.
 * Captures the tenant from AsyncLocalStorage; call from request context only.
 */
export function refreshTenantPasses() {
  const tenantId = getTenantId();
  if (!tenantId) return;

  setImmediate(() => {
    syncAllTenantPasses(tenantId).catch((err) => {
      console.error('[PassSync] tenant refresh failed:', err.message);
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

  const applePassIds = passes.filter((p) => p.platform === 'apple').map((p) => p.id);
  await pushToRegistrations(tenantId, applePassIds);

  const googlePassIds = passes.filter((p) => p.platform === 'google').map((p) => p.id);
  await syncGoogleBalances(tenantId, googlePassIds);
}

async function syncAllTenantPasses(tenantId) {
  const passes = await adminSql`
    UPDATE wallet_passes
    SET updated_at = NOW()
    WHERE tenant_id = ${tenantId} AND revoked = false
    RETURNING id, platform
  `;
  if (passes.length === 0) return;

  const applePassIds = passes.filter((p) => p.platform === 'apple').map((p) => p.id);
  await pushToRegistrations(tenantId, applePassIds);

  const googlePassIds = passes.filter((p) => p.platform === 'google').map((p) => p.id);
  await syncGoogleBalances(tenantId, googlePassIds);
}

/**
 * Google has no device push — we PATCH the LoyaltyObject's balance and
 * Google refreshes the rendered card itself. Best-effort per pass.
 */
async function syncGoogleBalances(tenantId, googlePassIds) {
  if (!isGoogleWalletConfigured() || googlePassIds.length === 0) return;

  const rows = await adminSql`
    SELECT wp.serial_number, sc.stamps_earned, sc.stamps_required
    FROM wallet_passes wp
    JOIN loyalty_customers lc ON lc.id = wp.customer_id
    LEFT JOIN LATERAL (
      SELECT stamps_earned, stamps_required FROM stamp_cards
      WHERE customer_id = lc.id AND completed = false
      ORDER BY id DESC LIMIT 1
    ) sc ON true
    WHERE wp.tenant_id = ${tenantId} AND wp.id IN ${adminSql(googlePassIds)}
  `;

  for (const row of rows) {
    if (row.stamps_required == null) continue; // no active card yet — nothing to show
    await updateLoyaltyObjectBalance(
      row.serial_number,
      `${row.stamps_earned} / ${row.stamps_required}`
    ).catch(() => {});
  }
}

async function pushToRegistrations(tenantId, applePassIds) {
  if (!isAppleWalletConfigured() || applePassIds.length === 0) return;

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
