import crypto from 'crypto';
import { adminSql } from '../db/index.js';

/**
 * Auth middleware for on-site agents (print bridge, portal watcher).
 *
 * Agents authenticate with a per-tenant token in the X-Agent-Token header.
 * The token lives in tenant_credentials (service 'print_agent', key 'token')
 * and is generated from the Printer Management screen.
 *
 * Must run AFTER tenantMiddleware (req.tenant populated).
 */
export function requireAgentToken() {
  return async (req, res, next) => {
    try {
      const provided = req.headers['x-agent-token'];
      if (!provided || typeof provided !== 'string') {
        return res.status(401).json({ error: 'Agent token required' });
      }

      const tenantId = req.tenant?.id;
      if (!tenantId) {
        return res.status(400).json({ error: 'Tenant context required' });
      }

      const rows = await adminSql`
        SELECT value FROM tenant_credentials
        WHERE tenant_id = ${tenantId} AND service = 'print_agent' AND key = 'token'
        LIMIT 1
      `;
      const stored = rows[0]?.value;
      if (!stored) {
        return res.status(401).json({ error: 'No agent token configured for this tenant' });
      }

      const a = Buffer.from(provided);
      const b = Buffer.from(stored);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return res.status(401).json({ error: 'Invalid agent token' });
      }

      // Track liveness (best-effort, never blocks the request)
      adminSql`
        INSERT INTO tenant_credentials (tenant_id, service, key, value)
        VALUES (${tenantId}, 'print_agent', 'last_seen', ${new Date().toISOString()})
        ON CONFLICT (tenant_id, service, key)
        DO UPDATE SET value = EXCLUDED.value
      `.catch(() => {});

      next();
    } catch (err) {
      console.error('[AgentAuth] Error:', err.message);
      res.status(500).json({ error: 'Agent auth failed' });
    }
  };
}
