import { Router } from 'express';
import bcrypt from 'bcrypt';
import { requireOwner } from '../middleware/ownerAuth.js';
import { getTenant, updateTenant } from '../tenants.js';
import { adminSql } from '../db/index.js';
import { getPlanLimits } from '../planLimits.js';

const router = Router();

// GET /api/account — Account overview with usage vs plan limits
router.get('/', requireOwner, async (req, res) => {
  try {
    const tenant = await getTenant(req.owner.tenantId);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    const [usage] = await adminSql`
      SELECT
        (SELECT COUNT(*) FROM employees WHERE tenant_id = ${tenant.id} AND active = true) AS employee_count,
        (SELECT COUNT(*) FROM menu_items WHERE tenant_id = ${tenant.id} AND active = true) AS menu_item_count
    `;

    const limits = getPlanLimits(tenant.plan);

    res.json({
      id: tenant.id,
      name: tenant.name,
      email: tenant.owner_email,
      plan: tenant.plan,
      subscription_status: tenant.subscription_status,
      created_at: tenant.created_at,
      mp_user_id: tenant.mp_user_id || null,
      mp_default_terminal_id: tenant.mp_default_terminal_id || null,
      usage: {
        employees: { current: Number(usage.employee_count), limit: limits.employees },
        menu_items: { current: Number(usage.menu_item_count), limit: limits.menuItems },
      },
    });
  } catch (error) {
    console.error('Account fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch account info' });
  }
});

// PUT /api/account — Update name/email
router.put('/', requireOwner, async (req, res) => {
  try {
    const { name, email } = req.body;
    const updates = {};

    if (name && typeof name === 'string' && name.trim()) {
      updates.name = name.trim();
    }
    if (email && typeof email === 'string' && email.trim()) {
      // Basic email check
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
        return res.status(400).json({ error: 'Invalid email format' });
      }
      updates.owner_email = email.trim();
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    await updateTenant(req.owner.tenantId, updates);
    const tenant = await getTenant(req.owner.tenantId);

    res.json({ name: tenant.name, email: tenant.owner_email });
  } catch (error) {
    console.error('Account update error:', error);
    res.status(500).json({ error: 'Failed to update account' });
  }
});

// PUT /api/account/password — Change password
router.put('/password', requireOwner, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;

    if (!current_password || !new_password) {
      return res.status(400).json({ error: 'Both current_password and new_password are required' });
    }

    if (new_password.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }

    const tenant = await getTenant(req.owner.tenantId);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    // Verify current password
    const valid = await bcrypt.compare(current_password, tenant.owner_password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    // Hash and save new password
    const hash = await bcrypt.hash(new_password, 12);
    await updateTenant(req.owner.tenantId, { owner_password_hash: hash });

    res.json({ message: 'Password updated successfully' });
  } catch (error) {
    console.error('Password change error:', error);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

export default router;
