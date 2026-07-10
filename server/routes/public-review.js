// Public Google Reviews redirect. Purpose: give customers a clean SMS link on
// our own domain (e.g. https://juanbertos.desktop.kitchen/gr) that 302s to
// the tenant's real Google review URL. Owning the shortener avoids:
//   - Third-party interstitials (TinyURL sometimes shows a "preview page"
//     to first-time visitors, which reads as sketchy in SMS context)
//   - iOS SMS URL-detection quirks with underscores in raw g.page URLs
//
// Tenant resolution: extract subdomain from the Host header, look up the
// tenants row, read loyalty_config[google_review_target] for the actual
// URL to redirect to. Uses adminSql directly (bypasses RLS) since this is
// an unauthenticated public route not covered by the tenant middleware.

import { Router } from 'express';
import { adminSql } from '../db/index.js';

const router = Router();

function extractSubdomain(host) {
  if (!host) return null;
  const bare = host.split(':')[0];
  const parts = bare.split('.');
  // For `juanbertos.desktop.kitchen` we want `juanbertos`. Also allow
  // localhost-style single-label hosts to fall back gracefully.
  if (parts.length < 2) return null;
  return parts[0];
}

router.get('/gr', async (req, res) => {
  try {
    const subdomain = extractSubdomain(req.get('host'));
    if (!subdomain) return res.status(404).send('Not found');

    const tenants = await adminSql`SELECT id FROM tenants WHERE subdomain = ${subdomain} LIMIT 1`;
    if (tenants.length === 0) return res.status(404).send('Not found');

    const tenantId = tenants[0].id;
    const configs = await adminSql`
      SELECT value FROM loyalty_config
      WHERE tenant_id = ${tenantId} AND key = 'google_review_target' LIMIT 1
    `;
    const target = configs[0]?.value;
    if (!target) return res.status(404).send('Review link not configured');

    return res.redirect(302, target);
  } catch (err) {
    console.error('[public-review] redirect failed:', err.message);
    return res.status(500).send('Internal error');
  }
});

export default router;
