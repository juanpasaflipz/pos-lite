/**
 * Sentinel — Sensor Catalog (Phase 1: S1–S4)
 *
 * Each sensor is ONE deterministic SQL statement run cross-tenant via
 * adminSql. No LLM anywhere in this file — sensors detect, triage thinks.
 * (docs/ai-sentinel-design.md §3)
 *
 * Sensor contract:
 *   run() → [{ tenantId, dedupKey, severity, subjectTable, subjectId, evidence }]
 * The returned set is the CURRENT truth: the sweep upserts matches and
 * self-heals open incidents that no longer match.
 *
 * Threshold conventions follow autoCompleteReadyOrders.js: env-tunable,
 * sane defaults. All sensors:
 *   - join tenants ON active = true (never watch dead tenants)
 *   - bound lookback to 48h so the first deploy doesn't dredge history
 *     into a wall of incidents (and burn the triage budget)
 */

import { adminSql } from '../db/index.js';

const LOOKBACK_HOURS = Number(process.env.SENTINEL_LOOKBACK_HOURS) || 48;

// S1: order has been waiting on a card terminal too long.
const STUCK_TERMINAL_MINUTES = Number(process.env.SENTINEL_STUCK_TERMINAL_MINUTES) || 10;

// S2: kiosk draft never promoted. Generous — cash drafts legitimately wait
// for the customer to reach the cashier. Decision #2: the sentinel NEVER
// voids drafts; this sensor only surfaces them.
const STALE_DRAFT_MINUTES = Number(process.env.SENTINEL_STALE_DRAFT_MINUTES) || 45;

// S3: active orders no KDS has ever rendered.
const KDS_BLIND_MINUTES = Number(process.env.SENTINEL_KDS_BLIND_MINUTES) || 3;

// S4: paid delivery order whose courier dispatch never fired.
const STUCK_DISPATCH_MINUTES = Number(process.env.SENTINEL_STUCK_DISPATCH_MINUTES) || 5;

export const SENSORS = [
  {
    id: 'stuck_terminal_payment',
    description:
      `Order in payment_status='pending_terminal' with a processor ref for >${STUCK_TERMINAL_MINUTES}min. ` +
      `Either the intent died on the device (→ unstick) or the customer paid and we missed it (→ reconcile). ` +
      `Triage live-pulls the processor to tell the two apart.`,
    async run() {
      const rows = await adminSql`
        SELECT o.tenant_id, o.id, o.order_number, o.mp_order_id, o.clip_payment_id,
               o.mp_terminal_id, o.total, o.payment_method, o.created_at
        FROM orders o
        JOIN tenants t ON t.id = o.tenant_id AND t.active = true
        WHERE o.payment_status = 'pending_terminal'
          AND (o.mp_order_id IS NOT NULL OR o.clip_payment_id IS NOT NULL)
          AND o.created_at < NOW() - ${STUCK_TERMINAL_MINUTES} * INTERVAL '1 minute'
          AND o.created_at > NOW() - ${LOOKBACK_HOURS} * INTERVAL '1 hour'
      `;
      return rows.map((r) => ({
        tenantId: r.tenant_id,
        dedupKey: `order:${r.id}`,
        severity: 'high',
        subjectTable: 'orders',
        subjectId: String(r.id),
        evidence: {
          order_id: r.id,
          order_number: r.order_number,
          total: Number(r.total),
          processor: r.mp_order_id ? 'mercadopago' : 'clip',
          mp_order_id: r.mp_order_id,
          clip_payment_id: r.clip_payment_id,
          mp_terminal_id: r.mp_terminal_id,
          stuck_since: r.created_at,
        },
      }));
    },
  },

  {
    id: 'stale_kiosk_draft',
    description:
      `Kiosk draft (status='draft_kiosk') older than ${STALE_DRAFT_MINUTES}min. Cash drafts are low ` +
      `severity (likely abandoned — digest material, NEVER auto-voided per decision #2). Drafts with a ` +
      `processor ref are high severity: a customer may have paid for food the kitchen never made.`,
    async run() {
      const rows = await adminSql`
        SELECT o.tenant_id, o.id, o.order_number, o.total, o.payment_method,
               o.mp_order_id, o.clip_payment_id, o.created_at
        FROM orders o
        JOIN tenants t ON t.id = o.tenant_id AND t.active = true
        WHERE o.status = 'draft_kiosk'
          AND o.created_at < NOW() - ${STALE_DRAFT_MINUTES} * INTERVAL '1 minute'
          AND o.created_at > NOW() - ${LOOKBACK_HOURS} * INTERVAL '1 hour'
      `;
      return rows.map((r) => {
        const cardAttempt = Boolean(r.mp_order_id || r.clip_payment_id);
        return {
          tenantId: r.tenant_id,
          dedupKey: `order:${r.id}`,
          severity: cardAttempt ? 'high' : 'low',
          subjectTable: 'orders',
          subjectId: String(r.id),
          evidence: {
            order_id: r.id,
            order_number: r.order_number,
            total: Number(r.total),
            payment_method: r.payment_method,
            card_attempt: cardAttempt,
            mp_order_id: r.mp_order_id,
            clip_payment_id: r.clip_payment_id,
            draft_since: r.created_at,
          },
        };
      });
    },
  },

  {
    id: 'kds_blind',
    description:
      `Active orders whose first_kds_seen_at is NULL for >${KDS_BLIND_MINUTES}min — the kitchen screen is ` +
      `down/offline/logged out and food is not being made. Only fires for tenants that actually run a KDS ` +
      `(≥1 claimed, non-revoked kds_device); tenants without kitchen screens would false-positive forever.`,
    async run() {
      const rows = await adminSql`
        SELECT o.tenant_id,
               COUNT(*)::int AS unseen_count,
               MIN(o.created_at) AS oldest_created_at,
               (SELECT MAX(d.last_seen_at) FROM kds_devices d
                 WHERE d.tenant_id = o.tenant_id AND d.claimed_at IS NOT NULL AND d.revoked_at IS NULL
               ) AS kds_last_seen_at
        FROM orders o
        JOIN tenants t ON t.id = o.tenant_id AND t.active = true
        WHERE o.status = 'active'
          AND o.first_kds_seen_at IS NULL
          AND o.created_at < NOW() - ${KDS_BLIND_MINUTES} * INTERVAL '1 minute'
          AND o.created_at > NOW() - ${LOOKBACK_HOURS} * INTERVAL '1 hour'
          AND EXISTS (
            SELECT 1 FROM kds_devices d
            WHERE d.tenant_id = o.tenant_id
              AND d.claimed_at IS NOT NULL
              AND d.revoked_at IS NULL
          )
        GROUP BY o.tenant_id
      `;
      return rows.map((r) => ({
        tenantId: r.tenant_id,
        // One ongoing incident per tenant, not per order — the failure is
        // "the screen", not each ticket.
        dedupKey: 'kds-blind',
        severity: 'critical',
        subjectTable: 'kds_devices',
        subjectId: null,
        evidence: {
          unseen_count: r.unseen_count,
          oldest_created_at: r.oldest_created_at,
          kds_last_seen_at: r.kds_last_seen_at,
        },
      }));
    },
  },

  {
    id: 'stuck_courier_dispatch',
    description:
      `Paid kiosk delivery order whose Uber Direct dispatch never fired: pending_dispatch still stashed ` +
      `>${STUCK_DISPATCH_MINUTES}min after payment, or platform_status='dispatch_failed' (migration 0071's ` +
      `sentinel value). Customer paid; no courier is moving.`,
    async run() {
      const rows = await adminSql`
        SELECT d.tenant_id, d.id AS delivery_order_id, d.order_id, d.platform_status,
               o.order_number, o.payment_status, o.paid_at, o.total, o.created_at
        FROM delivery_orders d
        JOIN orders o ON o.id = d.order_id AND o.tenant_id = d.tenant_id
        JOIN tenants t ON t.id = d.tenant_id AND t.active = true
        WHERE o.created_at > NOW() - ${LOOKBACK_HOURS} * INTERVAL '1 hour'
          AND (
            (d.pending_dispatch IS NOT NULL
              AND o.payment_status = 'paid'
              AND o.paid_at < NOW() - ${STUCK_DISPATCH_MINUTES} * INTERVAL '1 minute')
            OR d.platform_status = 'dispatch_failed'
          )
      `;
      return rows.map((r) => ({
        tenantId: r.tenant_id,
        dedupKey: `delivery:${r.delivery_order_id}`,
        severity: 'high',
        subjectTable: 'delivery_orders',
        subjectId: String(r.delivery_order_id),
        evidence: {
          delivery_order_id: r.delivery_order_id,
          order_id: r.order_id,
          order_number: r.order_number,
          platform_status: r.platform_status,
          total: Number(r.total),
          paid_at: r.paid_at,
        },
      }));
    },
  },
];
