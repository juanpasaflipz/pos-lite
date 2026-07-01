import { Router } from 'express';
import { all, get, run, getTenantId } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { audit } from '../lib/auditLog.js';
import { tzDate } from '../lib/tz.js';

const router = Router();

// ---------- helpers ----------

/**
 * Compute the current weekly payroll period start (inclusive) and end
 * (exclusive) as YYYY-MM-DD strings, anchored to period_start_dow in tz.
 *
 * Why date strings: SQL compares with `(created_at AT TIME ZONE tz)::date`
 * elsewhere in the codebase (see reports.js getDateRange) — staying in the
 * same shape lets the query planner reuse the same index path.
 *
 * DOW convention: 0=Sun, 1=Mon, ..., 6=Sat (matches Postgres EXTRACT(DOW)).
 */
function currentWeeklyPeriod(tz, dow = 1) {
  const todayStr = tzDate(new Date(), tz);
  const [y, m, d] = todayStr.split('-').map(Number);
  const today = new Date(Date.UTC(y, m - 1, d));
  const todayDow = today.getUTCDay();
  const back = (todayDow - dow + 7) % 7;
  const start = new Date(today);
  start.setUTCDate(today.getUTCDate() - back);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 7);
  return {
    period_start: start.toISOString().slice(0, 10),
    period_end: end.toISOString().slice(0, 10),
  };
}

/** Add or subtract whole weeks from a YYYY-MM-DD date string. */
function shiftWeeks(dateStr, weeks) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + weeks * 7);
  return dt.toISOString().slice(0, 10);
}

function toCents(numeric) {
  return Math.round(Number(numeric || 0) * 100);
}

/** Load tenant payroll settings, lazy-creating defaults if absent. */
async function loadSettings() {
  let settings = await get('SELECT * FROM payroll_settings WHERE tenant_id = $1', [getTenantId()]);
  if (!settings) {
    await run('INSERT INTO payroll_settings (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING', [getTenantId()]);
    settings = await get('SELECT * FROM payroll_settings WHERE tenant_id = $1', [getTenantId()]);
  }
  return settings;
}

/**
 * Compute the payroll snapshot for [period_start, period_end) — used by both
 * the live view and the close-period workflow. Returns:
 *   {
 *     period_start, period_end,
 *     tip_policy,
 *     sales_cents,                  // subtotal of paid orders (excludes tip)
 *     tip_pool_cents,               // total tips collected in period
 *     overtime_threshold_hours,
 *     labor_warn_pct, labor_critical_pct,
 *     employees: [{
 *       employee_id, employee_name, employee_role,
 *       pay_type, hourly_rate_cents, weekly_salary_cents,
 *       hours_worked, hours_overtime, has_open_shift,
 *       base_pay_cents, tip_share_cents, total_cents,
 *     }],
 *     totals: { hours_worked, hours_overtime, base_pay_cents, tip_share_cents, total_cents, labor_pct_of_sales },
 *   }
 *
 * Tip allocation rules (matches CLAUDE.md decision: pool_by_hours default):
 *   - pool_by_hours: each emp gets (their_hours / sum_hours) * tip_pool
 *   - pool_equal: tip_pool / count(employees with hours > 0)
 *   - taker_keeps: SUM(orders.tip) where orders.employee_id = emp.id (in period)
 *   - house_keeps: every employee gets 0
 */
async function computeSnapshot({ period_start, period_end, tz }) {
  const settings = await loadSettings();
  const tipPolicy = settings.tip_policy;
  const otThreshold = Number(settings.overtime_threshold_hours);

  // Hours per employee — open shifts contribute (NOW() - clock_in_at).
  // GREATEST/LEAST clamps shifts that span the period boundary.
  const periodStartTs = `${period_start} 00:00:00`;
  const periodEndTs = `${period_end} 00:00:00`;
  const employees = await all(`
    SELECT
      e.id AS employee_id,
      e.name AS employee_name,
      e.role AS employee_role,
      e.pay_type,
      e.hourly_rate_cents,
      e.weekly_salary_cents,
      COALESCE(SUM(
        EXTRACT(EPOCH FROM (
          LEAST(COALESCE(s.clock_out_at, NOW()), ($2::timestamp AT TIME ZONE $3))
          - GREATEST(s.clock_in_at, ($1::timestamp AT TIME ZONE $3))
        )) / 3600.0
      ) FILTER (WHERE s.id IS NOT NULL), 0)::numeric(8,2) AS hours_worked,
      BOOL_OR(s.clock_out_at IS NULL) FILTER (WHERE s.id IS NOT NULL) AS has_open_shift
    FROM employees e
    LEFT JOIN shifts s
      ON s.employee_id = e.id
      AND s.clock_in_at < ($2::timestamp AT TIME ZONE $3)
      AND COALESCE(s.clock_out_at, NOW()) > ($1::timestamp AT TIME ZONE $3)
    WHERE e.active = true
    GROUP BY e.id, e.name, e.role, e.pay_type, e.hourly_rate_cents, e.weekly_salary_cents
    ORDER BY e.name ASC
  `, [periodStartTs, periodEndTs, tz]);

  // Period sales + tip pool (paid orders only).
  // Use COALESCE(paid_at, created_at) to match reports.js — attributes a
  // sale to the day money changed hands, not when an employee later
  // clicked "complete" (which can land on a different business day).
  const salesRow = await get(`
    SELECT
      COALESCE(SUM(subtotal), 0) AS sales_subtotal,
      COALESCE(SUM(tip), 0) AS tip_total
    FROM orders
    WHERE payment_status = 'paid'
      AND (COALESCE(paid_at, created_at) AT TIME ZONE $3)::date >= $1::date
      AND (COALESCE(paid_at, created_at) AT TIME ZONE $3)::date <  $2::date
  `, [period_start, period_end, tz]);
  const salesCents = toCents(salesRow.sales_subtotal);
  const tipPoolCents = toCents(salesRow.tip_total);

  // Per-taker tips for taker_keeps policy.
  let perTakerTips = new Map();
  if (tipPolicy === 'taker_keeps') {
    const rows = await all(`
      SELECT employee_id, COALESCE(SUM(tip), 0) AS tip_total
      FROM orders
      WHERE payment_status = 'paid'
        AND (COALESCE(paid_at, created_at) AT TIME ZONE $3)::date >= $1::date
        AND (COALESCE(paid_at, created_at) AT TIME ZONE $3)::date <  $2::date
      GROUP BY employee_id
    `, [period_start, period_end, tz]);
    for (const r of rows) perTakerTips.set(r.employee_id, toCents(r.tip_total));
  }

  const totalHours = employees.reduce((s, e) => s + Number(e.hours_worked || 0), 0);
  const employeesWithHours = employees.filter(e => Number(e.hours_worked) > 0).length;

  const enriched = employees.map(e => {
    const hours = Number(e.hours_worked || 0);
    const otHours = Math.max(0, hours - otThreshold);

    let basePayCents = 0;
    if (e.pay_type === 'hourly') {
      basePayCents = Math.round(hours * Number(e.hourly_rate_cents));
    } else if (e.pay_type === 'salary') {
      // V1: emit full weekly_salary if any hours logged; the operator can prorate
      // in their payroll provider if they want fractional weeks. Salaried staff
      // typically work the full week, so this is correct for the common case.
      basePayCents = hours > 0 ? Number(e.weekly_salary_cents) : 0;
    }
    // commission and no_pay: basePayCents = 0 — handled via tip share / external.

    let tipShareCents = 0;
    if (tipPolicy === 'pool_by_hours' && totalHours > 0) {
      tipShareCents = Math.round((hours / totalHours) * tipPoolCents);
    } else if (tipPolicy === 'pool_equal' && employeesWithHours > 0 && hours > 0) {
      tipShareCents = Math.round(tipPoolCents / employeesWithHours);
    } else if (tipPolicy === 'taker_keeps') {
      tipShareCents = perTakerTips.get(e.employee_id) || 0;
    } // house_keeps -> 0

    return {
      employee_id: e.employee_id,
      employee_name: e.employee_name,
      employee_role: e.employee_role,
      pay_type: e.pay_type,
      hourly_rate_cents: Number(e.hourly_rate_cents),
      weekly_salary_cents: Number(e.weekly_salary_cents),
      hours_worked: Number(hours.toFixed(2)),
      hours_overtime: Number(otHours.toFixed(2)),
      has_open_shift: !!e.has_open_shift,
      base_pay_cents: basePayCents,
      tip_share_cents: tipShareCents,
      total_cents: basePayCents + tipShareCents,
    };
  });

  const totals = enriched.reduce((acc, e) => {
    acc.hours_worked += e.hours_worked;
    acc.hours_overtime += e.hours_overtime;
    acc.base_pay_cents += e.base_pay_cents;
    acc.tip_share_cents += e.tip_share_cents;
    acc.total_cents += e.total_cents;
    return acc;
  }, { hours_worked: 0, hours_overtime: 0, base_pay_cents: 0, tip_share_cents: 0, total_cents: 0 });
  totals.hours_worked = Number(totals.hours_worked.toFixed(2));
  totals.hours_overtime = Number(totals.hours_overtime.toFixed(2));
  totals.labor_pct_of_sales = salesCents > 0
    ? Number(((totals.base_pay_cents / salesCents) * 100).toFixed(2))
    : null;

  return {
    period_start,
    period_end,
    tip_policy: tipPolicy,
    sales_cents: salesCents,
    tip_pool_cents: tipPoolCents,
    overtime_threshold_hours: otThreshold,
    labor_warn_pct: Number(settings.labor_warn_pct),
    labor_critical_pct: Number(settings.labor_critical_pct),
    employees: enriched,
    totals,
  };
}

// ---------- routes ----------

/**
 * GET /api/payroll/live
 * Current week snapshot — recomputes on every call (cheap enough; <50 rows).
 * Returns the same shape as /period but with the current Mon→Mon window.
 */
router.get('/live', requireAuth('manage_payroll'), async (req, res) => {
  try {
    const tz = req.tenant?.timezone || 'America/Mexico_City';
    const settings = await loadSettings();
    const { period_start, period_end } = currentWeeklyPeriod(tz, settings.period_start_dow);
    const snapshot = await computeSnapshot({ period_start, period_end, tz });
    res.json(snapshot);
  } catch (error) {
    console.error('Payroll live error:', error);
    res.status(500).json({ error: 'Failed to compute live payroll' });
  }
});

/**
 * GET /api/payroll/forecast?from=ISO&to=ISO
 * Cost of the scheduled_shifts in [from, to). For each scheduled hour we
 * apply the employee's current pay rate (hourly: hours × rate, salary: flat
 * weekly_salary if any hours scheduled, commission/no_pay: 0). Cheap enough
 * to recompute on every call.
 *
 * Defaults to next 7 days starting tomorrow if from/to omitted — answers
 * "what is next week going to cost?".
 */
router.get('/forecast', requireAuth('manage_payroll'), async (req, res) => {
  try {
    const now = new Date();
    const defaultFrom = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    defaultFrom.setHours(0, 0, 0, 0);
    const defaultTo = new Date(defaultFrom.getTime() + 7 * 24 * 60 * 60 * 1000);

    const from = req.query.from ? new Date(req.query.from) : defaultFrom;
    const to = req.query.to ? new Date(req.query.to) : defaultTo;

    const rows = await all(`
      SELECT
        ss.employee_id,
        e.name AS employee_name,
        e.role AS employee_role,
        e.pay_type,
        e.hourly_rate_cents,
        e.weekly_salary_cents,
        COALESCE(SUM(
          EXTRACT(EPOCH FROM (
            LEAST(ss.ends_at, $2::timestamptz) - GREATEST(ss.starts_at, $1::timestamptz)
          )) / 3600.0
        ) FILTER (WHERE ss.id IS NOT NULL), 0)::numeric(8,2) AS hours_scheduled
      FROM employees e
      LEFT JOIN scheduled_shifts ss
        ON ss.employee_id = e.id
        AND ss.starts_at < $2::timestamptz
        AND ss.ends_at > $1::timestamptz
      WHERE e.active = true
      GROUP BY e.id, e.name, e.role, e.pay_type, e.hourly_rate_cents, e.weekly_salary_cents
      HAVING COALESCE(SUM(
        EXTRACT(EPOCH FROM (
          LEAST(ss.ends_at, $2::timestamptz) - GREATEST(ss.starts_at, $1::timestamptz)
        )) / 3600.0
      ) FILTER (WHERE ss.id IS NOT NULL), 0) > 0
      ORDER BY e.name ASC
    `, [from.toISOString(), to.toISOString()]);

    const employees = rows.map(r => {
      const hours = Number(r.hours_scheduled || 0);
      let costCents = 0;
      if (r.pay_type === 'hourly') {
        costCents = Math.round(hours * Number(r.hourly_rate_cents));
      } else if (r.pay_type === 'salary') {
        costCents = hours > 0 ? Number(r.weekly_salary_cents) : 0;
      }
      return {
        employee_id: r.employee_id,
        employee_name: r.employee_name,
        employee_role: r.employee_role,
        pay_type: r.pay_type,
        hourly_rate_cents: Number(r.hourly_rate_cents),
        weekly_salary_cents: Number(r.weekly_salary_cents),
        hours_scheduled: Number(hours.toFixed(2)),
        cost_cents: costCents,
      };
    });

    const totals = employees.reduce((acc, e) => {
      acc.hours_scheduled += e.hours_scheduled;
      acc.cost_cents += e.cost_cents;
      return acc;
    }, { hours_scheduled: 0, cost_cents: 0 });
    totals.hours_scheduled = Number(totals.hours_scheduled.toFixed(2));

    res.json({
      from: from.toISOString(),
      to: to.toISOString(),
      employees,
      totals,
    });
  } catch (error) {
    console.error('Payroll forecast error:', error);
    res.status(500).json({ error: 'Failed to compute scheduled labor forecast' });
  }
});

/**
 * GET /api/payroll/period?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Arbitrary window for historical inspection. If the window matches a closed
 * payroll_periods row exactly, returns the frozen snapshot instead of
 * recomputing (so retroactive shift edits don't silently move closed totals).
 */
router.get('/period', requireAuth('manage_payroll'), async (req, res) => {
  try {
    const tz = req.tenant?.timezone || 'America/Mexico_City';
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ error: 'from and to required (YYYY-MM-DD)' });

    const closed = await get(
      `SELECT * FROM payroll_periods
       WHERE period_start = $1 AND period_end = $2 AND status = 'closed'`,
      [from, to]
    );
    if (closed) {
      const lines = await all(
        `SELECT * FROM payroll_period_lines WHERE period_id = $1 ORDER BY employee_name ASC`,
        [closed.id]
      );
      return res.json({
        period_start: closed.period_start,
        period_end: closed.period_end,
        frozen: true,
        closed_at: closed.closed_at,
        tip_policy: closed.tip_policy_snapshot,
        sales_cents: Number(closed.total_sales_cents),
        tip_pool_cents: Number(closed.total_tip_pool_cents),
        overtime_threshold_hours: null,
        labor_warn_pct: null,
        labor_critical_pct: null,
        employees: lines.map(l => ({
          employee_id: l.employee_id,
          employee_name: l.employee_name,
          employee_role: l.employee_role,
          pay_type: l.pay_type,
          hourly_rate_cents: Number(l.hourly_rate_cents),
          weekly_salary_cents: Number(l.weekly_salary_cents),
          hours_worked: Number(l.hours_worked),
          hours_overtime: Number(l.hours_overtime),
          has_open_shift: false,
          base_pay_cents: Number(l.base_pay_cents),
          tip_share_cents: Number(l.tip_share_cents),
          total_cents: Number(l.total_cents),
        })),
        totals: {
          hours_worked: Number(closed.total_hours),
          hours_overtime: Number(closed.total_overtime_hours),
          base_pay_cents: Number(closed.total_base_pay_cents),
          tip_share_cents: Number(closed.total_tip_pool_cents),
          total_cents: Number(closed.total_base_pay_cents) + Number(closed.total_tip_pool_cents),
          labor_pct_of_sales: closed.labor_pct_of_sales == null ? null : Number(closed.labor_pct_of_sales),
        },
      });
    }

    const snapshot = await computeSnapshot({ period_start: from, period_end: to, tz });
    res.json({ ...snapshot, frozen: false });
  } catch (error) {
    console.error('Payroll period error:', error);
    res.status(500).json({ error: 'Failed to compute period payroll' });
  }
});

/** GET /api/payroll/settings */
router.get('/settings', requireAuth('manage_payroll'), async (req, res) => {
  try {
    const s = await loadSettings();
    res.json({
      tip_policy: s.tip_policy,
      period_type: s.period_type,
      period_start_dow: s.period_start_dow,
      overtime_threshold_hours: Number(s.overtime_threshold_hours),
      labor_warn_pct: Number(s.labor_warn_pct),
      labor_critical_pct: Number(s.labor_critical_pct),
    });
  } catch (error) {
    console.error('Payroll settings get error:', error);
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

/** PUT /api/payroll/settings */
router.put('/settings', requireAuth('manage_payroll'), async (req, res) => {
  try {
    const allowedTip = ['taker_keeps', 'pool_by_hours', 'pool_equal', 'house_keeps'];
    const {
      tip_policy, period_start_dow, overtime_threshold_hours,
      labor_warn_pct, labor_critical_pct,
    } = req.body || {};

    if (tip_policy !== undefined && !allowedTip.includes(tip_policy)) {
      return res.status(400).json({ error: 'Invalid tip_policy' });
    }
    if (period_start_dow !== undefined && (period_start_dow < 0 || period_start_dow > 6)) {
      return res.status(400).json({ error: 'period_start_dow must be 0-6' });
    }
    if (overtime_threshold_hours !== undefined && (overtime_threshold_hours < 0 || overtime_threshold_hours > 168)) {
      return res.status(400).json({ error: 'overtime_threshold_hours must be 0-168' });
    }
    for (const [k, v] of [['labor_warn_pct', labor_warn_pct], ['labor_critical_pct', labor_critical_pct]]) {
      if (v !== undefined && (v < 0 || v > 100)) {
        return res.status(400).json({ error: `${k} must be 0-100` });
      }
    }

    await loadSettings(); // ensure row exists
    const updates = [];
    const params = [];
    const push = (col, val) => {
      if (val === undefined) return;
      params.push(val);
      updates.push(`${col} = $${params.length}`);
    };
    push('tip_policy', tip_policy);
    push('period_start_dow', period_start_dow);
    push('overtime_threshold_hours', overtime_threshold_hours);
    push('labor_warn_pct', labor_warn_pct);
    push('labor_critical_pct', labor_critical_pct);

    if (updates.length === 0) return res.json(await loadSettings());

    updates.push('updated_at = NOW()');
    params.push(getTenantId());
    await run(
      `UPDATE payroll_settings SET ${updates.join(', ')} WHERE tenant_id = $${params.length}`,
      params
    );
    audit({
      tenantId: req.tenant?.id || 'default',
      actorType: 'employee',
      actorId: req.employee.id,
      action: 'payroll_settings_update',
      resource: 'payroll_settings',
      resourceId: req.tenant?.id || 'default',
      details: { changes: req.body },
      ip: req.ip,
    });
    const s = await loadSettings();
    res.json({
      tip_policy: s.tip_policy,
      period_type: s.period_type,
      period_start_dow: s.period_start_dow,
      overtime_threshold_hours: Number(s.overtime_threshold_hours),
      labor_warn_pct: Number(s.labor_warn_pct),
      labor_critical_pct: Number(s.labor_critical_pct),
    });
  } catch (error) {
    console.error('Payroll settings update error:', error);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

/**
 * GET /api/payroll/employees/rates
 * List current pay rates so the Settings UI can render them.
 */
router.get('/employees/rates', requireAuth('manage_payroll'), async (req, res) => {
  try {
    const rows = await all(`
      SELECT id AS employee_id, name AS employee_name, role,
             pay_type, hourly_rate_cents, weekly_salary_cents
      FROM employees
      WHERE active = true
      ORDER BY name ASC
    `);
    res.json(rows.map(r => ({
      ...r,
      hourly_rate_cents: Number(r.hourly_rate_cents),
      weekly_salary_cents: Number(r.weekly_salary_cents),
    })));
  } catch (error) {
    console.error('Payroll rates list error:', error);
    res.status(500).json({ error: 'Failed to list rates' });
  }
});

/**
 * PATCH /api/payroll/employees/:id/rate
 * Body: { pay_type, hourly_rate_cents?, weekly_salary_cents?, note? }
 * Writes the denormalized current rate on employees AND appends a history row.
 */
router.patch('/employees/:id/rate', requireAuth('manage_payroll'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { pay_type, hourly_rate_cents = 0, weekly_salary_cents = 0, note } = req.body || {};
    const valid = ['hourly', 'salary', 'commission', 'no_pay'];
    if (!valid.includes(pay_type)) return res.status(400).json({ error: 'Invalid pay_type' });
    if (hourly_rate_cents < 0 || weekly_salary_cents < 0) {
      return res.status(400).json({ error: 'Rates must be non-negative' });
    }

    const emp = await get('SELECT id FROM employees WHERE id = $1 AND active = true', [id]);
    if (!emp) return res.status(404).json({ error: 'Employee not found' });

    // Tenant middleware already wraps the request in a transaction on the
    // reserved connection. Run statements directly via the run() helper —
    // reserved postgres.js connections do NOT expose .begin().
    await run(
      `UPDATE employees
       SET pay_type = $1, hourly_rate_cents = $2, weekly_salary_cents = $3
       WHERE id = $4`,
      [pay_type, hourly_rate_cents, weekly_salary_cents, id]
    );
    await run(
      `INSERT INTO employee_pay_rates
         (employee_id, pay_type, hourly_rate_cents, weekly_salary_cents, set_by_employee_id, note)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, pay_type, hourly_rate_cents, weekly_salary_cents, req.employee.id, note || null]
    );

    audit({
      tenantId: req.tenant?.id || 'default',
      actorType: 'employee',
      actorId: req.employee.id,
      action: 'payroll_rate_update',
      resource: 'employee',
      resourceId: String(id),
      details: { pay_type, hourly_rate_cents, weekly_salary_cents, note },
      ip: req.ip,
    });

    res.json({
      employee_id: id,
      pay_type,
      hourly_rate_cents,
      weekly_salary_cents,
    });
  } catch (error) {
    console.error('Payroll rate update error:', error);
    res.status(500).json({ error: 'Failed to update rate' });
  }
});

/**
 * GET /api/payroll/periods
 * List closed periods (most recent first), plus the current open week as a virtual row.
 */
router.get('/periods', requireAuth('manage_payroll'), async (req, res) => {
  try {
    const tz = req.tenant?.timezone || 'America/Mexico_City';
    const settings = await loadSettings();
    const current = currentWeeklyPeriod(tz, settings.period_start_dow);

    const closed = await all(`
      SELECT id, period_start, period_end, status, total_hours, total_overtime_hours,
             total_base_pay_cents, total_tip_pool_cents, total_sales_cents,
             labor_pct_of_sales, closed_at
      FROM payroll_periods
      WHERE status = 'closed'
      ORDER BY period_start DESC
      LIMIT 26
    `);

    res.json({
      current,
      closed: closed.map(p => ({
        id: p.id,
        period_start: p.period_start,
        period_end: p.period_end,
        status: p.status,
        total_hours: Number(p.total_hours),
        total_overtime_hours: Number(p.total_overtime_hours),
        total_base_pay_cents: Number(p.total_base_pay_cents),
        total_tip_pool_cents: Number(p.total_tip_pool_cents),
        total_sales_cents: Number(p.total_sales_cents),
        labor_pct_of_sales: p.labor_pct_of_sales == null ? null : Number(p.labor_pct_of_sales),
        closed_at: p.closed_at,
      })),
    });
  } catch (error) {
    console.error('Payroll periods list error:', error);
    res.status(500).json({ error: 'Failed to list periods' });
  }
});

/**
 * POST /api/payroll/periods/close
 * Body: { period_start, period_end }
 * Computes the snapshot once, inserts payroll_periods + lines, marks closed.
 * Idempotent: returns 409 if the window is already closed.
 */
router.post('/periods/close', requireAuth('manage_payroll'), async (req, res) => {
  try {
    const tz = req.tenant?.timezone || 'America/Mexico_City';
    const { period_start, period_end } = req.body || {};
    if (!period_start || !period_end) {
      return res.status(400).json({ error: 'period_start and period_end required' });
    }

    const existing = await get(
      `SELECT id, status FROM payroll_periods
       WHERE period_start = $1 AND period_end = $2`,
      [period_start, period_end]
    );
    if (existing && existing.status === 'closed') {
      return res.status(409).json({ error: 'Period already closed', period_id: existing.id });
    }

    // Guard: refuse to close a period that's still in the future or in progress.
    // We can close yesterday and earlier, not today's open week.
    const today = tzDate(new Date(), tz);
    if (period_end > today) {
      return res.status(400).json({ error: 'Cannot close a period that has not ended yet' });
    }

    const snapshot = await computeSnapshot({ period_start, period_end, tz });

    // Runs inside the tenant middleware's transaction on the reserved
    // connection; we use the helpers directly because postgres.js reserved
    // connections do not expose .begin().
    const inserted = await all(
      `INSERT INTO payroll_periods
         (period_start, period_end, status, total_hours, total_overtime_hours,
          total_base_pay_cents, total_tip_pool_cents, total_sales_cents,
          labor_pct_of_sales, tip_policy_snapshot, closed_by_employee_id, closed_at)
       VALUES ($1, $2, 'closed', $3, $4, $5, $6, $7, $8, $9, $10, NOW())
       ON CONFLICT (tenant_id, period_start, period_end)
       DO UPDATE SET
         status = 'closed',
         total_hours = EXCLUDED.total_hours,
         total_overtime_hours = EXCLUDED.total_overtime_hours,
         total_base_pay_cents = EXCLUDED.total_base_pay_cents,
         total_tip_pool_cents = EXCLUDED.total_tip_pool_cents,
         total_sales_cents = EXCLUDED.total_sales_cents,
         labor_pct_of_sales = EXCLUDED.labor_pct_of_sales,
         tip_policy_snapshot = EXCLUDED.tip_policy_snapshot,
         closed_by_employee_id = EXCLUDED.closed_by_employee_id,
         closed_at = NOW()
       RETURNING id`,
      [
        period_start, period_end,
        snapshot.totals.hours_worked, snapshot.totals.hours_overtime,
        snapshot.totals.base_pay_cents, snapshot.tip_pool_cents,
        snapshot.sales_cents,
        snapshot.totals.labor_pct_of_sales,
        snapshot.tip_policy,
        req.employee.id,
      ]
    );
    const periodId = inserted[0].id;

    await run(`DELETE FROM payroll_period_lines WHERE period_id = $1`, [periodId]);
    for (const e of snapshot.employees) {
      await run(
        `INSERT INTO payroll_period_lines
           (period_id, employee_id, employee_name, employee_role, pay_type,
            hourly_rate_cents, weekly_salary_cents, hours_worked, hours_overtime,
            base_pay_cents, tip_share_cents, total_cents)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          periodId, e.employee_id, e.employee_name, e.employee_role, e.pay_type,
          e.hourly_rate_cents, e.weekly_salary_cents,
          e.hours_worked, e.hours_overtime,
          e.base_pay_cents, e.tip_share_cents, e.total_cents,
        ]
      );
    }

    audit({
      tenantId: req.tenant?.id || 'default',
      actorType: 'employee',
      actorId: req.employee.id,
      action: 'payroll_period_close',
      resource: 'payroll_period',
      resourceId: String(periodId),
      details: { period_start, period_end, total_cents: snapshot.totals.total_cents },
      ip: req.ip,
    });

    res.status(201).json({ period_id: periodId, ...snapshot, frozen: true });
  } catch (error) {
    console.error('Payroll period close error:', error);
    res.status(500).json({ error: 'Failed to close period' });
  }
});

/**
 * GET /api/payroll/periods/:id/export.csv
 * Generic CSV with one row per employee — designed to be imported into
 * Runa / Worky / Aspel NOI. Columns are stable so operators can map once.
 */
router.get('/periods/:id/export.csv', requireAuth('manage_payroll'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const period = await get(`SELECT * FROM payroll_periods WHERE id = $1`, [id]);
    if (!period) return res.status(404).json({ error: 'Period not found' });
    const lines = await all(
      `SELECT * FROM payroll_period_lines WHERE period_id = $1 ORDER BY employee_name ASC`,
      [id]
    );

    const header = [
      'employee_id', 'employee_name', 'role', 'pay_type',
      'hours_worked', 'hours_overtime',
      'hourly_rate', 'weekly_salary',
      'base_pay', 'tip_share', 'total',
    ];
    const escape = (s) => {
      const v = s == null ? '' : String(s);
      return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    };
    const fmtMoney = (cents) => (Number(cents || 0) / 100).toFixed(2);
    const rows = lines.map(l => [
      l.employee_id, l.employee_name, l.employee_role || '', l.pay_type,
      Number(l.hours_worked).toFixed(2), Number(l.hours_overtime).toFixed(2),
      fmtMoney(l.hourly_rate_cents), fmtMoney(l.weekly_salary_cents),
      fmtMoney(l.base_pay_cents), fmtMoney(l.tip_share_cents), fmtMoney(l.total_cents),
    ]);
    const csv = [header.join(','), ...rows.map(r => r.map(escape).join(','))].join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="payroll_${period.period_start}_${period.period_end}.csv"`
    );
    res.send(csv);
  } catch (error) {
    console.error('Payroll export error:', error);
    res.status(500).json({ error: 'Failed to export period' });
  }
});

// ---------- helpers for callers outside this file ----------
export { currentWeeklyPeriod, shiftWeeks, computeSnapshot };

export default router;
