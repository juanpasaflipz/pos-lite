import crypto from 'crypto';
import { getServiceCredentials } from '../helpers/tenantCredentials.js';

const UBER_API = 'https://api.uber.com';
const UBER_AUTH = 'https://login.uber.com';

// Token cache per tenant (tenantId -> { token, expiresAt })
const _tokenCache = new Map();

/**
 * Validate Uber Eats webhook signature (HMAC-SHA256 of raw body with client_secret).
 * @param {Buffer} rawBody - Raw request body buffer
 * @param {string} signature - Value of X-Uber-Signature header
 * @param {string} clientSecret - Uber app client_secret
 * @returns {boolean}
 */
export function verifyWebhookSignature(rawBody, signature, clientSecret) {
  if (!rawBody || !signature || !clientSecret) return false;
  const expected = crypto.createHmac('sha256', clientSecret).update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

/**
 * Get a valid OAuth access token for Uber Eats API.
 * Uses Client Credentials grant with cached tokens.
 */
export async function getAccessToken(tenantId) {
  const cached = _tokenCache.get(tenantId);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const creds = await getServiceCredentials(tenantId, 'uber_eats', {
    client_id: '',
    client_secret: '',
  });

  if (!creds.client_id || !creds.client_secret) {
    throw new Error('Uber Eats credentials not configured');
  }

  const res = await fetch(`${UBER_AUTH}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      grant_type: 'client_credentials',
      scope: 'eats.order',
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error('[Uber Eats] OAuth token failed:', text);
    throw new Error('Failed to get Uber Eats access token');
  }

  const data = await res.json();
  _tokenCache.set(tenantId, {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
  });
  return data.access_token;
}

/**
 * Fetch full order details from Uber Eats API.
 */
export async function fetchOrder(accessToken, orderId) {
  const res = await fetch(`${UBER_API}/v2/eats/order/${orderId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`fetchOrder failed (${res.status}): ${text}`);
  }
  return res.json();
}

/**
 * Accept an order on Uber Eats.
 * Must be called within 11.5 minutes of receiving the notification.
 */
export async function acceptOrder(accessToken, orderId, { reason, pickupTime, externalRef } = {}) {
  const body = { reason: reason || 'Accepted by POS' };
  if (pickupTime) body.pickup_time = Math.floor(pickupTime / 1000);
  if (externalRef) body.external_reference_id = externalRef;

  const res = await fetch(`${UBER_API}/v1/eats/orders/${orderId}/accept_pos_order`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok && res.status !== 204) {
    const text = await res.text();
    throw new Error(`acceptOrder failed (${res.status}): ${text}`);
  }
  return true;
}

/**
 * Deny an order on Uber Eats.
 * @param {Object} opts
 * @param {string} opts.explanation - Human-readable reason
 * @param {string} opts.code - STORE_CLOSED|POS_NOT_READY|POS_OFFLINE|ITEM_AVAILABILITY|OTHER
 */
export async function denyOrder(accessToken, orderId, { explanation, code } = {}) {
  const body = {
    reason: {
      explanation: explanation || 'Order denied by restaurant',
      code: code || 'OTHER',
    },
  };

  const res = await fetch(`${UBER_API}/v1/eats/orders/${orderId}/deny_pos_order`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok && res.status !== 204) {
    const text = await res.text();
    throw new Error(`denyOrder failed (${res.status}): ${text}`);
  }
  return true;
}

/**
 * Cancel an already-accepted order on Uber Eats.
 */
export async function cancelUberOrder(accessToken, orderId, reason) {
  const res = await fetch(`${UBER_API}/v1/eats/orders/${orderId}/cancel`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ reason: reason || 'Cancelled by restaurant' }),
  });

  if (!res.ok && res.status !== 204) {
    const text = await res.text();
    throw new Error(`cancelUberOrder failed (${res.status}): ${text}`);
  }
  return true;
}
