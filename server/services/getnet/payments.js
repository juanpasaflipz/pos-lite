import crypto from 'crypto';
import { getAccessToken, getBaseUrl, getGetnetCredentials } from './auth.js';

/**
 * Make an authenticated request to the Getnet API.
 */
async function getnetRequest(tenantId, environment, method, path, body = null, extraHeaders = {}) {
  const token = await getAccessToken(tenantId, environment);
  const baseUrl = getBaseUrl(environment);

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    ...extraHeaders,
  };

  const options = { method, headers };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(`${baseUrl}${path}`, options);

  // Some Getnet endpoints return empty body on success
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    const msg = data?.message || data?.error_description || `Getnet API error ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.getnetError = data;
    throw err;
  }

  return data;
}

/**
 * Convert MXN amount to centavos (integer).
 */
function toCentavos(amount) {
  return Math.round(amount * 100);
}

/**
 * Create a card payment (auto-capture).
 */
export async function createPayment(tenantId, environment, {
  amount,
  orderId,
  orderNumber,
  cardToken,
  customerId,
  installments = 1,
}) {
  const creds = await getGetnetCredentials(tenantId);
  const idempotencyKey = crypto.randomUUID();
  const centavos = toCentavos(amount);

  const body = {
    seller_id: creds.merchant_id,
    amount: centavos,
    currency: 'MXN',
    order: {
      order_id: String(orderId),
      product_type: 'service',
    },
    credit: {
      delayed: false,
      authenticated: false,
      number_installments: installments,
      card: {
        number_token: cardToken,
      },
    },
    device: {},
  };

  if (customerId) {
    body.customer = { customer_id: customerId };
  }

  const data = await getnetRequest(
    tenantId,
    environment,
    'POST',
    '/dpm/payments-gwproxy/v2/payments',
    body,
    { idempotency_key: idempotencyKey }
  );

  return {
    getnet_payment_id: data.payment_id || data.id,
    idempotency_key: idempotencyKey,
    status: data.status,
    authorization_code: data.authorization_code || null,
    nsu: data.received_at || null,
    amount_centavos: centavos,
    card_brand: data.credit?.brand || null,
    card_last_four: data.credit?.last_four_digits || null,
    raw_response: data,
  };
}

/**
 * Create a pre-authorized payment (capture later).
 */
export async function preAuthorize(tenantId, environment, {
  amount,
  orderId,
  cardToken,
}) {
  const creds = await getGetnetCredentials(tenantId);
  const idempotencyKey = crypto.randomUUID();
  const centavos = toCentavos(amount);

  const body = {
    seller_id: creds.merchant_id,
    amount: centavos,
    currency: 'MXN',
    order: {
      order_id: String(orderId),
      product_type: 'service',
    },
    credit: {
      delayed: true,
      authenticated: false,
      number_installments: 1,
      card: {
        number_token: cardToken,
      },
    },
  };

  const data = await getnetRequest(
    tenantId,
    environment,
    'POST',
    '/dpm/payments-gwproxy/v2/payments',
    body,
    { idempotency_key: idempotencyKey }
  );

  return {
    getnet_payment_id: data.payment_id || data.id,
    idempotency_key: idempotencyKey,
    status: data.status,
    authorization_code: data.authorization_code || null,
    amount_centavos: centavos,
    raw_response: data,
  };
}

/**
 * Capture a pre-authorized payment.
 */
export async function capturePayment(tenantId, environment, paymentId, amount) {
  const centavos = toCentavos(amount);

  const data = await getnetRequest(
    tenantId,
    environment,
    'POST',
    '/dpm/payments-gwproxy/v2/payments/capture',
    { payment_id: paymentId, amount: centavos }
  );

  return {
    status: data.status,
    authorization_code: data.authorization_code || null,
    raw_response: data,
  };
}

/**
 * Refund a payment (full or partial).
 */
export async function refundPayment(tenantId, environment, paymentId, amount = null) {
  const body = { payment_id: paymentId };
  if (amount) body.amount = toCentavos(amount);

  const data = await getnetRequest(
    tenantId,
    environment,
    'POST',
    '/api/v1/refunds',
    body
  );

  return {
    refund_id: data.refund_id || data.id,
    status: data.status,
    amount: amount || (data.amount ? data.amount / 100 : null),
    raw_response: data,
  };
}

/**
 * Void/cancel a payment.
 */
export async function voidPayment(tenantId, environment, paymentId) {
  const data = await getnetRequest(
    tenantId,
    environment,
    'POST',
    `/dpm/payments-gwproxy/v2/payments/${paymentId}/cancel`,
    {}
  );

  return {
    status: data.status || 'cancelled',
    raw_response: data,
  };
}

/**
 * Tokenize a card number for secure storage.
 */
export async function tokenizeCard(tenantId, environment, {
  cardNumber,
  expirationMonth,
  expirationYear,
  securityCode,
  holderName,
}) {
  const creds = await getGetnetCredentials(tenantId);

  const data = await getnetRequest(
    tenantId,
    environment,
    'POST',
    '/v1/tokens/card',
    {
      card_number: cardNumber,
      expiration_month: expirationMonth,
      expiration_year: expirationYear,
      security_code: securityCode,
      cardholder_name: holderName,
      seller_id: creds.merchant_id,
    }
  );

  return {
    number_token: data.number_token,
    brand: data.brand || null,
    last_four: cardNumber.slice(-4),
  };
}
