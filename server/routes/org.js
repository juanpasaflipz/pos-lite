import { Router } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { adminSql } from '../db/index.js';
import { JWT_SECRET } from '../lib/constants.js';

/**
 * Corporate (organization) dashboard API.
 *
 * Cross-tenant by design: an organization owns many tenants (stores) and its
 * corporate admin needs consolidated, READ-ONLY reporting across all of them.
 *
 * Mounted BEFORE tenantMiddleware (see server/index.js) because there is no
 * single tenant to resolve. Every query runs on adminSql (bypasses RLS) and
 * is scoped with `WHERE t.org_id = $orgId`. Nothing here writes to
 * tenant-owned tables — keep it that way; the per-store RLS boundary stays
 * the source of truth for anything transactional.
 *
 * Auth: dedicated org JWT ({ type: 'org', orgId }), 12h expiry. Org
 * credentials live on the organizations table (migration 0085), which has
 * no app_user grant — the tenant pool cannot even read it.
 */

const router = Router();

const ORG_JWT_EXPIRY = '12h';

// All Helados y Donas-style orgs are single-timezone chains today. If a
// multi-timezone org ever signs, group by each tenant's own timezone instead.
const DEFAULT_TZ = 'America/Mexico_City';

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyGenerator: (req) => `org-login:${ipKeyGenerator(req.ip)}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, please try again later' },
});

// ==================== Auth ====================

// POST /api/org/login — { email, password } → { token, org }
router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }

    const [org] = await adminSql`
      SELECT id, name, admin_email, admin_password_hash
      FROM organizations
      WHERE admin_email = ${String(email).trim().toLowerCase()}
    `;

    // Same error for unknown email and bad password — no account enumeration.
    if (!org || !(await bcrypt.compare(password, org.admin_password_hash))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { type: 'org', orgId: org.id, email: org.admin_email },
      JWT_SECRET,
      { expiresIn: ORG_JWT_EXPIRY },
    );

    res.json({ token, org: { id: org.id, name: org.name } });
  } catch (err) {
    console.error('[Org] Login error:', err.message);
    res.status(500).json({ error: 'Login failed' });
  }
});

/** Org auth middleware — validates the org JWT, attaches req.org. */
async function requireOrg(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    const decoded = jwt.verify(authHeader.slice(7), JWT_SECRET);
    if (decoded.type !== 'org') {
      return res.status(403).json({ error: 'Org token required' });
    }
    const [org] = await adminSql`
      SELECT id, name FROM organizations WHERE id = ${decoded.orgId}
    `;
    if (!org) return res.status(401).json({ error: 'Organization not found' });
    req.org = { id: org.id, name: org.name, email: decoded.email };
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// GET /api/org/me — token check for the frontend session restore
router.get('/me', requireOrg, async (req, res) => {
  const [row] = await adminSql`
    SELECT COUNT(*)::int AS store_count FROM tenants
    WHERE org_id = ${req.org.id} AND active = true
  `;
  res.json({ org: { id: req.org.id, name: req.org.name }, store_count: row.store_count });
});

// ==================== Query helpers (exported for tests) ====================

const num = (v) => Number(v ?? 0);

/**
 * Consolidated KPIs across all active stores of the org.
 * "Paid revenue" convention mirrors routes/reports.js:
 * payment_status = 'paid', bucketed by COALESCE(paid_at, created_at) in local time.
 */
export async function orgOverview(orgId, tz = DEFAULT_TZ) {
  const [row] = await adminSql`
    WITH org_orders AS (
      SELECT o.total, (COALESCE(o.paid_at, o.created_at) AT TIME ZONE ${tz})::date AS day
      FROM orders o
      JOIN tenants t ON t.id = o.tenant_id
      WHERE t.org_id = ${orgId}
        AND t.active = true
        AND o.payment_status = 'paid'
        AND COALESCE(o.paid_at, o.created_at) >= NOW() - INTERVAL '31 days'
    ), today AS (
      SELECT (NOW() AT TIME ZONE ${tz})::date AS d
    )
    SELECT
      COALESCE(SUM(total) FILTER (WHERE day = (SELECT d FROM today)), 0)                    AS today_revenue,
      COUNT(*)  FILTER (WHERE day = (SELECT d FROM today))                                  AS today_orders,
      COALESCE(SUM(total) FILTER (WHERE day = (SELECT d FROM today) - 1), 0)                AS yesterday_revenue,
      COALESCE(SUM(total) FILTER (WHERE day >= (SELECT d FROM today) - 6), 0)               AS week_revenue,
      COALESCE(SUM(total), 0)                                                               AS month_revenue,
      COUNT(*)                                                                              AS month_orders
    FROM org_orders
  `;

  const [stores] = await adminSql`
    SELECT COUNT(*)::int AS n FROM tenants WHERE org_id = ${orgId} AND active = true
  `;

  const monthOrders = num(row.month_orders);
  return {
    store_count: stores.n,
    today_revenue: num(row.today_revenue),
    today_orders: num(row.today_orders),
    yesterday_revenue: num(row.yesterday_revenue),
    week_revenue: num(row.week_revenue),
    month_revenue: num(row.month_revenue),
    month_orders: monthOrders,
    avg_ticket_30d: monthOrders > 0 ? num(row.month_revenue) / monthOrders : 0,
  };
}

/** Per-store rollup: today / 7d / 30d revenue, orders, avg ticket, last sale. */
export async function orgStores(orgId, tz = DEFAULT_TZ) {
  const rows = await adminSql`
    WITH today AS (SELECT (NOW() AT TIME ZONE ${tz})::date AS d)
    SELECT
      t.id, t.name, t.subdomain,
      COALESCE(SUM(o.total) FILTER (
        WHERE (COALESCE(o.paid_at, o.created_at) AT TIME ZONE ${tz})::date = (SELECT d FROM today)
      ), 0) AS today_revenue,
      COUNT(o.id) FILTER (
        WHERE (COALESCE(o.paid_at, o.created_at) AT TIME ZONE ${tz})::date = (SELECT d FROM today)
      ) AS today_orders,
      COALESCE(SUM(o.total) FILTER (
        WHERE (COALESCE(o.paid_at, o.created_at) AT TIME ZONE ${tz})::date >= (SELECT d FROM today) - 6
      ), 0) AS week_revenue,
      COALESCE(SUM(o.total), 0) AS month_revenue,
      COUNT(o.id)               AS month_orders,
      MAX(COALESCE(o.paid_at, o.created_at)) AS last_sale_at
    FROM tenants t
    LEFT JOIN orders o
      ON o.tenant_id = t.id
      AND o.payment_status = 'paid'
      AND COALESCE(o.paid_at, o.created_at) >= NOW() - INTERVAL '31 days'
    WHERE t.org_id = ${orgId} AND t.active = true
    GROUP BY t.id, t.name, t.subdomain
    ORDER BY month_revenue DESC
  `;

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    subdomain: r.subdomain,
    today_revenue: num(r.today_revenue),
    today_orders: num(r.today_orders),
    week_revenue: num(r.week_revenue),
    month_revenue: num(r.month_revenue),
    month_orders: num(r.month_orders),
    avg_ticket: num(r.month_orders) > 0 ? num(r.month_revenue) / num(r.month_orders) : 0,
    last_sale_at: r.last_sale_at,
  }));
}

/** Org-wide daily revenue/orders series for the chart. */
export async function orgTimeseries(orgId, days = 30, tz = DEFAULT_TZ) {
  const span = Math.min(Math.max(parseInt(days) || 30, 7), 90);
  const rows = await adminSql`
    SELECT
      (COALESCE(o.paid_at, o.created_at) AT TIME ZONE ${tz})::date AS day,
      COUNT(*)                 AS orders,
      COALESCE(SUM(o.total), 0) AS revenue
    FROM orders o
    JOIN tenants t ON t.id = o.tenant_id
    WHERE t.org_id = ${orgId}
      AND t.active = true
      AND o.payment_status = 'paid'
      AND COALESCE(o.paid_at, o.created_at) >= NOW() - MAKE_INTERVAL(days => ${span})
    GROUP BY 1
    ORDER BY 1
  `;
  return rows.map((r) => ({
    day: r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day),
    orders: num(r.orders),
    revenue: num(r.revenue),
  }));
}

/** Best sellers across the whole org (30d window). */
export async function orgTopItems(orgId, limit = 10) {
  const capped = Math.min(Math.max(parseInt(limit) || 10, 1), 25);
  const rows = await adminSql`
    SELECT
      oi.item_name,
      SUM(oi.quantity)                      AS units,
      COALESCE(SUM(oi.quantity * oi.unit_price), 0) AS revenue
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id AND o.tenant_id = oi.tenant_id
    JOIN tenants t ON t.id = o.tenant_id
    WHERE t.org_id = ${orgId}
      AND t.active = true
      AND o.payment_status = 'paid'
      AND COALESCE(o.paid_at, o.created_at) >= NOW() - INTERVAL '31 days'
    GROUP BY oi.item_name
    ORDER BY revenue DESC
    LIMIT ${capped}
  `;
  return rows.map((r) => ({
    item_name: r.item_name,
    units: num(r.units),
    revenue: num(r.revenue),
  }));
}

// ==================== Read-only endpoints ====================

router.get('/overview', requireOrg, async (req, res) => {
  try {
    res.json(await orgOverview(req.org.id));
  } catch (err) {
    console.error('[Org] Overview error:', err.message);
    res.status(500).json({ error: 'Failed to fetch overview' });
  }
});

router.get('/stores', requireOrg, async (req, res) => {
  try {
    res.json(await orgStores(req.org.id));
  } catch (err) {
    console.error('[Org] Stores error:', err.message);
    res.status(500).json({ error: 'Failed to fetch stores' });
  }
});

router.get('/timeseries', requireOrg, async (req, res) => {
  try {
    res.json(await orgTimeseries(req.org.id, req.query.days));
  } catch (err) {
    console.error('[Org] Timeseries error:', err.message);
    res.status(500).json({ error: 'Failed to fetch timeseries' });
  }
});

router.get('/top-items', requireOrg, async (req, res) => {
  try {
    res.json(await orgTopItems(req.org.id, req.query.limit));
  } catch (err) {
    console.error('[Org] Top items error:', err.message);
    res.status(500).json({ error: 'Failed to fetch top items' });
  }
});

export default router;
