import { Router } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import rateLimit from 'express-rate-limit';
import { adminSql } from '../db/index.js';
import { JWT_SECRET } from '../lib/constants.js';

const router = Router();

const bindLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many bind attempts. Try again in a minute.' },
});

// POST /api/kiosk/bind
// Body: { pin }
// Returns: { tenant_id, tenant_name, kiosk_token }
//
// Cross-tenant PIN search restricted to admin/manager roles only.
// Issues a 30-day kiosk token that scopes subsequent requests to the matched tenant.
router.post('/bind', bindLimiter, async (req, res) => {
  try {
    const { pin } = req.body || {};
    if (!pin || typeof pin !== 'string' || pin.length < 4) {
      return res.status(400).json({ error: 'PIN required (min 4 digits)' });
    }

    const candidates = await adminSql`
      SELECT e.id, e.tenant_id, e.role, e.pin, t.name AS tenant_name
      FROM employees e
      JOIN tenants t ON t.id = e.tenant_id
      WHERE e.active = true AND e.role IN ('admin', 'manager')
    `;

    let matched = null;
    for (const c of candidates) {
      const ok = await bcrypt.compare(pin, c.pin);
      if (ok) {
        matched = c;
        break;
      }
    }

    if (!matched) {
      return res.status(401).json({ error: 'Invalid PIN or insufficient permissions' });
    }

    const kioskToken = jwt.sign(
      {
        tenantId: matched.tenant_id,
        type: 'kiosk',
        boundEmployeeId: matched.id,
      },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      tenant_id: matched.tenant_id,
      tenant_name: matched.tenant_name,
      kiosk_token: kioskToken,
    });
  } catch (err) {
    console.error('[kiosk/bind] error', err);
    res.status(500).json({ error: 'Server error' });
  }
});

function checkAdminSecret(req) {
  const provided = req.headers['x-admin-secret'] || req.body?.admin_secret;
  if (!process.env.ADMIN_SECRET) return false;
  return typeof provided === 'string' && provided === process.env.ADMIN_SECRET;
}

// GET /api/kiosk/admin/tenants — list tenants (super-admin only, used in bind flow)
router.get('/admin/tenants', async (req, res) => {
  if (!checkAdminSecret(req)) {
    return res.status(401).json({ error: 'Invalid admin secret' });
  }
  try {
    const rows = await adminSql`
      SELECT id, name, subdomain
      FROM tenants
      WHERE active = true
      ORDER BY name ASC
    `;
    res.json(rows);
  } catch (err) {
    console.error('[kiosk/admin/tenants] error', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/kiosk/admin/bind — bind kiosk via ADMIN_SECRET + chosen tenant_id
// Body: { admin_secret, tenant_id }  (or admin_secret via X-Admin-Secret header)
router.post('/admin/bind', bindLimiter, async (req, res) => {
  if (!checkAdminSecret(req)) {
    return res.status(401).json({ error: 'Invalid admin secret' });
  }
  const { tenant_id } = req.body || {};
  if (!tenant_id || typeof tenant_id !== 'string') {
    return res.status(400).json({ error: 'tenant_id required' });
  }
  try {
    const [tenant] = await adminSql`
      SELECT id, name FROM tenants WHERE id = ${tenant_id} AND active = true
    `;
    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }
    const kioskToken = jwt.sign(
      { tenantId: tenant.id, type: 'kiosk', boundVia: 'admin_secret' },
      JWT_SECRET,
      { expiresIn: '30d' }
    );
    res.json({
      tenant_id: tenant.id,
      tenant_name: tenant.name,
      kiosk_token: kioskToken,
    });
  } catch (err) {
    console.error('[kiosk/admin/bind] error', err);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
