import { Router } from 'express';
import Stripe from 'stripe';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import { adminSql } from '../db/index.js';
import { provisionPaidTenant } from '../lib/provisionPaidTenant.js';
import { JWT_SECRET, JWT_OWNER_EXPIRY } from '../lib/constants.js';

const router = Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_dummy');

const BASE_URL = process.env.APP_URL || 'https://pos.desktop.kitchen';
const LANDING_URL = process.env.LANDING_URL || 'https://www.desktop.kitchen';

// Price map for the public pay-first flow. `plan` stays 'pro' in the tenant
// row — founders is a PRICE (lifetime $799 MXN/mes), not a feature tier.
const PUBLIC_PRICES = {
  founders: () => process.env.STRIPE_PRICE_FOUNDERS || null,
  pro: () => process.env.STRIPE_PRICE_PRO || null,
};

const startLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many checkout attempts. Please try again later.' },
});

const claimLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60, // success page polls this while provisioning completes
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' },
});

/**
 * GET /api/public/checkout/start?price=founders
 *
 * One-click purchase entry point for marketing pages: a plain <a href> —
 * no auth, no form, no CORS. Creates a Stripe Checkout session (which
 * collects email, card, and restaurant name via a custom field) and 303s
 * the browser straight to Stripe. This endpoint is unauthenticated by
 * design, so a server-side redirect is fine here (the OAuth `{ auth_url }`
 * convention only applies to authenticated entry points).
 *
 * Append `&format=json` to get { url } instead of a redirect (for fetch()).
 */
router.get('/start', startLimiter, async (req, res) => {
  try {
    const priceKey = String(req.query.price || 'founders');
    const priceId = (PUBLIC_PRICES[priceKey] || (() => null))();
    if (!priceId) {
      return res.status(503).json({
        error: `Checkout is not configured for '${priceKey}' (missing Stripe price). Contact soporte@desktop.kitchen.`,
      });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      currency: 'mxn',
      line_items: [{ price: priceId, quantity: 1 }],
      custom_fields: [
        {
          key: 'restaurant_name',
          label: { type: 'custom', custom: 'Nombre de tu restaurante' },
          type: 'text',
          text: { maximum_length: 60 },
        },
      ],
      allow_promotion_codes: true,
      metadata: {
        flow: 'pay_first',
        plan: 'pro',
        price_key: priceKey,
      },
      success_url: `${BASE_URL}/#/onboarding?paid_session={CHECKOUT_SESSION_ID}`,
      cancel_url: `${LANDING_URL}/?checkout=cancelled`,
    });

    if (req.query.format === 'json') {
      return res.json({ url: session.url });
    }
    res.redirect(303, session.url);
  } catch (error) {
    console.error('[PayFirst] Checkout start error:', error);
    res.status(500).json({ error: 'Failed to start checkout' });
  }
});

/**
 * GET /api/public/checkout/claim?session_id=cs_...
 *
 * Success-page endpoint. Live-pulls the session from Stripe (never trusts
 * the webhook to have fired), verifies it is paid, provisions the tenant if
 * the webhook hasn't already, and returns everything the success screen
 * needs to drop the buyer straight into their POS:
 *
 *   { ready, created, subdomain, tenant_name, email, pin?, owner_token, login_url }
 *
 * `pin` is only present when THIS call provisioned the tenant (it is hashed
 * at rest); the welcome email always carries it regardless.
 *
 * Auth model: possession of the unguessable cs_… session id (only ever
 * delivered to the payer's browser by Stripe) — same trust level as the
 * existing demo_token flow. Claims are additionally limited to 24h after
 * session creation; after that the welcome email is the way in.
 */
router.get('/claim', claimLimiter, async (req, res) => {
  try {
    const sessionId = String(req.query.session_id || '');
    if (!/^cs_[a-zA-Z0-9_]+$/.test(sessionId)) {
      return res.status(400).json({ error: 'Invalid session id' });
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.metadata?.flow !== 'pay_first') {
      return res.status(400).json({ error: 'Not a pay-first checkout session' });
    }
    if (session.created && Date.now() / 1000 - session.created > 24 * 60 * 60) {
      return res.status(410).json({ error: 'Session expired — use the access link in your welcome email' });
    }
    if (session.status === 'open') {
      return res.json({ ready: false, status: 'open' });
    }
    const paidStatuses = ['paid', 'no_payment_required']; // latter: 100%-off promo / trial
    if (session.status !== 'complete' || !paidStatuses.includes(session.payment_status)) {
      return res.json({ ready: false, status: session.payment_status || session.status });
    }

    const email = session.customer_details?.email;
    if (!email) {
      return res.status(422).json({ error: 'No email on checkout session' });
    }
    const restaurantName = session.custom_fields?.find(f => f.key === 'restaurant_name')?.text?.value || '';

    const result = await provisionPaidTenant({
      email,
      restaurantName,
      plan: session.metadata?.plan || 'pro',
      stripeCustomerId: typeof session.customer === 'string' ? session.customer : session.customer?.id,
      stripeSubscriptionId: typeof session.subscription === 'string' ? session.subscription : session.subscription?.id,
    });

    const tenant = result.tenant;

    // Fresh short-lived magic-login token for the "Entrar a mi POS" button
    // (the provision-time token lives in the welcome email). Exchanged by the
    // existing /api/auth/demo-login endpoint via ?demo_token= on the tenant URL.
    let loginUrl = null;
    try {
      const [admin] = await adminSql`
        SELECT id FROM employees
        WHERE tenant_id = ${tenant.id} AND role = 'admin' AND active = true
        ORDER BY id ASC LIMIT 1
      `;
      if (admin) {
        const [tokenRow] = await adminSql`
          INSERT INTO demo_tokens (tenant_id, employee_id, expires_at)
          VALUES (${tenant.id}, ${admin.id}, NOW() + INTERVAL '30 minutes')
          RETURNING token
        `;
        loginUrl = `https://${tenant.subdomain}.desktop.kitchen/?demo_token=${tokenRow.token}`;
      }
    } catch (err) {
      console.error('[PayFirst] Could not mint login token:', err.message);
    }

    // Owner JWT so the success screen can run the menu-template / AI menu
    // setup steps immediately (same shape /api/auth/register returns).
    const ownerToken = jwt.sign(
      { tenantId: tenant.id, email: tenant.owner_email, role: 'owner', type: 'owner' },
      JWT_SECRET,
      { expiresIn: JWT_OWNER_EXPIRY }
    );

    res.json({
      ready: true,
      created: result.created,
      subdomain: tenant.subdomain,
      tenant_id: tenant.id,
      tenant_name: tenant.name,
      email: tenant.owner_email,
      pin: result.created ? result.pin : null,
      owner_token: ownerToken,
      login_url: loginUrl,
    });
  } catch (error) {
    if (error?.type === 'StripeInvalidRequestError') {
      return res.status(404).json({ error: 'Checkout session not found' });
    }
    console.error('[PayFirst] Claim error:', error);
    res.status(500).json({ error: 'Failed to claim checkout session' });
  }
});

export default router;
