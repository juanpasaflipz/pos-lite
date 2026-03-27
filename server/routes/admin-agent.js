import { Router } from 'express';
import { adminSql } from '../db/index.js';

const router = Router();

// Admin auth middleware
function requireAdmin(req, res, next) {
  const secret = req.headers['x-admin-secret'] || req.headers['authorization']?.replace('Bearer ', '');
  if (!process.env.ADMIN_SECRET || secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Invalid admin secret' });
  }
  next();
}

router.use(requireAdmin);

// ==================== Monitoring Rules ====================

// GET /admin/agent/monitor/rules
router.get('/monitor/rules', async (req, res) => {
  try {
    const rules = await adminSql`SELECT * FROM agent_monitor_rules ORDER BY created_at DESC`;
    res.json(rules);
  } catch (err) {
    console.error('[AdminAgent] List rules error:', err.message);
    res.status(500).json({ error: 'Failed to list monitoring rules' });
  }
});

// POST /admin/agent/monitor/rules
router.post('/monitor/rules', async (req, res) => {
  try {
    const { name, metric, condition, threshold, severity = 'warning', auto_action, cooldown_hours = 24 } = req.body;
    if (!name || !metric || !condition || threshold == null) {
      return res.status(400).json({ error: 'Required: name, metric, condition, threshold' });
    }

    const [rule] = await adminSql`
      INSERT INTO agent_monitor_rules (name, metric, condition, threshold, severity, auto_action, cooldown_hours)
      VALUES (${name}, ${metric}, ${condition}, ${threshold}, ${severity}, ${auto_action || null}, ${cooldown_hours})
      RETURNING *
    `;
    res.status(201).json(rule);
  } catch (err) {
    console.error('[AdminAgent] Create rule error:', err.message);
    res.status(500).json({ error: 'Failed to create rule' });
  }
});

// PATCH /admin/agent/monitor/rules/:id
router.patch('/monitor/rules/:id', async (req, res) => {
  try {
    const { name, metric, condition, threshold, severity, auto_action, cooldown_hours, enabled } = req.body;
    const [rule] = await adminSql`
      UPDATE agent_monitor_rules SET
        name = COALESCE(${name || null}, name),
        metric = COALESCE(${metric || null}, metric),
        condition = COALESCE(${condition || null}, condition),
        threshold = COALESCE(${threshold ?? null}, threshold),
        severity = COALESCE(${severity || null}, severity),
        auto_action = COALESCE(${auto_action || null}, auto_action),
        cooldown_hours = COALESCE(${cooldown_hours ?? null}, cooldown_hours),
        enabled = COALESCE(${enabled ?? null}, enabled)
      WHERE id = ${req.params.id}
      RETURNING *
    `;
    if (!rule) return res.status(404).json({ error: 'Rule not found' });
    res.json(rule);
  } catch (err) {
    console.error('[AdminAgent] Update rule error:', err.message);
    res.status(500).json({ error: 'Failed to update rule' });
  }
});

// DELETE /admin/agent/monitor/rules/:id
router.delete('/monitor/rules/:id', async (req, res) => {
  try {
    const [rule] = await adminSql`DELETE FROM agent_monitor_rules WHERE id = ${req.params.id} RETURNING id`;
    if (!rule) return res.status(404).json({ error: 'Rule not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[AdminAgent] Delete rule error:', err.message);
    res.status(500).json({ error: 'Failed to delete rule' });
  }
});

// ==================== Alerts ====================

// GET /admin/agent/alerts
router.get('/alerts', async (req, res) => {
  try {
    const { severity, acknowledged, limit = 50, offset = 0 } = req.query;

    let alerts;
    if (severity && acknowledged !== undefined) {
      alerts = await adminSql`
        SELECT * FROM agent_alerts
        WHERE severity = ${severity} AND acknowledged = ${acknowledged === 'true'}
        ORDER BY created_at DESC LIMIT ${Number(limit)} OFFSET ${Number(offset)}`;
    } else if (severity) {
      alerts = await adminSql`
        SELECT * FROM agent_alerts WHERE severity = ${severity}
        ORDER BY created_at DESC LIMIT ${Number(limit)} OFFSET ${Number(offset)}`;
    } else if (acknowledged !== undefined) {
      alerts = await adminSql`
        SELECT * FROM agent_alerts WHERE acknowledged = ${acknowledged === 'true'}
        ORDER BY created_at DESC LIMIT ${Number(limit)} OFFSET ${Number(offset)}`;
    } else {
      alerts = await adminSql`
        SELECT * FROM agent_alerts
        ORDER BY created_at DESC LIMIT ${Number(limit)} OFFSET ${Number(offset)}`;
    }

    res.json(alerts);
  } catch (err) {
    console.error('[AdminAgent] List alerts error:', err.message);
    res.status(500).json({ error: 'Failed to list alerts' });
  }
});

// PATCH /admin/agent/alerts/:id/acknowledge
router.patch('/alerts/:id/acknowledge', async (req, res) => {
  try {
    const [alert] = await adminSql`
      UPDATE agent_alerts SET acknowledged = true, acknowledged_at = NOW()
      WHERE id = ${req.params.id}
      RETURNING *
    `;
    if (!alert) return res.status(404).json({ error: 'Alert not found' });
    res.json(alert);
  } catch (err) {
    console.error('[AdminAgent] Acknowledge alert error:', err.message);
    res.status(500).json({ error: 'Failed to acknowledge alert' });
  }
});

// POST /admin/agent/monitor/run — manual monitoring sweep
router.post('/monitor/run', async (req, res) => {
  try {
    const alertCount = await runPlatformMonitoring();
    res.json({ ok: true, alerts_created: alertCount });
  } catch (err) {
    console.error('[AdminAgent] Manual run error:', err.message);
    res.status(500).json({ error: 'Failed to run monitoring' });
  }
});

// ==================== Sales Reps (admin management) ====================

// GET /admin/agent/sales-reps
router.get('/sales-reps', async (req, res) => {
  try {
    const reps = await adminSql`
      SELECT sr.id, sr.email, sr.name, sr.phone, sr.role, sr.active, sr.created_at,
        (SELECT COUNT(*) FROM leads WHERE assigned_rep_id = sr.id AND status = 'converted') AS conversions,
        (SELECT COUNT(*) FROM sales_commissions WHERE rep_id = sr.id AND active = true) AS active_clients
      FROM sales_reps sr ORDER BY sr.created_at DESC
    `;
    res.json(reps);
  } catch (err) {
    console.error('[AdminAgent] List sales reps error:', err.message);
    res.status(500).json({ error: 'Failed to list sales reps' });
  }
});

// ==================== Demo Config (admin) ====================

// GET /admin/agent/demo-config
router.get('/demo-config', async (req, res) => {
  try {
    const configs = await adminSql`
      SELECT dc.*, t.name AS tenant_name
      FROM demo_config dc JOIN tenants t ON t.id = dc.tenant_id
    `;
    res.json(configs);
  } catch (err) {
    console.error('[AdminAgent] Demo config error:', err.message);
    res.status(500).json({ error: 'Failed to get demo config' });
  }
});

/**
 * Platform monitoring — checks rules against live data.
 * Returns number of alerts created.
 */
async function runPlatformMonitoring() {
  const rules = await adminSql`SELECT * FROM agent_monitor_rules WHERE enabled = true`;
  let alertCount = 0;

  for (const rule of rules) {
    try {
      let violations = [];

      if (rule.metric === 'days_inactive') {
        // Find tenants with no orders in N days
        violations = await adminSql`
          SELECT t.id AS tenant_id, t.name,
            EXTRACT(DAY FROM NOW() - COALESCE(
              (SELECT MAX(created_at) FROM orders WHERE tenant_id = t.id),
              t.created_at
            ))::int AS value
          FROM tenants t WHERE t.active = true
          HAVING EXTRACT(DAY FROM NOW() - COALESCE(
            (SELECT MAX(created_at) FROM orders WHERE tenant_id = t.id),
            t.created_at
          )) ${adminSql.unsafe(rule.condition === 'gt' ? '>' : '<')} ${rule.threshold}
        `;
      } else if (rule.metric === 'revenue_change_pct') {
        // Revenue change: last 7d vs prior 7d
        violations = await adminSql`
          SELECT t.id AS tenant_id, t.name,
            CASE
              WHEN COALESCE(prior.rev, 0) = 0 THEN 0
              ELSE ((COALESCE(recent.rev, 0) - COALESCE(prior.rev, 0)) / prior.rev * 100)
            END AS value
          FROM tenants t
          LEFT JOIN (
            SELECT tenant_id, SUM(total) AS rev FROM orders
            WHERE created_at > NOW() - INTERVAL '7 days' GROUP BY tenant_id
          ) recent ON recent.tenant_id = t.id
          LEFT JOIN (
            SELECT tenant_id, SUM(total) AS rev FROM orders
            WHERE created_at BETWEEN NOW() - INTERVAL '14 days' AND NOW() - INTERVAL '7 days'
            GROUP BY tenant_id
          ) prior ON prior.tenant_id = t.id
          WHERE t.active = true AND t.plan = 'pro'
            AND CASE
              WHEN COALESCE(prior.rev, 0) = 0 THEN 0
              ELSE ((COALESCE(recent.rev, 0) - COALESCE(prior.rev, 0)) / prior.rev * 100)
            END ${adminSql.unsafe(rule.condition === 'lt' ? '<' : '>')} ${rule.threshold}
        `;
      } else if (rule.metric === 'days_no_orders') {
        // Pro tenants with no orders in N days
        violations = await adminSql`
          SELECT t.id AS tenant_id, t.name,
            EXTRACT(DAY FROM NOW() - COALESCE(
              (SELECT MAX(created_at) FROM orders WHERE tenant_id = t.id),
              t.created_at
            ))::int AS value
          FROM tenants t WHERE t.active = true AND t.plan = 'pro'
          HAVING EXTRACT(DAY FROM NOW() - COALESCE(
            (SELECT MAX(created_at) FROM orders WHERE tenant_id = t.id),
            t.created_at
          )) ${adminSql.unsafe(rule.condition === 'gt' ? '>' : '<')} ${rule.threshold}
        `;
      }

      for (const v of violations) {
        // Check cooldown
        const [recent] = await adminSql`
          SELECT id FROM agent_alerts
          WHERE alert_type = ${rule.metric} AND tenant_id = ${v.tenant_id}
            AND created_at > NOW() - INTERVAL '1 hour' * ${rule.cooldown_hours}
        `;
        if (recent) continue;

        // Create alert
        await adminSql`
          INSERT INTO agent_alerts (alert_type, severity, tenant_id, title, message, metadata, auto_action_taken)
          VALUES (
            ${rule.metric},
            ${rule.severity},
            ${v.tenant_id},
            ${`${rule.name}: ${v.name}`},
            ${`${rule.metric} = ${Math.round(v.value)} (threshold: ${rule.condition} ${rule.threshold})`},
            ${JSON.stringify({ value: v.value, rule_id: rule.id })},
            ${rule.auto_action || null}
          )
        `;
        alertCount++;

        // Execute auto-actions
        if (rule.auto_action === 'notify_sales_rep') {
          const [commission] = await adminSql`
            SELECT rep_id FROM sales_commissions WHERE tenant_id = ${v.tenant_id} AND active = true LIMIT 1
          `;
          if (commission) {
            await adminSql`
              INSERT INTO sales_activities (rep_id, tenant_id, activity_type, description)
              VALUES (${commission.rep_id}, ${v.tenant_id}, 'follow_up', ${`Auto-alert: ${rule.name} triggered for ${v.name}`})
            `;
          }
        }
      }
    } catch (ruleErr) {
      console.error(`[AdminAgent] Rule ${rule.name} error:`, ruleErr.message);
    }
  }

  return alertCount;
}

export { runPlatformMonitoring };
export default router;
