/**
 * Apple Wallet pass builder (storeCard).
 *
 * Platform-wide certificate set (Desktop Kitchen's Pass Type ID) serves all
 * tenants — white-label branding is data on the pass, not a separate cert.
 *
 * Env (all required for Apple passes to be enabled):
 *   APPLE_TEAM_ID                — 10-char team id
 *   APPLE_PASS_TYPE_ID           — e.g. pass.kitchen.desktop.loyalty
 *   APPLE_PASS_CERT_BASE64       — base64 of the signer certificate PEM
 *   APPLE_PASS_KEY_BASE64        — base64 of the signer private key PEM
 *   APPLE_PASS_KEY_PASSPHRASE    — key passphrase (optional if key is unencrypted)
 *   APPLE_WWDR_CERT_BASE64       — base64 of Apple WWDR G4 intermediate PEM
 *
 * Extract PEMs from the .p12 exported from Keychain:
 *   openssl pkcs12 -in pass.p12 -clcerts -nokeys -legacy | openssl x509 > signerCert.pem
 *   openssl pkcs12 -in pass.p12 -nocerts -legacy -passout pass:<passphrase> > signerKey.pem
 *   base64 -i signerCert.pem | pbcopy   # etc.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PKPass } from 'passkit-generator';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.join(__dirname, '../../assets/pass');

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

/** '#9333ea' → 'rgb(147, 51, 234)' (pass.json color format) */
export function hexToRgb(hex, fallback = 'rgb(13, 148, 136)') {
  if (!hex || typeof hex !== 'string') return fallback;
  const m = hex.trim().match(/^#?([0-9a-f]{6})$/i);
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

/** Static images shared by all tenants (tenant logo can override logo.png). */
function loadBaseImages() {
  const images = {};
  for (const f of ['icon.png', 'icon@2x.png', 'icon@3x.png', 'logo.png', 'logo@2x.png']) {
    images[f] = fs.readFileSync(path.join(ASSETS_DIR, f));
  }
  return images;
}

/**
 * Fetch the tenant's logo if it's a PNG we can reach; return null on any failure.
 * Pass images MUST be PNG — skip JPG/SVG uploads silently.
 */
async function fetchTenantLogo(logoUrl, host) {
  try {
    if (!logoUrl || !/\.png(\?|$)/i.test(logoUrl)) return null;
    const url = logoUrl.startsWith('http') ? logoUrl : `https://${host}${logoUrl}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok || !(res.headers.get('content-type') || '').includes('png')) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > 0 && buf.length < 1_000_000 ? buf : null;
  } catch {
    return null;
  }
}

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
  const cfg = (key, dflt = '') => config?.[key]?.value ?? dflt;

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
    backgroundColor: hexToRgb(branding.primaryColor),
    foregroundColor: 'rgb(255, 255, 255)',
    labelColor: 'rgb(235, 235, 235)',
    sharingProhibited: true,
    storeCard: {
      primaryFields: [
        {
          key: 'stamps',
          label: 'SELLOS',
          value: `${card.stamps_earned} / ${card.stamps_required}`,
        },
      ],
      secondaryFields: [
        {
          key: 'reward',
          label: 'RECOMPENSA',
          value: card.reward_description || cfg('reward_description', 'Producto gratis'),
        },
      ],
      auxiliaryFields: [
        { key: 'name', label: 'CLIENTE', value: customer.name },
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
          value: 'Tu tarjeta se actualiza sola con cada compra. Muéstrala al pagar para acumular sellos.',
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
  const tenantLogo = await fetchTenantLogo(branding.logoUrl, host);
  if (tenantLogo) {
    images['logo.png'] = tenantLogo;
    images['logo@2x.png'] = tenantLogo;
  }

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
