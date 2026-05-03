import { Router } from 'express';
import bcrypt from 'bcrypt';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { all, get, run } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { audit } from '../lib/auditLog.js';

const router = Router();

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

    const openShift = await get(
      `SELECT id, clock_in_at, clock_out_at
       FROM shifts
       WHERE employee_id = $1 AND clock_out_at IS NULL
       ORDER BY clock_in_at DESC
       LIMIT 1`,
      [employee.id]
    );

    res.json({
      employee: { id: employee.id, name: employee.name, role: employee.role },
      openShift: openShift || null,
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

    const existing = await get(
      `SELECT id, clock_in_at FROM shifts
       WHERE employee_id = $1 AND clock_out_at IS NULL
       ORDER BY clock_in_at DESC LIMIT 1`,
      [employee.id]
    );

    if (existing) {
      return res.status(200).json({
        already_open: true,
        shift: existing,
        employee: { id: employee.id, name: employee.name, role: employee.role },
      });
    }

    const shift = await get(
      `INSERT INTO shifts (employee_id) VALUES ($1)
       RETURNING id, clock_in_at, clock_out_at`,
      [employee.id]
    );

    audit({
      tenantId: req.tenant?.id || 'default',
      actorType: 'employee',
      actorId: employee.id,
      action: 'clock_in',
      resource: 'shift',
      resourceId: shift.id,
      details: { ip: req.ip },
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

    const open = await get(
      `SELECT id, clock_in_at FROM shifts
       WHERE employee_id = $1 AND clock_out_at IS NULL
       ORDER BY clock_in_at DESC LIMIT 1`,
      [employee.id]
    );

    if (!open) {
      return res.status(409).json({ error: 'No open shift to clock out from' });
    }

    const closed = await get(
      `UPDATE shifts SET clock_out_at = NOW()
       WHERE id = $1
       RETURNING id, clock_in_at, clock_out_at`,
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

    const rows = await all(`
      SELECT s.id, s.employee_id, e.name AS employee_name, e.role AS employee_role,
             s.clock_in_at, s.clock_out_at, s.notes,
             s.edited_by_employee_id, s.edited_at,
             editor.name AS edited_by_name,
             CASE
               WHEN s.clock_out_at IS NOT NULL
                 THEN EXTRACT(EPOCH FROM (s.clock_out_at - s.clock_in_at))::INTEGER
               ELSE NULL
             END AS duration_seconds,
             (s.clock_out_at IS NULL AND s.clock_in_at < NOW() - INTERVAL '12 hours') AS flagged_long_open
      FROM shifts s
      JOIN employees e ON e.id = s.employee_id
      LEFT JOIN employees editor ON editor.id = s.edited_by_employee_id
      WHERE ${where}
      ORDER BY s.clock_in_at DESC
    `, params);

    res.json(rows);
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

export default router;
