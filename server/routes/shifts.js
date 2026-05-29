import { Router } from 'express';
import bcrypt from 'bcrypt';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { all, get, getConn } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { audit } from '../lib/auditLog.js';

const router = Router();
const CASH_DENOMINATIONS = [1000, 500, 200, 100, 50, 20, 10, 5, 2, 1, 0.5];

const clockLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  keyGenerator: (req) => `clock:${ipKeyGenerator(req.ip)}:${req.tenant?.id || 'unknown'}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many clock attempts, please try again later' },
});

/**
 * Verify PIN against the employees table for the current tenant.
 * Returns the matched employee row, or null.
 */
async function findEmployeeByPin(pin) {
  if (!pin || typeof pin !== 'string') return null;
  const employees = await all(`
    SELECT id, name, role, pin, active
    FROM employees
    WHERE active = true
  `);
  for (const emp of employees) {
    if (await bcrypt.compare(pin, emp.pin)) {
      return emp;
    }
  }
  return null;
}

function shiftDurationSeconds(clockIn, clockOut) {
  if (!clockOut) return null;
  return Math.round((new Date(clockOut).getTime() - new Date(clockIn).getTime()) / 1000);
}

/**
 * Find the best unclaimed scheduled shift for an employee at the moment they
 * clock in. Match window: ±4 hours from scheduled start. Picks the closest.
 * Returns the scheduled_shift id, or null if no match.
 */
async function findMatchingScheduledShiftId(conn, employeeId, clockInAt) {
  const row = await one(conn,
    `SELECT ss.id
       FROM scheduled_shifts ss
       LEFT JOIN shifts s ON s.scheduled_shift_id = ss.id
      WHERE ss.employee_id = $1
        AND ss.starts_at BETWEEN $2::timestamptz - INTERVAL '4 hours'
                              AND $2::timestamptz + INTERVAL '4 hours'
        AND s.id IS NULL
      ORDER BY ABS(EXTRACT(EPOCH FROM (ss.starts_at - $2::timestamptz)))
      LIMIT 1`,
    [employeeId, clockInAt]
  );
  return row?.id || null;
}

function zeroCounts() {
  return Object.fromEntries(CASH_DENOMINATIONS.map((value) => [String(value), 0]));
}

function toMoney(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function normalizeCounts(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return null;
  }

  const counts = zeroCounts();
  for (const denomination of CASH_DENOMINATIONS) {
    const key = String(denomination);
    const raw = input[key];
    if (raw === undefined || raw === null || raw === '') continue;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
      return null;
    }
    counts[key] = value;
  }
  return counts;
}

function computeCountedTotal(counts) {
  return toMoney(
    Object.entries(counts || {}).reduce((sum, [denomination, count]) => {
      return sum + Number(denomination) * Number(count || 0);
    }, 0)
  );
}

async function one(conn, sql, params = []) {
  const rows = await conn.unsafe(sql, params);
  return rows[0] || undefined;
}

async function many(conn, sql, params = []) {
  const rows = await conn.unsafe(sql, params);
  return Array.from(rows);
}

function serializeCounts(counts) {
  return JSON.stringify(counts || zeroCounts());
}

async function ensureCashDrawerSession(conn, shift) {
  let cashDrawer = await getCashDrawerSession(conn, shift.id);
  if (cashDrawer) return cashDrawer;

  const openingCounts = zeroCounts();
  await conn.unsafe(
    `INSERT INTO cash_drawer_sessions (shift_id, employee_id, opening_counts, opening_total, opened_at)
     VALUES ($1, $2, $3::jsonb, 0, $4)`,
    [shift.id, shift.employee_id, serializeCounts(openingCounts), shift.clock_in_at]
  );
  return getCashDrawerSession(conn, shift.id);
}

function mapCashDrawerSession(row) {
  if (!row) return null;
  const openingCounts = normalizeCounts(row.opening_counts) || zeroCounts();
  const closingCounts = row.closing_counts ? (normalizeCounts(row.closing_counts) || zeroCounts()) : null;
  return {
    id: row.id,
    shift_id: row.shift_id,
    employee_id: row.employee_id,
    opened_at: row.opened_at,
    closed_at: row.closed_at,
    opening_counts: openingCounts,
    opening_total: toMoney(row.opening_total),
    closing_counts: closingCounts,
    closing_total: row.closing_total == null ? null : toMoney(row.closing_total),
    expected_cash_total: row.expected_cash_total == null ? null : toMoney(row.expected_cash_total),
    variance_total: row.variance_total == null ? null : toMoney(row.variance_total),
    variance_note: row.variance_note || null,
  };
}

async function getCashDrawerSession(conn, shiftId) {
  const row = await one(conn, 'SELECT * FROM cash_drawer_sessions WHERE shift_id = $1', [shiftId]);
  return mapCashDrawerSession(row);
}

async function getShiftCashSummary(conn, shift) {
  const endAt = shift.clock_out_at || new Date().toISOString();
  const row = await one(conn, `
    SELECT
      COALESCE((
        SELECT SUM(COALESCE(o.total, 0) + COALESCE(o.tip, 0))
        FROM orders o
        WHERE o.employee_id = $1
          AND o.payment_status = 'paid'
          AND o.payment_method = 'cash'
          AND o.created_at >= $2
          AND o.created_at <= $3
      ), 0) AS direct_cash_total,
      COALESCE((
        SELECT SUM(COALESCE(op.amount, 0) + COALESCE(op.tip, 0))
        FROM order_payments op
        JOIN orders o ON o.id = op.order_id
        WHERE o.employee_id = $1
          AND o.payment_method = 'split'
          AND op.payment_method = 'cash'
          AND op.status = 'paid'
          AND op.created_at >= $2
          AND op.created_at <= $3
      ), 0) AS split_cash_total
  `, [shift.employee_id, shift.clock_in_at, endAt]);

  const cashSalesTotal = toMoney(Number(row?.direct_cash_total || 0) + Number(row?.split_cash_total || 0));
  const openingTotal = toMoney(shift.cash_drawer?.opening_total || 0);

  return {
    opening_total: openingTotal,
    cash_sales_total: cashSalesTotal,
    expected_cash_total: toMoney(openingTotal + cashSalesTotal),
  };
}

async function attachCashDrawers(conn, shifts) {
  if (!shifts.length) return shifts;

  const sessionRows = await many(conn, 'SELECT * FROM cash_drawer_sessions WHERE shift_id = ANY($1::int[])', [
    shifts.map((shift) => shift.id),
  ]);
  const sessionMap = new Map(sessionRows.map((row) => [row.shift_id, mapCashDrawerSession(row)]));

  const enriched = [];
  for (const shift of shifts) {
    const cashDrawer = sessionMap.get(shift.id) || null;
    const withDrawer = { ...shift, cash_drawer: cashDrawer };
    if (cashDrawer) {
      const summary = await getShiftCashSummary(conn, withDrawer);
      withDrawer.cash_drawer = {
        ...cashDrawer,
        cash_sales_total: summary.cash_sales_total,
        expected_cash_total: cashDrawer.expected_cash_total == null
          ? summary.expected_cash_total
          : toMoney(cashDrawer.expected_cash_total),
      };
      withDrawer.cash_drawer_preview = summary;
    } else {
      withDrawer.cash_drawer_preview = {
        opening_total: 0,
        cash_sales_total: 0,
        expected_cash_total: 0,
      };
    }
    enriched.push(withDrawer);
  }

  return enriched;
}

/**
 * GET /api/shifts/me/cash-summary
 * Returns the running cash-drawer total for the authenticated employee's open
 * shift. Cashiers use this to see the expected drawer cash live during a shift
 * instead of waiting until close-out. Returns `has_open_shift: false` when
 * the employee is not currently clocked in.
 */
router.get('/me/cash-summary', requireAuth(), async (req, res) => {
  try {
    const conn = getConn();
    const openShift = await one(conn,
      `SELECT id, employee_id, clock_in_at, clock_out_at
         FROM shifts
        WHERE employee_id = $1 AND clock_out_at IS NULL
        ORDER BY clock_in_at DESC
        LIMIT 1`,
      [req.employee.id]
    );

    if (!openShift) {
      return res.json({ has_open_shift: false });
    }

    const cashDrawer = await getCashDrawerSession(conn, openShift.id);
    const summary = await getShiftCashSummary(conn, { ...openShift, cash_drawer: cashDrawer });

    res.json({
      has_open_shift: true,
      shift_id: openShift.id,
      opening_total: summary.opening_total,
      cash_sales_total: summary.cash_sales_total,
      expected_cash_total: summary.expected_cash_total,
    });
  } catch (error) {
    console.error('Cash summary error:', error);
    res.status(500).json({ error: 'Failed to load cash summary' });
  }
});

/**
 * POST /api/shifts/status — body: { pin }
 * Returns { employee, openShift|null } so the UI can decide whether to show
 * "Clock In" or "Clock Out" before the user commits.
 */
router.post('/status', clockLimiter, async (req, res) => {
  try {
    const { pin } = req.body || {};
    const employee = await findEmployeeByPin(pin);
    if (!employee) {
      return res.status(401).json({ error: 'Invalid PIN' });
    }

    const conn = getConn();
    const openShift = await one(conn,
      `SELECT id, clock_in_at, clock_out_at
       FROM shifts
       WHERE employee_id = $1 AND clock_out_at IS NULL
       ORDER BY clock_in_at DESC
       LIMIT 1`,
      [employee.id]
    );

    const shifts = await attachCashDrawers(conn, openShift ? [{ ...openShift, employee_id: employee.id }] : []);
    const decoratedOpenShift = shifts[0] || null;

    res.json({
      employee: { id: employee.id, name: employee.name, role: employee.role },
      openShift: decoratedOpenShift || null,
      supported_denominations: CASH_DENOMINATIONS,
    });
  } catch (error) {
    console.error('Shift status error:', error);
    res.status(500).json({ error: 'Failed to look up shift status' });
  }
});

/**
 * POST /api/shifts/clock-in — body: { pin }
 * Idempotent: if an open shift already exists for the employee, returns it
 * instead of creating a duplicate.
 */
router.post('/clock-in', clockLimiter, async (req, res) => {
  try {
    const { pin } = req.body || {};
    const employee = await findEmployeeByPin(pin);
    if (!employee) {
      return res.status(401).json({ error: 'Invalid PIN' });
    }

    const conn = getConn();
    const existing = await one(conn,
      `SELECT id, clock_in_at FROM shifts
       WHERE employee_id = $1 AND clock_out_at IS NULL
       ORDER BY clock_in_at DESC LIMIT 1`,
      [employee.id]
    );

    if (existing) {
      const [decoratedExisting] = await attachCashDrawers(conn, [{ ...existing, employee_id: employee.id, clock_out_at: null }]);
      return res.status(200).json({
        already_open: true,
        shift: decoratedExisting,
        employee: { id: employee.id, name: employee.name, role: employee.role },
        supported_denominations: CASH_DENOMINATIONS,
      });
    }

    const shift = await one(conn,
      `INSERT INTO shifts (employee_id) VALUES ($1)
       RETURNING id, employee_id, clock_in_at, clock_out_at`,
      [employee.id]
    );

    const scheduledId = await findMatchingScheduledShiftId(conn, employee.id, shift.clock_in_at);
    if (scheduledId) {
      await conn.unsafe('UPDATE shifts SET scheduled_shift_id = $1 WHERE id = $2', [scheduledId, shift.id]);
    }

    audit({
      tenantId: req.tenant?.id || 'default',
      actorType: 'employee',
      actorId: employee.id,
      action: 'clock_in',
      resource: 'shift',
      resourceId: shift.id,
      details: { ip: req.ip, scheduled_shift_id: scheduledId },
      ip: req.ip,
    });

    res.status(201).json({
      shift,
      employee: { id: employee.id, name: employee.name, role: employee.role },
    });
  } catch (error) {
    console.error('Clock-in error:', error);
    res.status(500).json({ error: 'Failed to clock in' });
  }
});

/**
 * POST /api/shifts/clock-out — body: { pin }
 * Closes the open shift. If none open, returns 409.
 */
router.post('/clock-out', clockLimiter, async (req, res) => {
  try {
    const { pin } = req.body || {};
    const employee = await findEmployeeByPin(pin);
    if (!employee) {
      return res.status(401).json({ error: 'Invalid PIN' });
    }

    const conn = getConn();
    const open = await one(conn,
      `SELECT id, clock_in_at FROM shifts
       WHERE employee_id = $1 AND clock_out_at IS NULL
       ORDER BY clock_in_at DESC LIMIT 1`,
      [employee.id]
    );

    if (!open) {
      return res.status(409).json({ error: 'No open shift to clock out from' });
    }

    const closed = await one(conn,
      `UPDATE shifts SET clock_out_at = NOW()
       WHERE id = $1
       RETURNING id, employee_id, clock_in_at, clock_out_at`,
      [open.id]
    );

    audit({
      tenantId: req.tenant?.id || 'default',
      actorType: 'employee',
      actorId: employee.id,
      action: 'clock_out',
      resource: 'shift',
      resourceId: closed.id,
      details: { ip: req.ip, duration_seconds: shiftDurationSeconds(closed.clock_in_at, closed.clock_out_at) },
      ip: req.ip,
    });

    res.json({
      shift: {
        ...closed,
        duration_seconds: shiftDurationSeconds(closed.clock_in_at, closed.clock_out_at),
      },
      employee: { id: employee.id, name: employee.name, role: employee.role },
    });
  } catch (error) {
    console.error('Clock-out error:', error);
    res.status(500).json({ error: 'Failed to clock out' });
  }
});

/**
 * POST /api/shifts/admin/clock-in — manager clocks an employee in by id.
 * Body: { employee_id }
 * Idempotent: if the employee already has an open shift, returns it instead.
 */
router.post('/admin/clock-in', requireAuth('manage_employees'), async (req, res) => {
  try {
    const employeeId = Number(req.body?.employee_id);
    if (!Number.isInteger(employeeId) || employeeId <= 0) {
      return res.status(400).json({ error: 'employee_id is required' });
    }

    const employee = await get(
      'SELECT id, name, role, active FROM employees WHERE id = $1',
      [employeeId]
    );
    if (!employee) {
      return res.status(404).json({ error: 'Employee not found' });
    }
    if (!employee.active) {
      return res.status(400).json({ error: 'Employee is inactive' });
    }

    const conn = getConn();
    const existing = await one(conn,
      `SELECT id, clock_in_at FROM shifts
       WHERE employee_id = $1 AND clock_out_at IS NULL
       ORDER BY clock_in_at DESC LIMIT 1`,
      [employee.id]
    );

    if (existing) {
      const [decoratedExisting] = await attachCashDrawers(conn, [{ ...existing, employee_id: employee.id, clock_out_at: null }]);
      return res.status(200).json({
        already_open: true,
        shift: decoratedExisting,
        employee: { id: employee.id, name: employee.name, role: employee.role },
      });
    }

    const shift = await one(conn,
      `INSERT INTO shifts (employee_id)
       VALUES ($1)
       RETURNING id, employee_id, clock_in_at, clock_out_at`,
      [employee.id]
    );

    const scheduledId = await findMatchingScheduledShiftId(conn, employee.id, shift.clock_in_at);
    if (scheduledId) {
      await conn.unsafe('UPDATE shifts SET scheduled_shift_id = $1 WHERE id = $2', [scheduledId, shift.id]);
    }

    audit({
      tenantId: req.tenant?.id || 'default',
      actorType: 'employee',
      actorId: req.employee.id,
      action: 'admin_clock_in',
      resource: 'shift',
      resourceId: shift.id,
      details: { target_employee_id: employee.id, ip: req.ip, scheduled_shift_id: scheduledId },
      ip: req.ip,
    });

    res.status(201).json({
      shift,
      employee: { id: employee.id, name: employee.name, role: employee.role },
    });
  } catch (error) {
    console.error('Admin clock-in error:', error);
    res.status(500).json({ error: 'Failed to clock in employee' });
  }
});

/**
 * POST /api/shifts/admin/clock-out — manager clocks an employee out by id.
 * Body: { employee_id }
 * Closes the employee's open shift. 409 if no open shift.
 */
router.post('/admin/clock-out', requireAuth('manage_employees'), async (req, res) => {
  try {
    const employeeId = Number(req.body?.employee_id);
    if (!Number.isInteger(employeeId) || employeeId <= 0) {
      return res.status(400).json({ error: 'employee_id is required' });
    }

    const employee = await get(
      'SELECT id, name, role FROM employees WHERE id = $1',
      [employeeId]
    );
    if (!employee) {
      return res.status(404).json({ error: 'Employee not found' });
    }

    const conn = getConn();
    const open = await one(conn,
      `SELECT id, clock_in_at FROM shifts
       WHERE employee_id = $1 AND clock_out_at IS NULL
       ORDER BY clock_in_at DESC LIMIT 1`,
      [employee.id]
    );

    if (!open) {
      return res.status(409).json({ error: 'No open shift to clock out from' });
    }

    const closed = await one(conn,
      `UPDATE shifts
         SET clock_out_at = NOW(),
             edited_by_employee_id = $1,
             edited_at = NOW()
       WHERE id = $2
       RETURNING id, employee_id, clock_in_at, clock_out_at`,
      [req.employee.id, open.id]
    );

    audit({
      tenantId: req.tenant?.id || 'default',
      actorType: 'employee',
      actorId: req.employee.id,
      action: 'admin_clock_out',
      resource: 'shift',
      resourceId: closed.id,
      details: {
        target_employee_id: employee.id,
        ip: req.ip,
        duration_seconds: shiftDurationSeconds(closed.clock_in_at, closed.clock_out_at),
      },
      ip: req.ip,
    });

    res.json({
      shift: {
        ...closed,
        duration_seconds: shiftDurationSeconds(closed.clock_in_at, closed.clock_out_at),
      },
      employee: { id: employee.id, name: employee.name, role: employee.role },
    });
  } catch (error) {
    console.error('Admin clock-out error:', error);
    res.status(500).json({ error: 'Failed to clock out employee' });
  }
});

/**
 * GET /api/shifts/active — manager view of who is currently on the clock.
 */
router.get('/active', requireAuth(), async (req, res) => {
  try {
    const rows = await all(`
      SELECT s.id, s.employee_id, s.clock_in_at, e.name AS employee_name, e.role AS employee_role,
             EXTRACT(EPOCH FROM (NOW() - s.clock_in_at))::INTEGER AS elapsed_seconds
      FROM shifts s
      JOIN employees e ON e.id = s.employee_id
      WHERE s.clock_out_at IS NULL
      ORDER BY s.clock_in_at ASC
    `);
    res.json(rows);
  } catch (error) {
    console.error('Active shifts error:', error);
    res.status(500).json({ error: 'Failed to load active shifts' });
  }
});

/**
 * GET /api/shifts — list shifts in a range (for payroll).
 *
 * Query: from=ISO date, to=ISO date, employee_id (optional).
 * Defaults to last 14 days.
 *
 * Each row includes duration_seconds (NULL if still open) and a `flagged`
 * boolean for shifts open >12h (forgot to clock out).
 */
router.get('/', requireAuth(), async (req, res) => {
  try {
    const conn = getConn();
    const to = req.query.to ? new Date(req.query.to) : new Date();
    const from = req.query.from
      ? new Date(req.query.from)
      : new Date(to.getTime() - 14 * 24 * 60 * 60 * 1000);
    const employeeId = req.query.employee_id ? Number(req.query.employee_id) : null;

    const params = [from.toISOString(), to.toISOString()];
    let where = 's.clock_in_at >= $1 AND s.clock_in_at < $2';
    if (employeeId) {
      params.push(employeeId);
      where += ` AND s.employee_id = $${params.length}`;
    }

    const rows = await many(conn, `
      SELECT s.id, s.employee_id, e.name AS employee_name, e.role AS employee_role,
             s.clock_in_at, s.clock_out_at, s.notes,
             s.edited_by_employee_id, s.edited_at,
             editor.name AS edited_by_name,
             s.scheduled_shift_id,
             ss.starts_at AS scheduled_start_at,
             ss.ends_at AS scheduled_end_at,
             CASE
               WHEN s.clock_out_at IS NOT NULL
                 THEN EXTRACT(EPOCH FROM (s.clock_out_at - s.clock_in_at))::INTEGER
               ELSE NULL
             END AS duration_seconds,
             CASE
               WHEN ss.id IS NOT NULL
                 THEN EXTRACT(EPOCH FROM (ss.ends_at - ss.starts_at))::INTEGER
               ELSE NULL
             END AS scheduled_seconds,
             (s.clock_out_at IS NULL AND s.clock_in_at < NOW() - INTERVAL '12 hours') AS flagged_long_open
      FROM shifts s
      JOIN employees e ON e.id = s.employee_id
      LEFT JOIN employees editor ON editor.id = s.edited_by_employee_id
      LEFT JOIN scheduled_shifts ss ON ss.id = s.scheduled_shift_id
      WHERE ${where}
      ORDER BY s.clock_in_at DESC
    `, params);

    res.json(await attachCashDrawers(conn, rows));
  } catch (error) {
    console.error('List shifts error:', error);
    res.status(500).json({ error: 'Failed to load shifts' });
  }
});

/**
 * PATCH /api/shifts/:id — manager edit.
 *
 * Body: { clock_in_at?, clock_out_at?, notes? }
 * Requires manage_employees permission. Records who edited and when.
 */
router.patch('/:id', requireAuth('manage_employees'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { clock_in_at, clock_out_at, notes } = req.body || {};

    const existing = await get('SELECT id FROM shifts WHERE id = $1', [id]);
    if (!existing) {
      return res.status(404).json({ error: 'Shift not found' });
    }

    const updates = [];
    const params = [];
    if (clock_in_at !== undefined) {
      params.push(clock_in_at);
      updates.push(`clock_in_at = $${params.length}`);
    }
    if (clock_out_at !== undefined) {
      params.push(clock_out_at);
      updates.push(`clock_out_at = $${params.length}`);
    }
    if (notes !== undefined) {
      params.push(notes);
      updates.push(`notes = $${params.length}`);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    params.push(req.employee.id);
    updates.push(`edited_by_employee_id = $${params.length}`);
    updates.push('edited_at = NOW()');

    params.push(id);
    const updated = await get(
      `UPDATE shifts SET ${updates.join(', ')} WHERE id = $${params.length}
       RETURNING id, employee_id, clock_in_at, clock_out_at, notes,
                 edited_by_employee_id, edited_at`,
      params
    );

    if (updated.clock_out_at && new Date(updated.clock_out_at) <= new Date(updated.clock_in_at)) {
      return res.status(400).json({ error: 'clock_out_at must be after clock_in_at' });
    }

    audit({
      tenantId: req.tenant?.id || 'default',
      actorType: 'employee',
      actorId: req.employee.id,
      action: 'shift_edit',
      resource: 'shift',
      resourceId: id,
      details: { changes: req.body },
      ip: req.ip,
    });

    res.json(updated);
  } catch (error) {
    console.error('Edit shift error:', error);
    res.status(500).json({ error: 'Failed to edit shift' });
  }
});

router.patch('/:id/cash-drawer', requireAuth('manage_employees'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { opening_counts, closing_counts, variance_note } = req.body || {};
    const conn = getConn();

    const shift = await one(conn,
      `SELECT id, employee_id, clock_in_at, clock_out_at
       FROM shifts
       WHERE id = $1`,
      [id]
    );
    if (!shift) {
      return res.status(404).json({ error: 'Shift not found' });
    }

    const hasOpening = opening_counts !== undefined;
    const hasClosing = closing_counts !== undefined;
    const hasNote = variance_note !== undefined;
    if (!hasOpening && !hasClosing && !hasNote) {
      return res.status(400).json({ error: 'No cash drawer fields to update' });
    }

    // Runs inside the tenant middleware's transaction on the reserved
    // connection. postgres.js reserved connections don't expose .begin(),
    // so we operate on `conn` directly; errors bubble to the catch below
    // and the middleware rollbacks the outer transaction on 5xx.
    const existingDrawer = await ensureCashDrawerSession(conn, shift);
    const nextOpeningCounts = hasOpening ? normalizeCounts(opening_counts) : existingDrawer.opening_counts;
    const nextClosingCounts = hasClosing ? normalizeCounts(closing_counts) : existingDrawer.closing_counts;
    const nextNote = hasNote
      ? (typeof variance_note === 'string' ? variance_note.trim() : '')
      : (existingDrawer.variance_note || '');

    if (hasOpening && !nextOpeningCounts) {
      return res.status(400).json({ error: 'Valid opening_counts are required' });
    }
    if (hasClosing && !nextClosingCounts) {
      return res.status(400).json({ error: 'Valid closing_counts are required' });
    }

    const openingTotal = computeCountedTotal(nextOpeningCounts || zeroCounts());
    const summary = await getShiftCashSummary(conn, {
      ...shift,
      cash_drawer: { ...existingDrawer, opening_total: openingTotal },
    });

    let closingTotal = null;
    let varianceTotal = null;
    let closedAt = existingDrawer.closed_at;
    if (nextClosingCounts) {
      closingTotal = computeCountedTotal(nextClosingCounts);
      varianceTotal = toMoney(closingTotal - summary.expected_cash_total);
      if (varianceTotal !== 0 && !nextNote) {
        return res.status(400).json({ error: 'variance_note is required when the closing count differs from expected cash' });
      }
      closedAt = shift.clock_out_at || existingDrawer.closed_at || new Date().toISOString();
    }

    await conn.unsafe(
      `UPDATE cash_drawer_sessions
       SET opening_counts = $1::jsonb,
           opening_total = $2,
           closing_counts = $3::jsonb,
           closing_total = $4,
           expected_cash_total = $5,
           variance_total = $6,
           variance_note = $7,
           closed_at = $8
       WHERE shift_id = $9`,
      [
        serializeCounts(nextOpeningCounts || zeroCounts()),
        openingTotal,
        nextClosingCounts ? serializeCounts(nextClosingCounts) : null,
        closingTotal,
        summary.expected_cash_total,
        varianceTotal,
        nextNote || null,
        closedAt,
        shift.id,
      ]
    );

    const [updatedShift] = await attachCashDrawers(conn, [shift]);

    audit({
      tenantId: req.tenant?.id || 'default',
      actorType: 'employee',
      actorId: req.employee.id,
      action: 'shift_cash_drawer_edit',
      resource: 'shift',
      resourceId: id,
      details: { changes: req.body },
      ip: req.ip,
    });

    res.json(updatedShift);
  } catch (error) {
    console.error('Cash drawer edit error:', error);
    const message = error instanceof Error ? error.message : '';
    if (/opening_counts|closing_counts|variance_note/i.test(message)) {
      return res.status(400).json({ error: message });
    }
    res.status(500).json({ error: 'Failed to update cash drawer' });
  }
});

/* ==================== Scheduled shifts ==================== */

/**
 * GET /api/shifts/scheduled?from=&to=&employee_id= — list scheduled shifts.
 * Defaults to this week. Returns the linked actual shift (if any) for variance.
 */
router.get('/scheduled', requireAuth(), async (req, res) => {
  try {
    const conn = getConn();
    const to = req.query.to ? new Date(req.query.to) : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const employeeId = req.query.employee_id ? Number(req.query.employee_id) : null;

    const params = [from.toISOString(), to.toISOString()];
    let where = 'ss.starts_at >= $1 AND ss.starts_at < $2';
    if (employeeId) {
      params.push(employeeId);
      where += ` AND ss.employee_id = $${params.length}`;
    }

    const rows = await many(conn, `
      SELECT ss.id, ss.employee_id, e.name AS employee_name, e.role AS employee_role,
             ss.starts_at, ss.ends_at, ss.notes,
             ss.created_by_employee_id, ss.created_at, ss.updated_at,
             EXTRACT(EPOCH FROM (ss.ends_at - ss.starts_at))::INTEGER AS scheduled_seconds,
             actual.id AS shift_id,
             actual.clock_in_at AS actual_clock_in_at,
             actual.clock_out_at AS actual_clock_out_at,
             CASE
               WHEN actual.clock_out_at IS NOT NULL
                 THEN EXTRACT(EPOCH FROM (actual.clock_out_at - actual.clock_in_at))::INTEGER
               ELSE NULL
             END AS actual_duration_seconds
      FROM scheduled_shifts ss
      JOIN employees e ON e.id = ss.employee_id
      LEFT JOIN shifts actual ON actual.scheduled_shift_id = ss.id
      WHERE ${where}
      ORDER BY ss.starts_at ASC
    `, params);

    res.json(rows);
  } catch (error) {
    console.error('List scheduled shifts error:', error);
    res.status(500).json({ error: 'Failed to load scheduled shifts' });
  }
});

/**
 * POST /api/shifts/scheduled — create a scheduled shift.
 * Body: { employee_id, starts_at, ends_at, notes? }
 */
router.post('/scheduled', requireAuth('manage_employees'), async (req, res) => {
  try {
    const { employee_id, starts_at, ends_at, notes } = req.body || {};
    const empId = Number(employee_id);
    if (!Number.isInteger(empId) || empId <= 0) {
      return res.status(400).json({ error: 'employee_id is required' });
    }
    if (!starts_at || !ends_at) {
      return res.status(400).json({ error: 'starts_at and ends_at are required' });
    }
    if (new Date(ends_at).getTime() <= new Date(starts_at).getTime()) {
      return res.status(400).json({ error: 'ends_at must be after starts_at' });
    }

    const employee = await get(
      'SELECT id, active FROM employees WHERE id = $1',
      [empId]
    );
    if (!employee) {
      return res.status(404).json({ error: 'Employee not found' });
    }

    const inserted = await get(
      `INSERT INTO scheduled_shifts (employee_id, starts_at, ends_at, notes, created_by_employee_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, employee_id, starts_at, ends_at, notes, created_by_employee_id, created_at, updated_at`,
      [empId, starts_at, ends_at, notes || null, req.employee.id]
    );

    audit({
      tenantId: req.tenant?.id || 'default',
      actorType: 'employee',
      actorId: req.employee.id,
      action: 'scheduled_shift_create',
      resource: 'scheduled_shift',
      resourceId: inserted.id,
      details: { employee_id: empId, starts_at, ends_at },
      ip: req.ip,
    });

    // Retroactive link: if the employee already clocked in within ±4h of this
    // scheduled start with no current link, hook it up.
    const conn = getConn();
    await conn.unsafe(`
      UPDATE shifts s
         SET scheduled_shift_id = $1
       WHERE s.id = (
         SELECT id FROM shifts
          WHERE employee_id = $2
            AND scheduled_shift_id IS NULL
            AND clock_in_at BETWEEN $3::timestamptz - INTERVAL '4 hours'
                                AND $3::timestamptz + INTERVAL '4 hours'
          ORDER BY ABS(EXTRACT(EPOCH FROM (clock_in_at - $3::timestamptz)))
          LIMIT 1
       )
    `, [inserted.id, empId, starts_at]);

    res.status(201).json(inserted);
  } catch (error) {
    console.error('Create scheduled shift error:', error);
    res.status(500).json({ error: 'Failed to create scheduled shift' });
  }
});

/**
 * PATCH /api/shifts/scheduled/:id — edit a scheduled shift.
 */
router.patch('/scheduled/:id', requireAuth('manage_employees'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { starts_at, ends_at, notes } = req.body || {};

    const existing = await get('SELECT id, starts_at, ends_at FROM scheduled_shifts WHERE id = $1', [id]);
    if (!existing) {
      return res.status(404).json({ error: 'Scheduled shift not found' });
    }

    const nextStart = starts_at ?? existing.starts_at;
    const nextEnd = ends_at ?? existing.ends_at;
    if (new Date(nextEnd).getTime() <= new Date(nextStart).getTime()) {
      return res.status(400).json({ error: 'ends_at must be after starts_at' });
    }

    const updates = [];
    const params = [];
    if (starts_at !== undefined) { params.push(starts_at); updates.push(`starts_at = $${params.length}`); }
    if (ends_at !== undefined)   { params.push(ends_at);   updates.push(`ends_at = $${params.length}`); }
    if (notes !== undefined)     { params.push(notes);     updates.push(`notes = $${params.length}`); }
    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }
    updates.push('updated_at = NOW()');
    params.push(id);

    const updated = await get(
      `UPDATE scheduled_shifts SET ${updates.join(', ')} WHERE id = $${params.length}
       RETURNING id, employee_id, starts_at, ends_at, notes, created_by_employee_id, created_at, updated_at`,
      params
    );

    audit({
      tenantId: req.tenant?.id || 'default',
      actorType: 'employee',
      actorId: req.employee.id,
      action: 'scheduled_shift_edit',
      resource: 'scheduled_shift',
      resourceId: id,
      details: { changes: req.body },
      ip: req.ip,
    });

    res.json(updated);
  } catch (error) {
    console.error('Edit scheduled shift error:', error);
    res.status(500).json({ error: 'Failed to edit scheduled shift' });
  }
});

/**
 * DELETE /api/shifts/scheduled/:id — remove a scheduled shift.
 * Any linked actual shift's scheduled_shift_id becomes NULL (ON DELETE SET NULL).
 */
router.delete('/scheduled/:id', requireAuth('manage_employees'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = await get('SELECT id, employee_id FROM scheduled_shifts WHERE id = $1', [id]);
    if (!existing) {
      return res.status(404).json({ error: 'Scheduled shift not found' });
    }

    await getConn().unsafe('DELETE FROM scheduled_shifts WHERE id = $1', [id]);

    audit({
      tenantId: req.tenant?.id || 'default',
      actorType: 'employee',
      actorId: req.employee.id,
      action: 'scheduled_shift_delete',
      resource: 'scheduled_shift',
      resourceId: id,
      details: { employee_id: existing.employee_id },
      ip: req.ip,
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Delete scheduled shift error:', error);
    res.status(500).json({ error: 'Failed to delete scheduled shift' });
  }
});

export default router;
