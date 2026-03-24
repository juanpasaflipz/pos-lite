import { Router } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { adminSql } from '../db/index.js';
import { createTenant, getTenantByEmail } from '../tenants.js';
import { sendPinEmail } from '../helpers/email.js';
import { generateDemoData } from '../lib/demoDataGenerator.js';
import { BCRYPT_ROUNDS, JWT_SECRET, JWT_EMPLOYEE_EXPIRY, JWT_OWNER_EXPIRY } from '../lib/constants.js';

const router = Router();

// Rate limiting: 3 demo provisions per IP per 15 minutes
const demoLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many demo requests. Please try again later.' },
});

// Rate limiting: 10 demo-login attempts per IP per 15 minutes
const demoLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again later.' },
});

/**
 * POST /api/demo/provision — create a demo tenant with auto-login token
 *
 * Body: { name, email, restaurant_name, phone? }
 * Returns: { success, subdomain, demo_token } or { existing, subdomain }
 */
router.post('/provision', demoLimiter, async (req, res) => {
  try {
    const { name, email, restaurant_name, phone } = req.body;

    if (!name || !email || !restaurant_name) {
      return res.status(400).json({ error: 'Required: name, email, restaurant_name' });
    }

    if (!email.includes('@')) {
      return res.status(400).json({ error: 'Valid email is required' });
    }

    const cleanEmail = email.trim().toLowerCase();

    // Check if email already has a tenant
    const existing = await getTenantByEmail(cleanEmail);
    if (existing) {
      return res.status(409).json({
        existing: true,
        subdomain: existing.subdomain,
        message: 'An account with this email already exists',
      });
    }

    // Generate URL-safe slug from restaurant name
    let slug = restaurant_name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40);

    // Ensure slug uniqueness — append random suffix if collision
    const existingSlug = await adminSql`SELECT id FROM tenants WHERE id = ${slug} OR subdomain = ${slug}`;
    if (existingSlug.length > 0) {
      slug = `${slug}-${crypto.randomBytes(3).toString('hex')}`;
    }

    // Generate random password (user never sees this — PIN login only)
    const password = crypto.randomBytes(16).toString('hex');
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    // Create tenant (plan='free')
    const tenant = await createTenant({
      id: slug,
      name: restaurant_name,
      subdomain: slug,
      owner_email: cleanEmail,
      owner_password_hash: passwordHash,
      plan: 'free',
    });

    // Generate random 6-digit PIN for admin employee
    const pin = String(Math.floor(100000 + Math.random() * 900000));
    const hashedPin = await bcrypt.hash(pin, BCRYPT_ROUNDS);

    // Create admin employee
    const [employee] = await adminSql`
      INSERT INTO employees (tenant_id, name, pin, role, active)
      VALUES (${slug}, ${name}, ${hashedPin}, 'admin', true)
      RETURNING id
    `;

    // Generate demo_token (UUID, 15-min TTL)
    const [tokenRow] = await adminSql`
      INSERT INTO demo_tokens (tenant_id, employee_id, expires_at)
      VALUES (${slug}, ${employee.id}, NOW() + INTERVAL '15 minutes')
      RETURNING token
    `;

    // Upsert lead (source='demo_landing')
    const existingLead = await adminSql`SELECT id FROM leads WHERE email = ${cleanEmail}`;
    if (existingLead.length > 0) {
      await adminSql`
        UPDATE leads SET
          restaurant_name = COALESCE(${restaurant_name}, restaurant_name),
          name = COALESCE(${name}, leads.name),
          phone = COALESCE(${phone || null}, phone),
          source = 'demo_landing'
        WHERE email = ${cleanEmail}
      `;
    } else {
      await adminSql`
        INSERT INTO leads (restaurant_name, name, email, phone, source)
        VALUES (${restaurant_name}, ${name}, ${cleanEmail}, ${phone || null}, 'demo_landing')
      `;
    }

    // Fire-and-forget: send PIN email
    sendPinEmail(cleanEmail, pin, restaurant_name, slug).catch(() => {});

    // Fire-and-forget: generate demo data
    (async () => {
      try {
        // Seed example menu first (same as registration flow)
        const catRows = await adminSql`
          INSERT INTO menu_categories (name, sort_order, active, tenant_id)
          VALUES ('Platillos', 1, true, ${slug})
          ON CONFLICT DO NOTHING
          RETURNING id
        `;
        if (catRows.length > 0) {
          const categoryId = catRows[0].id;
          await adminSql`
            INSERT INTO menu_items (category_id, name, price, description, active, is_example, tenant_id)
            VALUES
              (${categoryId}, 'Ejemplo: Taco de Res', 45, 'Platillo de ejemplo', true, true, ${slug}),
              (${categoryId}, 'Ejemplo: Agua de Jamaica', 25, 'Bebida de ejemplo', true, true, ${slug})
          `;
        }

        const [run] = await adminSql`
          INSERT INTO stress_test_runs (tenant_id, config)
          VALUES (${slug}, ${JSON.stringify({ volume: 'medium', date_range_days: 30, source: 'demo_provision' })})
          RETURNING id
        `;

        const summary = await generateDemoData(adminSql, {
          tenantId: slug,
          batchId: run.id,
          volume: 'medium',
          dateRangeDays: 30,
          includeDelivery: true,
          includeLoyalty: true,
          includeAi: true,
          includeFinancials: true,
        });

        await adminSql`UPDATE stress_test_runs SET summary = ${JSON.stringify(summary)} WHERE id = ${run.id}`;
        console.log(`[Demo] Demo data generated for tenant ${slug}`);
      } catch (err) {
        console.error(`[Demo] Failed to generate demo data for ${slug}:`, err.message);
      }
    })();

    res.status(201).json({
      success: true,
      subdomain: slug,
      demo_token: tokenRow.token,
    });
  } catch (error) {
    console.error('[Demo] Provision error:', error);
    res.status(500).json({ error: 'Failed to provision demo' });
  }
});

/**
 * POST /api/auth/demo-login — exchange a demo_token for JWT tokens
 *
 * Body: { demo_token }
 * Returns: { owner_token, employee_token, tenant, pin_hint }
 */
router.post('/demo-login', demoLoginLimiter, async (req, res) => {
  try {
    const { demo_token } = req.body;

    if (!demo_token) {
      return res.status(400).json({ error: 'demo_token is required' });
    }

    // Look up token
    const [tokenRow] = await adminSql`
      SELECT dt.*, t.name AS tenant_name, t.subdomain, t.plan,
             e.name AS employee_name, e.role AS employee_role
      FROM demo_tokens dt
      JOIN tenants t ON t.id = dt.tenant_id
      JOIN employees e ON e.id = dt.employee_id AND e.tenant_id = dt.tenant_id
      WHERE dt.token = ${demo_token}
    `;

    if (!tokenRow) {
      return res.status(401).json({ error: 'Invalid or expired demo token' });
    }

    // Check expiry
    if (new Date(tokenRow.expires_at) < new Date()) {
      // Clean up expired token
      await adminSql`DELETE FROM demo_tokens WHERE token = ${demo_token}`;
      return res.status(401).json({ error: 'Demo token has expired' });
    }

    // Delete token (single-use)
    await adminSql`DELETE FROM demo_tokens WHERE token = ${demo_token}`;

    // Sign owner JWT
    const ownerToken = jwt.sign(
      { tenantId: tokenRow.tenant_id, email: '', role: 'owner', type: 'owner' },
      JWT_SECRET,
      { expiresIn: JWT_OWNER_EXPIRY }
    );

    // Sign employee JWT
    const employeeToken = jwt.sign(
      { employeeId: tokenRow.employee_id, tenantId: tokenRow.tenant_id, role: tokenRow.employee_role },
      JWT_SECRET,
      { expiresIn: JWT_EMPLOYEE_EXPIRY }
    );

    res.json({
      owner_token: ownerToken,
      employee_token: employeeToken,
      tenant: {
        id: tokenRow.tenant_id,
        name: tokenRow.tenant_name,
        subdomain: tokenRow.subdomain,
        plan: tokenRow.plan,
      },
      employee: {
        id: tokenRow.employee_id,
        name: tokenRow.employee_name,
        role: tokenRow.employee_role,
      },
    });
  } catch (error) {
    console.error('[Demo] Demo-login error:', error);
    res.status(500).json({ error: 'Failed to authenticate demo token' });
  }
});

export default router;
