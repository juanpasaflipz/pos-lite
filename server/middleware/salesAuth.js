import jwt from 'jsonwebtoken';
import { adminSql } from '../db/index.js';
import { JWT_SECRET } from '../lib/constants.js';

/**
 * Sales rep auth middleware factory.
 * Validates sales rep JWT from Authorization header.
 *
 * Usage:
 *   router.get('/', requireSalesAuth(), handler)         // any sales rep
 *   router.post('/', requireSalesAuth(true), handler)    // manager only
 */
export function requireSalesAuth(managerOnly = false) {
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

    if (decoded.type !== 'sales_rep') {
      return res.status(401).json({ error: 'Invalid token type' });
    }

    const [rep] = await adminSql`
      SELECT id, email, name, phone, role, active FROM sales_reps WHERE id = ${decoded.repId}
    `;

    if (!rep) {
      return res.status(401).json({ error: 'Sales rep not found' });
    }

    if (!rep.active) {
      return res.status(401).json({ error: 'Account is inactive' });
    }

    if (managerOnly && rep.role !== 'manager') {
      return res.status(403).json({ error: 'Manager access required' });
    }

    req.salesRep = rep;
    next();
  };
}
