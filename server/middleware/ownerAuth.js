import jwt from 'jsonwebtoken';
import { getTenant } from '../tenants.js';
import { adminSql } from '../db/index.js';
import { JWT_SECRET } from '../lib/constants.js';

/**
 * Owner auth middleware.
 * Validates JWT, ensures tenant is active and subscription not expired.
 * Accepts both owner JWT and admin-role employee JWT tokens.
 * Attaches req.owner = { tenantId, email, role } for downstream use.
 */
export async function requireOwner(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const decoded = jwt.verify(authHeader.slice(7), JWT_SECRET);

    // Accept admin-role employee tokens as owner-equivalent
    if (decoded.type === 'employee') {
      const [employee] = await adminSql`
        SELECT id, name, role, active FROM employees
        WHERE id = ${decoded.employeeId} AND tenant_id = ${decoded.tenantId}
      `;
      if (!employee || !employee.active) {
        return res.status(401).json({ error: 'Employee not found or inactive' });
      }
      if (employee.role !== 'admin') {
        return res.status(403).json({ error: 'Admin role required' });
      }

      const tenant = await getTenant(decoded.tenantId);
      if (!tenant) return res.status(401).json({ error: 'Tenant not found' });
      if (!tenant.active) return res.status(403).json({ error: 'Account is inactive' });

      req.owner = {
        tenantId: decoded.tenantId,
        email: tenant.owner_email,
        role: 'admin',
      };
      return next();
    }

    // Standard owner JWT path — reject any non-owner token type
    if (decoded.type && decoded.type !== 'owner') {
      return res.status(403).json({ error: 'Owner token required' });
    }

    const tenant = await getTenant(decoded.tenantId);
    if (!tenant) {
      return res.status(401).json({ error: 'Tenant not found' });
    }
    if (!tenant.active) {
      return res.status(403).json({ error: 'Account is inactive' });
    }

    // Block owners whose subscription has been cancelled or is unpaid.
    // Allow null (free without Stripe), 'active', 'trialing', and 'past_due' (grace period).
    const blockedStatuses = ['cancelled', 'unpaid'];
    if (tenant.subscription_status && blockedStatuses.includes(tenant.subscription_status)) {
      return res.status(403).json({ error: 'Subscription expired. Please renew your plan.' });
    }

    req.owner = {
      tenantId: decoded.tenantId,
      email: decoded.email,
      role: decoded.role,
    };

    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
}
