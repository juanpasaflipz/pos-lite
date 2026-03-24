import crypto from 'crypto';
import { getServiceCredentials } from '../helpers/tenantCredentials.js';

// DiDi Food Open Platform (Mexico/LATAM)
const DIDI_API = 'https://openplatform-portal.didi-food.com';

// Token cache per tenant (tenantId -> { token, expiresAt })
const _tokenCache = new Map();

/**
 * Validate DiDi Food webhook signature.
 * DiDi signs callbacks with HMAC-SHA256 of the raw body using the app_secret.
 * The signature is sent in the X-DiDi-Signature header.
 *
 * @param {Buffer} rawBody - Raw request body buffer
 * @param {string} signature - Signature header value
 * @param {string} secret - App secret or webhook secret
 * @returns {boolean}
 */
export function verifyDidiSignature(rawBody, signature, secret) {
  if (!rawBody || !signature || !secret) return false;
  try {
    // DiDi may use "t=<ts>,sign=<hex>" format (like Rappi) or plain hex
    let receivedSign = signature;
    if (signature.includes('sign=')) {
      const parts = signature.split(',');
      const timestamp = parts.find(p => p.startsWith('t='))?.split('=')[1];
      receivedSign = parts.find(p => p.startsWith('sign='))?.split('=')[1];
      if (!receivedSign) return false;
      // If timestamp-based, construct signed payload
      if (timestamp) {
        const signedPayload = `${timestamp}.${rawBody.toString()}`;
        const expected = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
        return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(receivedSign));
      }
    }
    // Plain HMAC-SHA256 of raw body
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(receivedSign));
  } catch {
    return false;
  }
}

/**
 * Get a valid auth token for DiDi Food API.
 * Uses app_id + app_secret to authenticate.
 */
export async function getAccessToken(tenantId) {
  const cached = _tokenCache.get(tenantId);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const creds = await getServiceCredentials(tenantId, 'didi_food', {
    app_id: '',
    app_secret: '',
  });

  if (!creds.app_id || !creds.app_secret) {
    throw new Error('DiDi Food credentials not configured');
  }

  const res = await fetch(`${DIDI_API}/auth/v1/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: creds.app_id,
      app_secret: creds.app_secret,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error('[DiDi Food] Auth token failed:', text);
    throw new Error('Failed to get DiDi Food access token');
  }

  const data = await res.json();
  const token = data.access_token || data.token || data.data?.token;
  const expiresIn = data.expires_in || data.data?.expires_in || 7200;

  _tokenCache.set(tenantId, {
    token,
    expiresAt: Date.now() + expiresIn * 1000,
  });
  return token;
}

/**
 * Helper for authenticated DiDi Food API requests.
 */
async function didiRequest(accessToken, method, path, body = null) {
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`${DIDI_API}${path}`, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`DiDi Food ${method} ${path} failed (${res.status}): ${text}`);
  }
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return res.json();
  }
  return { status: res.status };
}

/**
 * Confirm (accept) an order on DiDi Food.
 * @param {string} accessToken
 * @param {string} orderId - DiDi Food order ID
 */
export async function confirmOrder(accessToken, orderId) {
  return didiRequest(accessToken, 'POST', `/order/v1/confirm`, {
    order_id: orderId,
  });
}

/**
 * Reject/cancel an order on DiDi Food.
 * @param {string} accessToken
 * @param {string} orderId
 * @param {string} [reason] - Cancellation reason
 */
export async function cancelDidiOrder(accessToken, orderId, reason) {
  return didiRequest(accessToken, 'POST', `/order/v1/cancel`, {
    order_id: orderId,
    reason: reason || 'Cancelled by restaurant',
  });
}
