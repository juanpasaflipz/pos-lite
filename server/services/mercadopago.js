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
  const res = await fetch(`${MP}/point/integration-api/devices`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`MP getTerminals failed: ${res.status} ${text}`);
  }

  const data = await res.json();
  return (data.devices || []).filter(d => d.operating_mode === 'PDV');
}

/**
 * Create a Point order and push it to the terminal.
 */
export async function createPointOrder(accessToken, { amount, description, externalRef, terminalId }) {
  const res = await fetch(`${MP}/point/integration-api/devices/${terminalId}/payment-intents`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'X-Idempotency-Key': `dk-${externalRef}-${Date.now()}`,
    },
    body: JSON.stringify({
      amount: Math.round(amount * 100), // centavos
      description,
      external_reference: externalRef,
      print_on_terminal: true,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`MP createPointOrder failed: ${res.status} ${text}`);
  }

  return res.json();
}

/**
 * Cancel an active Point payment intent.
 */
export async function cancelPointOrder(accessToken, terminalId, paymentIntentId) {
  const res = await fetch(`${MP}/point/integration-api/devices/${terminalId}/payment-intents/${paymentIntentId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`MP cancelPointOrder failed: ${res.status} ${text}`);
  }
}
