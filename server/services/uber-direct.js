import crypto from 'crypto';
import { getServiceCredentials } from '../helpers/tenantCredentials.js';
import { fetchWithTimeout } from '../lib/http.js';

const UBER_API = 'https://api.uber.com';
const UBER_AUTH = 'https://login.uber.com';

// Token cache per tenant (tenantId -> { token, expiresAt })
const _tokenCache = new Map();

/**
 * Verify Uber Direct webhook signature.
 * Direct sends X-Postmates-Signature (legacy) or X-Uber-Signature, HMAC-SHA256
 * of the raw body using the webhook signing key configured in the dashboard.
 * Falls back to client_secret to match older dashboards that don't expose a
 * separate webhook key.
 */
export function verifyDirectSignature(rawBody, signature, signingKey) {
  if (!rawBody || !signature || !signingKey) return false;
  const expected = crypto.createHmac('sha256', signingKey).update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

async function getCreds(tenantId) {
  return getServiceCredentials(tenantId, 'uber_direct', {
    customer_id: '',
    client_id: '',
    client_secret: '',
    webhook_signing_key: '',
  });
}

/**
 * Get a valid OAuth access token (Client Credentials, scope=eats.deliveries).
 * Cached per tenant with 60s expiry margin.
 */
export async function getAccessToken(tenantId) {
  const cached = _tokenCache.get(tenantId);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const creds = await getCreds(tenantId);
  if (!creds.client_id || !creds.client_secret) {
    throw new Error('Uber Direct credentials not configured');
  }

  const res = await fetchWithTimeout(`${UBER_AUTH}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      grant_type: 'client_credentials',
      scope: 'eats.deliveries',
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error('[Uber Direct] OAuth token failed:', text);
    throw new Error('Failed to get Uber Direct access token');
  }

  const data = await res.json();
  _tokenCache.set(tenantId, {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
  });
  return data.access_token;
}

/**
 * Get the Customer ID for the tenant (path-segment for all Direct calls).
 */
export async function getCustomerId(tenantId) {
  const creds = await getCreds(tenantId);
  if (!creds.customer_id) {
    throw new Error('Uber Direct customer_id not configured');
  }
  return creds.customer_id;
}

/**
 * Get the configured webhook signing key (falls back to client_secret).
 */
export async function getWebhookSigningKey(tenantId) {
  const creds = await getCreds(tenantId);
  return creds.webhook_signing_key || creds.client_secret || '';
}

async function uberCall(token, method, path, body) {
  const res = await fetchWithTimeout(`${UBER_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const err = new Error(`Uber Direct ${method} ${path} failed (${res.status}): ${text}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/**
 * Create a delivery quote (no courier dispatched).
 * Required: pickup_address, dropoff_address (objects or strings).
 * @returns { id, fee, currency, currency_type, duration, dropoff_eta, expires, kind }
 */
export async function createQuote(tenantId, payload) {
  const token = await getAccessToken(tenantId);
  const customerId = await getCustomerId(tenantId);
  return uberCall(token, 'POST', `/v1/customers/${customerId}/delivery_quotes`, payload);
}

/**
 * Create a delivery (dispatches a courier).
 * Required: pickup_address, pickup_name, pickup_phone_number, dropoff_address,
 * dropoff_name, dropoff_phone_number, manifest_items (array).
 * Optional: quote_id (uses prior quote), external_id, manifest_reference,
 * pickup_business_name, dropoff_business_name, deliverable_action.
 */
export async function createDelivery(tenantId, payload) {
  const token = await getAccessToken(tenantId);
  const customerId = await getCustomerId(tenantId);
  return uberCall(token, 'POST', `/v1/customers/${customerId}/deliveries`, payload);
}

/**
 * Pull current state of a delivery (webhook backstop — never rely on
 * webhooks alone for correctness; the CLAUDE.md rule applies here too).
 */
export async function getDelivery(tenantId, deliveryId) {
  const token = await getAccessToken(tenantId);
  const customerId = await getCustomerId(tenantId);
  return uberCall(token, 'GET', `/v1/customers/${customerId}/deliveries/${deliveryId}`);
}

/**
 * Cancel a delivery. Idempotent on Uber's side; subsequent calls return 4xx.
 */
export async function cancelDelivery(tenantId, deliveryId) {
  const token = await getAccessToken(tenantId);
  const customerId = await getCustomerId(tenantId);
  return uberCall(token, 'POST', `/v1/customers/${customerId}/deliveries/${deliveryId}/cancel`);
}
