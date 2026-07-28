// WhatsApp Embedded Signup (coexistence) onboarding — one number per tenant.
//
// Why this exists: coexistence (keeping a number on the WhatsApp Business app
// while attaching the Cloud API) can ONLY be established through Meta's
// Embedded Signup flow run by a Meta **Tech Provider**. We are the Tech
// Provider, so the same flow connects DK's own number and every tenant
// restaurant's number.
//
// Two-page flow, because the person who finishes it is often the restaurant
// owner rather than us:
//
//   1. Super-admin opens GET /admin/wa-onboarding?secret=<ADMIN_SECRET>.
//      That page lists tenants and mints a signed, short-lived, tenant-scoped
//      link for one of them.
//   2. Whoever has the restaurant phone opens that link (no ADMIN_SECRET in
//      it) and runs Embedded Signup. Meta returns an auth `code` plus the WABA
//      id and phone number id via postMessage.
//   3. The page POSTs those to /admin/wa-onboarding/exchange, which swaps the
//      code for a long-lived business token, subscribes our app to the WABA's
//      webhooks, and **stores the credentials against that tenant** in
//      tenant_credentials (service='whatsapp').
//
// The token is never rendered to the browser and never printed to a log — the
// link holder may be a customer, not staff. Runtime messaging reads these rows
// through cloudConfigFor() in helpers/waCloud.js.
//
// Env:
//   WA_META_APP_ID       Meta app id (public — appears in the page)
//   WA_META_APP_SECRET   Meta app secret (server-side only, code exchange)
//   WA_ES_CONFIG_ID      Facebook Login for Business configuration id
//   ADMIN_SECRET         Gates the tenant picker and signs the per-tenant links

import { Router } from 'express';
import crypto from 'crypto';
import { fetchWithTimeout } from '../lib/http.js';
import { adminSql } from '../db/index.js';
import { clearCloudTenantCache } from '../helpers/waCloud.js';

const router = Router();

const GRAPH_VERSION = process.env.WA_GRAPH_VERSION || 'v23.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

// How long a minted onboarding link stays valid. The flow itself takes ~10
// minutes with the phone in hand; an hour absorbs a reschedule without
// leaving a usable link lying around in someone's WhatsApp history.
const LINK_TTL_MS = 60 * 60 * 1000;

function hasAdminSecret(req) {
  const secret = req.headers['x-admin-secret']
    || req.headers['authorization']?.replace('Bearer ', '')
    || req.query.secret;
  return Boolean(process.env.ADMIN_SECRET) && secret === process.env.ADMIN_SECRET;
}

/**
 * Sign a tenant-scoped onboarding grant. Carries its own expiry so no table
 * is needed; ADMIN_SECRET is the signing key and never leaves the server.
 */
function signGrant(tenantId, exp) {
  return crypto
    .createHmac('sha256', process.env.ADMIN_SECRET || '')
    .update(`${tenantId}.${exp}`)
    .digest('hex');
}

function verifyGrant(tenantId, exp, sig) {
  if (!process.env.ADMIN_SECRET || !tenantId || !exp || !sig) return false;
  if (!Number.isFinite(Number(exp)) || Number(exp) < Date.now()) return false;
  const expected = signGrant(tenantId, exp);
  try {
    const a = Buffer.from(String(sig), 'utf8');
    const b = Buffer.from(expected, 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** Either a valid admin secret, or a valid signed grant for this tenant. */
function authorizeTenant(req, tenantId) {
  if (hasAdminSecret(req)) return true;
  const exp = req.query.exp ?? req.body?.exp;
  const sig = req.query.sig ?? req.body?.sig;
  return verifyGrant(tenantId, exp, sig);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

const HEAD = `<meta charset="utf-8"><meta name="robots" content="noindex">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Conectar WhatsApp — Desktop Kitchen</title>
<style>
  :root { --paper:#F6EDDC; --ink:#241a12; --terracota:#C2501F; --verde:#41682F; }
  body { margin:0; padding:48px 24px; background:var(--paper); color:var(--ink);
         font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
  main { max-width:720px; margin:0 auto; }
  h1 { font-size:28px; margin:0 0 8px; }
  p.sub { margin:0 0 32px; opacity:.75; }
  button { background:var(--terracota); color:#fff; border:0; border-radius:8px;
           padding:14px 22px; font-size:16px; font-weight:600; cursor:pointer; }
  button:disabled { opacity:.5; cursor:not-allowed; }
  ol { padding-left:20px; } li { margin-bottom:6px; }
  pre { background:#fff; border:1px solid #e3d5bd; border-radius:8px; padding:16px;
        overflow-x:auto; font-size:13px; white-space:pre-wrap; word-break:break-all; }
  table { width:100%; border-collapse:collapse; margin-top:16px; }
  td { padding:8px 4px; border-bottom:1px solid #e3d5bd; }
  td.n { font-weight:600; }
  .box { margin-top:28px; padding:20px; background:#fff; border:1px solid #e3d5bd; border-radius:12px; }
  .ok { color:var(--verde); font-weight:600; } .err { color:#7E2412; font-weight:600; }
  .on { color:var(--verde); } .off { opacity:.5; }
</style>`;

// --- Page 1: tenant picker (ADMIN_SECRET only) -----------------------------

const PICKER_PAGE = (rows, secret) => `<!DOCTYPE html>
<html lang="es"><head>${HEAD}</head>
<body><main>
  <h1>Conectar WhatsApp</h1>
  <p class="sub">Elige el restaurante y genera una liga temporal. La liga no lleva el secreto de administrador — se le puede mandar a quien tenga el teléfono del negocio.</p>
  <table>
    ${rows.map((r) => `<tr>
      <td class="n">${esc(r.name)}<br><small class="${r.connected ? 'on' : 'off'}">${r.connected ? '✓ conectado · ' + esc(r.display || r.phone_number_id) : 'sin conectar'}</small></td>
      <td style="text-align:right"><button data-tenant="${esc(r.id)}">Generar liga</button></td>
    </tr>`).join('')}
  </table>
  <div id="out"></div>
<script>
  const SECRET = ${JSON.stringify(secret)};
  const out = document.getElementById('out');
  document.querySelectorAll('button[data-tenant]').forEach((b) => {
    b.addEventListener('click', () => {
      fetch('/admin/wa-onboarding/link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-secret': SECRET },
        body: JSON.stringify({ tenant: b.dataset.tenant }),
      })
        .then((r) => r.json())
        .then((r) => {
          if (r.error) { out.innerHTML = '<div class="box"><span class="err">' + r.error + '</span></div>'; return; }
          out.innerHTML = '<div class="box"><p class="ok">Liga válida 1 hora:</p><pre>' + r.url + '</pre></div>';
        });
    });
  });
</script>
</main></body></html>`;

// --- Page 2: the actual Embedded Signup run (signed grant, no admin secret) -

const CONNECT_PAGE = (appId, configId, tenantId, tenantName, exp, sig) => `<!DOCTYPE html>
<html lang="es"><head>${HEAD}</head>
<body><main>
  <h1>Conectar WhatsApp (coexistencia)</h1>
  <p class="sub">Restaurante: <strong>${esc(tenantName)}</strong>. El número sigue funcionando en la app WhatsApp Business del teléfono. Esto solo agrega la API.</p>
  <ol>
    <li>Ten el teléfono del negocio a la mano — vas a escanear un QR con la app WhatsApp Business.</li>
    <li>Confirma que la foto de perfil ya esté puesta: después del onboarding no se puede cambiar desde la API.</li>
    <li>Inicia sesión con la cuenta de Facebook administradora del número.</li>
  </ol>
  <button id="go">Iniciar Embedded Signup</button>
  <div id="out"></div>

<script>
  const APP_ID = ${JSON.stringify(appId)};
  const CONFIG_ID = ${JSON.stringify(configId)};
  const GRANT = ${JSON.stringify({ tenant: tenantId, exp, sig })};
  const out = document.getElementById('out');
  let session = {};

  function show(html) { out.innerHTML = '<div class="box">' + html + '</div>'; }

  window.fbAsyncInit = function () {
    FB.init({ appId: APP_ID, cookie: true, xfbml: false, version: '${GRAPH_VERSION}' });
  };
  (function (d, s, id) {
    var js, fjs = d.getElementsByTagName(s)[0];
    if (d.getElementById(id)) return;
    js = d.createElement(s); js.id = id; js.src = 'https://connect.facebook.net/en_US/sdk.js';
    fjs.parentNode.insertBefore(js, fjs);
  })(document, 'script', 'facebook-jssdk');

  // Meta posts the WABA id + phone number id back through the opener.
  window.addEventListener('message', (event) => {
    if (!/^https:\\/\\/www\\.facebook\\.com$/.test(event.origin)) return;
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'WA_EMBEDDED_SIGNUP' && data.event === 'FINISH') {
        session = data.data || {};
      }
    } catch { /* non-JSON chatter from the SDK */ }
  });

  document.getElementById('go').addEventListener('click', () => {
    if (!APP_ID || !CONFIG_ID) { show('<span class="err">Falta WA_META_APP_ID o WA_ES_CONFIG_ID en el servidor.</span>'); return; }
    FB.login((response) => {
      const code = response?.authResponse?.code;
      if (!code) { show('<span class="err">Cancelado o sin código de autorización.</span>'); return; }
      show('Conectando…');
      fetch('/admin/wa-onboarding/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, ...session, ...GRANT }),
      })
        .then((r) => r.json())
        .then((r) => {
          if (r.error) { show('<span class="err">' + r.error + '</span>'); return; }
          show('<p class="ok">✅ WhatsApp conectado para ' + ${JSON.stringify(esc(tenantName))} + '.</p>'
             + '<p>Número: <code>' + (r.display_phone_number || r.phone_number_id || '—') + '</code></p>'
             + (r.subscribed ? '<p class="ok">App suscrita a los webhooks de la cuenta.</p>'
                             : '<p class="err">No se pudo suscribir la app a la WABA — hazlo manualmente en WhatsApp Manager.</p>')
             + '<p>Ya puedes cerrar esta ventana. Manda una nota de voz o una foto de un ticket desde el teléfono de un empleado registrado para probarlo.</p>');
        })
        .catch((e) => show('<span class="err">' + e.message + '</span>'));
    }, {
      config_id: CONFIG_ID,
      response_type: 'code',
      override_default_response_type: true,
      extras: {
        setup: {},
        // Onboard a number that ALREADY lives on the WhatsApp Business app
        // (coexistence) instead of registering a fresh API-only number.
        featureType: 'whatsapp_business_app_onboarding',
        sessionInfoVersion: '3',
      },
    });
  });
</script>
</main></body></html>`;

// GET / — tenant picker with ADMIN_SECRET, or the connect page with a grant.
router.get('/', async (req, res) => {
  const tenantId = req.query.tenant;

  if (tenantId) {
    if (!authorizeTenant(req, tenantId)) {
      return res.status(401).type('html').send('<p>Liga inválida o expirada.</p>');
    }
    const rows = await adminSql`SELECT name FROM tenants WHERE id = ${tenantId} LIMIT 1`;
    if (rows.length === 0) return res.status(404).type('html').send('<p>Restaurante no encontrado.</p>');
    return res.type('html').send(CONNECT_PAGE(
      process.env.WA_META_APP_ID || '',
      process.env.WA_ES_CONFIG_ID || '',
      tenantId,
      rows[0].name,
      req.query.exp || '',
      req.query.sig || '',
    ));
  }

  if (!hasAdminSecret(req)) {
    return res.status(401).type('html').send('<p>Se requiere el secreto de administrador.</p>');
  }
  const tenants = await adminSql`
    SELECT t.id, t.name,
           MAX(c.value) FILTER (WHERE c.key = 'phone_number_id')      AS phone_number_id,
           MAX(c.value) FILTER (WHERE c.key = 'display_phone_number') AS display
    FROM tenants t
    LEFT JOIN tenant_credentials c ON c.tenant_id = t.id AND c.service = 'whatsapp'
    WHERE t.active = true
    GROUP BY t.id, t.name
    ORDER BY t.name
  `;
  res.type('html').send(PICKER_PAGE(
    tenants.map((t) => ({ ...t, connected: Boolean(t.phone_number_id) })),
    process.env.ADMIN_SECRET || '',
  ));
});

// POST /link — mint a signed, tenant-scoped, expiring onboarding URL.
router.post('/link', (req, res) => {
  if (!hasAdminSecret(req)) return res.status(401).json({ error: 'Invalid admin secret' });
  const tenantId = req.body?.tenant;
  if (!tenantId) return res.status(400).json({ error: 'Missing tenant' });

  const exp = Date.now() + LINK_TTL_MS;
  const sig = signGrant(tenantId, exp);
  const base = process.env.APP_URL || `https://${req.get('host')}`;
  const url = `${base}/admin/wa-onboarding?tenant=${encodeURIComponent(tenantId)}&exp=${exp}&sig=${sig}`;
  res.json({ ok: true, url, expires_at: new Date(exp).toISOString() });
});

// POST /exchange — code → token → subscribe → store against the tenant.
router.post('/exchange', async (req, res) => {
  const {
    code,
    waba_id: wabaId,
    phone_number_id: phoneNumberId,
    tenant: tenantId,
  } = req.body || {};
  const appId = process.env.WA_META_APP_ID;
  const appSecret = process.env.WA_META_APP_SECRET;

  if (!tenantId) return res.status(400).json({ error: 'Missing tenant' });
  if (!authorizeTenant(req, tenantId)) {
    return res.status(401).json({ error: 'Liga inválida o expirada' });
  }
  if (!code) return res.status(400).json({ error: 'Missing authorization code' });
  if (!phoneNumberId) {
    return res.status(400).json({ error: 'Meta no devolvió el phone_number_id — reintenta el flujo' });
  }
  if (!appId || !appSecret) {
    return res.status(500).json({ error: 'WA_META_APP_ID / WA_META_APP_SECRET not configured' });
  }

  // 1. Code → business access token. Embedded Signup tokens issued with
  //    "never expires" configs come back without expires_in.
  let token;
  try {
    const url = `${GRAPH_BASE}/oauth/access_token`
      + `?client_id=${encodeURIComponent(appId)}`
      + `&client_secret=${encodeURIComponent(appSecret)}`
      + `&code=${encodeURIComponent(code)}`;
    const r = await fetchWithTimeout(url, { timeoutMs: 15000 });
    const data = await r.json();
    if (!r.ok || !data.access_token) {
      return res.status(502).json({ error: `Token exchange failed: ${data?.error?.message || r.status}` });
    }
    token = data.access_token;
  } catch (err) {
    return res.status(502).json({ error: `Token exchange error: ${err.message}` });
  }

  // 2. Subscribe our app to this WABA's webhooks. Without this, Meta accepts
  //    the connection but never delivers inbound messages.
  let subscribed = false;
  if (wabaId) {
    try {
      const r = await fetchWithTimeout(`${GRAPH_BASE}/${wabaId}/subscribed_apps`, {
        timeoutMs: 15000,
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await r.json().catch(() => ({}));
      subscribed = Boolean(r.ok && data.success !== false);
      if (!subscribed) console.error('[WAOnboarding] subscribe failed:', data?.error?.message || r.status);
    } catch (err) {
      console.error('[WAOnboarding] subscribe error:', err.message);
    }
  }

  // 3. Ask Meta what the number actually is, for display in the picker and in
  //    Integrations. Cosmetic — a failure here doesn't fail the connection.
  let displayPhone = null;
  try {
    const r = await fetchWithTimeout(`${GRAPH_BASE}/${phoneNumberId}?fields=display_phone_number`, {
      timeoutMs: 15000,
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok && data.display_phone_number) displayPhone = data.display_phone_number;
  } catch { /* cosmetic */ }

  // 4. Store against the tenant. This is what routes inbound messages — see
  //    resolveTenantByPhoneNumberId() in helpers/waCloud.js.
  const creds = [
    ['access_token', token],
    ['phone_number_id', String(phoneNumberId)],
    ['waba_id', wabaId ? String(wabaId) : ''],
    ['display_phone_number', displayPhone || ''],
  ].filter(([, v]) => v !== '');

  try {
    for (const [key, value] of creds) {
      await adminSql`
        INSERT INTO tenant_credentials (tenant_id, service, key, value)
        VALUES (${tenantId}, 'whatsapp', ${key}, ${value})
        ON CONFLICT (tenant_id, service, key)
        DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
      `;
    }
  } catch (err) {
    console.error('[WAOnboarding] credential store failed:', err.message);
    return res.status(500).json({ error: 'No se pudieron guardar las credenciales' });
  }

  // A number may have been re-pointed at a different tenant; drop the memo so
  // the next inbound message resolves against what we just wrote.
  clearCloudTenantCache();

  console.log(`[WAOnboarding] connected tenant=${tenantId} waba=${wabaId || 'n/a'} phone_id=${phoneNumberId} subscribed=${subscribed}`);

  // Deliberately no token in the response — the browser may not be ours.
  res.json({
    ok: true,
    subscribed,
    tenant: tenantId,
    waba_id: wabaId || null,
    phone_number_id: phoneNumberId,
    display_phone_number: displayPhone,
    webhook_url: `${process.env.APP_URL || `https://${req.get('host')}`}/api/wa-cloud/webhook`,
  });
});

export default router;
