/**
 * Apple Wallet pass builder (storeCard).
 *
 * Platform-wide certificate set (Desktop Kitchen's Pass Type ID) serves all
 * tenants — white-label branding is data on the pass, not a separate cert.
 *
 * Per-tenant personalization (all optional, via loyalty_config):
 *   wallet_bg_color            — hex card color (falls back to branding primaryColor)
 *   wallet_label_stamps        — primary field label   (default "SELLOS")
 *   wallet_label_reward        — secondary field label (default "RECOMPENSA")
 *   wallet_label_customer      — auxiliary field label (default "CLIENTE")
 *   wallet_back_text           — back-of-card copy
 *   store_latitude/longitude   — geofence
 *   wallet_location_message    — lock-screen relevance text
 * Text color (foreground/label) is chosen automatically for contrast against
 * the card color. Tenant logo comes from branding logoUrl in ANY image format —
 * sharp converts/resizes it to pass-spec PNG at build time.
 *
 * Env (all required for Apple passes to be enabled):
 *   APPLE_TEAM_ID                — 10-char team id
 *   APPLE_PASS_TYPE_ID           — e.g. pass.kitchen.desktop.loyalty
 *   APPLE_PASS_CERT_BASE64       — base64 of the signer certificate PEM
 *   APPLE_PASS_KEY_BASE64        — base64 of the signer private key PEM
 *   APPLE_PASS_KEY_PASSPHRASE    — key passphrase (optional if key is unencrypted)
 *   APPLE_WWDR_CERT_BASE64       — base64 of Apple WWDR G4 intermediate PEM
 *
 * Extract PEMs from the .p12 exported from Keychain (note: -passin and
 * -passout must reference DIFFERENT pass files, and -legacy is required for
 * Keychain's RC2 encryption):
 *   openssl pkcs12 -legacy -in pass.p12 -clcerts -nokeys -passin file:pp1.txt | openssl x509 > signerCert.pem
 *   openssl pkcs12 -legacy -in pass.p12 -nocerts -passin file:pp1.txt -passout file:pp2.txt > signerKey.pem
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PKPass } from 'passkit-generator';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.join(__dirname, '../../assets/pass');
const UPLOADS_DIR = path.join(__dirname, '../../../data/uploads');

function env(key) {
  return process.env[key] || null;
}

export function isAppleWalletConfigured() {
  return !!(
    env('APPLE_TEAM_ID') &&
    env('APPLE_PASS_TYPE_ID') &&
    env('APPLE_PASS_CERT_BASE64') &&
    env('APPLE_PASS_KEY_BASE64') &&
    env('APPLE_WWDR_CERT_BASE64')
  );
}

export function getPassTypeId() {
  return env('APPLE_PASS_TYPE_ID');
}

function getCertificates() {
  return {
    wwdr: Buffer.from(env('APPLE_WWDR_CERT_BASE64'), 'base64'),
    signerCert: Buffer.from(env('APPLE_PASS_CERT_BASE64'), 'base64'),
    signerKey: Buffer.from(env('APPLE_PASS_KEY_BASE64'), 'base64'),
    signerKeyPassphrase: env('APPLE_PASS_KEY_PASSPHRASE') || undefined,
  };
}

/* ==================== Colors ==================== */

function parseHex(hex) {
  if (!hex || typeof hex !== 'string') return null;
  const m = hex.trim().match(/^#?([0-9a-f]{6})$/i);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** '#9333ea' → 'rgb(147, 51, 234)' (pass.json color format) */
export function hexToRgb(hex, fallback = 'rgb(13, 148, 136)') {
  const c = parseHex(hex);
  return c ? `rgb(${c.r}, ${c.g}, ${c.b})` : fallback;
}

/**
 * Background from config override → branding primaryColor → teal fallback.
 * Foreground/label picked by YIQ luminance so light brand colors (e.g. lime)
 * get dark text instead of unreadable white-on-light.
 */
export function resolvePassColors(config, branding) {
  const cfgHex = config?.wallet_bg_color?.value;
  const bg = parseHex(cfgHex) || parseHex(branding?.primaryColor) || { r: 13, g: 148, b: 136 };
  const yiq = (bg.r * 299 + bg.g * 587 + bg.b * 114) / 1000;
  const lightBg = yiq >= 150;
  return {
    backgroundColor: `rgb(${bg.r}, ${bg.g}, ${bg.b})`,
    foregroundColor: lightBg ? 'rgb(28, 28, 30)' : 'rgb(255, 255, 255)',
    labelColor: lightBg ? 'rgb(60, 60, 67)' : 'rgb(235, 235, 235)',
  };
}

/* ==================== Images ==================== */

/** Static images shared by all tenants (tenant logo overrides logo.png). */
function loadBaseImages() {
  const images = {};
  for (const f of ['icon.png', 'icon@2x.png', 'icon@3x.png', 'logo.png', 'logo@2x.png']) {
    images[f] = fs.readFileSync(path.join(ASSETS_DIR, f));
  }
  return images;
}

/**
 * Tenant logo in ANY format (png/jpg/webp/...) → pass-spec PNGs via sharp.
 * Local /uploads/* files are read straight from disk (same volume the
 * branding upload writes to); anything else is fetched. Returns
 * { 'logo.png', 'logo@2x.png' } buffers, or null on any failure.
 */
async function resolveTenantLogo(logoUrl, host) {
  try {
    if (!logoUrl) return null;

    let raw;
    if (logoUrl.startsWith('/uploads/')) {
      // Key may be nested (e.g. <tenant>/branding/logo-x.png) — keep the full
      // relative path, but never let it escape the uploads root.
      const key = logoUrl.slice('/uploads/'.length).split('?')[0];
      const filePath = path.join(UPLOADS_DIR, key);
      if (!path.resolve(filePath).startsWith(path.resolve(UPLOADS_DIR) + path.sep)) return null;
      raw = fs.readFileSync(filePath);
    } else {
      const url = logoUrl.startsWith('http') ? logoUrl : `https://${host}${logoUrl}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) return null;
      raw = Buffer.from(await res.arrayBuffer());
    }
    if (!raw || raw.length === 0 || raw.length > 5_000_000) return null;

    // Pass logo box is 160×50 pt; render @1x and @2x, preserve aspect.
    const logo2x = await sharp(raw)
      .resize({ width: 320, height: 100, fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer();
    const logo1x = await sharp(raw)
      .resize({ width: 160, height: 50, fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer();

    return { 'logo.png': logo1x, 'logo@2x.png': logo2x };
  } catch (err) {
    console.warn('[Wallet] tenant logo unusable, using default:', err.message);
    return null;
  }
}

/* ==================== Pass build ==================== */

/**
 * Build a signed .pkpass buffer for a loyalty customer.
 *
 * @param {object} p
 * @param {object} p.pass       wallet_passes row (serial_number, auth_token)
 * @param {object} p.customer   loyalty_customers row
 * @param {object} p.card       active stamp_cards row
 * @param {object} p.config     loyalty_config map { key: { value } }
 * @param {object} p.tenant     { name, branding: { primaryColor, logoUrl } }
 * @param {string} p.host       request host, e.g. juanbertos.desktop.kitchen
 * @returns {Promise<Buffer>}
 */
export async function buildApplePass({ pass, customer, card, config, tenant, host }) {
  if (!isAppleWalletConfigured()) {
    throw new Error('Apple Wallet is not configured (missing APPLE_* env vars)');
  }

  const branding = tenant?.branding || {};
  const restaurantName = tenant?.name || 'Desktop Kitchen';
  const cfg = (key, dflt = '') => {
    const v = config?.[key]?.value;
    return v !== undefined && v !== null && String(v).trim() !== '' ? String(v) : dflt;
  };

  const colors = resolvePassColors(config, branding);

  const passJson = {
    formatVersion: 1,
    passTypeIdentifier: env('APPLE_PASS_TYPE_ID'),
    teamIdentifier: env('APPLE_TEAM_ID'),
    organizationName: restaurantName,
    description: `${restaurantName} — tarjeta de lealtad`,
    // Derived from the request host — NEVER from BASE_URL (see CLAUDE.md).
    webServiceURL: `https://${host}/api/wallet/apple`,
    authenticationToken: pass.auth_token,
    serialNumber: pass.serial_number,
    ...colors,
    sharingProhibited: true,
    storeCard: {
      primaryFields: [
        {
          key: 'stamps',
          label: cfg('wallet_label_stamps', 'SELLOS'),
          value: `${card.stamps_earned} / ${card.stamps_required}`,
        },
      ],
      secondaryFields: [
        {
          key: 'reward',
          label: cfg('wallet_label_reward', 'RECOMPENSA'),
          value: card.reward_description || cfg('reward_description', 'Producto gratis'),
        },
      ],
      auxiliaryFields: [
        { key: 'name', label: cfg('wallet_label_customer', 'CLIENTE'), value: customer.name },
      ],
      backFields: [
        {
          key: 'referral',
          label: 'Tu código de referido',
          value: customer.referral_code
            ? `${customer.referral_code} — compártelo y ambos ganan sellos extra`
            : '—',
        },
        {
          key: 'about',
          label: restaurantName,
          value: cfg(
            'wallet_back_text',
            'Tu tarjeta se actualiza sola con cada compra. Muéstrala al pagar para acumular sellos.'
          ),
        },
      ],
    },
  };

  // Geofence: lock-screen relevance when the customer is near the store.
  const lat = parseFloat(cfg('store_latitude'));
  const lon = parseFloat(cfg('store_longitude'));
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    passJson.locations = [
      {
        latitude: lat,
        longitude: lon,
        relevantText: cfg('wallet_location_message') || `¡Estás cerca de ${restaurantName}!`,
      },
    ];
  }

  const images = loadBaseImages();
  const tenantLogo = await resolveTenantLogo(branding.logoUrl, host);
  if (tenantLogo) Object.assign(images, tenantLogo);

  const pkpass = new PKPass(
    {
      ...images,
      'pass.json': Buffer.from(JSON.stringify(passJson)),
    },
    getCertificates()
  );

  // QR on the pass: future-proofs "scan the pass at the register".
  pkpass.setBarcodes({
    format: 'PKBarcodeFormatQR',
    message: `dk-loyalty:${pass.serial_number}`,
    messageEncoding: 'iso-8859-1',
    altText: customer.referral_code || undefined,
  });

  return pkpass.getAsBuffer();
}
