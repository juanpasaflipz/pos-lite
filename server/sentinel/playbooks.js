/**
 * Sentinel — Playbook Registry (Phase 1: P1, P4, P5)
 *
 * A playbook is a named remediation function. This registry is the ONLY
 * write surface the triage agent can reach — there is no raw-SQL tool, and
 * an LLM cannot invent a remediation that isn't in this map.
 * (docs/ai-sentinel-design.md §5)
 *
 * Contract: run(incident, { shadow }) → result object.
 *   - Every playbook re-validates its own preconditions AT EXECUTION TIME
 *     (the world may have changed since diagnosis) and returns
 *     { aborted: <reason> } when a guard trips. Guards are what make
 *     "auto-safe" true.
 *   - shadow=true (SENTINEL_AUTOFIX=off, the launch default) performs all
 *     reads and guard checks but NO mutation; returns { shadow: true,
 *     would: <description> } so the incident records exactly what a live
 *     run would have done.
 *   - Every live mutation writes audit_log (actor_type='sentinel').
 *
 * P2 (reconcile_orphan_payment) is deliberately ABSENT in Phase 1: when
 * triage discovers a processor-side paid order, the incident goes to
 * needs_human with the reconcile plan in the diagnosis. The approval-gated
 * execution path ships in Phase 2 after we've watched real cases.
 */

import { adminSql } from '../db/index.js';
import { audit } from '../lib/auditLog.js';
import { getTenant } from '../tenants.js';
import {
  ensureFreshToken,
  getPointOrder,
  mapPointOrderStatus,
  cancelPointOrder,
} from '../services/mercadopago.js';
import { dispatchPendingCourier } from '../routes/kiosk.js';

// ---------------------------------------------------------------------------
// Diagnostic READ helpers — shared by playbooks and triage tools. Side-effect
// free by contract.
// ---------------------------------------------------------------------------

export async function pullPaymentStatus(tenantId, orderId) {
  const [order] = await adminSql`
    SELECT id, payment_status, mp_order_id, clip_payment_id, mp_terminal_id, total
    FROM orders WHERE id = ${orderId} AND tenant_id = ${tenantId}
  `;
  if (!order) return { error: 'order_not_found' };
  if (!order.mp_order_id) {
    // Clip live-pull lands with processor parity (decision #5). Until then:
    // degraded gracefully, never silently ignored.
    return {
      processor: order.clip_payment_id ? 'clip' : 'none',
      status: 'unknown',
      note: 'live-pull not implemented for this processor yet; treat as needs_human',
    };
  }
  const tenant = await getTenant(tenantId);
  if (!tenant?.mp_access_token) {
    return { processor: 'mercadopago', status: 'unknown', note: 'tenant has no MP credentials' };
  }
  const accessToken = await ensureFreshToken(tenant, adminSql);
  const mpOrder = await getPointOrder(accessToken, order.mp_order_id, tenant.mp_default_terminal_id);
  return {
    processor: 'mercadopago',
    status: mapPointOrderStatus(mpOrder),
    mp_status_raw: mpOrder?.status ?? null,
    mp_status_detail: mpOrder?.status_detail ?? null,
  };
}

export async function getOrderTimeline(tenantId, orderId) {
  const [order] = await adminSql`
    SELECT id, order_number, status, payment_status, payment_method, total, tip,
           mp_order_id, clip_payment_id, source, created_at, paid_at, ready_at, completed_at
    FROM orders WHERE id = ${orderId} AND tenant_id = ${tenantId}
  `;
  if (!order) return { error: 'order_not_found' };
  const payments = await adminSql`
    SELECT payment_method, amount, status, payment_intent_id, created_at
    FROM order_payments WHERE order_id = ${orderId} AND tenant_id = ${tenantId}
    ORDER BY created_at
  `;
  const auditRows = await adminSql`
    SELECT actor_type, action, resource, details, created_at
    FROM audit_log
    WHERE tenant_id = ${tenantId} AND resource = 'orders' AND resource_id = ${String(orderId)}
    ORDER BY created_at DESC LIMIT 10
  `;
  return { order, payments, recent_audit: auditRows };
}

export async function getDeviceLiveness(tenantId) {
  const devices = await adminSql`
    SELECT device_label, device_type, last_seen_at, revoked_at IS NOT NULL AS revoked
    FROM kds_devices
    WHERE tenant_id = ${tenantId} AND claimed_at IS NOT NULL
    ORDER BY last_seen_at DESC NULLS LAST
  `;
  return { devices };
}

// ---------------------------------------------------------------------------
// Playbooks
// ---------------------------------------------------------------------------

export const PLAYBOOKS = {
  /**
   * P1 — unstick a terminal payment (auto-safe).
   * Port of scripts/mp-unstick.mjs, generalized: terminal ids come from the
   * order/tenant rows, and we live-pull FIRST — if the processor says the
   * order is actually PAID, unsticking would eat the customer's money, so we
   * abort and let triage route to the reconcile path instead.
   */
  unstick_terminal_payment: {
    auto: true,
    title: 'Cancel dead payment intent and reset order to pending',
    async run(incident, { shadow = true } = {}) {
      const tenantId = incident.tenant_id;
      const orderId = Number(incident.subject_id);

      // Guard 1: order still stuck (re-read; diagnosis may be stale).
      const [order] = await adminSql`
        SELECT id, payment_status, mp_order_id, mp_terminal_id, total
        FROM orders WHERE id = ${orderId} AND tenant_id = ${tenantId}
      `;
      if (!order) return { aborted: 'order_not_found' };
      if (order.payment_status !== 'pending_terminal') {
        return { aborted: 'no_longer_pending_terminal', current: order.payment_status };
      }
      // Phase 1 is MP-only; Clip cancel lands with processor parity.
      if (!order.mp_order_id) return { aborted: 'unsupported_processor' };

      const tenant = await getTenant(tenantId);
      if (!tenant?.mp_access_token) return { aborted: 'no_mp_credentials' };
      const accessToken = await ensureFreshToken(tenant, adminSql);

      // Guard 2: never cancel an intent the customer actually paid.
      const mpOrder = await getPointOrder(accessToken, order.mp_order_id, tenant.mp_default_terminal_id);
      const mpStatus = mapPointOrderStatus(mpOrder);
      if (mpStatus === 'paid') {
        return { aborted: 'order_actually_paid', note: 'route to reconcile (P2 / needs_human)' };
      }

      const terminalId = order.mp_terminal_id || tenant.mp_default_terminal_id;
      if (shadow) {
        return {
          shadow: true,
          would: `cancel MP intent ${order.mp_order_id} on terminal ${terminalId}, ` +
                 `then reset order ${orderId} to payment_status='pending'`,
          mp_status: mpStatus,
        };
      }

      try {
        await cancelPointOrder(accessToken, terminalId, order.mp_order_id);
      } catch (err) {
        // A cancel that 404s usually means the intent already expired on the
        // device — safe to proceed with the local reset. Anything else, stop.
        if (!/404/.test(err.message)) throw err;
      }

      const updated = await adminSql`
        UPDATE orders
        SET mp_order_id = NULL, payment_status = 'pending'
        WHERE id = ${orderId} AND tenant_id = ${tenantId}
          AND payment_status = 'pending_terminal'
        RETURNING id
      `;
      if (!updated.length) return { aborted: 'order_changed_during_execution' };

      audit({
        tenantId,
        actorType: 'sentinel',
        action: 'update',
        resource: 'orders',
        resourceId: String(orderId),
        details: { playbook: 'unstick_terminal_payment', incident_id: incident.id, mp_status: mpStatus },
      });
      return { fixed: true, mp_status: mpStatus };
    },
  },

  /**
   * P4 — notify only. The remediation IS a well-written message; the actual
   * notification fanout happens in the triage/sweep layer via notify.js.
   * Used by kds_blind (no safe auto-fix for an unplugged TV) and stale cash
   * drafts (decision #2: never void).
   */
  notify_only: {
    auto: true,
    title: 'No mutation — surface to a human with diagnosis attached',
    async run() {
      return { fixed: false, notify: true };
    },
  },

  /**
   * P5 — retry courier dispatch (auto-safe). dispatchPendingCourier is the
   * same guarded code path the payment-success handler uses: it re-reads
   * pending_dispatch and clears it on success, so retrying is idempotent.
   */
  retry_courier_dispatch: {
    auto: true,
    title: 'Re-run Uber Direct dispatch for a paid delivery order',
    async run(incident, { shadow = true } = {}) {
      const tenantId = incident.tenant_id;
      const orderId = Number(incident.evidence?.order_id);
      if (!orderId) return { aborted: 'missing_order_id_in_evidence' };

      // Guard: still paid, dispatch still pending.
      const [row] = await adminSql`
        SELECT d.id, d.pending_dispatch IS NOT NULL AS still_pending, d.platform_status, o.payment_status
        FROM delivery_orders d
        JOIN orders o ON o.id = d.order_id AND o.tenant_id = d.tenant_id
        WHERE d.order_id = ${orderId} AND d.tenant_id = ${tenantId}
      `;
      if (!row) return { aborted: 'delivery_order_not_found' };
      if (row.payment_status !== 'paid') return { aborted: 'order_not_paid' };
      if (!row.still_pending && row.platform_status !== 'dispatch_failed') {
        return { aborted: 'dispatch_no_longer_pending', current: row.platform_status };
      }

      if (shadow) {
        return { shadow: true, would: `re-run dispatchPendingCourier(${orderId}, ${tenantId})` };
      }

      const result = await dispatchPendingCourier(orderId, tenantId);
      audit({
        tenantId,
        actorType: 'sentinel',
        action: 'update',
        resource: 'delivery_orders',
        resourceId: String(row.id),
        details: { playbook: 'retry_courier_dispatch', incident_id: incident.id, result },
      });
      return { fixed: true, result };
    },
  },
};

/**
 * Execute a playbook against an incident, honoring shadow mode. Central
 * chokepoint so every execution — triage-initiated or human-approved — gets
 * the same guard/audit/recording behavior.
 */
export async function executePlaybook(playbookId, incident, { shadow = true } = {}) {
  const playbook = PLAYBOOKS[playbookId];
  if (!playbook) return { aborted: 'unknown_playbook', playbook: playbookId };
  try {
    return await playbook.run(incident, { shadow });
  } catch (err) {
    console.error(`[Sentinel] playbook ${playbookId} failed for incident ${incident.id}:`, err.message);
    return { error: err.message };
  }
}
