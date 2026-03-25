import { Router } from 'express';
import { all, get, run, getTenantId } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

const VALID_PAYMENT_METHODS = ['cash', 'transfer', 'check'];
const VALID_WAGE_TYPES = ['hourly', 'salary'];
const VALID_PAY_FREQUENCIES = ['weekly', 'biweekly', 'monthly'];

// GET /api/payroll — list payments with optional filters
router.get('/', requireAuth('view_reports'), async (req, res) => {
  try {
    const { from, to, employee_id } = req.query;

    let query = `
      SELECT pp.*, e.name as employee_name, cb.name as created_by_name
      FROM payroll_payments pp
      LEFT JOIN employees e ON pp.employee_id = e.id
      LEFT JOIN employees cb ON pp.created_by = cb.id
    `;
    const conditions = [];
    const params = [];

    if (from) {
      params.push(from);
      conditions.push(`pp.payment_date >= $${params.length}`);
    }
    if (to) {
      params.push(to);
      conditions.push(`pp.payment_date <= $${params.length}`);
    }
    if (employee_id) {
      params.push(employee_id);
      conditions.push(`pp.employee_id = $${params.length}`);
    }

    if (conditions.length) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY pp.payment_date DESC, pp.created_at DESC';

    const payments = await all(query, params);
    res.json(payments);
  } catch (err) {
    console.error('[Payroll] List error:', err.message);
    res.status(500).json({ error: 'Failed to fetch payroll payments' });
  }
});

// GET /api/payroll/summary — totals for date range
router.get('/summary', requireAuth('view_reports'), async (req, res) => {
  try {
    const { from, to } = req.query;
    const conditions = [];
    const params = [];

    if (from) {
      params.push(from);
      conditions.push(`payment_date >= $${params.length}`);
    }
    if (to) {
      params.push(to);
      conditions.push(`payment_date <= $${params.length}`);
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const row = await get(`
      SELECT
        COALESCE(SUM(gross_amount), 0) as total_gross,
        COALESCE(SUM(deductions), 0) as total_deductions,
        COALESCE(SUM(bonuses), 0) as total_bonuses,
        COALESCE(SUM(net_amount), 0) as total_net,
        COUNT(DISTINCT employee_id) as employees_paid
      FROM payroll_payments ${where}
    `, params);

    res.json(row);
  } catch (err) {
    console.error('[Payroll] Summary error:', err.message);
    res.status(500).json({ error: 'Failed to fetch payroll summary' });
  }
});

// GET /api/payroll/employees — active employees with wage config
router.get('/employees', requireAuth('view_reports'), async (req, res) => {
  try {
    const employees = await all(`
      SELECT id, name, role, wage_type, wage_rate, pay_frequency, hire_date
      FROM employees
      WHERE active = true
      ORDER BY name ASC
    `);
    res.json(employees);
  } catch (err) {
    console.error('[Payroll] Employees error:', err.message);
    res.status(500).json({ error: 'Failed to fetch employees' });
  }
});

// POST /api/payroll — create payment
router.post('/', requireAuth('manage_payroll'), async (req, res) => {
  try {
    const { employee_id, pay_period_start, pay_period_end, hours_worked, gross_amount, deductions, bonuses, net_amount, payment_method, payment_date, notes } = req.body;

    if (!employee_id) return res.status(400).json({ error: 'employee_id is required' });
    if (!pay_period_start || !pay_period_end) return res.status(400).json({ error: 'pay period dates are required' });
    if (!payment_date) return res.status(400).json({ error: 'payment_date is required' });
    if (gross_amount == null || gross_amount < 0) return res.status(400).json({ error: 'gross_amount must be >= 0' });
    if (payment_method && !VALID_PAYMENT_METHODS.includes(payment_method)) {
      return res.status(400).json({ error: `payment_method must be one of: ${VALID_PAYMENT_METHODS.join(', ')}` });
    }

    const tenantId = getTenantId();
    const createdBy = req.employee?.id || null;

    const result = await get(
      `INSERT INTO payroll_payments (tenant_id, employee_id, pay_period_start, pay_period_end, hours_worked, gross_amount, deductions, bonuses, net_amount, payment_method, payment_date, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING *`,
      [tenantId, employee_id, pay_period_start, pay_period_end, hours_worked || null, gross_amount, deductions || 0, bonuses || 0, net_amount || 0, payment_method || 'cash', payment_date, notes || null, createdBy]
    );

    res.json(result);
  } catch (err) {
    console.error('[Payroll] Create error:', err.message);
    res.status(500).json({ error: 'Failed to create payroll payment' });
  }
});

// PUT /api/payroll/:id — update payment
router.put('/:id', requireAuth('manage_payroll'), async (req, res) => {
  try {
    const { id } = req.params;
    const { employee_id, pay_period_start, pay_period_end, hours_worked, gross_amount, deductions, bonuses, net_amount, payment_method, payment_date, notes } = req.body;

    const existing = await get('SELECT id FROM payroll_payments WHERE id = $1', [id]);
    if (!existing) return res.status(404).json({ error: 'Payment not found' });

    if (payment_method && !VALID_PAYMENT_METHODS.includes(payment_method)) {
      return res.status(400).json({ error: `payment_method must be one of: ${VALID_PAYMENT_METHODS.join(', ')}` });
    }

    const result = await get(
      `UPDATE payroll_payments SET
        employee_id = COALESCE($1, employee_id),
        pay_period_start = COALESCE($2, pay_period_start),
        pay_period_end = COALESCE($3, pay_period_end),
        hours_worked = $4,
        gross_amount = COALESCE($5, gross_amount),
        deductions = COALESCE($6, deductions),
        bonuses = COALESCE($7, bonuses),
        net_amount = COALESCE($8, net_amount),
        payment_method = COALESCE($9, payment_method),
        payment_date = COALESCE($10, payment_date),
        notes = $11,
        updated_at = NOW()
      WHERE id = $12
      RETURNING *`,
      [employee_id || null, pay_period_start || null, pay_period_end || null, hours_worked ?? null, gross_amount ?? null, deductions ?? null, bonuses ?? null, net_amount ?? null, payment_method || null, payment_date || null, notes ?? null, id]
    );

    res.json(result);
  } catch (err) {
    console.error('[Payroll] Update error:', err.message);
    res.status(500).json({ error: 'Failed to update payroll payment' });
  }
});

// DELETE /api/payroll/:id — delete payment
router.delete('/:id', requireAuth('manage_payroll'), async (req, res) => {
  try {
    const { id } = req.params;

    const existing = await get('SELECT id FROM payroll_payments WHERE id = $1', [id]);
    if (!existing) return res.status(404).json({ error: 'Payment not found' });

    await run('DELETE FROM payroll_payments WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('[Payroll] Delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete payroll payment' });
  }
});

// PUT /api/payroll/employee-wage/:id — update employee wage config
router.put('/employee-wage/:id', requireAuth('manage_payroll'), async (req, res) => {
  try {
    const { id } = req.params;
    const { wage_type, wage_rate, pay_frequency, hire_date } = req.body;

    const existing = await get('SELECT id FROM employees WHERE id = $1', [id]);
    if (!existing) return res.status(404).json({ error: 'Employee not found' });

    if (wage_type && !VALID_WAGE_TYPES.includes(wage_type)) {
      return res.status(400).json({ error: `wage_type must be one of: ${VALID_WAGE_TYPES.join(', ')}` });
    }
    if (pay_frequency && !VALID_PAY_FREQUENCIES.includes(pay_frequency)) {
      return res.status(400).json({ error: `pay_frequency must be one of: ${VALID_PAY_FREQUENCIES.join(', ')}` });
    }

    const result = await get(
      `UPDATE employees SET
        wage_type = COALESCE($1, wage_type),
        wage_rate = COALESCE($2, wage_rate),
        pay_frequency = COALESCE($3, pay_frequency),
        hire_date = $4
      WHERE id = $5
      RETURNING id, name, role, wage_type, wage_rate, pay_frequency, hire_date`,
      [wage_type || null, wage_rate ?? null, pay_frequency || null, hire_date ?? null, id]
    );

    res.json(result);
  } catch (err) {
    console.error('[Payroll] Wage config error:', err.message);
    res.status(500).json({ error: 'Failed to update wage config' });
  }
});

// GET /api/payroll/export — CSV export
router.get('/export', requireAuth('view_reports'), async (req, res) => {
  try {
    const { from, to } = req.query;

    let query = `
      SELECT pp.*, e.name as employee_name
      FROM payroll_payments pp
      LEFT JOIN employees e ON pp.employee_id = e.id
    `;
    const conditions = [];
    const params = [];

    if (from) {
      params.push(from);
      conditions.push(`pp.payment_date >= $${params.length}`);
    }
    if (to) {
      params.push(to);
      conditions.push(`pp.payment_date <= $${params.length}`);
    }

    if (conditions.length) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY pp.payment_date ASC';

    const payments = await all(query, params);

    const headers = ['Employee', 'Period Start', 'Period End', 'Hours Worked', 'Gross', 'Deductions', 'Bonuses', 'Net', 'Method', 'Payment Date', 'Notes'];
    const rows = payments.map(p => [
      csvEscape(p.employee_name || ''),
      p.pay_period_start?.toISOString?.().slice(0, 10) || p.pay_period_start,
      p.pay_period_end?.toISOString?.().slice(0, 10) || p.pay_period_end,
      p.hours_worked || '',
      p.gross_amount,
      p.deductions,
      p.bonuses,
      p.net_amount,
      p.payment_method || '',
      p.payment_date?.toISOString?.().slice(0, 10) || p.payment_date,
      csvEscape(p.notes || ''),
    ]);

    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="payroll-${from || 'all'}-${to || 'all'}.csv"`);
    res.send(csv);
  } catch (err) {
    console.error('[Payroll] Export error:', err.message);
    res.status(500).json({ error: 'Failed to export payroll' });
  }
});

function csvEscape(str) {
  if (!str) return '';
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export default router;
