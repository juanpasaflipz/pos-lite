import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { adminSql } from '../db/index.js';
import { createTenant, getTenantByEmail, updateTenant } from '../tenants.js';
import { seedNewTenant } from './seedNewTenant.js';
import { sendFoundersWelcomeEmail } from '../helpers/email.js';
import { BCRYPT_ROUNDS } from './constants.js';

const WELCOME_TOKEN_TTL_DAYS = 7;
const PASSWORD_LINK_TTL_DAYS = 7;

/**
 * Idempotently turn a completed pay-first Stripe Checkout into a live tenant.
 *
 * Called from BOTH the Stripe webhook (checkout.session.completed) and the
 * success-page claim endpoint (live-pull fallback — repo rule: never depend
 * on webhooks alone). Whoever arrives first provisions; the other finds the
 * existing tenant and returns it. Serialized per-email with an advisory
 * transaction lock so the two paths can't double-create.
 *
 * If the email already belongs to a tenant (e.g. an existing free-plan user
 * buying from the landing page), the subscription is attached to that tenant
 * instead of creating a duplicate.
 *
 * Returns { tenant, created, pin?, loginToken?, passwordToken? }.
 * pin / loginToken / passwordToken are only present when created === true —
 * the PIN is bcrypt-hashed at rest and cannot be recovered later.
 */
export async function provisionPaidTenant({
  email,
  restaurantName,
  plan = 'pro',
  stripeCustomerId,
  stripeSubscriptionId,
  promoCode,
  slug: slugOverride, // trusted internal callers/tests only
  sendEmail = true,
}) {
  if (!email || !email.includes('@')) {
    throw new Error('provisionPaidTenant: valid email is required');
  }
  const cleanEmail = email.trim().toLowerCase();

  return adminSql.begin(async (sql) => {
    // Serialize concurrent provision attempts (webhook vs claim) per email.
    // Lock is released automatically when this transaction commits.
    await sql`SELECT pg_advisory_xact_lock(hashtext(${cleanEmail}))`;

    // ── Existing tenant: attach the subscription, don't duplicate ──
    const existing = await getTenantByEmail(cleanEmail);
    if (existing) {
      const updates = {};
      if (stripeCustomerId && !existing.stripe_customer_id) updates.stripe_customer_id = stripeCustomerId;
      if (stripeSubscriptionId && existing.stripe_subscription_id !== stripeSubscriptionId) {
        updates.stripe_subscription_id = stripeSubscriptionId;
      }
      if (existing.plan !== plan) updates.plan = plan;
      if (existing.subscription_status !== 'active') updates.subscription_status = 'active';
      if (!existing.billing_interval) updates.billing_interval = 'monthly';
      if (Object.keys(updates).length > 0) await updateTenant(existing.id, updates);
      await enableAi(existing.id);
      console.log(`[PayFirst] Attached subscription ${stripeSubscriptionId || '(none)'} to existing tenant ${existing.id}`);
      return { tenant: { ...existing, ...updates }, created: false };
    }

    // ── Fresh tenant ──
    const name = (restaurantName || '').trim() || cleanEmail.split('@')[0];
    let slug = slugOverride || name
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip accents
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40);
    if (!slug) slug = `resto-${crypto.randomBytes(3).toString('hex')}`;

    // Ensure slug uniqueness — append a random suffix on collision.
    const slugTaken = await adminSql`SELECT id FROM tenants WHERE id = ${slug} OR subdomain = ${slug}`;
    if (slugTaken.length > 0) {
      slug = `${slug.slice(0, 33)}-${crypto.randomBytes(3).toString('hex')}`;
    }

    // Owner password: random placeholder. The welcome email carries a
    // create-your-password link (reset_token flow) so the owner sets a real
    // one without ever seeing this value.
    const passwordHash = await bcrypt.hash(crypto.randomBytes(16).toString('hex'), BCRYPT_ROUNDS);

    const tenant = await createTenant({
      id: slug,
      name,
      subdomain: slug,
      owner_email: cleanEmail,
      owner_password_hash: passwordHash,
      plan,
    });

    const passwordToken = crypto.randomBytes(32).toString('hex');
    await updateTenant(slug, {
      subscription_status: 'active',
      billing_interval: 'monthly',
      ...(stripeCustomerId ? { stripe_customer_id: stripeCustomerId } : {}),
      ...(stripeSubscriptionId ? { stripe_subscription_id: stripeSubscriptionId } : {}),
      ...(promoCode ? { signup_promo_code: String(promoCode).trim().toUpperCase() } : {}),
      reset_token: passwordToken,
      reset_token_expires: new Date(Date.now() + PASSWORD_LINK_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString(),
    });

    // Admin employee with a fresh 4-digit PIN
    const pin = String(crypto.randomInt(1000, 10000));
    const hashedPin = await bcrypt.hash(pin, BCRYPT_ROUNDS);
    const [employee] = await adminSql`
      INSERT INTO employees (tenant_id, name, pin, role, active)
      VALUES (${slug}, ${cleanEmail}, ${hashedPin}, 'admin', true)
      RETURNING id
    `;

    // Example menu so the POS isn't empty on first login
    await seedNewTenant(slug);

    // Paid plans get AI enabled (mirrors the billing webhook behavior)
    await enableAi(slug);

    // Single-use magic-login token (same table + exchange endpoint the demo
    // flow uses — /api/auth/demo-login). Long TTL: this is the welcome-email
    // link the owner may click days later.
    const [tokenRow] = await adminSql`
      INSERT INTO demo_tokens (tenant_id, employee_id, expires_at)
      VALUES (${slug}, ${employee.id}, NOW() + make_interval(days => ${WELCOME_TOKEN_TTL_DAYS}))
      RETURNING token
    `;

    // Convert any matching marketing lead (non-critical)
    adminSql`
      UPDATE leads
      SET tenant_id = ${slug}, converted_at = NOW()
      WHERE email = ${cleanEmail} AND tenant_id IS NULL
    `.catch(() => {});

    if (sendEmail) {
      sendFoundersWelcomeEmail({
        email: cleanEmail,
        restaurantName: name,
        subdomain: slug,
        pin,
        loginToken: tokenRow.token,
        passwordToken,
      }).catch(() => {});
    }

    console.log(`[PayFirst] Provisioned tenant ${slug} for ${cleanEmail} (plan=${plan})`);
    return {
      tenant: await refreshTenant(slug),
      created: true,
      pin,
      loginToken: tokenRow.token,
      passwordToken,
      employeeId: employee.id,
    };
  });
}

async function refreshTenant(tenantId) {
  const rows = await adminSql`SELECT * FROM tenants WHERE id = ${tenantId}`;
  return rows[0];
}

async function enableAi(tenantId) {
  try {
    await adminSql`
      INSERT INTO ai_config (tenant_id, key, value, description)
      VALUES (${tenantId}, 'grok_api_enabled', '1', 'Enable Grok API for enhanced analysis')
      ON CONFLICT (tenant_id, key) DO UPDATE SET value = '1'
    `;
  } catch (err) {
    console.error(`[PayFirst] Could not enable AI for ${tenantId}:`, err.message);
  }
}
