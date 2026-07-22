/**
 * Control Tower — cross-tenant fleet monitoring for the super-admin dashboard.
 *
 * Everything here runs on adminSql (neondb_owner, bypasses RLS) and is
 * strictly read-only. The fleet query is set-based on purpose: one round
 * trip aggregates orders/employees/menu/printers/credentials/incidents for
 * every tenant at once, so the dashboard costs O(1) admin-rate-limit
 * requests no matter how many tenants exist (the 100 req/15 min limiter on
 * /admin would starve a per-tenant N+1 pattern almost immediately).
 *
 * Sensitive columns NEVER leave this module: sanitizeTenant() is the single
 * chokepoint that strips password hashes, Mercado Pago OAuth tokens, and
 * password-reset tokens before a tenant row is serialized to the browser.
 */

import { adminSql } from '../db/index.js';
import { effectivePlan, isTrialActive } from '../planLimits.js';

/** Fields that must never be serialized into an admin API response. */
const SENSITIVE_TENANT_FIELDS = [
  'owner_password_hash',
  'mp_access_token',
  'mp_refresh_token',
  'reset_token',
  'reset_token_expires',
];

/** Strip credential-bearing columns from a tenants row (non-mutating). */
export function sanitizeTenant(tenant) {
  if (!tenant) return tenant;
  const safe = { ...tenant };
  for (const f of SENSITIVE_TENANT_FIELDS) delete safe[f];
  return safe;
}

/** Whole-number days left on a trial, floored at 0. Null when no trial. */
function trialDaysLeft(tenant) {
  if (!tenant?.trial_ends_at) return null;
  const ends = new Date(tenant.trial_ends_at).getTime();
  if (!Number.isFinite(ends)) return null;
  return Math.max(0, Math.ceil((ends - Date.now()) / 86_400_000));
}

const ACTIVE_INCIDENT_STATUSES = ['open', 'diagnosing', 'waiting_approval', 'needs_human'];

/**
 * One row per tenant with everything the control tower needs:
 * identity + billing state, effective (trial-aware) plan, activity pulse,
 * onboarding progress, and open sentinel-incident counts.
 */
export async function getFleetOverview() {
  const rows = await adminSql`
    WITH order_stats AS (
      SELECT tenant_id,
             MAX(created_at) FILTER (WHERE status <> 'draft_kiosk') AS last_order_at,
             COUNT(*) FILTER (WHERE status <> 'draft_kiosk'
               AND created_at >= NOW() - INTERVAL '24 hours')::int AS orders_24h,
             COUNT(*) FILTER (WHERE status <> 'draft_kiosk'
               AND created_at >= NOW() - INTERVAL '7 days')::int AS orders_7d,
             COUNT(*) FILTER (WHERE status <> 'draft_kiosk'
               AND created_at >= NOW() - INTERVAL '30 days')::int AS orders_30d,
             COALESCE(SUM(total) FILTER (WHERE status NOT IN ('draft_kiosk', 'cancelled')
               AND created_at >= NOW() - INTERVAL '30 days'), 0) AS revenue_30d,
             COUNT(*) FILTER (WHERE status NOT IN ('draft_kiosk', 'cancelled'))::int AS real_order_count
      FROM orders
      GROUP BY tenant_id
    ),
    emp_stats AS (
      SELECT tenant_id, COUNT(*)::int AS employee_count
      FROM employees
      GROUP BY tenant_id
    ),
    menu_stats AS (
      SELECT tenant_id,
             COUNT(*) FILTER (WHERE active = true AND is_example = false)::int AS real_menu_items
      FROM menu_items
      GROUP BY tenant_id
    ),
    printer_stats AS (
      SELECT tenant_id, COUNT(*) FILTER (WHERE active = true)::int AS active_printers
      FROM printers
      GROUP BY tenant_id
    ),
    cred_stats AS (
      SELECT DISTINCT tenant_id
      FROM tenant_credentials
      WHERE service IN ('stripe', 'mercadopago', 'clip', 'getnet')
    ),
    incident_stats AS (
      SELECT tenant_id,
             COUNT(*) FILTER (WHERE status = ANY(${ACTIVE_INCIDENT_STATUSES}::text[]))::int AS open_incidents,
             COUNT(*) FILTER (WHERE status = ANY(${ACTIVE_INCIDENT_STATUSES}::text[])
               AND severity = 'critical')::int AS critical_incidents,
             COUNT(*) FILTER (WHERE status = ANY(${ACTIVE_INCIDENT_STATUSES}::text[])
               AND severity = 'high')::int AS high_incidents,
             MAX(last_seen_at) FILTER (WHERE status = ANY(${ACTIVE_INCIDENT_STATUSES}::text[])) AS last_incident_at
      FROM sentinel_incidents
      GROUP BY tenant_id
    )
    SELECT t.id, t.name, t.subdomain, t.owner_email, t.plan, t.active,
           t.subscription_status, t.subscription_cancelled_at, t.trial_ends_at,
           t.signup_promo_code, t.timezone, t.created_at,
           (t.stripe_customer_id IS NOT NULL) AS has_stripe_customer,
           (t.stripe_subscription_id IS NOT NULL) AS has_stripe_subscription,
           (t.mp_access_token IS NOT NULL) AS has_mp_connected,
           os.last_order_at,
           COALESCE(os.orders_24h, 0) AS orders_24h,
           COALESCE(os.orders_7d, 0) AS orders_7d,
           COALESCE(os.orders_30d, 0) AS orders_30d,
           COALESCE(os.revenue_30d, 0) AS revenue_30d,
           COALESCE(os.real_order_count, 0) AS real_order_count,
           COALESCE(es.employee_count, 0) AS employee_count,
           COALESCE(ms.real_menu_items, 0) AS real_menu_items,
           COALESCE(ps.active_printers, 0) AS active_printers,
           (cs.tenant_id IS NOT NULL) AS has_processor_credentials,
           COALESCE(ins.open_incidents, 0) AS open_incidents,
           COALESCE(ins.critical_incidents, 0) AS critical_incidents,
           COALESCE(ins.high_incidents, 0) AS high_incidents,
           ins.last_incident_at
    FROM tenants t
    LEFT JOIN order_stats os ON os.tenant_id = t.id
    LEFT JOIN emp_stats es ON es.tenant_id = t.id
    LEFT JOIN menu_stats ms ON ms.tenant_id = t.id
    LEFT JOIN printer_stats ps ON ps.tenant_id = t.id
    LEFT JOIN cred_stats cs ON cs.tenant_id = t.id
    LEFT JOIN incident_stats ins ON ins.tenant_id = t.id
    ORDER BY t.created_at DESC
  `;

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    subdomain: r.subdomain,
    owner_email: r.owner_email,
    plan: r.plan,
    active: r.active,
    subscription_status: r.subscription_status,
    subscription_cancelled_at: r.subscription_cancelled_at,
    trial_ends_at: r.trial_ends_at,
    signup_promo_code: r.signup_promo_code,
    timezone: r.timezone,
    created_at: r.created_at,
    has_stripe_customer: r.has_stripe_customer,
    has_stripe_subscription: r.has_stripe_subscription,
    effective_plan: effectivePlan(r),
    trial_active: isTrialActive(r),
    trial_days_left: trialDaysLeft(r),
    pulse: {
      last_order_at: r.last_order_at,
      orders_24h: Number(r.orders_24h),
      orders_7d: Number(r.orders_7d),
      orders_30d: Number(r.orders_30d),
      revenue_30d: Number(r.revenue_30d),
    },
    onboarding: {
      has_menu: Number(r.real_menu_items) > 0,
      has_payment: r.has_mp_connected || r.has_processor_credentials,
      has_printer: Number(r.active_printers) > 0,
      has_extra_staff: Number(r.employee_count) > 1,
      has_first_order: Number(r.real_order_count) > 0,
      real_order_count: Number(r.real_order_count),
      employee_count: Number(r.employee_count),
      menu_item_count: Number(r.real_menu_items),
    },
    incidents: {
      open: Number(r.open_incidents),
      critical: Number(r.critical_incidents),
      high: Number(r.high_incidents),
      last_seen_at: r.last_incident_at,
    },
  }));
}

const LISTABLE_INCIDENT_STATUSES = new Set([
  'open', 'diagnosing', 'auto_fixed', 'waiting_approval', 'needs_human', 'resolved', 'dismissed',
]);

/**
 * Cross-tenant sentinel incident feed for the admin dashboard. The product's
 * /api/sentinel surface is deliberately RLS-scoped to one tenant; this is
 * the platform-operator view of the same spine. Read-only: acting on an
 * incident stays in the tenant's own panel where the playbook guards live.
 *
 * @param {object} opts
 * @param {string} [opts.status]  exact status filter; default = active-only
 * @param {string} [opts.tenantId] filter to one tenant
 * @param {number} [opts.limit]
 */
export async function listAllIncidents({ status, tenantId, limit = 100 } = {}) {
  if (status && !LISTABLE_INCIDENT_STATUSES.has(status)) {
    const err = new Error('Invalid status filter');
    err.status = 400;
    err.expose = true;
    throw err;
  }
  const cappedLimit = Math.min(Number(limit) || 100, 300);

  const rows = await adminSql`
    SELECT i.id, i.tenant_id, t.name AS tenant_name, t.subdomain AS tenant_subdomain,
           i.sensor, i.severity, i.status, i.subject_table, i.subject_id,
           i.evidence, i.diagnosis, i.first_seen_at, i.last_seen_at, i.resolved_at
    FROM sentinel_incidents i
    LEFT JOIN tenants t ON t.id = i.tenant_id
    WHERE (${status ?? null}::text IS NULL OR i.status = ${status ?? null})
      AND (${tenantId ?? null}::text IS NULL OR i.tenant_id = ${tenantId ?? null})
    ORDER BY (i.status = ANY(${ACTIVE_INCIDENT_STATUSES}::text[])) DESC,
             i.last_seen_at DESC
    LIMIT ${cappedLimit}
  `;
  return Array.from(rows);
}
