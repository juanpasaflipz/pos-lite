import { Router } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { createTenant, getTenantByEmail, updateTenant } from '../tenants.js';
import { adminSql } from '../db/index.js';
import { sendPinEmail, sendPasswordResetEmail } from '../helpers/email.js';
import { audit } from '../lib/auditLog.js';
// Financing consent removed in pos-lite
const CONSENT_VERSION = '1.0';
const auditFinancing = () => {};

import { BCRYPT_ROUNDS, JWT_SECRET, JWT_OWNER_EXPIRY } from '../lib/constants.js';

const router = Router();

// Rate limiting: 5 registration attempts per IP per 15 minutes
const registerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many registration attempts. Please try again later.' },
});

// Rate limiting: 10 login attempts per IP per 15 minutes
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again later.' },
});

// Rate limiting: 3 forgot-password attempts per IP per 15 minutes
const forgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' },
});

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_OWNER_EXPIRY });
}

/**
 * Seed a newly created tenant with 1 example category and 2 example menu items
 * so the POS isn't completely empty on first login.
 */
async function seedNewTenant(tenantId) {
  const catRows = await adminSql`
    INSERT INTO menu_categories (name, sort_order, active, tenant_id)
    VALUES ('Platillos', 1, true, ${tenantId})
    RETURNING id
  `;
  const categoryId = catRows[0].id;

  await adminSql`
    INSERT INTO menu_items (category_id, name, price, description, active, is_example, tenant_id)
    VALUES
      (${categoryId}, 'Ejemplo: Taco de Res', 45, 'Platillo de ejemplo — edita o elimina desde el menú', true, true, ${tenantId}),
      (${categoryId}, 'Ejemplo: Agua de Jamaica', 25, 'Bebida de ejemplo — edita o elimina desde el menú', true, true, ${tenantId})
  `;
}

/**
 * POST /api/auth/register — create a new tenant account
 *
 * Body: { email, password, restaurant_name, subdomain? }
 * Returns: { token, tenant }
 */
router.post('/register', registerLimiter, async (req, res) => {
  try {
    const { email, password, restaurant_name, subdomain, primaryColor, logoUrl, promo_code, financing_consent } = req.body;

    if (!email || !password || !restaurant_name) {
      return res.status(400).json({ error: 'Required: email, password, restaurant_name' });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    // Check email uniqueness
    const existing = await getTenantByEmail(email);
    if (existing) {
      return res.status(409).json({ error: 'An account with this email already exists', code: 'EMAIL_EXISTS' });
    }

    // Generate a URL-safe slug from restaurant name
    const slug = (subdomain || restaurant_name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40);

    // Ensure slug uniqueness
    const existingSlug = await adminSql`SELECT id FROM tenants WHERE id = ${slug} OR subdomain = ${slug}`;
    if (existingSlug.length > 0) {
      return res.status(409).json({ error: `Subdomain '${slug}' is already taken` });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    // Build branding JSON if custom color or logo provided
    const branding = {};
    if (primaryColor) branding.primaryColor = primaryColor;
    if (logoUrl) branding.logoUrl = logoUrl;
    const branding_json = Object.keys(branding).length > 0 ? JSON.stringify(branding) : null;

    // Create tenant
    const tenant = await createTenant({
      id: slug,
      name: restaurant_name,
      subdomain: slug,
      owner_email: email,
      owner_password_hash: passwordHash,
      plan: 'free',
      branding_json,
    });

    // Save promo code if provided (will be applied when they subscribe)
    if (promo_code) {
      await updateTenant(slug, { signup_promo_code: promo_code.trim().toUpperCase() });
    }

    // Generate random 6-digit PIN for the admin employee
    const pin = String(Math.floor(100000 + Math.random() * 900000));
    const hashedPin = await bcrypt.hash(pin, BCRYPT_ROUNDS);

    // Create a default admin employee in the tenant DB (use adminSql with tenant_id)
    await adminSql`
      INSERT INTO employees (tenant_id, name, pin, role, active)
      VALUES (${slug}, ${email}, ${hashedPin}, 'admin', true)
    `;

    // Seed example menu category + items so POS isn't empty on first login
    await seedNewTenant(slug);

    // Record financing consent if opted in during registration
    if (financing_consent) {
      const ip = req.ip;
      const userAgent = req.headers['user-agent'] || '';
      const consentTypes = ['financial_data_analysis', 'financing_offers'];

      for (const consentType of consentTypes) {
        await adminSql`
          INSERT INTO data_processing_consent (tenant_id, consent_type, accepted, accepted_at, ip_address, user_agent, consent_version)
          VALUES (${slug}, ${consentType}, true, NOW(), ${ip}, ${userAgent}, ${CONSENT_VERSION})
        `;
      }

      await adminSql`
        UPDATE tenants
        SET financing_consent_at = NOW(),
            financing_consent_ip = ${ip},
            financing_consent_version = ${CONSENT_VERSION}
        WHERE id = ${slug}
      `;

      auditFinancing({
        tenantId: slug,
        actorType: 'owner',
        actorId: email,
        eventType: 'consent_granted',
        resource: 'financing_consent',
        details: { consent_types: consentTypes, version: CONSENT_VERSION, source: 'registration' },
        ip,
        userAgent,
      });
    }

    // Fire-and-forget email with PIN (include tenant subdomain for login URL)
    sendPinEmail(email, pin, restaurant_name, slug).catch(() => {});

    // Convert any matching lead (fire-and-forget)
    adminSql`
      UPDATE leads
      SET tenant_id = ${slug}, converted_at = NOW()
      WHERE email = ${email.trim().toLowerCase()} AND tenant_id IS NULL
    `.catch(() => {});

    // Sign JWT
    const token = signToken({
      tenantId: tenant.id,
      email: tenant.owner_email,
      role: 'owner',
      type: 'owner',
    });

    res.status(201).json({
      token,
      pin,
      tenant: {
        id: tenant.id,
        name: tenant.name,
        subdomain: tenant.subdomain,
        plan: tenant.plan,
      },
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

/**
 * POST /api/auth/login — owner login (separate from employee PIN login)
 *
 * Body: { email, password }
 * Returns: { token, tenant }
 */
router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Required: email, password' });
    }

    const tenant = await getTenantByEmail(email);
    if (!tenant) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    if (!tenant.active) {
      return res.status(403).json({ error: 'Account is inactive' });
    }

    const passwordMatch = await bcrypt.compare(password, tenant.owner_password_hash);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = signToken({
      tenantId: tenant.id,
      email: tenant.owner_email,
      role: 'owner',
      type: 'owner',
    });

    res.json({
      token,
      tenant: {
        id: tenant.id,
        name: tenant.name,
        subdomain: tenant.subdomain,
        plan: tenant.plan,
        branding: tenant.branding_json ? JSON.parse(tenant.branding_json) : null,
      },
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

/**
 * POST /api/auth/refresh — refresh JWT (requires valid token)
 */
router.post('/refresh', (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Token required' });
    }

    const decoded = jwt.verify(authHeader.slice(7), JWT_SECRET);

    const newToken = signToken({
      tenantId: decoded.tenantId,
      email: decoded.email,
      role: decoded.role,
      type: 'owner',
    });

    res.json({ token: newToken });
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    res.status(401).json({ error: 'Invalid token' });
  }
});

/**
 * POST /api/auth/forgot-password — request a password reset link
 *
 * Body: { email }
 * Always returns same message to prevent email enumeration.
 */
router.post('/forgot-password', forgotPasswordLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    // Always respond with the same success message
    const successMsg = { message: 'If an account with that email exists, a reset link has been sent.' };

    const tenant = await getTenantByEmail(email);
    if (!tenant || !tenant.active) {
      return res.json(successMsg);
    }

    // Generate 256-bit token
    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await updateTenant(tenant.id, {
      reset_token: token,
      reset_token_expires: expires.toISOString(),
    });

    const appUrl = process.env.APP_URL || 'https://pos.desktop.kitchen';
    const resetUrl = `${appUrl}/#/reset-password?token=${token}`;

    // Fire-and-forget
    sendPasswordResetEmail(email, resetUrl, tenant.name).catch(() => {});

    res.json(successMsg);
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

/**
 * POST /api/auth/reset-password — set a new password using a valid token
 *
 * Body: { token, new_password }
 */
router.post('/reset-password', async (req, res) => {
  try {
    const { token, new_password } = req.body;

    if (!token || !new_password) {
      return res.status(400).json({ error: 'Token and new password are required' });
    }

    if (new_password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    // Look up tenant by token
    const rows = await adminSql`
      SELECT id, name, reset_token_expires
      FROM tenants
      WHERE reset_token = ${token} AND active = true
    `;

    if (rows.length === 0) {
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    const tenant = rows[0];

    // Check expiry
    if (new Date(tenant.reset_token_expires) < new Date()) {
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    // Hash new password and clear token (single-use)
    const passwordHash = await bcrypt.hash(new_password, BCRYPT_ROUNDS);
    await updateTenant(tenant.id, {
      owner_password_hash: passwordHash,
      reset_token: null,
      reset_token_expires: null,
    });

    res.json({ message: 'Password has been reset successfully' });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

export default router;
