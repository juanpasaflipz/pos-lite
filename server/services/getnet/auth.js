import { getServiceCredentials } from '../../helpers/tenantCredentials.js';

const SANDBOX_URL = 'https://api-sbx.pre.globalgetnet.com';
const PRODUCTION_URL = 'https://api.globalgetnet.com';

// Token cache per tenant (keyed by tenantId)
const _tokenCache = new Map();

/**
 * Get the base URL for the Getnet API based on environment.
 */
export function getBaseUrl(environment = 'sandbox') {
  return environment === 'production' ? PRODUCTION_URL : SANDBOX_URL;
}

/**
 * Get Getnet credentials for a tenant.
 */
export async function getGetnetCredentials(tenantId) {
  return getServiceCredentials(tenantId, 'getnet', {
    client_id: 'GETNET_CLIENT_ID',
    client_secret: 'GETNET_CLIENT_SECRET',
    merchant_id: 'GETNET_MERCHANT_ID',
  });
}

/**
 * Obtain an OAuth2 access token from Getnet.
 * Caches tokens per tenant with 5-minute early expiry buffer.
 */
export async function getAccessToken(tenantId, environment = 'sandbox') {
  const cacheKey = `${tenantId}:${environment}`;
  const cached = _tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 300_000) {
    return cached.token;
  }

  const creds = await getGetnetCredentials(tenantId);
  if (!creds.client_id || !creds.client_secret) {
    throw new Error('Getnet credentials not configured');
  }

  const baseUrl = getBaseUrl(environment);
  const basicAuth = Buffer.from(`${creds.client_id}:${creds.client_secret}`).toString('base64');

  const res = await fetch(`${baseUrl}/authentication/oauth2/access_token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basicAuth}`,
    },
    body: 'grant_type=client_credentials&scope=digital-platform:gateway-api',
  });

  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Getnet auth failed: ${res.status} ${text}`);
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  const token = data.access_token;
  const expiresIn = data.expires_in || 3600;

  _tokenCache.set(cacheKey, {
    token,
    expiresAt: Date.now() + expiresIn * 1000,
  });

  return token;
}

/**
 * Check if Getnet is configured for a tenant.
 */
export async function isGetnetConfigured(tenantId) {
  if (!tenantId) return false;
  const creds = await getGetnetCredentials(tenantId);
  return !!(creds.client_id && creds.client_secret && creds.merchant_id);
}

/**
 * Clear the token cache for a tenant (useful after credential changes).
 */
export function clearTokenCache(tenantId) {
  for (const key of _tokenCache.keys()) {
    if (key.startsWith(`${tenantId}:`)) {
      _tokenCache.delete(key);
    }
  }
}
