import jwt from 'jsonwebtoken';
import { get } from '../db/index.js';
import { JWT_SECRET } from '../lib/constants.js';

/**
 * Auth middleware factory.
 * Validates employee JWT from Authorization header, cross-checks tenant,
 * and optionally checks role_permissions for a specific permission.
 *
 * Usage:
 *   router.post('/', requireAuth('manage_menu'), handler)
 *   router.get('/', requireAuth(), handler)            // just requires login
 */
export function requireAuth(permission) {
  return async (req, res, next) => {
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    let decoded;
    try {
      decoded = jwt.verify(authHeader.slice(7), JWT_SECRET);
    } catch (error) {
      if (error.name === 'TokenExpiredError') {
        return res.status(401).json({ error: 'Token expired' });
      }
      return res.status(401).json({ error: 'Invalid token' });
    }

    if (decoded.type !== 'employee') {
      return res.status(401).json({ error: 'Invalid token type' });
    }

    // Cross-check: token tenant must match resolved tenant
    const currentTenant = req.tenant?.id || 'default';
    if (decoded.tenantId !== currentTenant) {
      return res.status(403).json({ error: 'Token does not match this tenant' });
    }

    const employee = await get(
      'SELECT id, name, role, active FROM employees WHERE id = $1',
      [decoded.employeeId]
    );

    if (!employee) {
      return res.status(401).json({ error: 'Employee not found' });
    }

    if (!employee.active) {
      return res.status(401).json({ error: 'Employee account is inactive' });
    }

    req.employee = employee;

    // If no specific permission required, just authenticate
    if (!permission) {
      return next();
    }

    const perm = await get(
      'SELECT granted FROM role_permissions WHERE role = $1 AND permission = $2',
      [employee.role, permission]
    );

    if (!perm || !perm.granted) {
      return res.status(403).json({
        error: `Permission denied: ${permission} is not granted for role ${employee.role}`,
      });
    }

    next();
  };
}
