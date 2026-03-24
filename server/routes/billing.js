import { Router } from 'express';
import Stripe from 'stripe';
import { requireOwner } from '../middleware/ownerAuth.js';
import { getTenant, updateTenant } from '../tenants.js';
import { adminSql } from '../db/index.js';

const router = Router();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_dummy');

const PRICE_IDS = {
  pro: process.env.STRIPE_PRICE_PRO || null,
};

const BASE_URL = process.env.APP_URL || 'https://pos.desktop.kitchen';

// ==================== Promo Code Cache (10-minute TTL) ====================
const promoCache = new Map(); // code -> { promotion_code_id, expires }
const PROMO_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

function cachePromo(code, promotionCodeId) {
  promoCache.set(code.toUpperCase(), {
    promotion_code_id: promotionCodeId,
    expires: Date.now() + PROMO_CACHE_TTL,
  });
}

function getCachedPromo(code) {
  const entry = promoCache.get(code.toUpperCase());
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    promoCache.delete(code.toUpperCase());
    return null;
  }
  return entry.promotion_code_id;
}

function buildDiscountDescription(coupon) {
  if (coupon.percent_off && coupon.duration === 'repeating') {
    return `${coupon.percent_off}% de descuento por ${coupon.duration_in_months} meses`;
  }
  if (coupon.percent_off && coupon.duration === 'forever') {
    return `${coupon.percent_off}% de descuento permanente`;
  }
  if (coupon.percent_off && coupon.duration === 'once') {
    return `${coupon.percent_off}% de descuento en el primer pago`;
  }
  if (coupon.amount_off) {
    return `${coupon.amount_off / 100} ${(coupon.currency || 'MXN').toUpperCase()} de descuento`;
  }
  return 'Descuento aplicado';
}

/**
 * Validate a promo code against Stripe and return the promotion code ID.
 * Returns { valid, promotionCodeId, code, discount_description } or { valid: false }.
 */
async function validatePromoWithStripe(code) {
  const results = await stripe.promotionCodes.list({
    code: code.toUpperCase(),
    active: true,
    limit: 1,
  });

  if (results.data.length === 0) {
    return { valid: false };
  }

  const promo = results.data[0];
  cachePromo(code, promo.id);

  return {
    valid: true,
    code: promo.code,
    promotion_code_id: promo.id,
    discount_description: buildDiscountDescription(promo.coupon),
  };
}

/**
 * Resolve a promo code string to a Stripe promotion_code_id.
 * Checks cache first, then re-validates with Stripe.
 */
async function resolvePromoCodeId(code) {
  const cached = getCachedPromo(code);
  if (cached) return cached;

  const result = await validatePromoWithStripe(code);
  if (!result.valid) return null;
  return result.promotion_code_id;
}

/**
 * GET /api/billing — current subscription status
 */
router.get('/', requireOwner, async (req, res) => {
  try {
    const tenant = await getTenant(req.owner.tenantId);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    res.json({
      plan: tenant.plan,
      subscription_status: tenant.subscription_status,
      stripe_customer_id: tenant.stripe_customer_id || null,
      stripe_subscription_id: tenant.stripe_subscription_id || null,
    });
  } catch (error) {
    console.error('Billing fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch billing info' });
  }
});

/**
 * POST /api/billing/checkout — create Stripe Checkout session for plan upgrade
 * Body: { plan: 'pro', promo_code?: string }
 */
router.post('/checkout', requireOwner, async (req, res) => {
  try {
    const { plan, promo_code } = req.body;
    const priceId = PRICE_IDS[plan];
    if (!priceId) {
      return res.status(400).json({ error: `Price not configured for plan: ${plan}` });
    }

    const tenant = await getTenant(req.owner.tenantId);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    // Create or reuse Stripe customer
    let customerId = tenant.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: tenant.owner_email,
        name: tenant.name,
        metadata: { tenant_id: tenant.id },
      });
      customerId = customer.id;
      await updateTenant(tenant.id, { stripe_customer_id: customerId });
    }

    // Resolve promo code: explicit body param > tenant's saved signup code
    let promotionCodeId = null;
    const codeToApply = promo_code || tenant.signup_promo_code;
    if (codeToApply) {
      promotionCodeId = await resolvePromoCodeId(codeToApply);
      if (promo_code && !promotionCodeId) {
        return res.status(400).json({ error: 'Código de descuento inválido' });
      }
    }

    // Create checkout session
    const sessionParams = {
      customer: customerId,
      mode: 'subscription',
      currency: 'mxn',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${BASE_URL}/#/admin?billing=success`,
      cancel_url: `${BASE_URL}/#/admin?billing=cancelled`,
      metadata: { tenant_id: tenant.id, plan, promo_code: codeToApply || '' },
    };

    if (promotionCodeId) {
      sessionParams.discounts = [{ promotion_code: promotionCodeId }];
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    res.json({ url: session.url });
  } catch (error) {
    console.error('Checkout error:', error);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

/**
 * POST /api/billing/portal — create Stripe Customer Portal session
 */
router.post('/portal', requireOwner, async (req, res) => {
  try {
    const tenant = await getTenant(req.owner.tenantId);
    if (!tenant?.stripe_customer_id) {
      return res.status(400).json({ error: 'No billing account. Subscribe to a plan first.' });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: tenant.stripe_customer_id,
      return_url: `${BASE_URL}/#/admin`,
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error('Portal error:', error);
    res.status(500).json({ error: 'Failed to create billing portal' });
  }
});

export default router;

/**
 * GET /api/billing/promo/validate — public promo code validation (no auth required).
 * Mounted separately before tenant middleware in server/index.js.
 */
export async function promoValidateHandler(req, res) {
  try {
    const code = (req.query.code || '').trim().toUpperCase();
    if (!code) {
      return res.json({ valid: false, message: 'Código inválido o expirado' });
    }

    const result = await validatePromoWithStripe(code);

    if (!result.valid) {
      return res.json({ valid: false, message: 'Código inválido o expirado' });
    }

    // Never expose promotion_code_id to the client
    res.json({
      valid: true,
      code: result.code,
      discount_description: result.discount_description,
    });
  } catch (error) {
    console.error('[Billing] Promo validation error:', error);
    res.json({ valid: false, message: 'Código inválido o expirado' });
  }
}

/**
 * Stripe webhook handler — must be mounted BEFORE express.json() body parser
 * to receive raw body for signature verification.
 *
 * Usage in server/index.js:
 *   import { stripeWebhook } from './routes/billing.js';
 *   app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), stripeWebhook);
 */
export async function stripeWebhook(req, res) {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.warn('[Billing] No STRIPE_WEBHOOK_SECRET configured — skipping webhook verification');
    return res.status(400).json({ error: 'Webhook secret not configured' });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('[Billing] Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  async function findTenantByCustomer(customerId) {
    const rows = await adminSql`SELECT * FROM tenants WHERE stripe_customer_id = ${customerId}`;
    return rows[0] || undefined;
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const tenantId = session.metadata?.tenant_id;
        const plan = session.metadata?.plan;
        if (tenantId && plan) {
          const updates = {
            plan,
            stripe_subscription_id: session.subscription,
            subscription_status: 'active',
            billing_interval: 'monthly',
          };
          // Save promo code used during signup/checkout
          const promoCode = session.metadata?.promo_code;
          if (promoCode) {
            updates.signup_promo_code = promoCode;
          }
          await updateTenant(tenantId, updates);

          // Auto-enable AI for paid plans
          if (plan === 'pro') {
            await adminSql`
              INSERT INTO ai_config (tenant_id, key, value, description)
              VALUES (${tenantId}, 'grok_api_enabled', '1', 'Enable Grok API for enhanced analysis')
              ON CONFLICT (tenant_id, key) DO UPDATE SET value = '1'
            `;
          }

          console.log(`[Billing] Tenant ${tenantId} upgraded to ${plan}${promoCode ? ` with promo ${promoCode}` : ''}`);
        }
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const tenant = await findTenantByCustomer(sub.customer);
        if (tenant) {
          await updateTenant(tenant.id, {
            subscription_status: sub.status === 'active' ? 'active' : sub.status,
            stripe_subscription_id: sub.id,
          });
          console.log(`[Billing] Tenant ${tenant.id} subscription status: ${sub.status}`);
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const tenant = await findTenantByCustomer(sub.customer);
        if (tenant) {
          await updateTenant(tenant.id, {
            plan: 'free',
            subscription_status: 'cancelled',
            stripe_subscription_id: null,
            subscription_cancelled_at: new Date().toISOString(),
          });

          // Disable AI on downgrade to free
          await adminSql`
            INSERT INTO ai_config (tenant_id, key, value, description)
            VALUES (${tenant.id}, 'grok_api_enabled', '0', 'Enable Grok API for enhanced analysis')
            ON CONFLICT (tenant_id, key) DO UPDATE SET value = '0'
          `;

          console.log(`[Billing] Tenant ${tenant.id} subscription cancelled`);
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const tenant = await findTenantByCustomer(invoice.customer);
        if (tenant) {
          await updateTenant(tenant.id, { subscription_status: 'past_due' });
          console.log(`[Billing] Tenant ${tenant.id} payment failed — marked past_due`);
        }
        break;
      }
    }

    res.json({ received: true });
  } catch (error) {
    console.error('[Billing] Webhook processing error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
}
