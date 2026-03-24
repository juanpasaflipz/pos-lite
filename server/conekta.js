import { tenantContext } from './db/index.js';
import { getServiceCredentials } from './helpers/tenantCredentials.js';

const CONEKTA_API = 'https://api.conekta.io';
const platformKey = process.env.CONEKTA_PRIVATE_KEY || '';

// Tenant Conekta key cache (5-min TTL)
const _cache = new Map();

/**
 * Resolve the Conekta private key for the current tenant (via AsyncLocalStorage).
 * Falls back to platform-level key when no tenant context or no tenant key stored.
 */
async function resolveConektaKey() {
  const tenantId = tenantContext.getStore()?.tenantId;
  if (!tenantId) return platformKey;

  const cached = _cache.get(tenantId);
  if (cached && cached.ts > Date.now() - 300_000) return cached.key;

  const creds = await getServiceCredentials(tenantId, 'conekta', {
    private_key: 'CONEKTA_PRIVATE_KEY',
  });

  const key = creds.private_key || platformKey;
  _cache.set(tenantId, { key, ts: Date.now() });
  return key;
}

/**
 * Check if the current tenant (or platform) has Conekta configured.
 */
export async function isConektaConfigured(tenantId) {
  if (tenantId) {
    const creds = await getServiceCredentials(tenantId, 'conekta', {
      private_key: 'CONEKTA_PRIVATE_KEY',
    });
    return !!creds.private_key;
  }
  return !!platformKey;
}

/**
 * Make an authenticated request to the Conekta API.
 */
async function conektaRequest(method, path, body = null) {
  const key = await resolveConektaKey();
  if (!key) throw new Error('Conekta not configured');

  const headers = {
    Accept: 'application/vnd.conekta-v2.2.0+json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${key}`,
  };

  const options = { method, headers };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(`${CONEKTA_API}${path}`, options);
  const data = await res.json();

  if (!res.ok) {
    const msg = data?.details?.[0]?.message || data?.message || `Conekta API error ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.conektaError = data;
    throw err;
  }

  return data;
}

/**
 * Create a Conekta order with a card charge.
 */
export async function createCardOrder(amount, tokenId, metadata = {}, customerInfo = {}) {
  const centavos = Math.round(amount * 100);
  const order = await conektaRequest('POST', '/orders', {
    currency: 'MXN',
    customer_info: {
      name: customerInfo.name || 'POS Customer',
      email: customerInfo.email || 'pos@desktop.kitchen',
      phone: customerInfo.phone || '+5215500000000',
    },
    line_items: [{
      name: `Order ${metadata.order_number || ''}`.trim(),
      unit_price: centavos,
      quantity: 1,
    }],
    charges: [{
      payment_method: {
        type: 'card',
        token_id: tokenId,
      },
    }],
    metadata,
  });

  const charge = order.charges?.data?.[0];
  return {
    conekta_order_id: order.id,
    conekta_charge_id: charge?.id || null,
    status: charge?.status || order.payment_status,
  };
}

/**
 * Create a Conekta order with OXXO cash payment.
 * Returns the OXXO reference and barcode URL for the customer.
 */
export async function createOxxoOrder(amount, metadata = {}, customerInfo = {}, expiresHours = 72) {
  const centavos = Math.round(amount * 100);
  const expiresAt = Math.floor(Date.now() / 1000) + expiresHours * 3600;

  const order = await conektaRequest('POST', '/orders', {
    currency: 'MXN',
    customer_info: {
      name: customerInfo.name || 'POS Customer',
      email: customerInfo.email || 'pos@desktop.kitchen',
      phone: customerInfo.phone || '+5215500000000',
    },
    line_items: [{
      name: `Order ${metadata.order_number || ''}`.trim(),
      unit_price: centavos,
      quantity: 1,
    }],
    charges: [{
      payment_method: {
        type: 'oxxo_cash',
        expires_at: expiresAt,
      },
    }],
    metadata,
  });

  const charge = order.charges?.data?.[0];
  const pmDetail = charge?.payment_method;

  return {
    conekta_order_id: order.id,
    conekta_charge_id: charge?.id || null,
    reference: pmDetail?.reference || null,
    barcode_url: pmDetail?.barcode_url || null,
    expires_at: new Date(expiresAt * 1000).toISOString(),
  };
}

/**
 * Create a Conekta order with SPEI bank transfer.
 * Returns the CLABE for the customer to make the transfer.
 */
export async function createSpeiOrder(amount, metadata = {}, customerInfo = {}, expiresHours = 72) {
  const centavos = Math.round(amount * 100);
  const expiresAt = Math.floor(Date.now() / 1000) + expiresHours * 3600;

  const order = await conektaRequest('POST', '/orders', {
    currency: 'MXN',
    customer_info: {
      name: customerInfo.name || 'POS Customer',
      email: customerInfo.email || 'pos@desktop.kitchen',
      phone: customerInfo.phone || '+5215500000000',
    },
    line_items: [{
      name: `Order ${metadata.order_number || ''}`.trim(),
      unit_price: centavos,
      quantity: 1,
    }],
    charges: [{
      payment_method: {
        type: 'spei',
        expires_at: expiresAt,
      },
    }],
    metadata,
  });

  const charge = order.charges?.data?.[0];
  const pmDetail = charge?.payment_method;

  return {
    conekta_order_id: order.id,
    conekta_charge_id: charge?.id || null,
    clabe: pmDetail?.clabe || null,
    bank: pmDetail?.receiving_account_bank || 'STP',
    expires_at: new Date(expiresAt * 1000).toISOString(),
  };
}

/**
 * Refund a Conekta order (full or partial).
 */
export async function createConektaRefund(conektaOrderId, amount = null, reason = 'requested_by_customer') {
  const body = { reason };
  if (amount) body.amount = Math.round(amount * 100);

  const data = await conektaRequest('POST', `/orders/${conektaOrderId}/refunds`, body);
  return {
    refund_id: data.id,
    status: data.status,
    amount: data.amount ? data.amount / 100 : null,
  };
}

/**
 * Get a Conekta order by ID (for status checks).
 */
export async function getConektaOrder(conektaOrderId) {
  return conektaRequest('GET', `/orders/${conektaOrderId}`);
}
