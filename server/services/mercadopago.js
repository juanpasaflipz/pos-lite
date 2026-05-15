/**
 * Mercado Pago Point integration service.
 * Uses the MP Orders API (unified API) for terminal payments.
 */

import { getServiceCredentials } from '../helpers/tenantCredentials.js';

const MP = 'https://api.mercadopago.com';

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

  const res = await fetch(`${MP}/oauth/token`, {
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
  const res = await fetch(`${MP}/terminals/v1/list?limit=50&offset=0`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (res.ok) {
    const data = await res.json();
    return (data.data?.terminals || []).filter(t => t.operating_mode === 'PDV');
  }

  // Fallback for accounts still exposed only through the legacy Point API.
  const legacy = await fetch(`${MP}/point/integration-api/devices`, {
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
 * Create a Point order and push it to the terminal.
 */
export async function createPointOrder(accessToken, { amount, externalRef, terminalId }) {
  const amountString = Number(amount).toFixed(2);
  const res = await fetch(`${MP}/v1/orders`, {
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
    const res = await fetch(`${MP}/v1/orders/${orderId}`, {
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

  const res = await fetch(`${MP}/point/integration-api/devices/${terminalId}/payment-intents/${orderId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`MP legacy getPointOrder failed: ${res.status} ${text}`);
  }

  return res.json();
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
    const res = await fetch(`${MP}/v1/orders/${paymentIntentId}/cancel`, {
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

  const res = await fetch(`${MP}/point/integration-api/devices/${terminalId}/payment-intents/${paymentIntentId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`MP cancelPointOrder failed: ${res.status} ${text}`);
  }
}
