import { Router } from 'express';
import { get } from '../db/index.js';

const router = Router();

/**
 * GET /api/onboarding/status
 * Returns 5 boolean flags for the setup checklist in a single query.
 */
router.get('/status', async (req, res) => {
  try {
    const row = await get(`
      SELECT
        EXISTS(SELECT 1 FROM menu_items WHERE active = true AND is_example = false) AS has_menu_items,
        EXISTS(SELECT 1 FROM delivery_platforms) AS has_delivery,
        (SELECT COUNT(*) FROM employees) > 1 AS has_extra_staff,
        (SELECT COUNT(*) FROM orders WHERE status != 'cancelled') AS real_order_count
    `);

    const branding = req.tenant?.branding;
    const hasBranding = !!branding?.primaryColor && branding.primaryColor !== '#0d9488';

    res.json({
      has_menu_items: row.has_menu_items,
      has_extra_staff: row.has_extra_staff,
      has_branding: hasBranding,
      has_delivery: row.has_delivery,
      real_order_count: Number(row.real_order_count),
    });
  } catch (err) {
    console.error('[Onboarding] status error:', err.message);
    res.status(500).json({ error: 'Failed to fetch onboarding status' });
  }
});

export default router;
