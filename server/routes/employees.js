import { Router } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { all, get, run, getTenantId } from '../db/index.js';
import { requireAuth, signApprovalToken } from '../middleware/auth.js';
import { checkLimit, planUpgradeError } from '../planLimits.js';
import { audit } from '../lib/auditLog.js';
import { sendPinEmail, sendSecurityAlertEmail } from '../helpers/email.js';
import { toE164 } from '../helpers/twilio.js';
import { BCRYPT_ROUNDS, JWT_SECRET } from '../lib/constants.js';

// ---------------------------------------------------------------------------
// Staff phone numbers (WhatsApp / SMS ops identity)
// ---------------------------------------------------------------------------
// `employees.phone` is what resolveEmployeeByPhone() matches an inbound
// WhatsApp/SMS sender against (helpers/inboundVoiceOps.js). That lookup builds
// a variant set (+52…, +521…, bare 10 digits) from whatever the transport
// sends, so storing the WhatsApp `+52` E.164 form is a hit on every variant.
// A number typed with an explicit non-MX country code is preserved rather than
// force-fed +52 — toE164 would otherwise mangle a US staff number.
const PHONE_MIN_DIGITS = 10;

export function normalizeStaffPhone(raw) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return { value: null }; // explicit clear
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < PHONE_MIN_DIGITS) return { error: 'Invalid phone number' };
  if (trimmed.startsWith('+') && !digits.startsWith('52')) return { value: `+${digits}` };
  return { value: toE164(trimmed, 'MX') };
}

// uq_employees_tenant_phone (migration 0059) makes a duplicate a hard failure.
// Pre-check instead of relying on the 23505 catch: a constraint violation
// aborts the tenant middleware's request transaction, and the friendly message
// needs the colliding employee's name anyway.
async function findPhoneOwner(phone, excludeId = null) {
  if (!phone) return null;
  return excludeId
    ? await get('SELECT id, name FROM employees WHERE phone = $1 AND id <> $2', [phone, excludeId])
    : await get('SELECT id, name FROM employees WHERE phone = $1', [phone]);
}

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

const managerApproveLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyGenerator: (req) => `manager-approve:${ipKeyGenerator(req.ip)}:${req.tenant?.id || 'unknown'}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many approval attempts, please try again later' },
});

const router = Router();

// GET /api/employees - list employees
router.get('/', requireAuth(), async (req, res) => {
  try {
    const employees = await all(`
      SELECT id, name, role, active, phone, created_at
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
router.post('/', requireAuth('manage_employees'), async (req, res) => {
  try {
    const { name, pin, role = 'cashier', phone } = req.body;

    if (!name || !pin) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const validRoles = ['admin', 'cashier', 'manager', 'kitchen', 'bar'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    const normalizedPhone = normalizeStaffPhone(phone);
    if (normalizedPhone.error) {
      return res.status(400).json({ error: normalizedPhone.error });
    }
    const phoneOwner = await findPhoneOwner(normalizedPhone.value);
    if (phoneOwner) {
      return res.status(409).json({ error: 'Phone already registered', conflict_with: phoneOwner.name });
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
      INSERT INTO employees (tenant_id, name, pin, role, active, phone, pin_changed_at)
      VALUES ($1, $2, $3, $4, true, $5, NOW())
    `, [tid, name, hashedPin, role, normalizedPhone.value]);

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
      phone: normalizedPhone.value,
    });
  } catch (error) {
    if (error?.code === '23505') {
      return res.status(409).json({ error: 'Phone already registered' });
    }
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

// POST /api/employees/manager-approve - manager PIN re-auth for permission-gated actions
// Verifies that some active employee with the supplied PIN has the requested permission.
// Returns { employee_id, employee_name } so the client can attach an audit handle to the action.
// Does NOT issue a JWT — the caller's existing session continues; this is a one-shot authorization.
router.post('/manager-approve', managerApproveLimiter, requireAuth(), async (req, res) => {
  try {
    const { pin, permission, context } = req.body;

    if (!pin || !permission) {
      return res.status(400).json({ error: 'PIN and permission required' });
    }

    // A discount approval is a record, not a header token — the approver rides
    // inside the cart payload, several can be open at once, and a cart outlives
    // the token's 5-minute TTL. The client sends what the manager is putting
    // their PIN behind so it can be bound to that exact discount.
    let discountBinding = null;
    if (permission === 'apply_discounts') {
      const scope = context?.scope;
      const type = context?.discount_type;
      if (!['cart', 'line'].includes(scope) || !['percent', 'amount', 'comp'].includes(type)) {
        return res.status(400).json({
          error: 'apply_discounts approval requires context { scope, discount_type, discount_value }',
        });
      }
      const rawValue = type === 'comp' ? 100 : Number(context?.discount_value);
      if (!Number.isFinite(rawValue) || rawValue < 0) {
        return res.status(400).json({ error: 'context.discount_value must be a non-negative number' });
      }
      discountBinding = {
        scope,
        type,
        value: Math.round((type === 'percent' ? Math.min(100, rawValue) : rawValue) * 100) / 100,
        baseAmount: Number.isFinite(Number(context?.base_amount)) ? Number(context.base_amount) : null,
        itemLabel: typeof context?.item_label === 'string' ? context.item_label.slice(0, 200) : null,
      };
    }

    const tenantId = req.tenant?.id || 'default';

    const lockoutStatus = checkLockout(req);
    if (lockoutStatus.locked) {
      const retryAfterSec = Math.ceil(lockoutStatus.retryAfterMs / 1000);
      res.set('Retry-After', String(retryAfterSec));
      return res.status(429).json({
        error: `Locked due to too many failed attempts. Try again in ${Math.ceil(retryAfterSec / 60)} minutes.`,
        locked: true,
      });
    }

    const employees = await all(`
      SELECT id, name, pin, role
      FROM employees
      WHERE active = true
    `);

    let approver = null;
    for (const emp of employees) {
      if (await bcrypt.compare(pin, emp.pin)) {
        approver = emp;
        break;
      }
    }

    if (!approver) {
      const entry = recordFailedAttempt(req);
      audit({
        tenantId,
        actorType: 'employee',
        actorId: String(req.employee?.id || 'unknown'),
        action: 'manager_approve_failed',
        resource: 'auth',
        resourceId: null,
        details: { permission, attempts: entry.attempts, locked: !!entry.lockedUntil },
        ip: req.ip,
      });
      const backoffDelay = BACKOFF_DELAYS[Math.min(entry.attempts - 1, BACKOFF_DELAYS.length - 1)];
      if (backoffDelay > 0) {
        await new Promise((r) => setTimeout(r, backoffDelay));
      }
      return res.status(401).json({ error: 'Invalid PIN' });
    }

    const perm = await get(
      'SELECT granted FROM role_permissions WHERE role = $1 AND permission = $2',
      [approver.role, permission]
    );

    if (!perm || !perm.granted) {
      audit({
        tenantId,
        actorType: 'employee',
        actorId: String(req.employee?.id || 'unknown'),
        action: 'manager_approve_denied',
        resource: 'auth',
        resourceId: String(approver.id),
        details: { permission, approver_role: approver.role },
        ip: req.ip,
      });
      return res.status(403).json({
        error: `${approver.name} does not have permission: ${permission}`,
      });
    }

    clearAttempts(req);

    // Single-use, binding-checked record consumed by authorizeDiscount. Only
    // minted once the PIN and the approver's permission have both been proven.
    let approvalId = null;
    if (discountBinding) {
      const row = await get(
        `INSERT INTO discount_approvals
           (approver_employee_id, requested_by_employee_id, scope, discount_type,
            discount_value, base_amount, item_label)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          approver.id,
          req.employee?.id ?? null,
          discountBinding.scope,
          discountBinding.type,
          discountBinding.value,
          discountBinding.baseAmount,
          discountBinding.itemLabel,
        ]
      );
      approvalId = row?.id ?? null;
    }

    audit({
      tenantId,
      actorType: 'employee',
      actorId: String(req.employee?.id || 'unknown'),
      action: 'manager_approve',
      resource: 'auth',
      resourceId: String(approver.id),
      details: {
        permission,
        approver_role: approver.role,
        ...(approvalId ? { approval_id: approvalId, binding: discountBinding } : {}),
      },
      ip: req.ip,
    });

    res.json({
      employee_id: approver.id,
      employee_name: approver.name,
      role: approver.role,
      // Discount approvals only. Bound to this exact discount and single-use;
      // the cart carries it per line / per cart-level discount.
      ...(approvalId ? { approval_id: approvalId } : {}),
      // Signed, permission-scoped, 5-minute one-shot. Routes that use
      // requireAuth(perm, { allowApproval: true }) accept this as
      // X-Approval-Token.
      approval_token: signApprovalToken({
        tenantId,
        approverId: approver.id,
        approverName: approver.name,
        permission,
      }),
    });
  } catch (error) {
    console.error('Error in manager approval:', error);
    res.status(500).json({ error: 'Approval failed' });
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
router.put('/:id', requireAuth('manage_employees'), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, pin, role, phone } = req.body;

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
      // Stamp the change so existing JWTs for this employee are invalidated
      // (see server/middleware/auth.js). NOW() takes no positional param.
      updates.push('pin_changed_at = NOW()');
    }
    if (role !== undefined) {
      const validRoles = ['admin', 'cashier', 'manager', 'kitchen', 'bar'];
      if (!validRoles.includes(role)) {
        return res.status(400).json({ error: 'Invalid role' });
      }
      updates.push(`role = $${values.length + 1}`);
      values.push(role);
    }
    if (phone !== undefined) {
      // An empty string clears the number (un-enrolls the employee from
      // WhatsApp ops); `undefined` leaves it untouched.
      const normalizedPhone = normalizeStaffPhone(phone);
      if (normalizedPhone.error) {
        return res.status(400).json({ error: normalizedPhone.error });
      }
      const phoneOwner = await findPhoneOwner(normalizedPhone.value, Number(id));
      if (phoneOwner) {
        return res.status(409).json({ error: 'Phone already registered', conflict_with: phoneOwner.name });
      }
      updates.push(`phone = $${values.length + 1}`);
      values.push(normalizedPhone.value);
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
    if (error?.code === '23505') {
      return res.status(409).json({ error: 'Phone already registered' });
    }
    console.error('Error updating employee:', error);
    res.status(500).json({ error: 'Failed to update employee' });
  }
});

// PUT /api/employees/:id/toggle - toggle active
router.put('/:id/toggle', requireAuth('manage_employees'), async (req, res) => {
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
