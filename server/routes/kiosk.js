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

export default router;
