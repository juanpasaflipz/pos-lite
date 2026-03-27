import { Router } from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { adminSql } from '../db/index.js';
import { createTenant, getTenant } from '../tenants.js';
import { generateDemoData } from '../lib/demoDataGenerator.js';
import { requireSalesAuth } from '../middleware/salesAuth.js';
import { BCRYPT_ROUNDS, JWT_SECRET, JWT_EMPLOYEE_EXPIRY } from '../lib/constants.js';
import bcrypt from 'bcrypt';

const router = Router();

/**
 * Admin auth — same pattern as admin.js
 */
function requireAdmin(req, res, next) {
  const secret = req.headers['x-admin-secret'] || req.headers['authorization']?.replace('Bearer ', '');
  if (!process.env.ADMIN_SECRET || secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Invalid admin secret' });
  }
  next();
}

// ── Admin: Setup persistent demo tenant ──
router.post('/setup', requireAdmin, async (req, res) => {
  try {
    const { tenant_id = 'demo-sales', data_volume = 'medium' } = req.body;

    let tenant = await getTenant(tenant_id);
    if (!tenant) {
      const pin = '123456';
      const pinHash = await bcrypt.hash(pin, BCRYPT_ROUNDS);
      const ownerHash = await bcrypt.hash('demo1234', BCRYPT_ROUNDS);

      tenant = await createTenant({
        id: tenant_id,
        name: 'Demo Restaurant',
        subdomain: tenant_id,
        owner_email: `demo@${tenant_id}.pos`,
        owner_password_hash: ownerHash,
        plan: 'pro',
        branding_json: JSON.stringify({ primaryColor: '#e11d48' }),
      });

      // Create admin employee
      await adminSql`
        INSERT INTO employees (tenant_id, name, pin, role, active)
        VALUES (${tenant_id}, 'Demo Admin', ${pinHash}, 'admin', true)
        ON CONFLICT DO NOTHING
      `;
    }

    // Generate demo data
    await generateDemoData(adminSql, {
      tenantId: tenant_id,
      volume: data_volume,
      dateRangeDays: 30,
      includeDelivery: true,
      includeLoyalty: true,
      includeFinancials: true,
    });

    // Upsert demo_config
    await adminSql`
      INSERT INTO demo_config (tenant_id, data_volume, active, last_reset_at)
      VALUES (${tenant_id}, ${data_volume}, true, NOW())
      ON CONFLICT (tenant_id) DO UPDATE SET
        data_volume = EXCLUDED.data_volume,
        active = true,
        last_reset_at = NOW()
    `;

    res.json({ ok: true, tenant_id, message: 'Demo tenant configured' });
  } catch (err) {
    console.error('[SalesDemo] Setup error:', err.message);
    res.status(500).json({ error: 'Failed to setup demo tenant' });
  }
});

// ── Admin: Manual reset ──
router.post('/reset', requireAdmin, async (req, res) => {
  try {
    const configs = await adminSql`SELECT * FROM demo_config WHERE active = true`;
    if (configs.length === 0) {
      return res.status(404).json({ error: 'No active demo tenant configured' });
    }

    for (const config of configs) {
      await resetDemoTenantData(config.tenant_id, config.data_volume);
      await adminSql`
        UPDATE demo_config SET last_reset_at = NOW() WHERE tenant_id = ${config.tenant_id}
      `;
    }

    res.json({ ok: true, message: `Reset ${configs.length} demo tenant(s)` });
  } catch (err) {
    console.error('[SalesDemo] Reset error:', err.message);
    res.status(500).json({ error: 'Failed to reset demo tenant' });
  }
});

// ── Admin: Status ──
router.get('/status', requireAdmin, async (req, res) => {
  try {
    const configs = await adminSql`SELECT * FROM demo_config WHERE active = true`;
    if (configs.length === 0) {
      return res.json({ configured: false });
    }

    const result = [];
    for (const config of configs) {
      const [counts] = await adminSql`
        SELECT
          (SELECT COUNT(*) FROM orders WHERE tenant_id = ${config.tenant_id}) AS orders,
          (SELECT COUNT(*) FROM menu_items WHERE tenant_id = ${config.tenant_id}) AS menu_items,
          (SELECT COUNT(*) FROM employees WHERE tenant_id = ${config.tenant_id}) AS employees
      `;
      result.push({ ...config, counts });
    }

    res.json({ configured: true, demos: result });
  } catch (err) {
    console.error('[SalesDemo] Status error:', err.message);
    res.status(500).json({ error: 'Failed to get demo status' });
  }
});

// ── Sales rep: Get demo access URL ──
router.get('/access', requireSalesAuth(), async (req, res) => {
  try {
    const [config] = await adminSql`SELECT * FROM demo_config WHERE active = true LIMIT 1`;
    if (!config) {
      return res.status(404).json({ error: 'No demo tenant configured' });
    }

    const tenantId = config.tenant_id;

    // Find the admin employee for demo
    const [employee] = await adminSql`
      SELECT id, name, role FROM employees
      WHERE tenant_id = ${tenantId} AND role = 'admin' AND active = true
      LIMIT 1
    `;

    if (!employee) {
      return res.status(404).json({ error: 'No admin employee in demo tenant' });
    }

    // Generate a short-lived demo token (token column is UUID)
    const demoToken = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000); // 2 hours

    await adminSql`
      INSERT INTO demo_tokens (tenant_id, token, employee_id, expires_at)
      VALUES (${tenantId}, ${demoToken}::uuid, ${employee.id}, ${expiresAt})
    `;

    // Log activity
    await adminSql`
      INSERT INTO sales_activities (rep_id, activity_type, description)
      VALUES (${req.salesRep.id}, 'demo', ${`Generated demo access link for ${tenantId}`})
    `;

    const baseUrl = process.env.APP_URL || 'https://pos.desktop.kitchen';
    const demoUrl = `${baseUrl}?demo_token=${demoToken}`;

    res.json({ ok: true, demo_url: demoUrl, expires_at: expiresAt, tenant_id: tenantId });
  } catch (err) {
    console.error('[SalesDemo] Access error:', err.message);
    res.status(500).json({ error: 'Failed to generate demo access' });
  }
});

/**
 * Reset demo tenant data: clears transactional data and regenerates.
 */
async function resetDemoTenantData(tenantId, volume = 'medium') {
  // Clear transactional data (keep menu/employees/config)
  await adminSql`DELETE FROM order_item_modifiers WHERE order_item_id IN (SELECT id FROM order_items WHERE tenant_id = ${tenantId})`;
  await adminSql`DELETE FROM order_items WHERE tenant_id = ${tenantId}`;
  await adminSql`DELETE FROM order_payments WHERE tenant_id = ${tenantId}`;
  await adminSql`DELETE FROM orders WHERE tenant_id = ${tenantId}`;
  await adminSql`DELETE FROM expenses WHERE tenant_id = ${tenantId}`;
  await adminSql`DELETE FROM waste_log WHERE tenant_id = ${tenantId}`;
  await adminSql`DELETE FROM demo_tokens WHERE tenant_id = ${tenantId}`;

  // Regenerate
  await generateDemoData(adminSql, {
    tenantId,
    volume,
    dateRangeDays: 30,
    includeDelivery: true,
    includeLoyalty: true,
    includeFinancials: true,
  });
}

// Export for scheduler
export { resetDemoTenantData };
export default router;
