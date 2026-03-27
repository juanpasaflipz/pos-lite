import { Router } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { adminSql } from '../db/index.js';
import { createTenant, getTenant, getTenantByEmail } from '../tenants.js';
import { generateDemoData } from '../lib/demoDataGenerator.js';
import { sendPinEmail } from '../helpers/email.js';
import { requireSalesAuth } from '../middleware/salesAuth.js';
import { BCRYPT_ROUNDS } from '../lib/constants.js';

const CONSENT_VERSION = '1.0';

const router = Router();

router.use(requireSalesAuth());

// ── Check subdomain/email availability ──
router.get('/check-availability', async (req, res) => {
  try {
    const { subdomain, email } = req.query;

    const result = { subdomain_available: true, email_available: true };

    if (subdomain) {
      const [existing] = await adminSql`SELECT id FROM tenants WHERE subdomain = ${subdomain} OR id = ${subdomain}`;
      result.subdomain_available = !existing;
    }

    if (email) {
      const cleanEmail = email.toString().trim().toLowerCase();
      const [existing] = await adminSql`SELECT id FROM tenants WHERE owner_email = ${cleanEmail}`;
      result.email_available = !existing;
    }

    res.json(result);
  } catch (err) {
    console.error('[SalesOnboard] Check availability error:', err.message);
    res.status(500).json({ error: 'Failed to check availability' });
  }
});

// ── Full onboarding wizard ──
router.post('/', async (req, res) => {
  try {
    const {
      restaurant_name,
      owner_name,
      owner_email,
      owner_phone,
      subdomain,
      plan = 'pro',
      branding,
      generate_demo_data = false,
      financing_consent = false,
    } = req.body;

    // Validate required fields
    if (!restaurant_name || !owner_name || !owner_email || !subdomain) {
      return res.status(400).json({
        error: 'Required: restaurant_name, owner_name, owner_email, subdomain',
      });
    }

    const cleanEmail = owner_email.trim().toLowerCase();
    const tenantId = subdomain.toLowerCase().replace(/[^a-z0-9-]/g, '-');

    // Check uniqueness
    const [existingTenant] = await adminSql`SELECT id FROM tenants WHERE id = ${tenantId} OR subdomain = ${tenantId}`;
    if (existingTenant) {
      return res.status(409).json({ error: 'Subdomain already taken' });
    }

    const [existingEmail] = await adminSql`SELECT id FROM tenants WHERE owner_email = ${cleanEmail}`;
    if (existingEmail) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    // Generate random owner password and employee PIN
    const ownerPassword = crypto.randomBytes(6).toString('hex'); // 12-char random
    const pin = String(Math.floor(100000 + Math.random() * 900000)); // 6-digit PIN
    const ownerHash = await bcrypt.hash(ownerPassword, BCRYPT_ROUNDS);
    const pinHash = await bcrypt.hash(pin, BCRYPT_ROUNDS);

    // Create tenant
    const brandingJson = branding ? JSON.stringify(branding) : null;
    await createTenant({
      id: tenantId,
      name: restaurant_name,
      subdomain: tenantId,
      owner_email: cleanEmail,
      owner_password_hash: ownerHash,
      plan,
      branding_json: brandingJson,
    });

    // Create admin employee
    const [employee] = await adminSql`
      INSERT INTO employees (tenant_id, name, pin, role, active)
      VALUES (${tenantId}, ${owner_name}, ${pinHash}, 'admin', true)
      RETURNING id, name, role
    `;

    // Generate demo token for instant access (token column is UUID)
    const demoToken = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
    await adminSql`
      INSERT INTO demo_tokens (tenant_id, token, employee_id, expires_at)
      VALUES (${tenantId}, ${demoToken}::uuid, ${employee.id}, ${expiresAt})
    `;

    // Send PIN email
    try {
      await sendPinEmail(cleanEmail, owner_name, pin, restaurant_name);
    } catch (emailErr) {
      console.error('[SalesOnboard] Email send failed:', emailErr.message);
    }

    // Optionally generate demo data
    if (generate_demo_data) {
      try {
        await generateDemoData(adminSql, {
          tenantId,
          volume: 'medium',
          dateRangeDays: 14,
          includeDelivery: false,
          includeLoyalty: false,
          includeFinancials: true,
        });
      } catch (demoErr) {
        console.error('[SalesOnboard] Demo data gen failed:', demoErr.message);
      }
    }

    // Update lead to converted (if exists)
    await adminSql`
      UPDATE leads SET
        status = 'converted',
        tenant_id = ${tenantId},
        converted_at = NOW(),
        assigned_rep_id = COALESCE(assigned_rep_id, ${req.salesRep.id})
      WHERE email = ${cleanEmail}
    `;

    // Create commission entry
    await adminSql`
      INSERT INTO sales_commissions (rep_id, tenant_id, commission_percent, duration_months, start_date)
      VALUES (${req.salesRep.id}, ${tenantId}, 10.00, 12, CURRENT_DATE)
      ON CONFLICT (rep_id, tenant_id) DO NOTHING
    `;

    // Record financing consent if opted in
    if (financing_consent) {
      const ip = req.ip;
      const userAgent = req.headers['user-agent'] || '';
      const consentTypes = ['financial_data_analysis', 'financing_offers'];

      for (const consentType of consentTypes) {
        await adminSql`
          INSERT INTO data_processing_consent (tenant_id, consent_type, accepted, accepted_at, ip_address, user_agent, consent_version)
          VALUES (${tenantId}, ${consentType}, true, NOW(), ${ip}, ${userAgent}, ${CONSENT_VERSION})
          ON CONFLICT (tenant_id, consent_type) DO UPDATE SET accepted = true, accepted_at = NOW()
        `;
      }

      await adminSql`
        UPDATE tenants
        SET financing_consent_at = NOW(),
            financing_consent_ip = ${ip},
            financing_consent_version = ${CONSENT_VERSION}
        WHERE id = ${tenantId}
      `;
    }

    // Log activity
    await adminSql`
      INSERT INTO sales_activities (rep_id, tenant_id, activity_type, description)
      VALUES (${req.salesRep.id}, ${tenantId}, 'note', ${`Onboarded ${restaurant_name} (${cleanEmail})`})
    `;

    const baseUrl = process.env.APP_URL || 'https://pos.desktop.kitchen';
    const loginUrl = `${baseUrl}?demo_token=${demoToken}`;

    res.status(201).json({
      ok: true,
      tenant_id: tenantId,
      login_url: loginUrl,
      demo_token: demoToken,
      pin,
      owner_password: ownerPassword,
      employee_id: employee.id,
    });
  } catch (err) {
    console.error('[SalesOnboard] Error:', err.message);
    res.status(500).json({ error: 'Failed to onboard tenant' });
  }
});

export default router;
