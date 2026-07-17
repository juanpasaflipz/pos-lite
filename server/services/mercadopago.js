/**
 * Mercado Pago Point integration service.
 * Uses the MP Orders API (unified API) for terminal payments.
 */

import { getServiceCredentials } from '../helpers/tenantCredentials.js';
import { fetchWithTimeout } from '../lib/http.js';

const MP = 'https://api.mercadopago.com';

// MP Point /v1/orders rejects amounts under this floor (MXN). Below this the
// MP API returns HTTP 400 with a property_value error, which our pre-flight
// guards convert to a user-friendly message instead of letting it explode
// inside createPointOrder.
export const MP_POINT_MIN_AMOUNT = 5;

/**
 * Convert an error thrown by createPointOrder/getPointOrder into a structured
 * response for the client. Unwraps MP's error envelope so cashiers see the
 * real reason ("monto mínimo $5.00") instead of a generic "Failed to create
 * terminal payment".
 *
 * Returns { status, payload } — pass straight to res.status(...).json(...).
 *   - 400 when MP rejected our request (validation / business rule)
 *   - 502 when MP itself failed (5xx / network)
 *   - 500 for non-MP errors (DB, programming bugs)
 */
export function parseMpError(err) {
  const msg = err?.message || '';
  const match = msg.match(/^MP \w+ failed: (\d{3}) ([\s\S]*)$/);
  if (!match) {
    return { status: 500, payload: { error: msg || 'Error de Mercado Pago' } };
  }
  const upstreamStatus = Number(match[1]);
  const raw = match[2];
  let body = null;
  try { body = JSON.parse(raw); } catch { /* leave null */ }

  let detail = '';
  if (body?.errors?.[0]) {
    const e = body.errors[0];
    detail = (e.details?.[0] || e.message || '').toString();
    // MP prefixes property errors with a JSONPath like "'$.transactions.payments[0].amount' "
    detail = detail.replace(/^'[^']+'\s*/, '');
  } else if (body?.message) {
    detail = body.message;
  } else if (raw) {
    detail = String(raw).slice(0, 200);
  }

  const clientStatus = upstreamStatus >= 400 && upstreamStatus < 500 ? 400 : 502;
  return {
    status: clientStatus,
    payload: {
      error: detail || 'Mercado Pago rechazó el cobro',
      mp_status: upstreamStatus,
    },
  };
}

/**
 * Ensure the tenant's MP access token is fresh.
 * Refreshes if expiring within 5 minutes.
 * Uses tenant-level MP credentials with fallback to platform env vars.
 * @returns {Promise<string>} valid access_token
 */
export async function ensureFreshToken(tenant, adminSql) {
  const expiresAt = new Date(tenant.mp_token_expires_at);
  const fiveMinFromNow = new Date(Date.now() + 5 * 60 * 1000);
  if (expiresAt > fiveMinFromNow) return tenant.mp_access_token;

  // Resolve MP credentials: tenant-level first, then platform env vars
  const mpCreds = await getServiceCredentials(tenant.id, 'mercadopago', {
    client_id: 'MP_CLIENT_ID',
    client_secret: 'MP_CLIENT_SECRET',
  });

  const res = await fetchWithTimeout(`${MP}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_secret: mpCreds.client_secret,
      client_id: mpCreds.client_id,
      grant_type: 'refresh_token',
      refresh_token: tenant.mp_refresh_token,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`MP token refresh failed: ${res.status} ${text}`);
  }

  const data = await res.json();
  const { access_token, refresh_token, expires_in } = data;
  const newExpiry = new Date(Date.now() + expires_in * 1000);

  await adminSql`
    UPDATE tenants
    SET mp_access_token = ${access_token},
        mp_refresh_token = ${refresh_token},
        mp_token_expires_at = ${newExpiry}
    WHERE id = ${tenant.id}
  `;

  // Update the in-memory tenant object for subsequent calls in same request
  tenant.mp_access_token = access_token;
  tenant.mp_refresh_token = refresh_token;
  tenant.mp_token_expires_at = newExpiry;

  return access_token;
}

/**
 * List Point terminals in PDV (integrated) mode.
 */
export async function getTerminals(accessToken) {
  const res = await fetchWithTimeout(`${MP}/terminals/v1/list?limit=50&offset=0`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (res.ok) {
    const data = await res.json();
    return (data.data?.terminals || []).filter(t => t.operating_mode === 'PDV');
  }

  // Fallback for accounts still exposed only through the legacy Point API.
  const legacy = await fetchWithTimeout(`${MP}/point/integration-api/devices`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!legacy.ok) {
    const text = await legacy.text();
    throw new Error(`MP getTerminals failed: ${res.status}; legacy failed: ${legacy.status} ${text}`);
  }

  const legacyData = await legacy.json();
  return (legacyData.devices || []).filter(d => d.operating_mode === 'PDV');
}

/**
 * List ALL Point devices on the account regardless of operating mode.
 * Used for terminal setup: new devices ship in STANDALONE mode and are
 * invisible to getTerminals() until switched to PDV.
 *
 * Uses the new terminals API first so the setup list reflects the same
 * source of truth as getTerminals(); falls back to the legacy Point API.
 */
export async function getAllDevices(accessToken) {
  const res = await fetchWithTimeout(`${MP}/terminals/v1/list?limit=50&offset=0`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (res.ok) {
    const data = await res.json();
    const terminals = data.data?.terminals || [];
    if (terminals.length > 0) return terminals;
  }

  const legacy = await fetchWithTimeout(`${MP}/point/integration-api/devices`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!legacy.ok) {
    const text = await legacy.text();
    throw new Error(`MP getAllDevices failed: ${res.status}; legacy failed: ${legacy.status} ${text}`);
  }

  const data = await legacy.json();
  return data.devices || [];
}

/**
 * Switch a Point device's operating mode ('PDV' = integrated, 'STANDALONE').
 *
 * IMPORTANT: charges and terminal listing go through MP's NEW APIs
 * (/v1/orders, /terminals/v1/list), so the mode switch must go through the
 * matching /terminals/v1/setup endpoint — a legacy-only PATCH updates the old
 * API's view but leaves the terminal invisible to /terminals/v1/list (bug seen
 * live 2026-07-17: terminal "activated" but never appeared in the POS pickers).
 * Legacy PATCH is kept as a fallback for accounts not yet on the new API.
 * The device must be restarted afterwards for the change to take effect.
 * Note: MP allows only ONE PDV-mode terminal per point-of-sale (caja) — if the
 * new API rejects the switch, check the terminal's store/POS assignment in the
 * MP dashboard.
 */
export async function setDeviceOperatingMode(accessToken, deviceId, operatingMode) {
  const res = await fetchWithTimeout(`${MP}/terminals/v1/setup`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      terminals: [{ id: deviceId, operating_mode: operatingMode }],
    }),
  });

  if (res.ok) {
    const data = await res.json();
    return data.terminals?.[0] || { id: deviceId, operating_mode: operatingMode };
  }

  const newApiError = await res.text();

  // Fallback for accounts still exposed only through the legacy Point API.
  const legacy = await fetchWithTimeout(`${MP}/point/integration-api/devices/${deviceId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ operating_mode: operatingMode }),
  });

  if (!legacy.ok) {
    const text = await legacy.text();
    throw new Error(
      `MP setDeviceOperatingMode failed: ${res.status} ${newApiError}; legacy failed: ${legacy.status} ${text}`
    );
  }

  return legacy.json();
}

/**
 * Create a Point order and push it to the terminal.
 */
export async function createPointOrder(accessToken, { amount, externalRef, terminalId }) {
  const amountString = Number(amount).toFixed(2);
  const res = await fetchWithTimeout(`${MP}/v1/orders`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'X-Idempotency-Key': `dk-${externalRef}-${Date.now()}`,
    },
    body: JSON.stringify({
      type: 'point',
      external_reference: externalRef,
      expiration_time: 'PT16M',
      transactions: {
        payments: [{ amount: amountString }],
      },
      config: {
        point: {
          terminal_id: terminalId,
          print_on_terminal: 'no_ticket',
        },
        payment_method: {
          default_type: 'credit_card',
        },
      },
      description: `POS order ${externalRef}`,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`MP createPointOrder failed: ${res.status} ${text}`);
  }

  return res.json();
}

export async function getPointOrder(accessToken, orderId, terminalId = null) {
  if (String(orderId).startsWith('ORD')) {
    const res = await fetchWithTimeout(`${MP}/v1/orders/${orderId}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`MP getPointOrder failed: ${res.status} ${text}`);
    }

    return res.json();
  }

  if (!terminalId) {
    throw new Error('Missing terminal_id for legacy MP payment intent lookup');
  }

  const res = await fetchWithTimeout(`${MP}/point/integration-api/devices/${terminalId}/payment-intents/${orderId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`MP legacy getPointOrder failed: ${res.status} ${text}`);
  }

  return res.json();
}

/**
 * Fetch a single payment from MP's /v1/payments resource.
 * Used as a fallback when the Point /v1/orders response doesn't carry fee_details
 * (MP populates fees on the payment object, not always on the order).
 */
export async function getPayment(accessToken, paymentId) {
  const res = await fetchWithTimeout(`${MP}/v1/payments/${paymentId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`MP getPayment failed: ${res.status} ${text}`);
  }
  return res.json();
}

/**
 * Pull fee + net from a paid MP Point order. Tries the order payload first
 * (fee_details may be inline), then falls back to /v1/payments/{id}.
 *
 * Returns { fee, net, raw } with numbers (or null if unknown). `raw` is the
 * fullest response we got for forensics — stored as JSONB in order_payments.
 */
export async function extractMpFees(accessToken, mpOrder) {
  const payment = mpOrder?.transactions?.payments?.[0];
  if (!payment) return { fee: null, net: null, raw: mpOrder ?? null };

  const sumFees = (arr) =>
    (Array.isArray(arr) ? arr : []).reduce((s, f) => s + Number(f?.amount || 0), 0);

  if (Array.isArray(payment.fee_details) && payment.fee_details.length > 0) {
    const fee = sumFees(payment.fee_details);
    const amount = Number(payment.paid_amount ?? payment.amount ?? 0);
    return { fee, net: amount - fee, raw: payment };
  }

  if (payment.id && accessToken) {
    try {
      const detail = await getPayment(accessToken, payment.id);
      const fee = sumFees(detail?.fee_details);
      const amount = Number(detail?.transaction_amount ?? payment.amount ?? 0);
      const net =
        detail?.transaction_details?.net_received_amount != null
          ? Number(detail.transaction_details.net_received_amount)
          : amount - fee;
      return { fee, net, raw: detail };
    } catch (err) {
      // Non-fatal — we still record the payment, just without fee data.
      return { fee: null, net: null, raw: payment, fetchError: err.message };
    }
  }

  return { fee: null, net: null, raw: payment };
}

export function mapPointOrderStatus(order) {
  const payment = order?.transactions?.payments?.[0];
  const status = String(payment?.status || order?.status || '').toLowerCase();
  const detail = String(payment?.status_detail || order?.status_detail || '').toLowerCase();

  if (['processed', 'approved', 'paid'].includes(status)) return 'paid';
  if (['canceled', 'cancelled', 'rejected', 'failed', 'expired'].includes(status)) return 'failed';
  if (['canceled', 'cancelled', 'rejected', 'failed', 'expired'].includes(detail)) return 'failed';

  // Legacy payment-intents API returns FINISHED / ERROR state.
  const state = String(order?.state || '').toUpperCase();
  if (state === 'FINISHED') return 'paid';
  if (state === 'CANCELED' || state === 'CANCELLED' || state === 'ERROR') return 'failed';

  return 'pending';
}

/**
 * Cancel an active Point payment intent.
 */
export async function cancelPointOrder(accessToken, terminalId, paymentIntentId) {
  if (String(paymentIntentId).startsWith('ORD')) {
    const res = await fetchWithTimeout(`${MP}/v1/orders/${paymentIntentId}/cancel`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': `dk-cancel-${paymentIntentId}-${Date.now()}`,
      },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`MP cancelPointOrder failed: ${res.status} ${text}`);
    }

    return;
  }

  const res = await fetchWithTimeout(`${MP}/point/integration-api/devices/${terminalId}/payment-intents/${paymentIntentId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`MP cancelPointOrder failed: ${res.status} ${text}`);
  }
}

// MP error 2205 = "There is already a queued intent for the device".
// Match on either the code or the message — MP has been known to vary the format.
export function isQueueStuckError(err) {
  const msg = err?.message || '';
  return /\b2205\b/.test(msg) || /queued intent/i.test(msg);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Clear MP Point queued intents that are blocking new charges for a tenant.
 *
 * Looks up orders in `pending_terminal` state with an `mp_order_id`, then DELETEs
 * each intent on every device on the account (covers the case where a stuck intent
 * lives on the OLD device after a terminal swap). Resets the order locally
 * regardless of MP's response, so the order can be retried fresh.
 *
 * Returns { cleared, attempted } where `cleared` is the count actually killed on MP
 * (200/404), and `attempted` is the total stuck orders found.
 *
 * Spaces calls ~3s apart to dodge MP's per-token rate limit (429 error 105).
 */
export async function recoverStuckQueue(accessToken, { tenantId, sql }) {
  const stuck = await sql`
    SELECT id, mp_order_id
    FROM orders
    WHERE tenant_id = ${tenantId}
      AND payment_status = 'pending_terminal'
      AND mp_order_id IS NOT NULL
  `;

  if (stuck.length === 0) return { cleared: 0, attempted: 0 };

  let devices = [];
  try {
    devices = (await getAllDevices(accessToken)).map((d) => d.id);
  } catch {
    // If we can't list devices, we can't DELETE on MP — but we can still reset orders locally.
  }

  let cleared = 0;

  for (let i = 0; i < stuck.length; i++) {
    const order = stuck[i];
    let killed = false;

    for (const device of devices) {
      try {
        const res = await fetchWithTimeout(
          `${MP}/point/integration-api/devices/${device}/payment-intents/${order.mp_order_id}`,
          { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } }
        );
        if (res.ok || res.status === 404) {
          killed = true;
          break;
        }
        if (res.status === 429) {
          await sleep(3500);
        }
      } catch {
        // network glitch — try next device
      }
    }

    await sql`
      UPDATE orders
      SET mp_order_id = NULL, payment_status = 'pending'
      WHERE id = ${order.id}
    `;

    if (killed) cleared++;
    if (i < stuck.length - 1) await sleep(3000);
  }

  return { cleared, attempted: stuck.length };
}
