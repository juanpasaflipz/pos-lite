import crypto from 'crypto';
import { getServiceCredentials } from '../helpers/tenantCredentials.js';

// Mexico production API
const RAPPI_API = 'https://api.rappi.com.mx';
const RAPPI_AUTH = `${RAPPI_API}/restaurants/auth/v1/token/login/integrations`;

// Token cache per tenant (tenantId -> { token, expiresAt })
const _tokenCache = new Map();

/**
 * Validate Rappi webhook signature.
 * Header format: "t=<timestamp>,sign=<hex_hmac>"
 * Signed payload: "{timestamp}.{rawBody}"
 *
 * @param {Buffer} rawBody - Raw request body buffer
 * @param {string} header - Full Rappi-Signature header value
 * @param {string} secret - Webhook signing secret
 * @returns {boolean}
 */
export function verifyRappiSignature(rawBody, header, secret) {
  if (!rawBody || !header || !secret) return false;
  try {
    const parts = header.split(',');
    const timestamp = parts.find(p => p.startsWith('t='))?.split('=')[1];
    const receivedSign = parts.find(p => p.startsWith('sign='))?.split('=')[1];
    if (!timestamp || !receivedSign) return false;

    const signedPayload = `${timestamp}.${rawBody.toString()}`;
    const expected = crypto
      .createHmac('sha256', secret)
      .update(signedPayload)
      .digest('hex');

    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(receivedSign));
  } catch {
    return false;
  }
}

/**
 * Get a valid OAuth access token for Rappi API.
 * Uses client_id + client_secret grant. Tokens last ~1 week.
 */
export async function getAccessToken(tenantId) {
  const cached = _tokenCache.get(tenantId);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const creds = await getServiceCredentials(tenantId, 'rappi', {
    client_id: '',
    client_secret: '',
  });

  if (!creds.client_id || !creds.client_secret) {
    throw new Error('Rappi credentials not configured');
  }

  const res = await fetch(RAPPI_AUTH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: creds.client_id,
      client_secret: creds.client_secret,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error('[Rappi] OAuth token failed:', text);
    throw new Error('Failed to get Rappi access token');
  }

  const data = await res.json();
  _tokenCache.set(tenantId, {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in || 604800) * 1000,
  });
  return data.access_token;
}

/**
 * Helper for authenticated Rappi API requests.
 * Rappi uses x-authorization header instead of standard Authorization.
 */
async function rappiRequest(accessToken, method, path, body = null) {
  const opts = {
    method,
    headers: {
      'x-authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`${RAPPI_API}${path}`, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Rappi ${method} ${path} failed (${res.status}): ${text}`);
  }
  // Some Rappi endpoints return 200/202 with no body
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return res.json();
  }
  return { status: res.status };
}

/**
 * Accept (take) an order on Rappi.
 * Must be called within 6 minutes of receiving the notification.
 * @param {string} accessToken
 * @param {string} storeId - Rappi store ID
 * @param {string} orderId - Rappi order ID
 * @param {number} [cookingTime] - Optional cooking time in minutes
 */
export async function takeOrder(accessToken, storeId, orderId, cookingTime) {
  const path = cookingTime
    ? `/restaurants/orders/v1/stores/${storeId}/orders/${orderId}/cooking_time/${cookingTime}/take`
    : `/restaurants/orders/v1/stores/${storeId}/orders/${orderId}/take`;
  return rappiRequest(accessToken, 'PUT', path);
}

/**
 * Reject an order on Rappi.
 * @param {string} accessToken
 * @param {string} storeId
 * @param {string} orderId
 * @param {string} cancelType - STORE_CLOSED|ITEM_STOCKOUT|ITEM_NOT_FOUND|POS_OFFLINE|POS_INTERNAL_ERROR|etc.
 * @param {string} [description] - Human-readable reason
 * @param {string[]} [itemSkus] - Required for ITEM_STOCKOUT, ITEM_NOT_FOUND, ITEM_PRICE_INCORRECT
 */
export async function rejectOrder(accessToken, storeId, orderId, cancelType, description, itemSkus) {
  const body = { description: description || 'Order rejected by restaurant' };
  if (itemSkus?.length) {
    body.additional_info = { items_skus: itemSkus };
  }
  return rappiRequest(
    accessToken,
    'PUT',
    `/restaurants/orders/v1/stores/${storeId}/orders/${orderId}/cancel_type/${cancelType}/reject`,
    body
  );
}

/**
 * Mark an order as ready for pickup on Rappi.
 * Limited to 3 calls per order.
 */
export async function markReadyForPickup(accessToken, storeId, orderId) {
  return rappiRequest(
    accessToken,
    'POST',
    `/restaurants/orders/v1/stores/${storeId}/orders/${orderId}/ready-for-pickup`
  );
}
