import Stripe from 'stripe';
import { tenantContext } from './db/index.js';
import { getServiceCredentials } from './helpers/tenantCredentials.js';

const platformKey = process.env.STRIPE_SECRET_KEY;
if (!platformKey && process.env.NODE_ENV === 'production') {
  console.error('FATAL: STRIPE_SECRET_KEY is required in production.');
  process.exit(1);
}
const platformStripe = platformKey ? new Stripe(platformKey) : null;

// Tenant Stripe client cache (5-min TTL to pick up credential changes)
const _cache = new Map();

/**
 * Resolve the Stripe client for the current tenant (via AsyncLocalStorage).
 * Falls back to platform-level key when no tenant context or no tenant key stored.
 */
async function resolveStripe() {
  const tenantId = tenantContext.getStore()?.tenantId;
  if (!tenantId) {
    if (!platformStripe) throw new Error('Stripe is not configured (STRIPE_SECRET_KEY missing)');
    return platformStripe;
  }

  const cached = _cache.get(tenantId);
  if (cached && cached.ts > Date.now() - 300_000) return cached.client;

  const creds = await getServiceCredentials(tenantId, 'stripe', {
    secret_key: 'STRIPE_SECRET_KEY',
  });

  const key = creds.secret_key || platformKey;
  if (!key) throw new Error('Stripe is not configured (no platform or tenant key)');
  const client = key === platformKey && platformStripe ? platformStripe : new Stripe(key);
  _cache.set(tenantId, { client, ts: Date.now() });
  return client;
}

export async function createPaymentIntent(amount, metadata = {}) {
  try {
    const stripe = await resolveStripe();
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100), // Convert to centavos
      currency: 'mxn',
      automatic_payment_methods: { enabled: true },
      metadata,
    });
    return paymentIntent;
  } catch (error) {
    console.error('Error creating payment intent:', error);
    throw error;
  }
}

export async function createRefund(paymentIntentId, amount = null) {
  try {
    const stripe = await resolveStripe();
    const refund = await stripe.refunds.create({
      payment_intent: paymentIntentId,
      ...(amount && { amount: Math.round(amount * 100) }),
    });
    return refund;
  } catch (error) {
    console.error('Error creating refund:', error);
    throw error;
  }
}

export async function getPaymentIntent(id) {
  try {
    const stripe = await resolveStripe();
    const paymentIntent = await stripe.paymentIntents.retrieve(id);
    return paymentIntent;
  } catch (error) {
    console.error('Error retrieving payment intent:', error);
    throw error;
  }
}

/**
 * Get balance transactions for reconciliation
 */
export async function getBalanceTransactions(startDate, endDate) {
  try {
    const stripe = await resolveStripe();
    const params = { limit: 100 };
    if (startDate) params.created = { gte: Math.floor(new Date(startDate).getTime() / 1000) };
    if (endDate) {
      params.created = params.created || {};
      params.created.lte = Math.floor(new Date(endDate).getTime() / 1000);
    }
    const transactions = await stripe.balanceTransactions.list(params);
    return transactions.data;
  } catch (error) {
    console.error('Error fetching balance transactions:', error);
    throw error;
  }
}

/**
 * Get charge fees from a payment intent's balance transaction
 */
export async function getChargeFees(paymentIntentId) {
  try {
    const stripe = await resolveStripe();
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId, {
      expand: ['latest_charge.balance_transaction'],
    });
    const charge = pi.latest_charge;
    if (charge && charge.balance_transaction) {
      const bt = charge.balance_transaction;
      return {
        gross: bt.amount / 100,
        fee: bt.fee / 100,
        net: bt.net / 100,
        fee_details: bt.fee_details?.map(d => ({
          type: d.type,
          amount: d.amount / 100,
          description: d.description,
        })) || [],
      };
    }
    return { gross: 0, fee: 0, net: 0, fee_details: [] };
  } catch (error) {
    console.error('Error fetching charge fees:', error);
    return { gross: 0, fee: 0, net: 0, fee_details: [] };
  }
}

// Platform-level client — used by billing.js (SaaS subscriptions are platform-level)
export default platformStripe;
