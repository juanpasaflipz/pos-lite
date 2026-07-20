import { Router } from 'express';
import { get } from '../db/index.js';

const router = Router();

/**
 * GET /api/onboarding/status
 * Returns the setup-checklist flags in a single query.
 *
 * has_payment / has_printer were added to preflight the new-tenant first-hour
 * landmine: an owner finishes onboarding, takes a card, and the charge fails
 * because no processor was ever connected. The POS banner reads these so it
 * can warn "connect a payment processor to accept cards" BEFORE the first
 * failed charge. A card processor = Mercado Pago connected (mp_access_token)
 * OR a per-tenant credential row for any processor (stripe/mercadopago/clip/
 * getnet). Cash always works, so this is informational, not blocking.
 */
router.get('/status', async (req, res) => {
  try {
    const row = await get(`
      SELECT
        EXISTS(SELECT 1 FROM menu_items WHERE active = true AND is_example = false) AS has_menu_items,
        EXISTS(SELECT 1 FROM delivery_platforms) AS has_delivery,
        (SELECT COUNT(*) FROM employees) > 1 AS has_extra_staff,
        (SELECT COUNT(*) FROM orders WHERE status != 'cancelled') AS real_order_count,
        EXISTS(SELECT 1 FROM printers WHERE active = true) AS has_printer,
        (
          EXISTS(SELECT 1 FROM tenants WHERE id = current_setting('app.tenant_id', true) AND mp_access_token IS NOT NULL)
          OR EXISTS(
            SELECT 1 FROM tenant_credentials
            WHERE service IN ('stripe','mercadopago','clip','getnet')
          )
        ) AS has_payment
    `);

    const branding = req.tenant?.branding;
    const hasBranding = !!branding?.primaryColor && branding.primaryColor !== '#0d9488';

    res.json({
      has_menu_items: row.has_menu_items,
      has_extra_staff: row.has_extra_staff,
      has_branding: hasBranding,
      has_delivery: row.has_delivery,
      has_payment: row.has_payment,
      has_printer: row.has_printer,
      real_order_count: Number(row.real_order_count),
    });
  } catch (err) {
    console.error('[Onboarding] status error:', err.message);
    res.status(500).json({ error: 'Failed to fetch onboarding status' });
  }
});

export default router;
