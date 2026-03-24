import { Router } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { all, get, run, getTenantId } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { checkLimit, planUpgradeError } from '../planLimits.js';
import { audit } from '../lib/auditLog.js';
import { sendPinEmail, sendSecurityAlertEmail } from '../helpers/email.js';
import { BCRYPT_ROUNDS, JWT_SECRET } from '../lib/constants.js';

// ---------------------------------------------------------------------------
// Brute-force protection: per-IP+tenant lockout with exponential backoff
// ---------------------------------------------------------------------------
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 30 * 60 * 1000; // 30 minutes
const BACKOFF_DELAYS = [0, 0, 1000, 2000, 5000]; // delays after 1st–5th attempt

// Map key: `${ip}:${tenantId}` → { attempts, firstAttempt, lockedUntil }
const loginAttempts = new Map();

// Cleanup stale entries every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of loginAttempts) {
    if (entry.lockedUntil && now > entry.lockedUntil) {
      loginAttempts.delete(key);
    } else if (now - entry.firstAttempt > LOCKOUT_DURATION_MS) {
      loginAttempts.delete(key);
    }
  }
}, 10 * 60 * 1000);

function getAttemptKey(req) {
  return `${req.ip}:${req.tenant?.id || 'unknown'}`;
}

function checkLockout(req) {
  const key = getAttemptKey(req);
  const entry = loginAttempts.get(key);
  if (!entry) return { locked: false, attempts: 0 };
  if (entry.lockedUntil) {
    const remaining = entry.lockedUntil - Date.now();
    if (remaining > 0) {
      return { locked: true, retryAfterMs: remaining, attempts: entry.attempts };
    }
    // Lockout expired — clear it
    loginAttempts.delete(key);
    return { locked: false, attempts: 0 };
  }
  return { locked: false, attempts: entry.attempts };
}

function recordFailedAttempt(req) {
  const key = getAttemptKey(req);
  const entry = loginAttempts.get(key) || { attempts: 0, firstAttempt: Date.now(), lockedUntil: null };
  entry.attempts += 1;
  if (entry.attempts >= MAX_FAILED_ATTEMPTS) {
    entry.lockedUntil = Date.now() + LOCKOUT_DURATION_MS;
  }
  loginAttempts.set(key, entry);
  return entry;
}

function clearAttempts(req) {
  loginAttempts.delete(getAttemptKey(req));
}

const pinLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => `pin-login:${ipKeyGenerator(req.ip)}:${req.tenant?.id || 'unknown'}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, please try again later' },
});

const router = Router();

// GET /api/employees - list employees
router.get('/', async (req, res) => {
  try {
    const employees = await all(`
      SELECT id, name, role, active, created_at
      FROM employees
      ORDER BY name ASC
    `);

    res.json(employees);
  } catch (error) {
    console.error('Error fetching employees:', error);
    res.status(500).json({ error: 'Failed to fetch employees' });
  }
});

// POST /api/employees - create employee
router.post('/', async (req, res) => {
  try {
    const { name, pin, role = 'cashier' } = req.body;

    if (!name || !pin) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const validRoles = ['admin', 'cashier', 'manager', 'kitchen', 'bar'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    // Plan limit check
    const plan = req.tenant?.plan || 'free';
    const { cnt } = await get('SELECT COUNT(*) as cnt FROM employees WHERE active = true') || { cnt: 0 };
    const check = checkLimit(plan, 'employees', cnt);
    if (!check.allowed) {
      return res.status(403).json(planUpgradeError('employees', plan, { limit: check.limit, current: check.current }));
    }

    const hashedPin = await bcrypt.hash(pin, BCRYPT_ROUNDS);

    const tid = getTenantId();
    const result = await run(`
      INSERT INTO employees (tenant_id, name, pin, role, active)
      VALUES ($1, $2, $3, $4, true)
    `, [tid, name, hashedPin, role]);

    audit({
      tenantId: req.tenant?.id || 'default',
      actorType: 'employee',
      actorId: req.headers['x-employee-id'] || 'unknown',
      action: 'create',
      resource: 'employee',
      resourceId: String(result.lastInsertRowid),
      ip: req.ip,
    });

    // Fire-and-forget PIN email if the name looks like an email
    if (name.includes('@')) {
      sendPinEmail(name, pin, req.tenant?.name || 'Desktop Kitchen', req.tenant?.subdomain).catch(() => {});
    }

    res.status(201).json({
      id: result.lastInsertRowid,
      name,
      role,
      active: true,
    });
  } catch (error) {
    console.error('Error creating employee:', error);
    res.status(500).json({ error: 'Failed to create employee' });
  }
});

// POST /api/employees/login - PIN login (must be before /:id to avoid shadowing)
router.post('/login', pinLoginLimiter, async (req, res) => {
  try {
    const { pin } = req.body;

    if (!pin) {
      return res.status(400).json({ error: 'PIN required' });
    }

    const tenantId = req.tenant?.id || 'default';

    // Check lockout status BEFORE attempting login
    const lockoutStatus = checkLockout(req);
    if (lockoutStatus.locked) {
      const retryAfterSec = Math.ceil(lockoutStatus.retryAfterMs / 1000);
      res.set('Retry-After', String(retryAfterSec));
      return res.status(429).json({
        error: `Account locked due to too many failed attempts. Try again in ${Math.ceil(retryAfterSec / 60)} minutes.`,
        locked: true,
        retryAfterSec,
      });
    }

    // Fetch all active employees and compare PIN with bcrypt
    const employees = await all(`
      SELECT id, name, pin, role, active, created_at
      FROM employees
      WHERE active = true
    `);

    let employee = null;
    for (const emp of employees) {
      const match = await bcrypt.compare(pin, emp.pin);
      if (match) {
        employee = emp;
        break;
      }
    }

    if (!employee) {
      // Record the failed attempt
      const entry = recordFailedAttempt(req);

      // Audit log the failed attempt
      audit({
        tenantId,
        actorType: 'system',
        actorId: null,
        action: 'login_failed',
        resource: 'employee',
        resourceId: null,
        details: {
          ip: req.ip,
          attempts: entry.attempts,
          locked: !!entry.lockedUntil,
          user_agent: req.headers['user-agent'] || null,
        },
        ip: req.ip,
      });

      // If just got locked out, send security alert email to owner
      if (entry.lockedUntil && entry.attempts === MAX_FAILED_ATTEMPTS) {
        const ownerEmail = req.tenant?.owner_email;
        if (ownerEmail) {
          sendSecurityAlertEmail(
            ownerEmail,
            req.tenant?.name || 'Your restaurant',
            req.ip,
            entry.attempts,
          ).catch(() => {});
        }
      }

      // Apply exponential backoff delay
      const backoffDelay = BACKOFF_DELAYS[Math.min(entry.attempts - 1, BACKOFF_DELAYS.length - 1)];
      if (backoffDelay > 0) {
        await new Promise(resolve => setTimeout(resolve, backoffDelay));
      }

      // Response based on lockout state
      if (entry.lockedUntil) {
        const retryAfterSec = Math.ceil(LOCKOUT_DURATION_MS / 1000);
        res.set('Retry-After', String(retryAfterSec));
        return res.status(429).json({
          error: `Too many failed attempts. Account locked for 30 minutes.`,
          locked: true,
          retryAfterSec,
        });
      }

      const remaining = MAX_FAILED_ATTEMPTS - entry.attempts;
      return res.status(401).json({
        error: `Invalid PIN. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining before lockout.`,
        attemptsRemaining: remaining,
      });
    }

    // Successful login — clear failed attempts
    clearAttempts(req);

    // Fetch permissions for this role
    const perms = await all(
      'SELECT permission FROM role_permissions WHERE role = $1 AND granted = true',
      [employee.role]
    );
    const permissions = perms.map(p => p.permission);

    const token = jwt.sign(
      { tenantId, employeeId: employee.id, role: employee.role, type: 'employee' },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      id: employee.id,
      name: employee.name,
      role: employee.role,
      active: employee.active,
      created_at: employee.created_at,
      permissions,
      token,
    });
  } catch (error) {
    console.error('Error during login:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// GET /api/employees/permissions - all roles with permissions
router.get('/permissions', async (req, res) => {
  try {
    const rows = await all(`
      SELECT role, permission, granted
      FROM role_permissions
      ORDER BY role, permission
    `);

    // Group by role
    const result = {};
    for (const row of rows) {
      if (!result[row.role]) result[row.role] = {};
      result[row.role][row.permission] = row.granted;
    }

    res.json(result);
  } catch (error) {
    console.error('Error fetching permissions:', error);
    res.status(500).json({ error: 'Failed to fetch permissions' });
  }
});

// PUT /api/employees/permissions/:role - update permissions for a role (admin only)
router.put('/permissions/:role', requireAuth('manage_permissions'), async (req, res) => {
  try {
    const { role } = req.params;
    const { permissions } = req.body;

    if (!permissions || typeof permissions !== 'object') {
      return res.status(400).json({ error: 'Missing permissions object' });
    }

    for (const [permission, granted] of Object.entries(permissions)) {
      const existing = await get(
        'SELECT id FROM role_permissions WHERE role = $1 AND permission = $2',
        [role, permission]
      );

      if (existing) {
        await run(
          'UPDATE role_permissions SET granted = $1 WHERE role = $2 AND permission = $3',
          [granted ? true : false, role, permission]
        );
      } else {
        const tid = getTenantId();
        await run(
          'INSERT INTO role_permissions (tenant_id, role, permission, granted) VALUES ($1, $2, $3, $4)',
          [tid, role, permission, granted ? true : false]
        );
      }
    }

    res.json({ message: 'Permissions updated successfully' });
  } catch (error) {
    console.error('Error updating permissions:', error);
    res.status(500).json({ error: 'Failed to update permissions' });
  }
});

// PUT /api/employees/:id - update employee
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, pin, role } = req.body;

    const employee = await get('SELECT id FROM employees WHERE id = $1', [id]);
    if (!employee) {
      return res.status(404).json({ error: 'Employee not found' });
    }

    const updates = [];
    const values = [];

    if (name !== undefined) {
      updates.push(`name = $${values.length + 1}`);
      values.push(name);
    }
    if (pin !== undefined) {
      const hashedPin = await bcrypt.hash(pin, BCRYPT_ROUNDS);
      updates.push(`pin = $${values.length + 1}`);
      values.push(hashedPin);
    }
    if (role !== undefined) {
      const validRoles = ['admin', 'cashier', 'manager', 'kitchen', 'bar'];
      if (!validRoles.includes(role)) {
        return res.status(400).json({ error: 'Invalid role' });
      }
      updates.push(`role = $${values.length + 1}`);
      values.push(role);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    values.push(id);

    await run(`
      UPDATE employees
      SET ${updates.join(', ')}
      WHERE id = $${values.length}
    `, values);

    audit({
      tenantId: req.tenant?.id || 'default',
      actorType: 'employee',
      actorId: req.headers['x-employee-id'] || 'unknown',
      action: 'update',
      resource: 'employee',
      resourceId: String(id),
      ip: req.ip,
    });

    res.json({ message: 'Employee updated successfully' });
  } catch (error) {
    console.error('Error updating employee:', error);
    res.status(500).json({ error: 'Failed to update employee' });
  }
});

// PUT /api/employees/:id/toggle - toggle active
router.put('/:id/toggle', async (req, res) => {
  try {
    const { id } = req.params;

    const employee = await get('SELECT id, active FROM employees WHERE id = $1', [id]);
    if (!employee) {
      return res.status(404).json({ error: 'Employee not found' });
    }

    const newActive = !employee.active;
    await run('UPDATE employees SET active = $1 WHERE id = $2', [newActive, id]);

    res.json({ id, active: newActive });
  } catch (error) {
    console.error('Error toggling employee:', error);
    res.status(500).json({ error: 'Failed to toggle employee' });
  }
});

export default router;
