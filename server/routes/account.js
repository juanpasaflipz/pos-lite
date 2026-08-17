import { Router } from 'express';
import bcrypt from 'bcrypt';
import { requireOwner } from '../middleware/ownerAuth.js';
import { getTenant, updateTenant } from '../tenants.js';
import { adminSql } from '../db/index.js';
import { getPlanLimits, effectivePlan } from '../planLimits.js';

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

    const plan = effectivePlan(tenant); // trial signups count as 'pro' until trial_ends_at
    const limits = getPlanLimits(plan);

    res.json({
      id: tenant.id,
      name: tenant.name,
      email: tenant.owner_email,
      plan,
      trial_ends_at: tenant.plan !== 'pro' ? (tenant.trial_ends_at || null) : null,
      subscription_status: tenant.subscription_status,
      created_at: tenant.created_at,
      mp_user_id: tenant.mp_user_id || null,
      mp_default_terminal_id: tenant.mp_default_terminal_id || null,
      mp_default_kiosk_terminal_id: tenant.mp_default_kiosk_terminal_id || null,
      inventory_mode: tenant.inventory_mode || 'ingredients',
      kiosk_fire_before_payment: tenant.kiosk_fire_before_payment === true,
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

const INVENTORY_MODES = ['ingredients', 'two_stage'];

// PUT /api/account — Update name/email/inventory_mode/kiosk_fire_before_payment
router.put('/', requireOwner, async (req, res) => {
  try {
    const { name, email, inventory_mode, kiosk_fire_before_payment } = req.body;
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
    if (inventory_mode !== undefined) {
      if (!INVENTORY_MODES.includes(inventory_mode)) {
        return res.status(400).json({ error: `inventory_mode must be one of: ${INVENTORY_MODES.join(', ')}` });
      }
      // Two-stage is a Pro feature. Gate the WRITE, not just the UI — a free
      // tenant that PUTs this directly would otherwise get prep runs and
      // auto-86 for free. Turning it back OFF is always allowed, so a lapsed
      // subscription never traps a tenant in a mode they can no longer manage.
      if (inventory_mode === 'two_stage') {
        const tenant = await getTenant(req.owner.tenantId);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        if (effectivePlan(tenant) !== 'pro') {
          return res.status(403).json({
            error: 'Two-stage inventory requires the Pro plan',
            code: 'PLAN_UPGRADE_REQUIRED',
          });
        }
      }
      updates.inventory_mode = inventory_mode;
    }
    if (kiosk_fire_before_payment !== undefined) {
      if (typeof kiosk_fire_before_payment !== 'boolean') {
        return res.status(400).json({ error: 'kiosk_fire_before_payment must be a boolean' });
      }
      updates.kiosk_fire_before_payment = kiosk_fire_before_payment;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    await updateTenant(req.owner.tenantId, updates);
    const tenant = await getTenant(req.owner.tenantId);

    res.json({
      name: tenant.name,
      email: tenant.owner_email,
      inventory_mode: tenant.inventory_mode || 'ingredients',
      kiosk_fire_before_payment: tenant.kiosk_fire_before_payment === true,
    });
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
