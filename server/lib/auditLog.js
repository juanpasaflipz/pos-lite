import { adminSql } from '../db/index.js';

/**
 * Write an audit log entry. Fire-and-forget — never blocks the request.
 *
 * @param {object} params
 * @param {string} params.tenantId
 * @param {string} params.actorType - 'employee' | 'owner' | 'system' | 'admin'
 * @param {string} [params.actorId]
 * @param {string} params.action - 'create' | 'update' | 'delete'
 * @param {string} params.resource - table/entity name
 * @param {string} [params.resourceId]
 * @param {object} [params.details] - arbitrary JSON (changed fields, etc.)
 * @param {string} [params.ip]
 */
export function audit({ tenantId, actorType, actorId, action, resource, resourceId, details, ip }) {
  // postgres.js throws UNDEFINED_VALUE on any `undefined` parameter — and a
  // fire-and-forget audit write must never be a source of error-log spam.
  // Skip loudly (with enough context to find the caller) when a required
  // field is missing; coerce optionals to null.
  if (!tenantId || !actorType || !action || !resource) {
    console.warn('[Audit] skipped — missing required field:', JSON.stringify({
      tenantId: tenantId ?? null, actorType: actorType ?? null,
      action: action ?? null, resource: resource ?? null, resourceId: resourceId ?? null,
    }));
    return;
  }
  adminSql`
    INSERT INTO audit_log (tenant_id, actor_type, actor_id, action, resource, resource_id, details, ip_address)
    VALUES (${tenantId}, ${actorType}, ${actorId ?? null}, ${action}, ${resource}, ${resourceId ?? null}, ${details ? adminSql.json(details) : null}, ${ip ?? null})
  `.catch(err => {
    console.error('[Audit] Failed to write audit log:', err.message);
  });
}

