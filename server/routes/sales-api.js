import { Router } from 'express';
import bcrypt from 'bcrypt';
import { adminSql } from '../db/index.js';
import { requireSalesAuth } from '../middleware/salesAuth.js';
import { BCRYPT_ROUNDS } from '../lib/constants.js';

const router = Router();

// All routes require sales auth
router.use(requireSalesAuth());

// ==================== Leads ====================

// GET /api/sales/leads — own leads (managers: all)
router.get('/leads', async (req, res) => {
  try {
    const { status, limit = 50, offset = 0 } = req.query;
    const isManager = req.salesRep.role === 'manager';

    let leads;
    if (isManager) {
      leads = status
        ? await adminSql`
            SELECT l.*, sr.name AS rep_name
            FROM leads l LEFT JOIN sales_reps sr ON sr.id = l.assigned_rep_id
            WHERE l.status = ${status}
            ORDER BY l.created_at DESC LIMIT ${Number(limit)} OFFSET ${Number(offset)}`
        : await adminSql`
            SELECT l.*, sr.name AS rep_name
            FROM leads l LEFT JOIN sales_reps sr ON sr.id = l.assigned_rep_id
            ORDER BY l.created_at DESC LIMIT ${Number(limit)} OFFSET ${Number(offset)}`;
    } else {
      leads = status
        ? await adminSql`
            SELECT l.*, sr.name AS rep_name
            FROM leads l LEFT JOIN sales_reps sr ON sr.id = l.assigned_rep_id
            WHERE l.assigned_rep_id = ${req.salesRep.id} AND l.status = ${status}
            ORDER BY l.created_at DESC LIMIT ${Number(limit)} OFFSET ${Number(offset)}`
        : await adminSql`
            SELECT l.*, sr.name AS rep_name
            FROM leads l LEFT JOIN sales_reps sr ON sr.id = l.assigned_rep_id
            WHERE l.assigned_rep_id = ${req.salesRep.id}
            ORDER BY l.created_at DESC LIMIT ${Number(limit)} OFFSET ${Number(offset)}`;
    }

    res.json(leads);
  } catch (err) {
    console.error('[SalesAPI] List leads error:', err.message);
    res.status(500).json({ error: 'Failed to list leads' });
  }
});

// GET /api/sales/leads/:id
router.get('/leads/:id', async (req, res) => {
  try {
    const [lead] = await adminSql`
      SELECT l.*, sr.name AS rep_name
      FROM leads l LEFT JOIN sales_reps sr ON sr.id = l.assigned_rep_id
      WHERE l.id = ${req.params.id}
    `;
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    // Check ownership (non-managers can only see own leads)
    if (req.salesRep.role !== 'manager' && lead.assigned_rep_id !== req.salesRep.id) {
      return res.status(403).json({ error: 'Not your lead' });
    }

    const activities = await adminSql`
      SELECT sa.*, sr.name AS rep_name
      FROM sales_activities sa LEFT JOIN sales_reps sr ON sr.id = sa.rep_id
      WHERE sa.lead_id = ${req.params.id}
      ORDER BY sa.created_at DESC LIMIT 50
    `;

    res.json({ lead, activities });
  } catch (err) {
    console.error('[SalesAPI] Get lead error:', err.message);
    res.status(500).json({ error: 'Failed to get lead' });
  }
});

// POST /api/sales/leads — create lead
router.post('/leads', async (req, res) => {
  try {
    const { restaurant_name, name, email, phone, source = 'sales_rep', notes } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });

    const cleanEmail = email.trim().toLowerCase();
    const [existing] = await adminSql`SELECT id FROM leads WHERE email = ${cleanEmail}`;
    if (existing) return res.status(409).json({ error: 'Lead with this email already exists' });

    const [lead] = await adminSql`
      INSERT INTO leads (restaurant_name, name, email, phone, source, assigned_rep_id, status, notes)
      VALUES (${restaurant_name || null}, ${name || null}, ${cleanEmail}, ${phone || null}, ${source}, ${req.salesRep.id}, 'new', ${notes || null})
      RETURNING *
    `;

    res.status(201).json(lead);
  } catch (err) {
    console.error('[SalesAPI] Create lead error:', err.message);
    res.status(500).json({ error: 'Failed to create lead' });
  }
});

// PATCH /api/sales/leads/:id — update lead
router.patch('/leads/:id', async (req, res) => {
  try {
    const { status, notes, assigned_rep_id, last_contacted_at } = req.body;

    const [lead] = await adminSql`SELECT * FROM leads WHERE id = ${req.params.id}`;
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    if (req.salesRep.role !== 'manager' && lead.assigned_rep_id !== req.salesRep.id) {
      return res.status(403).json({ error: 'Not your lead' });
    }

    const [updated] = await adminSql`
      UPDATE leads SET
        status = COALESCE(${status || null}, status),
        notes = COALESCE(${notes || null}, notes),
        assigned_rep_id = COALESCE(${assigned_rep_id || null}, assigned_rep_id),
        last_contacted_at = COALESCE(${last_contacted_at || null}, last_contacted_at)
      WHERE id = ${req.params.id}
      RETURNING *
    `;

    res.json(updated);
  } catch (err) {
    console.error('[SalesAPI] Update lead error:', err.message);
    res.status(500).json({ error: 'Failed to update lead' });
  }
});

// POST /api/sales/leads/:id/activity — log activity
router.post('/leads/:id/activity', async (req, res) => {
  try {
    const { activity_type, description } = req.body;
    if (!activity_type) return res.status(400).json({ error: 'activity_type is required' });

    const [lead] = await adminSql`SELECT id, tenant_id FROM leads WHERE id = ${req.params.id}`;
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    const [activity] = await adminSql`
      INSERT INTO sales_activities (rep_id, lead_id, tenant_id, activity_type, description)
      VALUES (${req.salesRep.id}, ${lead.id}, ${lead.tenant_id || null}, ${activity_type}, ${description || null})
      RETURNING *
    `;

    // Update last_contacted_at
    await adminSql`UPDATE leads SET last_contacted_at = NOW() WHERE id = ${lead.id}`;

    res.status(201).json(activity);
  } catch (err) {
    console.error('[SalesAPI] Log activity error:', err.message);
    res.status(500).json({ error: 'Failed to log activity' });
  }
});

// ==================== Dashboard ====================

// GET /api/sales/dashboard — own KPIs
router.get('/dashboard', async (req, res) => {
  try {
    const repId = req.salesRep.id;

    const [leadCounts] = await adminSql`
      SELECT
        COUNT(*) FILTER (WHERE status = 'new') AS new_leads,
        COUNT(*) FILTER (WHERE status = 'contacted') AS contacted,
        COUNT(*) FILTER (WHERE status = 'demo_scheduled') AS demo_scheduled,
        COUNT(*) FILTER (WHERE status = 'negotiating') AS negotiating,
        COUNT(*) FILTER (WHERE status = 'converted') AS converted,
        COUNT(*) FILTER (WHERE status = 'lost') AS lost,
        COUNT(*) AS total
      FROM leads WHERE assigned_rep_id = ${repId}
    `;

    const [commissionTotals] = await adminSql`
      SELECT
        COALESCE(SUM(commission_amount) FILTER (WHERE status = 'earned'), 0) AS earned,
        COALESCE(SUM(commission_amount) FILTER (WHERE status = 'paid'), 0) AS paid,
        COALESCE(SUM(commission_amount), 0) AS total
      FROM commission_payouts WHERE rep_id = ${repId}
    `;

    const [activeClients] = await adminSql`
      SELECT COUNT(*) AS count FROM sales_commissions WHERE rep_id = ${repId} AND active = true
    `;

    const recentLeads = await adminSql`
      SELECT id, restaurant_name, name, email, status, created_at
      FROM leads WHERE assigned_rep_id = ${repId}
      ORDER BY created_at DESC LIMIT 5
    `;

    res.json({
      leads: leadCounts,
      commissions: commissionTotals,
      active_clients: Number(activeClients.count),
      recent_leads: recentLeads,
    });
  } catch (err) {
    console.error('[SalesAPI] Dashboard error:', err.message);
    res.status(500).json({ error: 'Failed to load dashboard' });
  }
});

// GET /api/sales/dashboard/team — manager: all reps' KPIs
router.get('/dashboard/team', requireSalesAuth(true), async (req, res) => {
  try {
    const reps = await adminSql`
      SELECT
        sr.id, sr.name, sr.email,
        COUNT(DISTINCT l.id) FILTER (WHERE l.status = 'converted') AS conversions,
        COUNT(DISTINCT l.id) AS total_leads,
        COALESCE(SUM(cp.commission_amount), 0) AS total_commissions,
        COUNT(DISTINCT sc.tenant_id) AS active_clients
      FROM sales_reps sr
      LEFT JOIN leads l ON l.assigned_rep_id = sr.id
      LEFT JOIN commission_payouts cp ON cp.rep_id = sr.id
      LEFT JOIN sales_commissions sc ON sc.rep_id = sr.id AND sc.active = true
      WHERE sr.active = true
      GROUP BY sr.id, sr.name, sr.email
      ORDER BY conversions DESC
    `;

    res.json(reps);
  } catch (err) {
    console.error('[SalesAPI] Team dashboard error:', err.message);
    res.status(500).json({ error: 'Failed to load team dashboard' });
  }
});

// GET /api/sales/leaderboard
router.get('/leaderboard', async (req, res) => {
  try {
    const leaderboard = await adminSql`
      SELECT
        sr.id, sr.name,
        COUNT(DISTINCT l.id) FILTER (WHERE l.status = 'converted') AS conversions,
        COUNT(DISTINCT sc.tenant_id) AS clients,
        COALESCE(SUM(cp.commission_amount), 0) AS total_earned
      FROM sales_reps sr
      LEFT JOIN leads l ON l.assigned_rep_id = sr.id
      LEFT JOIN sales_commissions sc ON sc.rep_id = sr.id AND sc.active = true
      LEFT JOIN commission_payouts cp ON cp.rep_id = sr.id
      WHERE sr.active = true
      GROUP BY sr.id, sr.name
      ORDER BY conversions DESC, total_earned DESC
    `;

    res.json(leaderboard);
  } catch (err) {
    console.error('[SalesAPI] Leaderboard error:', err.message);
    res.status(500).json({ error: 'Failed to load leaderboard' });
  }
});

// ==================== Commissions ====================

// GET /api/sales/commissions — own
router.get('/commissions', async (req, res) => {
  try {
    const payouts = await adminSql`
      SELECT cp.*, t.name AS tenant_name
      FROM commission_payouts cp
      JOIN tenants t ON t.id = cp.tenant_id
      WHERE cp.rep_id = ${req.salesRep.id}
      ORDER BY cp.created_at DESC LIMIT 100
    `;
    res.json(payouts);
  } catch (err) {
    console.error('[SalesAPI] Commissions error:', err.message);
    res.status(500).json({ error: 'Failed to load commissions' });
  }
});

// GET /api/sales/commissions/summary — own totals
router.get('/commissions/summary', async (req, res) => {
  try {
    const [summary] = await adminSql`
      SELECT
        COALESCE(SUM(commission_amount) FILTER (WHERE status = 'earned'), 0) AS pending,
        COALESCE(SUM(commission_amount) FILTER (WHERE status = 'paid'), 0) AS paid,
        COALESCE(SUM(commission_amount), 0) AS total
      FROM commission_payouts WHERE rep_id = ${req.salesRep.id}
    `;

    const activeCommissions = await adminSql`
      SELECT sc.*, t.name AS tenant_name
      FROM sales_commissions sc
      JOIN tenants t ON t.id = sc.tenant_id
      WHERE sc.rep_id = ${req.salesRep.id} AND sc.active = true
    `;

    res.json({ summary, active_commissions: activeCommissions });
  } catch (err) {
    console.error('[SalesAPI] Commission summary error:', err.message);
    res.status(500).json({ error: 'Failed to load commission summary' });
  }
});

// GET /api/sales/commissions/all — manager: all reps
router.get('/commissions/all', requireSalesAuth(true), async (req, res) => {
  try {
    const payouts = await adminSql`
      SELECT cp.*, t.name AS tenant_name, sr.name AS rep_name
      FROM commission_payouts cp
      JOIN tenants t ON t.id = cp.tenant_id
      JOIN sales_reps sr ON sr.id = cp.rep_id
      ORDER BY cp.created_at DESC LIMIT 200
    `;
    res.json(payouts);
  } catch (err) {
    console.error('[SalesAPI] All commissions error:', err.message);
    res.status(500).json({ error: 'Failed to load all commissions' });
  }
});

// PATCH /api/sales/commissions/:id/pay — manager: mark as paid
router.patch('/commissions/:id/pay', requireSalesAuth(true), async (req, res) => {
  try {
    const [payout] = await adminSql`
      UPDATE commission_payouts SET status = 'paid', paid_at = NOW()
      WHERE id = ${req.params.id} AND status = 'earned'
      RETURNING *
    `;
    if (!payout) return res.status(404).json({ error: 'Payout not found or already paid' });
    res.json(payout);
  } catch (err) {
    console.error('[SalesAPI] Pay commission error:', err.message);
    res.status(500).json({ error: 'Failed to mark commission as paid' });
  }
});

// ==================== Clients ====================

// GET /api/sales/clients — tenants this rep onboarded
router.get('/clients', async (req, res) => {
  try {
    const isManager = req.salesRep.role === 'manager';

    const clients = isManager
      ? await adminSql`
          SELECT sc.tenant_id, t.name, t.plan, t.active, t.created_at,
            sc.commission_percent, sc.start_date, sc.end_date,
            sr.name AS rep_name,
            (SELECT COUNT(*) FROM orders WHERE tenant_id = t.id AND created_at > NOW() - INTERVAL '30 days') AS orders_30d
          FROM sales_commissions sc
          JOIN tenants t ON t.id = sc.tenant_id
          JOIN sales_reps sr ON sr.id = sc.rep_id
          WHERE sc.active = true
          ORDER BY t.created_at DESC`
      : await adminSql`
          SELECT sc.tenant_id, t.name, t.plan, t.active, t.created_at,
            sc.commission_percent, sc.start_date, sc.end_date,
            (SELECT COUNT(*) FROM orders WHERE tenant_id = t.id AND created_at > NOW() - INTERVAL '30 days') AS orders_30d
          FROM sales_commissions sc
          JOIN tenants t ON t.id = sc.tenant_id
          WHERE sc.rep_id = ${req.salesRep.id} AND sc.active = true
          ORDER BY t.created_at DESC`;

    res.json(clients);
  } catch (err) {
    console.error('[SalesAPI] Clients error:', err.message);
    res.status(500).json({ error: 'Failed to load clients' });
  }
});

// GET /api/sales/clients/:tenantId — client health
router.get('/clients/:tenantId', async (req, res) => {
  try {
    const tenantId = req.params.tenantId;

    // Verify rep has access
    if (req.salesRep.role !== 'manager') {
      const [commission] = await adminSql`
        SELECT id FROM sales_commissions WHERE rep_id = ${req.salesRep.id} AND tenant_id = ${tenantId}
      `;
      if (!commission) return res.status(403).json({ error: 'Not your client' });
    }

    const [tenant] = await adminSql`SELECT id, name, plan, active, created_at FROM tenants WHERE id = ${tenantId}`;
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    const [stats] = await adminSql`
      SELECT
        (SELECT COUNT(*) FROM orders WHERE tenant_id = ${tenantId}) AS total_orders,
        (SELECT COALESCE(SUM(total), 0) FROM orders WHERE tenant_id = ${tenantId}) AS total_revenue,
        (SELECT COUNT(*) FROM orders WHERE tenant_id = ${tenantId} AND created_at > NOW() - INTERVAL '30 days') AS orders_30d,
        (SELECT COALESCE(SUM(total), 0) FROM orders WHERE tenant_id = ${tenantId} AND created_at > NOW() - INTERVAL '30 days') AS revenue_30d,
        (SELECT COUNT(*) FROM employees WHERE tenant_id = ${tenantId} AND active = true) AS employees,
        (SELECT COUNT(*) FROM menu_items WHERE tenant_id = ${tenantId} AND active = true) AS menu_items,
        (SELECT MAX(created_at) FROM orders WHERE tenant_id = ${tenantId}) AS last_order_at
    `;

    res.json({ tenant, stats });
  } catch (err) {
    console.error('[SalesAPI] Client detail error:', err.message);
    res.status(500).json({ error: 'Failed to load client details' });
  }
});

// ==================== Reps (manager only) ====================

// GET /api/sales/reps
router.get('/reps', requireSalesAuth(true), async (req, res) => {
  try {
    const reps = await adminSql`
      SELECT id, email, name, phone, role, active, created_at FROM sales_reps ORDER BY created_at DESC
    `;
    res.json(reps);
  } catch (err) {
    console.error('[SalesAPI] List reps error:', err.message);
    res.status(500).json({ error: 'Failed to list reps' });
  }
});

// POST /api/sales/reps
router.post('/reps', requireSalesAuth(true), async (req, res) => {
  try {
    const { email, password, name, phone, role = 'rep' } = req.body;
    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Required: email, password, name' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const [existing] = await adminSql`SELECT id FROM sales_reps WHERE email = ${cleanEmail}`;
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const [rep] = await adminSql`
      INSERT INTO sales_reps (email, password_hash, name, phone, role)
      VALUES (${cleanEmail}, ${hash}, ${name}, ${phone || null}, ${role})
      RETURNING id, email, name, phone, role, active, created_at
    `;

    res.status(201).json(rep);
  } catch (err) {
    console.error('[SalesAPI] Create rep error:', err.message);
    res.status(500).json({ error: 'Failed to create rep' });
  }
});

// PATCH /api/sales/reps/:id
router.patch('/reps/:id', requireSalesAuth(true), async (req, res) => {
  try {
    const { name, phone, role, active } = req.body;
    const [rep] = await adminSql`
      UPDATE sales_reps SET
        name = COALESCE(${name || null}, name),
        phone = COALESCE(${phone || null}, phone),
        role = COALESCE(${role || null}, role),
        active = COALESCE(${active ?? null}, active)
      WHERE id = ${req.params.id}
      RETURNING id, email, name, phone, role, active, created_at
    `;
    if (!rep) return res.status(404).json({ error: 'Rep not found' });
    res.json(rep);
  } catch (err) {
    console.error('[SalesAPI] Update rep error:', err.message);
    res.status(500).json({ error: 'Failed to update rep' });
  }
});

// POST /api/sales/reps/:id/reset-password
router.post('/reps/:id/reset-password', requireSalesAuth(true), async (req, res) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const [rep] = await adminSql`
      UPDATE sales_reps SET password_hash = ${hash} WHERE id = ${req.params.id}
      RETURNING id, email, name
    `;
    if (!rep) return res.status(404).json({ error: 'Rep not found' });
    res.json({ ok: true, message: `Password reset for ${rep.email}` });
  } catch (err) {
    console.error('[SalesAPI] Reset password error:', err.message);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

export default router;
