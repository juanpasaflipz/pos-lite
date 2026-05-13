/**
 * Clip (Mexico) PinPad terminal integration service.
 *
 * Auth: Basic base64("<api_key>:<secret_key>") in Authorization header.
 * See https://developer.clip.mx/docs/autenticacion
 *
 * Endpoints:
 *   - PinPad payment intent: POST  https://api.payclip.io/f2f/pinpad/v1/payment
 *   - Payment status (read): GET   https://api.payclip.com/payments/{payment_id}
 *
 * NOTE on the PinPad request body shape: Clip does not publish a complete
 * JSON schema for this endpoint in their public docs. The body fields below
 * are inferred from the MP Point pattern and Clip's transactions API. After
 * the first sandbox call, swap field names to whatever Clip returns 4xx for.
 * Look for: amount unit (cents vs decimal), idempotency mechanism, terminal
 * identifier field name (pinpad_id vs terminal_id vs device_id).
 */

import { getServiceCredentials } from '../helpers/tenantCredentials.js';

const CLIP_PINPAD = 'https://api.payclip.io/f2f/pinpad/v1';
const CLIP_API = 'https://api.payclip.com';

/**
 * Resolve Clip credentials for a tenant and return the Authorization header value.
 * Returns null if no credentials are configured.
 */
export async function getClipAuthHeader(tenantId) {
  const creds = await getServiceCredentials(tenantId, 'clip', {
    api_key: 'CLIP_API_KEY',
    secret_key: 'CLIP_SECRET_KEY',
  });
  if (!creds.api_key || !creds.secret_key) return null;
  const token = Buffer.from(`${creds.api_key}:${creds.secret_key}`).toString('base64');
  return `Basic ${token}`;
}

/**
 * Resolve the tenant's default Clip PinPad terminal id (or null).
 */
export async function getClipDefaultTerminalId(tenantId) {
  const creds = await getServiceCredentials(tenantId, 'clip', {
    default_terminal_id: 'CLIP_DEFAULT_TERMINAL_ID',
  });
  return creds.default_terminal_id || null;
}

/**
 * Create a PinPad payment intent and push it to the paired Clip terminal.
 *
 * @param {string} authHeader  pre-built Basic auth header
 * @param {object} args
 * @param {number} args.amount         decimal MXN (e.g. 123.45)
 * @param {string} args.externalRef    reference to correlate with our order
 * @param {string} args.terminalId     Clip PinPad / terminal identifier
 * @returns {Promise<{ payment_id: string, raw: object }>}
 */
export async function createPinPadPayment(authHeader, { amount, externalRef, terminalId }) {
  // TODO(clip-sandbox): verify field names against first 200 response.
  const body = {
    amount: Math.round(amount * 100), // assume cents like MP / Stripe
    currency: 'MXN',
    pinpad_id: terminalId,
    external_reference: externalRef,
  };

  const res = await fetch(`${CLIP_PINPAD}/payment`, {
    method: 'POST',
    headers: {
      Authorization: authHeader,
      'Content-Type': 'application/json',
      'X-Idempotency-Key': `dk-${externalRef}-${Date.now()}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Clip createPinPadPayment failed: ${res.status} ${text}`);
  }

  const data = await res.json();
  // TODO(clip-sandbox): confirm id field name (id vs payment_id vs transaction_id).
  const paymentId = data.payment_id || data.id || data.transaction_id;
  return { payment_id: paymentId, raw: data };
}

/**
 * Pull the current status of a Clip payment.
 *
 * @returns {Promise<{ status: string, raw: object } | null>} null on 404
 */
export async function getPaymentStatus(authHeader, paymentId) {
  const res = await fetch(`${CLIP_API}/payments/${encodeURIComponent(paymentId)}`, {
    headers: {
      Authorization: authHeader,
      Accept: 'application/json',
    },
  });

  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Clip getPaymentStatus failed: ${res.status} ${text}`);
  }

  const data = await res.json();
  // TODO(clip-sandbox): map Clip status values. Likely one of:
  //   PENDING / IN_PROGRESS / APPROVED / DECLINED / CANCELLED / ERROR
  // Update mapStatus() in payments.js once confirmed.
  return { status: data.status || data.state, raw: data };
}

/**
 * Best-effort cancel of an in-flight PinPad payment.
 * Some PinPad APIs require canceling at the device, not over HTTP — if Clip
 * returns 404/405 we swallow and let the live-pull resolve to ERROR.
 */
export async function cancelPinPadPayment(authHeader, paymentId) {
  const res = await fetch(`${CLIP_PINPAD}/payment/${encodeURIComponent(paymentId)}`, {
    method: 'DELETE',
    headers: { Authorization: authHeader },
  });

  if (!res.ok && res.status !== 404 && res.status !== 405) {
    const text = await res.text();
    throw new Error(`Clip cancelPinPadPayment failed: ${res.status} ${text}`);
  }
}

/**
 * Normalize a Clip status string into our internal taxonomy.
 * Returns one of: 'pending' | 'paid' | 'failed' | 'unknown'
 */
export function mapStatus(clipStatus) {
  if (!clipStatus) return 'unknown';
  const s = String(clipStatus).toUpperCase();
  if (s === 'APPROVED' || s === 'COMPLETED' || s === 'SUCCESS' || s === 'FINISHED') return 'paid';
  if (s === 'DECLINED' || s === 'CANCELLED' || s === 'CANCELED' || s === 'ERROR' || s === 'FAILED') return 'failed';
  if (s === 'PENDING' || s === 'IN_PROGRESS' || s === 'PROCESSING') return 'pending';
  return 'unknown';
}
