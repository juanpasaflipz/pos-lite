import { adminSql } from '../db/index.js';

/**
 * Get a credential value for a tenant+service+key.
 * Falls back to the given envFallback if no tenant credential is stored.
 */
export async function getCredential(tenantId, service, key, envFallback) {
  if (!tenantId) return envFallback || '';
  const rows = await adminSql`
    SELECT value FROM tenant_credentials
    WHERE tenant_id = ${tenantId} AND service = ${service} AND key = ${key}
    LIMIT 1
  `;
  return rows[0]?.value || envFallback || '';
}

/**
 * Get all credentials for a tenant+service as an object.
 * Falls back to env vars using the provided mapping.
 */
export async function getServiceCredentials(tenantId, service, envMap) {
  const result = {};
  if (tenantId) {
    const rows = await adminSql`
      SELECT key, value FROM tenant_credentials
      WHERE tenant_id = ${tenantId} AND service = ${service}
    `;
    for (const row of rows) {
      result[row.key] = row.value;
    }
  }
  // Fill missing from env
  for (const [key, envVar] of Object.entries(envMap)) {
    if (!result[key]) {
      result[key] = process.env[envVar] || '';
    }
  }
  return result;
}
