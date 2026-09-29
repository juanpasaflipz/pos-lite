/**
 * Clip (Mexico) PinPad API integration — pushes a charge to a Clip reader
 * (Total 3, Ultra, Clip PinPad, Clip Stand 2) running the Clip PinPad APK.
 *
 * Source of truth: https://developer.clip.mx/reference/introducción-a-la-api-de-pinpad
 * (fetched 2026-09-26). Key facts from those docs:
 *   - Auth: `Authorization: Basic base64("<api_key>:<secret_key>")`.
 *   - PRODUCTION ONLY — there is no sandbox. Test with small real charges.
 *   - The reader needs the Clip PinPad APK, installed by Clip on request
 *     (email sdk@payclip.com with the reader's serial number) + KYC done.
 *   - The reader is addressed by its serial number (`serial_number_pos`).
 *   - `amount` / `tip_amount` are decimal pesos, NOT cents.
 *   - Cancel only works while the reader has not picked the intent up yet;
 *     after that Clip answers 400 PAYMENT_REQUEST_ISSUE and the charge can
 *     only be stopped on the device itself.
 *   - Webhook body is just `{ id, origin, event_type }` and is unsigned —
 *     consumers must re-read the payment via GET, never trust the body.
 *
 * Endpoints (base https://api.payclip.io/f2f/pinpad/v1):
 *   POST   /payment                                → { pinpad_request_id, reference, amount, serial_number_pos }
 *   GET    /payment?pinpadRequestId=…              → { status, amount, amount_paid, tip_amount, detail? }
 *   DELETE /payment/{pinpad_request_id}
 *   GET    /devices/status                         → [{ serial_number, status: active|inactive|expired|unknown }]
 */

import { getServiceCredentials } from '../helpers/tenantCredentials.js';
import { fetchWithTimeout } from '../lib/http.js';

const CLIP_PINPAD = 'https://api.payclip.io/f2f/pinpad/v1';

/** Error carrying Clip's HTTP status + `code` so routes can branch on them. */
export class ClipApiError extends Error {
  constructor(op, status, body) {
    const code = body?.code || null;
    super(`Clip ${op} failed: ${status}${code ? ` ${code}` : ''}${body?.message ? ` — ${body.message}` : ''}`);
    this.name = 'ClipApiError';
    this.status = status;
    this.code = code;
    this.clipMessage = body?.message || null;
  }
}

async function readError(op, res) {
  let body = null;
  try {
    const text = await res.text();
    body = text ? JSON.parse(text) : null;
  } catch {
    // Non-JSON error body — status alone will have to do.
  }
  return new ClipApiError(op, res.status, body);
}

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
 * Tenant-level Clip settings that aren't secrets: the default reader serial
 * (used only to pre-select a reader on a workstation that never picked one)
 * and the agreed fee rate used to estimate processor fees in reports.
 */
export async function getClipSettings(tenantId) {
  const creds = await getServiceCredentials(tenantId, 'clip', {
    default_terminal_id: 'CLIP_DEFAULT_TERMINAL_ID',
    fee_percent: 'CLIP_FEE_PERCENT',
  });
  const fee = Number(creds.fee_percent);
  return {
    default_terminal_id: creds.default_terminal_id || null,
    fee_percent: Number.isFinite(fee) && fee >= 0 && fee < 100 ? fee : null,
  };
}

/**
 * Create a PinPad payment intent and push it to the reader.
 *
 * @param {string} authHeader  pre-built Basic auth header
 * @param {object} args
 * @param {number} args.amount       decimal MXN bill amount (e.g. 123.45)
 * @param {number} [args.tipAmount]  decimal MXN tip chosen at the POS
 * @param {string} args.reference    our correlation id
 * @param {string} args.serialNumber reader serial number (serial_number_pos)
 * @param {string} [args.webhookUrl] https URL Clip should notify on status change
 * @returns {Promise<{ pinpad_request_id: string, raw: object }>}
 */
export async function createPinPadPayment(authHeader, { amount, tipAmount = 0, reference, serialNumber, webhookUrl }) {
  const body = {
    amount: roundMoney(amount),
    reference,
    serial_number_pos: serialNumber,
    preferences: {
      // The tip is chosen on the POS before charging; a second tip screen on
      // the reader would let the customer tip twice.
      is_tip_enabled: false,
      // One POS charge = one card transaction, so amount_paid maps cleanly
      // onto the order. Splits are done in DK, not on the reader.
      is_split_payment_enabled: false,
    },
  };
  if (tipAmount > 0) body.tip_amount = roundMoney(tipAmount);
  if (webhookUrl) body.webhook_url = webhookUrl;

  const res = await fetchWithTimeout(`${CLIP_PINPAD}/payment`, {
    method: 'POST',
    headers: {
      Authorization: authHeader,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  }, 15000);

  if (!res.ok) throw await readError('createPinPadPayment', res);

  const data = await res.json();
  if (!data?.pinpad_request_id) {
    throw new ClipApiError('createPinPadPayment', res.status, { message: 'response had no pinpad_request_id' });
  }
  return { pinpad_request_id: data.pinpad_request_id, raw: data };
}

/**
 * Read a PinPad payment intent, including per-transaction detail (card
 * brand/last digits, net amount) via `Pinpad-Include-Detail`.
 *
 * @returns {Promise<object|null>} Clip's payment object, or null on 404
 */
export async function getPinPadPayment(authHeader, pinpadRequestId) {
  const url = `${CLIP_PINPAD}/payment?pinpadRequestId=${encodeURIComponent(pinpadRequestId)}`;
  const res = await fetchWithTimeout(url, {
    headers: {
      Authorization: authHeader,
      Accept: 'application/json',
      'Pinpad-Include-Detail': 'true',
    },
  });

  if (res.status === 404) return null;
  if (!res.ok) throw await readError('getPinPadPayment', res);
  return res.json();
}

/**
 * Cancel an intent the reader has not picked up yet.
 *
 * @returns {Promise<{ cancelled: true } | { cancelled: false, code: string|null }>}
 *   `cancelled: false` means Clip refused (400) — typically because the
 *   reader already took the intent. The caller MUST NOT treat the order as
 *   unpaid in that case; re-read the payment instead.
 */
export async function cancelPinPadPayment(authHeader, pinpadRequestId) {
  const res = await fetchWithTimeout(`${CLIP_PINPAD}/payment/${encodeURIComponent(pinpadRequestId)}`, {
    method: 'DELETE',
    headers: { Authorization: authHeader, Accept: 'application/json' },
  });

  if (res.ok) return { cancelled: true };
  if (res.status === 400 || res.status === 404) {
    const err = await readError('cancelPinPadPayment', res);
    return { cancelled: false, code: err.code };
  }
  throw await readError('cancelPinPadPayment', res);
}

/**
 * List the merchant's PinPad readers and their live connectivity.
 * `expired` = no heartbeat in the last 20s; `unknown` = PinPad feature off.
 *
 * @returns {Promise<Array<{ serial_number: string, status: string, updated_at: string|null }>>}
 */
export async function listPinPadDevices(authHeader) {
  const res = await fetchWithTimeout(`${CLIP_PINPAD}/devices/status`, {
    headers: { Authorization: authHeader, Accept: 'application/json' },
  });
  if (!res.ok) throw await readError('listPinPadDevices', res);
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return data
    .filter((d) => d && d.serial_number)
    .map((d) => ({
      serial_number: String(d.serial_number),
      status: String(d.status || 'unknown').toLowerCase(),
      updated_at: d.updated_at || null,
    }));
}

/**
 * Normalize a Clip PinPad payment into our taxonomy:
 * 'paid' | 'failed' | 'pending'.
 *
 * Final statuses per Clip support (sdk@payclip.com, 2026-09-28): Approved,
 * Canceled, Rejected, and TIMEOUT_CANCELED (kiosk mode only). The docs'
 * examples also show COMPLETED / PENDING / FAILED. Anything unrecognised is
 * treated as still pending (never paid, never failed) and logged by the
 * caller — a wrong 'failed' would free the order for a second charge while the
 * first may still settle.
 */
export function mapStatus(payment) {
  const raw = typeof payment === 'string' ? payment : payment?.status;
  if (!raw) return 'pending';
  const s = String(raw).toUpperCase();
  if (s === 'COMPLETED' || s === 'APPROVED' || s === 'PAID') return 'paid';
  if (
    s === 'FAILED' || s === 'DECLINED' || s === 'REJECTED' || s === 'ERROR' ||
    s === 'CANCELLED' || s === 'CANCELED' || s === 'TIMEOUT_CANCELED' ||
    s === 'EXPIRED' || s === 'DELETED'
  ) return 'failed';
  return 'pending';
}

/** True when mapStatus fell through on a value Clip hasn't documented. */
export function isKnownStatus(payment) {
  const s = String(payment?.status || '').toUpperCase();
  return [
    'COMPLETED', 'APPROVED', 'PAID',
    'FAILED', 'DECLINED', 'REJECTED', 'ERROR', 'CANCELLED', 'CANCELED', 'TIMEOUT_CANCELED', 'EXPIRED', 'DELETED',
    'PENDING', 'IN_PROGRESS', 'PROCESSING', 'CREATED',
  ].includes(s);
}

/**
 * Split a completed Clip payment into bill / tip / fee for order_payments.
 *
 * Fee: ESTIMATED from the tenant's configured rate (like non-integrated bank
 * terminals), or left null when no rate is set — never guessed. The PinPad
 * detail's `net_amount` is NOT net of fees: Clip support confirmed
 * (2026-09-28) it is sale + tip. The real per-transaction fee is only exposed
 * by Clip's Deposits API, and only for payouts to an external CLABE (not a
 * Clip digital account).
 *
 * @param {object} payment      Clip GET /payment response
 * @param {object} ctx
 * @param {number} ctx.orderTotal  order bill total (no tip)
 * @param {number} ctx.feePercent  tenant Clip fee rate, or null
 */
export function summarizeClipPayment(payment, { orderTotal, feePercent = null }) {
  const requested = toNumber(payment?.amount) ?? orderTotal;
  const results = Array.isArray(payment?.detail?.results) ? payment.detail.results : [];
  const approved = results.filter((r) => String(r?.status || '').toLowerCase() === 'approved');

  const paidFromDetail = approved.reduce((sum, r) => sum + (toNumber(r.paid_amount) ?? toNumber(r.amount) ?? 0), 0);
  const gross = roundMoney(toNumber(payment?.amount_paid) ?? (paidFromDetail || requested));
  const tip = roundMoney(Math.max(0, toNumber(payment?.tip_amount) ?? (gross - requested)));
  const bill = roundMoney(gross - tip);

  let fee = null;
  let feeSource = null;
  if (feePercent != null) {
    fee = roundMoney(gross * (feePercent / 100));
    feeSource = 'estimated_fee_percent';
  }

  const card = approved[0]?.payment_method || null;
  return {
    gross,
    bill,
    tip,
    fee,
    net: fee == null ? null : roundMoney(gross - fee),
    feeSource,
    card: card
      ? {
          brand: card.id || null,
          type: card.type || null,
          last4: card.card?.last_digits || null,
          issuer: card.card?.issuer || null,
        }
      : null,
  };
}

function toNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function roundMoney(n) {
  return Math.round(Number(n) * 100) / 100;
}
