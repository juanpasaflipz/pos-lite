/**
 * Wallet pass routes.
 *
 * Mounted at /api/wallet (AFTER tenant middleware — Apple's callbacks arrive
 * on the tenant subdomain, so tenant resolution + RLS apply unchanged).
 *
 * Three groups:
 *   1. POST /enroll            — staff-authenticated: issue/fetch a pass for a customer
 *   2. GET  /p/:enrollToken    — public capability URL: smart landing / .pkpass download
 *   3. /apple/v1/*             — Apple PassKit Web Service spec (device registration,
 *                                pass re-fetch, log). Auth = "ApplePass <auth_token>",
 *                                NOT the employee JWT.
 */

import { Router } from 'express';
import { get, all, run, getTenantId } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePlanFeature } from '../planLimits.js';
import { getActiveStampCard, getLoyaltyConfig } from '../helpers/loyalty.js';
import {
  buildApplePass,
  isAppleWalletConfigured,
  getPassTypeId,
} from '../helpers/wallet/applePass.js';
import { ensureApplePass, ensureGooglePass } from '../helpers/wallet/enroll.js';
import {
  isGoogleWalletConfigured,
  ensureLoyaltyClass,
  ensureLoyaltyObject,
  saveLinkFor,
} from '../helpers/wallet/googleWallet.js';

const router = Router();

const PKPASS_MIME = 'application/vnd.apple.pkpass';

/* ==================== Helpers ==================== */

function applePassToken(req) {
  const header = req.headers.authorization || '';
  const m = header.match(/^ApplePass\s+(.+)$/i);
  return m ? m[1] : null;
}

async function loadPassContext(passRow, req) {
  const customer = await get('SELECT * FROM loyalty_customers WHERE id = $1', [passRow.customer_id]);
  if (!customer) return null;
  const card = await getActiveStampCard(customer.id);
  const config = await getLoyaltyConfig();
  return {
    pass: passRow,
    customer,
    card,
    config,
    tenant: req.tenant,
    host: req.get('host'),
  };
}

async function sendPkpass(res, ctx) {
  const buffer = await buildApplePass(ctx);
  res.set({
    'Content-Type': PKPASS_MIME,
    'Content-Disposition': 'attachment; filename="loyalty.pkpass"',
    'Last-Modified': new Date(ctx.pass.updated_at).toUTCString(),
    'Cache-Control': 'no-store',
  });
  res.send(buffer);
}

/* ==================== 1. Enrollment (staff) ==================== */

// GET /api/wallet/status — lets the UI show/hide wallet features
router.get('/status', requireAuth('pos_access'), (_req, res) => {
  res.json({ apple: isAppleWalletConfigured(), google: isGoogleWalletConfigured() });
});

// POST /api/wallet/enroll { customer_id } → { enroll_url, serial_number, created }
router.post('/enroll', requireAuth('pos_access'), requirePlanFeature('loyalty'), async (req, res) => {
  try {
    if (!isAppleWalletConfigured()) {
      return res.status(503).json({ error: 'Wallet passes are not configured on this server' });
    }

    const customerId = parseInt(req.body.customer_id);
    if (!customerId) return res.status(400).json({ error: 'customer_id is required' });

    const customer = await get('SELECT id FROM loyalty_customers WHERE id = $1', [customerId]);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const { pass, created } = await ensureApplePass(customerId);

    res.status(created ? 201 : 200).json({
      created,
      serial_number: pass.serial_number,
      enroll_url: `https://${req.get('host')}/api/wallet/p/${pass.enroll_token}`,
    });
  } catch (err) {
    console.error('[Wallet] enroll error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/* ==================== 2. Public capability URL ==================== */

// GET /api/wallet/p/:enrollToken — iOS gets the .pkpass directly; everything
// else gets a tiny landing page. Unguessable token = same trust model as
// cfdi_invoice_tokens.
router.get('/p/:enrollToken', async (req, res) => {
  try {
    const pass = await get(
      'SELECT * FROM wallet_passes WHERE enroll_token = $1 AND revoked = false',
      [req.params.enrollToken]
    );
    if (!pass) return res.status(404).send('Not found');

    const ctx = await loadPassContext(pass, req);
    if (!ctx) return res.status(404).send('Not found');

    const ua = req.headers['user-agent'] || '';
    const isIOS = /iPhone|iPad|iPod/i.test(ua);
    const isAndroid = /Android/i.test(ua);
    const googleReady = isGoogleWalletConfigured();

    // Android tap on the Google button (or direct Android arrival when only
    // Google is configured): mirror state into Google's API and bounce to
    // the signed Save-to-Wallet link.
    if (googleReady && req.query.platform === 'google') {
      const { pass: gpass } = await ensureGooglePass(ctx.customer.id);
      const tenantId = getTenantId();
      const classId = await ensureLoyaltyClass({
        tenantId,
        tenant: ctx.tenant,
        config: ctx.config,
        host: ctx.host,
      });
      await ensureLoyaltyObject({
        pass: gpass,
        customer: ctx.customer,
        card: ctx.card,
        config: ctx.config,
        classId,
      });
      return res.redirect(saveLinkFor(gpass.serial_number));
    }

    if (isAppleWalletConfigured() && (req.query.format === 'pkpass' || (isIOS && !isAndroid))) {
      return await sendPkpass(res, ctx);
    }

    const restaurantName = req.tenant?.name || 'Desktop Kitchen';
    const appleButton = isAppleWalletConfigured()
      ? `<a class="btn" href="?format=pkpass">Agregar a Apple Wallet</a>`
      : '';
    const googleButton = googleReady
      ? `<a class="btn" href="?platform=google">Agregar a Google Wallet</a>`
      : `<p style="font-size:13px;margin-top:32px">¿Android? Google Wallet estará disponible muy pronto.<br>
<span style="color:#737373">Android support (Google Wallet) coming soon.</span></p>`;

    res.set('Content-Type', 'text/html; charset=utf-8').send(`<!doctype html>
<html lang="es"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${restaurantName} — Tarjeta de lealtad</title>
<style>
  body{font-family:-apple-system,system-ui,sans-serif;background:#0a0a0a;color:#fff;
       display:flex;flex-direction:column;align-items:center;justify-content:center;
       min-height:100vh;margin:0;padding:24px;text-align:center}
  .btn{display:inline-block;background:#000;border:1px solid #444;border-radius:12px;
       color:#fff;text-decoration:none;padding:14px 28px;font-weight:700;margin-top:24px;
       min-height:40px;box-sizing:border-box}
  p{color:#a3a3a3;max-width:420px;line-height:1.5}
</style></head><body>
<h1>${restaurantName}</h1>
<p>Agrega tu tarjeta de lealtad a tu teléfono. Se actualiza sola con cada compra.</p>
${isAndroid ? googleButton + appleButton : appleButton + googleButton}
</body></html>`);
  } catch (err) {
    console.error('[Wallet] download error:', err);
    res.status(500).send('Error');
  }
});

/* ==================== 3. Apple PassKit Web Service ==================== */
/* Spec: https://developer.apple.com/documentation/walletpasses               */

// Register a device for pass updates
router.post('/apple/v1/devices/:deviceLibraryId/registrations/:passTypeId/:serial', async (req, res) => {
  try {
    if (req.params.passTypeId !== getPassTypeId()) return res.status(404).send();

    const pass = await get(
      'SELECT * FROM wallet_passes WHERE serial_number = $1 AND revoked = false',
      [req.params.serial]
    );
    if (!pass) return res.status(404).send();
    if (applePassToken(req) !== pass.auth_token) return res.status(401).send();

    const pushToken = req.body?.pushToken;
    if (!pushToken) return res.status(400).send();

    const existing = await get(
      'SELECT id FROM wallet_registrations WHERE pass_id = $1 AND device_library_id = $2',
      [pass.id, req.params.deviceLibraryId]
    );
    if (existing) {
      await run('UPDATE wallet_registrations SET push_token = $1 WHERE id = $2', [pushToken, existing.id]);
      return res.status(200).send();
    }

    await run(
      'INSERT INTO wallet_registrations (pass_id, device_library_id, push_token) VALUES ($1, $2, $3)',
      [pass.id, req.params.deviceLibraryId, pushToken]
    );
    res.status(201).send();
  } catch (err) {
    console.error('[Wallet] register error:', err);
    res.status(500).send();
  }
});

// Unregister a device
router.delete('/apple/v1/devices/:deviceLibraryId/registrations/:passTypeId/:serial', async (req, res) => {
  try {
    if (req.params.passTypeId !== getPassTypeId()) return res.status(404).send();

    const pass = await get(
      'SELECT * FROM wallet_passes WHERE serial_number = $1',
      [req.params.serial]
    );
    if (!pass) return res.status(404).send();
    if (applePassToken(req) !== pass.auth_token) return res.status(401).send();

    await run(
      'DELETE FROM wallet_registrations WHERE pass_id = $1 AND device_library_id = $2',
      [pass.id, req.params.deviceLibraryId]
    );
    res.status(200).send();
  } catch (err) {
    console.error('[Wallet] unregister error:', err);
    res.status(500).send();
  }
});

// Which of this device's passes changed since ?passesUpdatedSince=<tag>
// (Per spec this endpoint is unauthenticated; it leaks only serial numbers
// already known to the requesting device's registrations.)
router.get('/apple/v1/devices/:deviceLibraryId/registrations/:passTypeId', async (req, res) => {
  try {
    if (req.params.passTypeId !== getPassTypeId()) return res.status(404).send();

    const since = req.query.passesUpdatedSince ? Number(req.query.passesUpdatedSince) : 0;

    const rows = await all(
      `SELECT wp.serial_number, wp.updated_at
       FROM wallet_registrations wr
       JOIN wallet_passes wp ON wp.id = wr.pass_id
       WHERE wr.device_library_id = $1 AND wp.revoked = false`,
      [req.params.deviceLibraryId]
    );
    if (rows.length === 0) return res.status(404).send();

    const updated = rows.filter((r) => new Date(r.updated_at).getTime() > since);
    if (updated.length === 0) return res.status(204).send();

    const lastUpdated = Math.max(...updated.map((r) => new Date(r.updated_at).getTime()));
    res.json({
      lastUpdated: String(lastUpdated),
      serialNumbers: updated.map((r) => r.serial_number),
    });
  } catch (err) {
    console.error('[Wallet] registrations query error:', err);
    res.status(500).send();
  }
});

// Latest version of a pass (device re-fetch after an APNs nudge)
router.get('/apple/v1/passes/:passTypeId/:serial', async (req, res) => {
  try {
    if (req.params.passTypeId !== getPassTypeId()) return res.status(404).send();

    const pass = await get(
      'SELECT * FROM wallet_passes WHERE serial_number = $1 AND revoked = false',
      [req.params.serial]
    );
    if (!pass) return res.status(404).send();
    if (applePassToken(req) !== pass.auth_token) return res.status(401).send();

    const ifModifiedSince = req.headers['if-modified-since'];
    if (ifModifiedSince) {
      const since = new Date(ifModifiedSince).getTime();
      const updatedAt = new Date(pass.updated_at).getTime();
      // HTTP dates have 1s resolution — round down before comparing
      if (Number.isFinite(since) && Math.floor(updatedAt / 1000) * 1000 <= since) {
        return res.status(304).send();
      }
    }

    const ctx = await loadPassContext(pass, req);
    if (!ctx) return res.status(404).send();
    await sendPkpass(res, ctx);
  } catch (err) {
    console.error('[Wallet] pass fetch error:', err);
    res.status(500).send();
  }
});

// Device error logs — accept and record
router.post('/apple/v1/log', (req, res) => {
  const logs = req.body?.logs;
  if (Array.isArray(logs)) {
    for (const line of logs) console.warn('[Wallet][AppleLog]', line);
  }
  res.status(200).send();
});

export default router;
