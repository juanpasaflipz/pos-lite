import { Router } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { createTenant, getTenant, listTenants, updateTenant } from '../tenants.js';
import { tenantCache } from '../lib/tenantCache.js';
import { run, adminSql, TENANT_POOL_MAX, ADMIN_POOL_MAX } from '../db/index.js';
import { sendPinEmail, sendWelcomeEmail } from '../helpers/email.js';
import { audit } from '../lib/auditLog.js';
import { purgeTenant, dryRunPurge } from '../helpers/tenantPurge.js';
import { getFleetOverview, listAllIncidents, sanitizeTenant } from '../helpers/controlTower.js';
import { BCRYPT_ROUNDS } from '../lib/constants.js';
import os from 'os';
// Lightweight monitoring (full monitoring removed in pos-lite). These used to
// be empty-object stubs, which crashed the Health tab: HealthTab.tsx reads
// services.postgres.latency_ms, requests.totalRequests, scheduler.running,
// and per-pool counters, so every shape below must stay complete even when
// the underlying value is "we don't track this" (zeros / unconfigured).
const EMPTY_POOL = { active: 0, peakActive: 0, totalReserves: 0, successes: 0, failures: 0, avgWaitMs: 0 };
const getPoolMetrics = () => ({ tenant: { ...EMPTY_POOL }, admin: { ...EMPTY_POOL } });
const getRequestMetrics = () => ({
  totalRequests: 0, totalErrors: 0, errorRate: 0, latencyBuckets: {}, recentErrors: [],
});
const envService = (configured) => ({ status: configured ? 'ok' : 'unconfigured', latency_ms: 0 });
const runServiceChecks = async () => {
  let postgres;
  const t0 = Date.now();
  try {
    await adminSql`SELECT 1`;
    postgres = { status: 'ok', latency_ms: Date.now() - t0 };
  } catch {
    postgres = { status: 'down', latency_ms: 0 };
  }
  return {
    postgres,
    stripe: envService(Boolean(process.env.STRIPE_SECRET_KEY)),
    twilio: envService(Boolean(process.env.TWILIO_ACCOUNT_SID)),
    grok: envService(Boolean(process.env.XAI_API_KEY || process.env.GROK_API_KEY)),
  };
};
const getAIStatus = () => ({ enabled: false, scheduler: { running: false, jobs: [] } });

const router = Router();

// Rate limit all admin routes — 100 requests per 15 min per IP
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  keyGenerator: (req) => `admin:${ipKeyGenerator(req.ip)}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many admin requests, please try again later' },
});

/**
 * Admin auth middleware — protects all admin routes with ADMIN_SECRET env var.
 */
function requireAdmin(req, res, next) {
  const secret = req.headers['x-admin-secret'] || req.headers['authorization']?.replace('Bearer ', '');
  if (!process.env.ADMIN_SECRET) {
    return res.status(500).json({ error: 'ADMIN_SECRET not configured' });
  }
  if (secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Invalid admin secret' });
  }
  next();
}

router.use(adminLimiter);
router.use(requireAdmin);

// ==================== Analytics Endpoints ====================

const PLAN_PRICES = { pro: 80 };

// GET /admin/analytics/overview — KPIs: total tenants, plan breakdown, MRR, total orders/revenue
router.get('/analytics/overview', async (req, res) => {
  try {
    const [tenantStats] = await adminSql`
      SELECT
        COUNT(*) AS total_tenants,
        COUNT(*) FILTER (WHERE active = true) AS active_tenants,
        COUNT(*) FILTER (WHERE plan = 'free') AS free_count,
        COUNT(*) FILTER (WHERE plan = 'pro') AS pro_count
      FROM tenants
    `;

    const [orderStats] = await adminSql`
      SELECT
        COUNT(*) AS total_orders,
        COALESCE(SUM(total), 0) AS total_revenue
      FROM orders
    `;

    const mrr = tenantStats.pro_count * PLAN_PRICES.pro;

    res.json({
      total_tenants: Number(tenantStats.total_tenants),
      active_tenants: Number(tenantStats.active_tenants),
      plan_breakdown: {
        free: Number(tenantStats.free_count),
        pro: Number(tenantStats.pro_count),
      },
      mrr,
      total_orders: Number(orderStats.total_orders),
      total_revenue: Number(orderStats.total_revenue),
    });
  } catch (error) {
    console.error('Analytics overview error:', error);
    res.status(500).json({ error: 'Failed to fetch analytics overview' });
  }
});

// GET /admin/analytics/signups?months=12 — Monthly signup trend
router.get('/analytics/signups', async (req, res) => {
  try {
    const months = Math.min(parseInt(req.query.months) || 12, 36);
    const rows = await adminSql`
      SELECT
        TO_CHAR(created_at, 'YYYY-MM') AS month,
        COUNT(*) AS count
      FROM tenants
      WHERE created_at >= NOW() - MAKE_INTERVAL(months => ${months})
      GROUP BY TO_CHAR(created_at, 'YYYY-MM')
      ORDER BY month
    `;
    res.json(rows.map(r => ({ month: r.month, count: Number(r.count) })));
  } catch (error) {
    console.error('Analytics signups error:', error);
    res.status(500).json({ error: 'Failed to fetch signup analytics' });
  }
});

// GET /admin/analytics/revenue?months=12 — Monthly platform revenue + order counts
router.get('/analytics/revenue', async (req, res) => {
  try {
    const months = Math.min(parseInt(req.query.months) || 12, 36);
    const rows = await adminSql`
      SELECT
        TO_CHAR(created_at, 'YYYY-MM') AS month,
        COUNT(*) AS order_count,
        COALESCE(SUM(total), 0) AS revenue
      FROM orders
      WHERE created_at >= NOW() - MAKE_INTERVAL(months => ${months})
      GROUP BY TO_CHAR(created_at, 'YYYY-MM')
      ORDER BY month
    `;
    res.json(rows.map(r => ({
      month: r.month,
      order_count: Number(r.order_count),
      revenue: Number(r.revenue),
    })));
  } catch (error) {
    console.error('Analytics revenue error:', error);
    res.status(500).json({ error: 'Failed to fetch revenue analytics' });
  }
});

// GET /admin/analytics/churn?months=12 — Monthly cancellation counts
router.get('/analytics/churn', async (req, res) => {
  try {
    const months = Math.min(parseInt(req.query.months) || 12, 36);
    const rows = await adminSql`
      SELECT
        TO_CHAR(subscription_cancelled_at, 'YYYY-MM') AS month,
        COUNT(*) AS count
      FROM tenants
      WHERE subscription_cancelled_at IS NOT NULL
        AND subscription_cancelled_at >= NOW() - MAKE_INTERVAL(months => ${months})
      GROUP BY TO_CHAR(subscription_cancelled_at, 'YYYY-MM')
      ORDER BY month
    `;
    res.json(rows.map(r => ({ month: r.month, count: Number(r.count) })));
  } catch (error) {
    console.error('Analytics churn error:', error);
    res.status(500).json({ error: 'Failed to fetch churn analytics' });
  }
});

// GET /admin/analytics/health — System health info
router.get('/analytics/health', async (req, res) => {
  try {
    const mem = process.memoryUsage();
    const [pgVersion] = await adminSql`SELECT version() AS v`;
    res.json({
      uptime_seconds: Math.floor(process.uptime()),
      node_version: process.version,
      platform: process.platform,
      memory: {
        rss_mb: Math.round(mem.rss / 1048576),
        heap_used_mb: Math.round(mem.heapUsed / 1048576),
        heap_total_mb: Math.round(mem.heapTotal / 1048576),
      },
      os: {
        total_mem_mb: Math.round(os.totalmem() / 1048576),
        free_mem_mb: Math.round(os.freemem() / 1048576),
        cpus: os.cpus().length,
      },
      postgres_version: pgVersion?.v || 'unknown',
    });
  } catch (error) {
    console.error('Analytics health error:', error);
    res.status(500).json({ error: 'Failed to fetch health data' });
  }
});

// GET /admin/analytics/health/detailed — Comprehensive system health with pool, request, service metrics
router.get('/analytics/health/detailed', async (req, res) => {
  try {
    const mem = process.memoryUsage();
    const [pgVersion] = await adminSql`SELECT version() AS v`;
    const poolMetrics = getPoolMetrics();
    const requestMetrics = getRequestMetrics();
    const serviceChecks = await runServiceChecks();
    const aiStatus = getAIStatus();

    res.json({
      uptime_seconds: Math.floor(process.uptime()),
      node_version: process.version,
      platform: process.platform,
      memory: {
        rss_mb: Math.round(mem.rss / 1048576),
        heap_used_mb: Math.round(mem.heapUsed / 1048576),
        heap_total_mb: Math.round(mem.heapTotal / 1048576),
        external_mb: Math.round((mem.external || 0) / 1048576),
      },
      os: {
        total_mem_mb: Math.round(os.totalmem() / 1048576),
        free_mem_mb: Math.round(os.freemem() / 1048576),
        cpus: os.cpus().length,
        load_avg: os.loadavg(),
      },
      postgres_version: pgVersion?.v || 'unknown',
      pools: {
        tenant: { ...poolMetrics.tenant, max: TENANT_POOL_MAX },
        admin: { ...poolMetrics.admin, max: ADMIN_POOL_MAX },
      },
      requests: requestMetrics,
      services: serviceChecks,
      scheduler: aiStatus.scheduler,
    });
  } catch (error) {
    console.error('Detailed health error:', error);
    res.status(500).json({ error: 'Failed to fetch detailed health data' });
  }
});

// GET /admin/analytics/metrics/history?minutes=60 — Ring buffer for charts
router.get('/analytics/metrics/history', (req, res) => {
  try {
    const minutes = Math.min(parseInt(req.query.minutes) || 60, 1440);
    const history = getMetricsHistory(minutes);
    res.json(history);
  } catch (error) {
    console.error('Metrics history error:', error);
    res.status(500).json({ error: 'Failed to fetch metrics history' });
  }
});

// GET /admin/analytics/alerts?limit=50 — Recent platform alerts
router.get('/analytics/alerts', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const rows = await adminSql`
      SELECT * FROM platform_alerts
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
    res.json(Array.from(rows));
  } catch (error) {
    console.error('Alerts error:', error);
    res.status(500).json({ error: 'Failed to fetch alerts' });
  }
});

// GET /admin/analytics/alerts/unacknowledged/count — Count of unacknowledged alerts
router.get('/analytics/alerts/unacknowledged/count', async (req, res) => {
  try {
    const [row] = await adminSql`
      SELECT COUNT(*)::int AS count FROM platform_alerts WHERE acknowledged = false
    `;
    res.json({ count: row?.count || 0 });
  } catch (error) {
    res.json({ count: 0 });
  }
});

// PATCH /admin/analytics/alerts/:id/acknowledge — Acknowledge an alert
router.patch('/analytics/alerts/:id/acknowledge', async (req, res) => {
  try {
    const [updated] = await adminSql`
      UPDATE platform_alerts
      SET acknowledged = true, acknowledged_at = NOW()
      WHERE id = ${req.params.id}
      RETURNING *
    `;
    if (!updated) return res.status(404).json({ error: 'Alert not found' });
    res.json(updated);
  } catch (error) {
    console.error('Acknowledge alert error:', error);
    res.status(500).json({ error: 'Failed to acknowledge alert' });
  }
});

// GET /admin/analytics/alerts/rules — List alert rules
router.get('/analytics/alerts/rules', async (req, res) => {
  try {
    const rows = await adminSql`SELECT * FROM platform_alert_rules ORDER BY id`;
    res.json(Array.from(rows));
  } catch (error) {
    console.error('Alert rules error:', error);
    res.status(500).json({ error: 'Failed to fetch alert rules' });
  }
});

// POST /admin/analytics/alerts/rules — Create alert rule
router.post('/analytics/alerts/rules', async (req, res) => {
  try {
    const { name, metric_type, metric_name, condition, threshold, severity, cooldown_minutes, webhook_url } = req.body;
    if (!name || !metric_type || !metric_name || threshold == null) {
      return res.status(400).json({ error: 'Required: name, metric_type, metric_name, threshold' });
    }
    const [rule] = await adminSql`
      INSERT INTO platform_alert_rules (name, metric_type, metric_name, condition, threshold, severity, cooldown_minutes, webhook_url)
      VALUES (${name}, ${metric_type}, ${metric_name}, ${condition || '>'}, ${threshold}, ${severity || 'warning'}, ${cooldown_minutes || 5}, ${webhook_url || null})
      RETURNING *
    `;
    invalidateRulesCache();
    res.status(201).json(rule);
  } catch (error) {
    console.error('Create alert rule error:', error);
    res.status(500).json({ error: 'Failed to create alert rule' });
  }
});

// PATCH /admin/analytics/alerts/rules/:id — Update alert rule
router.patch('/analytics/alerts/rules/:id', async (req, res) => {
  try {
    const allowed = ['name', 'metric_type', 'metric_name', 'condition', 'threshold', 'severity', 'cooldown_minutes', 'webhook_url', 'enabled'];
    const sets = [];
    const vals = [];
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        sets.push(`${key} = $${vals.length + 1}`);
        vals.push(req.body[key]);
      }
    }
    if (sets.length === 0) return res.status(400).json({ error: 'No valid fields to update' });

    vals.push(req.params.id);
    const result = await adminSql.unsafe(
      `UPDATE platform_alert_rules SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`,
      vals
    );
    if (result.length === 0) return res.status(404).json({ error: 'Rule not found' });

    invalidateRulesCache();
    res.json(result[0]);
  } catch (error) {
    console.error('Update alert rule error:', error);
    res.status(500).json({ error: 'Failed to update alert rule' });
  }
});

// GET /admin/analytics/activity — Top 10 most/least active tenants (last 30 days)
router.get('/analytics/activity', async (req, res) => {
  try {
    const mostActive = await adminSql`
      SELECT t.id, t.name, t.plan, COUNT(o.id) AS order_count,
             COALESCE(SUM(o.total), 0) AS revenue
      FROM tenants t
      LEFT JOIN orders o ON o.tenant_id = t.id
        AND o.created_at >= NOW() - INTERVAL '30 days'
      WHERE t.active = true
      GROUP BY t.id, t.name, t.plan
      ORDER BY order_count DESC
      LIMIT 10
    `;

    const leastActive = await adminSql`
      SELECT t.id, t.name, t.plan, COUNT(o.id) AS order_count,
             COALESCE(SUM(o.total), 0) AS revenue
      FROM tenants t
      LEFT JOIN orders o ON o.tenant_id = t.id
        AND o.created_at >= NOW() - INTERVAL '30 days'
      WHERE t.active = true
      GROUP BY t.id, t.name, t.plan
      ORDER BY order_count ASC
      LIMIT 10
    `;

    res.json({
      most_active: mostActive.map(r => ({ ...r, order_count: Number(r.order_count), revenue: Number(r.revenue) })),
      least_active: leastActive.map(r => ({ ...r, order_count: Number(r.order_count), revenue: Number(r.revenue) })),
    });
  } catch (error) {
    console.error('Analytics activity error:', error);
    res.status(500).json({ error: 'Failed to fetch activity analytics' });
  }
});

// GET /admin/tenants/fleet — Control-tower overview: one row per tenant with
// identity + billing state, trial-aware effective plan, activity pulse,
// onboarding progress, and open sentinel-incident counts. One set-based
// query; safe under the admin rate limiter regardless of tenant count.
// NOTE: must stay registered before GET /tenants/:id or Express will treat
// 'fleet' as a tenant id.
router.get('/tenants/fleet', async (req, res) => {
  try {
    res.json(await getFleetOverview());
  } catch (error) {
    console.error('Fleet overview error:', error);
    res.status(500).json({ error: 'Failed to fetch fleet overview' });
  }
});

// GET /admin/sentinel/incidents — cross-tenant incident feed (read-only).
// ?status=<status> for an exact filter (default: everything, active first),
// ?tenant_id=<id> to scope to one tenant, ?limit=<n> (max 300).
router.get('/sentinel/incidents', async (req, res) => {
  try {
    const incidents = await listAllIncidents({
      status: req.query.status,
      tenantId: req.query.tenant_id,
      limit: req.query.limit,
    });
    res.json(incidents);
  } catch (error) {
    if (error.expose) return res.status(error.status || 400).json({ error: error.message });
    console.error('Admin incidents error:', error);
    res.status(500).json({ error: 'Failed to fetch incidents' });
  }
});

// GET /admin/tenants/:id/deep-dive — Per-tenant detailed stats
router.get('/tenants/:id/deep-dive', async (req, res) => {
  try {
    const tenant = await getTenant(req.params.id);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    const [stats] = await adminSql`
      SELECT
        (SELECT COUNT(*) FROM orders WHERE tenant_id = ${tenant.id}) AS total_orders,
        (SELECT COALESCE(SUM(total), 0) FROM orders WHERE tenant_id = ${tenant.id}) AS total_revenue,
        (SELECT COUNT(*) FROM orders WHERE tenant_id = ${tenant.id}
          AND created_at >= NOW() - INTERVAL '30 days') AS orders_30d,
        (SELECT COALESCE(SUM(total), 0) FROM orders WHERE tenant_id = ${tenant.id}
          AND created_at >= NOW() - INTERVAL '30 days') AS revenue_30d,
        (SELECT COUNT(*) FROM employees WHERE tenant_id = ${tenant.id}) AS employee_count,
        (SELECT COUNT(*) FROM menu_items WHERE tenant_id = ${tenant.id}) AS menu_item_count,
        (SELECT COUNT(*) FROM menu_categories WHERE tenant_id = ${tenant.id}) AS category_count,
        (SELECT COUNT(*) FROM loyalty_customers WHERE tenant_id = ${tenant.id}) AS customer_count,
        (SELECT MAX(created_at) FROM orders WHERE tenant_id = ${tenant.id}) AS last_order_at
    `;

    res.json({
      tenant: sanitizeTenant(tenant),
      stats: {
        total_orders: Number(stats.total_orders),
        total_revenue: Number(stats.total_revenue),
        orders_30d: Number(stats.orders_30d),
        revenue_30d: Number(stats.revenue_30d),
        employee_count: Number(stats.employee_count),
        menu_item_count: Number(stats.menu_item_count),
        category_count: Number(stats.category_count),
        customer_count: Number(stats.customer_count),
        last_order_at: stats.last_order_at,
      },
    });
  } catch (error) {
    console.error('Tenant deep-dive error:', error);
    res.status(500).json({ error: 'Failed to fetch tenant deep-dive' });
  }
});

// ==================== Tenant CRUD ====================

// POST /admin/tenants — create new tenant
router.post('/tenants', async (req, res) => {
  try {
    const { id, name, owner_email, owner_password, subdomain, plan, branding_json } = req.body;

    if (!id || !name || !owner_email || !owner_password) {
      return res.status(400).json({ error: 'Required: id, name, owner_email, owner_password' });
    }

    if (owner_password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    // Validate slug format
    if (!/^[a-z0-9-]+$/.test(id)) {
      return res.status(400).json({ error: 'Tenant ID must be lowercase alphanumeric with hyphens' });
    }

    // Check uniqueness
    if (await getTenant(id)) {
      return res.status(409).json({ error: `Tenant '${id}' already exists` });
    }

    // Check email uniqueness
    const [existingEmail] = await adminSql`SELECT id FROM tenants WHERE owner_email = ${owner_email}`;
    if (existingEmail) {
      return res.status(409).json({ error: `Email '${owner_email}' is already associated with another tenant` });
    }

    // Hash password
    const owner_password_hash = await bcrypt.hash(owner_password, BCRYPT_ROUNDS);

    const tenant = await createTenant({
      id,
      name,
      subdomain: subdomain || id,
      owner_email,
      owner_password_hash,
      plan,
      branding_json: branding_json ? JSON.stringify(branding_json) : null,
    });

    // Generate random 4-digit PIN for the admin employee
    const pin = String(crypto.randomInt(1000, 10000));
    const hashedPin = await bcrypt.hash(pin, BCRYPT_ROUNDS);

    await adminSql`
      INSERT INTO employees (tenant_id, name, pin, role, active)
      VALUES (${id}, ${owner_email}, ${hashedPin}, 'admin', true)
    `;

    // Fire-and-forget welcome email with PIN and setup guide
    sendWelcomeEmail(owner_email, name, subdomain || id, pin).catch(() => {});

    audit({
      tenantId: id,
      actorType: 'admin',
      actorId: 'super-admin',
      action: 'create',
      resource: 'tenant',
      resourceId: id,
      details: { name, owner_email, plan: plan || 'free' },
      ip: req.ip,
    });

    res.status(201).json({ ...sanitizeTenant(tenant), pin });
  } catch (error) {
    console.error('Error creating tenant:', error);
    res.status(500).json({ error: 'Failed to create tenant' });
  }
});

// GET /admin/tenants — list all tenants with stats, search/filter/sort
router.get('/tenants', async (req, res) => {
  try {
    const { search, plan, status, sort, order } = req.query;

    let tenants = await listTenants();

    // Filter by search term (name, id, email)
    if (search) {
      const q = search.toLowerCase();
      tenants = tenants.filter(t =>
        t.id.toLowerCase().includes(q) ||
        t.name.toLowerCase().includes(q) ||
        (t.owner_email || '').toLowerCase().includes(q)
      );
    }

    // Filter by plan
    if (plan) {
      tenants = tenants.filter(t => t.plan === plan);
    }

    // Filter by status (active/inactive)
    if (status === 'active') {
      tenants = tenants.filter(t => t.active);
    } else if (status === 'inactive') {
      tenants = tenants.filter(t => !t.active);
    }

    // Sort
    if (sort) {
      const dir = order === 'asc' ? 1 : -1;
      tenants.sort((a, b) => {
        const av = a[sort] ?? '';
        const bv = b[sort] ?? '';
        if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
        return String(av).localeCompare(String(bv)) * dir;
      });
    }

    res.json(tenants.map(sanitizeTenant));
  } catch (error) {
    console.error('Error listing tenants:', error);
    res.status(500).json({ error: 'Failed to list tenants' });
  }
});

// GET /admin/tenants/:id — get single tenant
router.get('/tenants/:id', async (req, res) => {
  try {
    const tenant = await getTenant(req.params.id);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
    res.json(sanitizeTenant(tenant));
  } catch (error) {
    res.status(500).json({ error: 'Failed to get tenant' });
  }
});

// PATCH /admin/tenants/:id — update plan/status/branding
router.patch('/tenants/:id', async (req, res) => {
  try {
    const tenant = await getTenant(req.params.id);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    const allowed = ['name', 'subdomain', 'owner_email', 'plan', 'active', 'subscription_status',
      'stripe_customer_id', 'stripe_subscription_id', 'branding_json', 'trial_ends_at',
      'inventory_mode'];

    if (req.body.inventory_mode !== undefined
        && !['ingredients', 'two_stage'].includes(req.body.inventory_mode)) {
      return res.status(400).json({ error: "inventory_mode must be 'ingredients' or 'two_stage'" });
    }
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        updates[key] = key === 'branding_json' && typeof req.body[key] === 'object'
          ? JSON.stringify(req.body[key])
          : req.body[key];
      }
    }

    // trial_ends_at: ISO timestamp or null (null clears the trial). Guard the
    // cast here so a bad value 400s instead of bubbling a Postgres error.
    if ('trial_ends_at' in updates && updates.trial_ends_at !== null) {
      const ts = new Date(updates.trial_ends_at);
      if (Number.isNaN(ts.getTime())) {
        return res.status(400).json({ error: 'trial_ends_at must be an ISO timestamp or null' });
      }
      updates.trial_ends_at = ts.toISOString();
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    await updateTenant(req.params.id, updates);

    // Auto-toggle AI (grok_api_enabled) based on plan: Pro → on, Free → off
    if (updates.plan) {
      const aiEnabled = updates.plan === 'pro' ? '1' : '0';
      await adminSql`
        INSERT INTO ai_config (tenant_id, key, value, description)
        VALUES (${req.params.id}, 'grok_api_enabled', ${aiEnabled}, 'Enable Grok API for enhanced analysis')
        ON CONFLICT (tenant_id, key) DO UPDATE SET value = ${aiEnabled}
      `;
      console.log(`[Admin] Tenant ${req.params.id} plan=${updates.plan} → grok_api_enabled=${aiEnabled}`);
    }

    audit({
      tenantId: req.params.id,
      actorType: 'admin',
      actorId: 'super-admin',
      action: 'update',
      resource: 'tenant',
      resourceId: req.params.id,
      details: { fields: Object.keys(updates) },
      ip: req.ip,
    });

    res.json(sanitizeTenant(await getTenant(req.params.id)));
  } catch (error) {
    console.error('Error updating tenant:', error);
    res.status(500).json({ error: 'Failed to update tenant' });
  }
});

// POST /admin/tenants/:id/reset-password — reset tenant owner password
router.post('/tenants/:id/reset-password', async (req, res) => {
  try {
    const tenant = await getTenant(req.params.id);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    const { new_password } = req.body;
    if (!new_password || new_password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const owner_password_hash = await bcrypt.hash(new_password, BCRYPT_ROUNDS);
    await updateTenant(req.params.id, { owner_password_hash });

    res.json({ message: 'Password reset successfully' });
  } catch (error) {
    console.error('Error resetting password:', error);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// GET /admin/tenants/:id/export — export all tenant data as JSON
router.get('/tenants/:id/export', async (req, res) => {
  try {
    const tenant = await getTenant(req.params.id);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    const tid = tenant.id;
    const tables = [
      'employees', 'menu_categories', 'menu_items', 'menu_item_modifier_groups',
      'menu_item_ingredients', 'modifier_groups', 'modifiers', 'combo_definitions',
      'combo_slots', 'orders', 'order_items', 'order_item_modifiers', 'order_payments',
      'order_payment_items', 'inventory_items', 'inventory_counts', 'vendors',
      'vendor_items', 'purchase_orders', 'purchase_order_items', 'printers',
      'category_printer_routes', 'delivery_platforms', 'delivery_orders',
      'delivery_markup_rules', 'delivery_recapture', 'virtual_brands',
      'virtual_brand_items', 'loyalty_customers', 'stamp_cards', 'stamp_events',
      'referral_events', 'loyalty_messages', 'loyalty_config',
      'ai_config', 'ai_suggestion_cache', 'ai_suggestion_events',
      'ai_hourly_snapshots', 'ai_item_pairs', 'ai_inventory_velocity',
      'ai_restock_log', 'ai_category_roles', 'shrinkage_alerts', 'refunds',
      'role_permissions', 'financial_targets', 'financial_actuals',
      'order_templates',
    ];

    const queries = tables.map(async (table) => {
      try {
        const rows = await adminSql.unsafe(
          `SELECT * FROM ${table} WHERE tenant_id = $1`,
          [tid]
        );
        return [table, Array.from(rows)];
      } catch {
        return [table, []];
      }
    });

    const results = await Promise.all(queries);
    const data = Object.fromEntries(results);

    // Add tenant metadata (credential-bearing columns stripped)
    data._tenant = sanitizeTenant(tenant);

    res.setHeader('Content-Disposition', `attachment; filename="${tid}-export-${new Date().toISOString().slice(0, 10)}.json"`);
    res.json(data);
  } catch (error) {
    console.error('Error exporting tenant:', error);
    res.status(500).json({ error: 'Failed to export tenant data' });
  }
});

// DELETE /admin/tenants/:id — permanently delete a tenant and all data.
// The cascade is driven by tenantPurge: it scans information_schema for
// every table carrying a tenant_id column and topologically sorts FK
// dependencies from pg_constraint, so new tenant-scoped tables are
// automatically covered the moment they ship.
//
// Pass ?dry_run=true to get the discovered table list + per-table row
// counts without deleting anything.
router.delete('/tenants/:id', async (req, res) => {
  try {
    const tenant = await getTenant(req.params.id);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    const tid = tenant.id;
    const dryRun = req.query.dry_run === 'true' || req.query.dry_run === '1';

    if (dryRun) {
      const plan = await dryRunPurge(tid);
      return res.json({ dry_run: true, ...plan });
    }

    const { confirm } = req.body;
    if (confirm !== req.params.id) {
      return res.status(400).json({ error: 'Must confirm deletion by passing { confirm: tenantId }' });
    }

    const result = await purgeTenant(tid);

    // Invalidate tenant cache so subsequent lookups return 404
    tenantCache.invalidate(tid);

    audit({
      tenantId: tid,
      actorType: 'admin',
      actorId: 'super-admin',
      action: 'delete',
      resource: 'tenant',
      resourceId: tid,
      details: { reason: 'admin action', ...result },
      ip: req.ip,
    });

    res.json({
      message: `Tenant '${tid}' and all associated data deleted permanently`,
      ...result,
    });
  } catch (error) {
    console.error('Error deleting tenant:', error);
    res.status(500).json({ error: 'Failed to delete tenant', detail: error.message });
  }
});

// GET /admin/promos/usage — promo code signup stats
router.get('/promos/usage', async (req, res) => {
  try {
    const rows = await adminSql`
      SELECT
        signup_promo_code,
        COUNT(*)::int AS signups,
        MIN(created_at) AS first_use,
        MAX(created_at) AS last_use
      FROM tenants
      WHERE signup_promo_code IS NOT NULL
      GROUP BY signup_promo_code
      ORDER BY signups DESC
    `;
    res.json(rows);
  } catch (error) {
    console.error('Promo usage error:', error);
    res.status(500).json({ error: 'Failed to fetch promo usage' });
  }
});

// POST /admin/tenants/:id/seed — seed full demo data for a tenant
router.post('/tenants/:id/seed', async (req, res) => {
  try {
    const tenant = await getTenant(req.params.id);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    const tid = tenant.id;

    // Clear existing seed-able data (preserves orders/customers)
    const clearTables = [
      'menu_item_modifier_groups', 'menu_item_ingredients',
      'combo_slots', 'combo_definitions',
      'modifiers', 'modifier_groups',
      'menu_items', 'menu_categories',
      'ai_restock_log', 'ai_inventory_velocity', 'inventory_counts',
      'inventory_items',
      'delivery_markup_rules', 'virtual_brand_items', 'virtual_brands', 'delivery_platforms',
      'ai_category_roles', 'ai_config',
    ];
    for (const t of clearTables) {
      try { await adminSql.unsafe(`DELETE FROM ${t} WHERE tenant_id = $1`, [tid]); } catch {}
    }

    // ── Employees (only add if none exist) ──
    const [empCount] = await adminSql`SELECT COUNT(*)::int AS c FROM employees WHERE tenant_id = ${tid}`;
    if (empCount.c === 0) {
      const pin1234 = await bcrypt.hash('1234', BCRYPT_ROUNDS);
      const pin5678 = await bcrypt.hash('5678', BCRYPT_ROUNDS);
      await adminSql`INSERT INTO employees (tenant_id, name, pin, role, active) VALUES (${tid}, 'Manager', ${pin1234}, 'admin', true)`;
      await adminSql`INSERT INTO employees (tenant_id, name, pin, role, active) VALUES (${tid}, 'Cashier', ${pin5678}, 'cashier', true)`;
    }

    // ── Menu Categories ──
    const catRows = await adminSql`
      INSERT INTO menu_categories (tenant_id, name, sort_order, active, printer_target) VALUES
        (${tid}, 'Burgers', 1, true, 'kitchen'),
        (${tid}, 'Chicken', 2, true, 'kitchen'),
        (${tid}, 'Sides', 3, true, 'kitchen'),
        (${tid}, 'Drinks', 4, true, 'bar'),
        (${tid}, 'Desserts', 5, true, 'kitchen')
      RETURNING id, name
    `;
    const catId = {};
    for (const r of catRows) catId[r.name] = r.id;

    // ── Menu Items (MXN prices) ──
    const items = [
      [catId['Burgers'], 'Classic Burger', 95, 'Beef patty, lettuce, tomato, onion, pickles'],
      [catId['Burgers'], 'Cheeseburger', 110, 'Beef patty with melted American cheese'],
      [catId['Burgers'], 'Double Burger', 145, 'Two beef patties, cheese, special sauce'],
      [catId['Burgers'], 'Bacon Burger', 130, 'Beef patty, crispy bacon, cheese, BBQ sauce'],
      [catId['Burgers'], 'Chicken Burger', 105, 'Grilled chicken breast, lettuce, mayo'],
      [catId['Chicken'], 'Chicken Tenders (4 pcs)', 85, 'Crispy breaded chicken strips'],
      [catId['Chicken'], 'Chicken Wings (6 pcs)', 95, 'Fried wings with your choice of sauce'],
      [catId['Chicken'], 'Chicken Wrap', 90, 'Grilled chicken, lettuce, ranch, flour tortilla'],
      [catId['Sides'], 'French Fries', 45, 'Classic golden fries'],
      [catId['Sides'], 'Onion Rings', 55, 'Crispy battered onion rings'],
      [catId['Sides'], 'Coleslaw', 35, 'Fresh creamy coleslaw'],
      [catId['Sides'], 'Side Salad', 50, 'Mixed greens, tomato, cucumber, dressing'],
      [catId['Drinks'], 'Coca-Cola', 30, 'Coca-Cola (500ml)'],
      [catId['Drinks'], 'Sprite', 30, 'Sprite (500ml)'],
      [catId['Drinks'], 'Lemonade', 35, 'Fresh-squeezed lemonade'],
      [catId['Drinks'], 'Water', 20, 'Bottled water'],
      [catId['Drinks'], 'Coffee', 35, 'Freshly brewed coffee'],
      [catId['Desserts'], 'Milkshake', 65, 'Vanilla, chocolate, or strawberry'],
      [catId['Desserts'], 'Brownie', 50, 'Warm chocolate brownie'],
      [catId['Desserts'], 'Ice Cream Cup', 45, 'Two scoops, your choice of flavor'],
    ];
    const itemId = {};
    for (const [categoryId, name, price, description] of items) {
      const [row] = await adminSql`
        INSERT INTO menu_items (tenant_id, category_id, name, price, description, active)
        VALUES (${tid}, ${categoryId}, ${name}, ${price}, ${description}, true)
        RETURNING id, name
      `;
      itemId[row.name] = row.id;
    }

    // ── Inventory ──
    const invItems = [
      ['Beef Patties', 200, 'count', 40, 'Meats', 25],
      ['Chicken Breast', 50, 'lbs', 10, 'Meats', 90],
      ['Bacon', 30, 'lbs', 5, 'Meats', 120],
      ['Burger Buns', 200, 'count', 40, 'Dry Goods', 5],
      ['French Fries (frozen)', 100, 'lbs', 20, 'Frozen', 15],
      ['Chicken Tenders (frozen)', 80, 'lbs', 15, 'Frozen', 50],
      ['American Cheese', 30, 'lbs', 8, 'Dairy', 80],
      ['Lettuce', 30, 'heads', 5, 'Produce', 15],
      ['Tomatoes', 50, 'lbs', 10, 'Produce', 30],
      ['Onions', 40, 'lbs', 8, 'Produce', 15],
      ['Pickles', 20, 'jars', 5, 'Supplies', 40],
      ['Cooking Oil', 40, 'liters', 10, 'Supplies', 30],
      ['Coca-Cola (500ml)', 100, 'count', 20, 'Beverages', 12],
      ['Sprite (500ml)', 80, 'count', 15, 'Beverages', 12],
      ['Coffee Beans', 20, 'lbs', 5, 'Beverages', 150],
    ];
    for (const [name, qty, unit, threshold, category, cost] of invItems) {
      await adminSql`
        INSERT INTO inventory_items (tenant_id, name, quantity, unit, low_stock_threshold, category, cost_price)
        VALUES (${tid}, ${name}, ${qty}, ${unit}, ${threshold}, ${category}, ${cost})
      `;
    }

    // ── Modifier Groups ──
    const mgRows = await adminSql`
      INSERT INTO modifier_groups (tenant_id, name, selection_type, required, min_selections, max_selections, sort_order, active) VALUES
        (${tid}, 'Extras', 'multi', false, 0, 5, 1, true),
        (${tid}, 'Sauce', 'single', false, 0, 1, 2, true)
      RETURNING id, name
    `;
    const mgId = {};
    for (const r of mgRows) mgId[r.name] = r.id;

    await adminSql`INSERT INTO modifiers (tenant_id, group_id, name, price_adjustment, sort_order, active) VALUES (${tid}, ${mgId['Extras']}, 'Extra Cheese', 15, 1, true)`;
    await adminSql`INSERT INTO modifiers (tenant_id, group_id, name, price_adjustment, sort_order, active) VALUES (${tid}, ${mgId['Extras']}, 'Bacon', 20, 2, true)`;
    await adminSql`INSERT INTO modifiers (tenant_id, group_id, name, price_adjustment, sort_order, active) VALUES (${tid}, ${mgId['Extras']}, 'Jalapenos', 0, 3, true)`;
    await adminSql`INSERT INTO modifiers (tenant_id, group_id, name, price_adjustment, sort_order, active) VALUES (${tid}, ${mgId['Extras']}, 'Extra Patty', 35, 4, true)`;

    await adminSql`INSERT INTO modifiers (tenant_id, group_id, name, price_adjustment, sort_order, active) VALUES (${tid}, ${mgId['Sauce']}, 'Ketchup', 0, 1, true)`;
    await adminSql`INSERT INTO modifiers (tenant_id, group_id, name, price_adjustment, sort_order, active) VALUES (${tid}, ${mgId['Sauce']}, 'BBQ', 0, 2, true)`;
    await adminSql`INSERT INTO modifiers (tenant_id, group_id, name, price_adjustment, sort_order, active) VALUES (${tid}, ${mgId['Sauce']}, 'Ranch', 0, 3, true)`;
    await adminSql`INSERT INTO modifiers (tenant_id, group_id, name, price_adjustment, sort_order, active) VALUES (${tid}, ${mgId['Sauce']}, 'Buffalo', 0, 4, true)`;

    // Assign Extras to burgers
    for (const n of ['Classic Burger', 'Cheeseburger', 'Double Burger', 'Bacon Burger', 'Chicken Burger']) {
      if (itemId[n]) await adminSql`INSERT INTO menu_item_modifier_groups (tenant_id, menu_item_id, modifier_group_id, sort_order) VALUES (${tid}, ${itemId[n]}, ${mgId['Extras']}, 1)`;
    }
    // Assign Sauce to chicken
    for (const n of ['Chicken Tenders (4 pcs)', 'Chicken Wings (6 pcs)', 'Chicken Wrap']) {
      if (itemId[n]) await adminSql`INSERT INTO menu_item_modifier_groups (tenant_id, menu_item_id, modifier_group_id, sort_order) VALUES (${tid}, ${itemId[n]}, ${mgId['Sauce']}, 1)`;
    }

    // ── Combos ──
    const comboRows = await adminSql`
      INSERT INTO combo_definitions (tenant_id, name, description, combo_price, active) VALUES
        (${tid}, 'Burger Combo', 'Any burger + fries + drink', 155, true),
        (${tid}, 'Chicken Combo', 'Tenders or wings + side + drink', 150, true)
      RETURNING id, name
    `;
    const comboId = {};
    for (const r of comboRows) comboId[r.name] = r.id;

    await adminSql`INSERT INTO combo_slots (tenant_id, combo_id, slot_label, category_id, sort_order) VALUES (${tid}, ${comboId['Burger Combo']}, 'Burger', ${catId['Burgers']}, 1)`;
    await adminSql`INSERT INTO combo_slots (tenant_id, combo_id, slot_label, category_id, sort_order) VALUES (${tid}, ${comboId['Burger Combo']}, 'Side', ${catId['Sides']}, 2)`;
    await adminSql`INSERT INTO combo_slots (tenant_id, combo_id, slot_label, category_id, sort_order) VALUES (${tid}, ${comboId['Burger Combo']}, 'Drink', ${catId['Drinks']}, 3)`;
    await adminSql`INSERT INTO combo_slots (tenant_id, combo_id, slot_label, category_id, sort_order) VALUES (${tid}, ${comboId['Chicken Combo']}, 'Chicken', ${catId['Chicken']}, 1)`;
    await adminSql`INSERT INTO combo_slots (tenant_id, combo_id, slot_label, category_id, sort_order) VALUES (${tid}, ${comboId['Chicken Combo']}, 'Side', ${catId['Sides']}, 2)`;
    await adminSql`INSERT INTO combo_slots (tenant_id, combo_id, slot_label, category_id, sort_order) VALUES (${tid}, ${comboId['Chicken Combo']}, 'Drink', ${catId['Drinks']}, 3)`;

    // ── Delivery Platforms ──
    await adminSql`INSERT INTO delivery_platforms (tenant_id, name, display_name, commission_percent, active) VALUES (${tid}, 'uber_eats', 'Uber Eats', 30, true)`;
    await adminSql`INSERT INTO delivery_platforms (tenant_id, name, display_name, commission_percent, active) VALUES (${tid}, 'rappi', 'Rappi', 25, true)`;
    await adminSql`INSERT INTO delivery_platforms (tenant_id, name, display_name, commission_percent, active) VALUES (${tid}, 'didi_food', 'DiDi Food', 22, true)`;

    // ── AI Config ──
    const aiEntries = [
      ['restaurant_name', tenant.name, 'Restaurant display name'],
      ['currency', 'MXN', 'Currency code'],
      ['tax_rate', '0.16', 'Tax rate (16% IVA)'],
      ['rush_hours', '11-14,18-21', 'Rush hour ranges (24h format)'],
      ['slow_hours', '15-17', 'Slow period ranges (24h format)'],
      ['max_suggestions_per_order', '2', 'Max AI suggestions per order'],
      ['upsell_enabled', '1', 'Enable upsell suggestions'],
      ['inventory_push_enabled', '1', 'Enable inventory-aware item pushing'],
      ['combo_upgrade_enabled', '1', 'Enable combo upgrade suggestions'],
    ];
    for (const [key, value, description] of aiEntries) {
      await adminSql`
        INSERT INTO ai_config (tenant_id, key, value, description)
        VALUES (${tid}, ${key}, ${value}, ${description})
        ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value
      `;
    }

    // AI category roles
    await adminSql`INSERT INTO ai_category_roles (tenant_id, category_id, role) VALUES (${tid}, ${catId['Burgers']}, 'main')`;
    await adminSql`INSERT INTO ai_category_roles (tenant_id, category_id, role) VALUES (${tid}, ${catId['Chicken']}, 'main')`;
    await adminSql`INSERT INTO ai_category_roles (tenant_id, category_id, role) VALUES (${tid}, ${catId['Sides']}, 'side')`;
    await adminSql`INSERT INTO ai_category_roles (tenant_id, category_id, role) VALUES (${tid}, ${catId['Drinks']}, 'drink')`;
    await adminSql`INSERT INTO ai_category_roles (tenant_id, category_id, role) VALUES (${tid}, ${catId['Desserts']}, 'side')`;

    audit({
      tenantId: tid,
      actorType: 'admin',
      actorId: 'super-admin',
      action: 'seed',
      resource: 'tenant',
      resourceId: tid,
      details: { items: items.length, categories: 5, inventory: invItems.length },
      ip: req.ip,
    });

    res.json({
      message: `Seeded demo data for tenant '${tid}'`,
      summary: {
        categories: 5,
        menu_items: items.length,
        inventory_items: invItems.length,
        modifier_groups: 2,
        combos: 2,
        delivery_platforms: 3,
      },
    });
  } catch (error) {
    console.error('Error seeding tenant:', error);
    res.status(500).json({ error: 'Failed to seed tenant' });
  }
});

// GET /admin/tenants/:id/employees — list employees with roles (PINs are hashed, not returned)
router.get('/tenants/:id/employees', async (req, res) => {
  try {
    const tenant = await getTenant(req.params.id);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    const rows = await adminSql`
      SELECT id, name, role, active, created_at
      FROM employees
      WHERE tenant_id = ${tenant.id}
      ORDER BY role, name
    `;
    res.json(Array.from(rows));
  } catch (error) {
    console.error('Error listing tenant employees:', error);
    res.status(500).json({ error: 'Failed to list employees' });
  }
});

// PATCH /admin/tenants/:id/employees/:empId/pin — set a new PIN for an employee
router.patch('/tenants/:id/employees/:empId/pin', async (req, res) => {
  try {
    const tenant = await getTenant(req.params.id);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    const { pin } = req.body;
    if (!pin || !/^\d{4}$/.test(pin)) {
      return res.status(400).json({ error: 'PIN must be 4 digits' });
    }

    // Verify employee belongs to this tenant
    const [emp] = await adminSql`
      SELECT id, name FROM employees
      WHERE id = ${req.params.empId} AND tenant_id = ${tenant.id}
    `;
    if (!emp) return res.status(404).json({ error: 'Employee not found' });

    const hashedPin = await bcrypt.hash(pin, BCRYPT_ROUNDS);
    await adminSql`
      UPDATE employees SET pin = ${hashedPin}
      WHERE id = ${req.params.empId} AND tenant_id = ${tenant.id}
    `;

    audit({
      tenantId: tenant.id,
      actorType: 'admin',
      actorId: 'super-admin',
      action: 'update',
      resource: 'employee_pin',
      resourceId: String(req.params.empId),
      details: { employee_name: emp.name },
      ip: req.ip,
    });

    res.json({ message: `PIN updated for ${emp.name}` });
  } catch (error) {
    console.error('Error updating employee PIN:', error);
    res.status(500).json({ error: 'Failed to update PIN' });
  }
});

// GET /admin/tenants/:id/kiosk-devices — list kiosk devices for a tenant
router.get('/tenants/:id/kiosk-devices', async (req, res) => {
  try {
    const tenant = await getTenant(req.params.id);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    const devices = await adminSql`
      SELECT id, name, bound_employee_id,
             bound_at, last_seen_at, client_version, client_platform, revoked_at
      FROM kiosk_devices
      WHERE tenant_id = ${tenant.id}
      ORDER BY revoked_at NULLS FIRST, bound_at DESC
    `;
    res.json({ devices });
  } catch (error) {
    console.error('Error listing kiosk devices:', error);
    res.status(500).json({ error: 'Failed to list kiosk devices' });
  }
});

// DELETE /admin/tenants/:id/kiosk-devices/:deviceId — revoke a device (soft)
router.delete('/tenants/:id/kiosk-devices/:deviceId', async (req, res) => {
  try {
    const tenant = await getTenant(req.params.id);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    const [row] = await adminSql`
      UPDATE kiosk_devices
      SET revoked_at = NOW()
      WHERE id = ${req.params.deviceId} AND tenant_id = ${tenant.id} AND revoked_at IS NULL
      RETURNING id, name
    `;
    if (!row) return res.status(404).json({ error: 'Device not found' });

    audit({
      tenantId: tenant.id,
      actorType: 'admin',
      actorId: 'super-admin',
      action: 'delete',
      resource: 'kiosk_device',
      resourceId: row.id,
      details: { device_name: row.name },
      ip: req.ip,
    });

    res.json({ message: `Device ${row.name} revoked` });
  } catch (error) {
    console.error('Error revoking kiosk device:', error);
    res.status(500).json({ error: 'Failed to revoke device' });
  }
});

export default router;
