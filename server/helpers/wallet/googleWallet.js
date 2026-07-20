import { fetchWithTimeout } from '../../lib/http.js';
/**
 * Google Wallet loyalty passes — the Android counterpart to applePass.js.
 *
 * Much simpler model than Apple: no signing certs, no device registrations,
 * no push service. We mirror state into Google's REST API (LoyaltyClass per
 * tenant, LoyaltyObject per customer) and Google renders/refreshes the card
 * itself. "Enrollment" is a signed Save-to-Wallet JWT link.
 *
 * Auth: a Google Cloud service account added to the Wallet issuer. We sign
 * both the OAuth assertion and the save link with `jsonwebtoken` (already a
 * dependency) — no Google SDK needed.
 *
 * Env (both required for Google passes to be enabled):
 *   GOOGLE_WALLET_ISSUER_ID       — numeric issuer id from Google Pay & Wallet Console
 *   GOOGLE_WALLET_SA_KEY_BASE64   — base64 of the service-account JSON key file
 */

import jwt from 'jsonwebtoken';

const API = 'https://walletobjects.googleapis.com/walletobjects/v1';
const SCOPE = 'https://www.googleapis.com/auth/wallet_object.issuer';

function issuerId() {
  return process.env.GOOGLE_WALLET_ISSUER_ID || null;
}

let _sa = null;
function serviceAccount() {
  if (_sa) return _sa;
  const b64 = process.env.GOOGLE_WALLET_SA_KEY_BASE64;
  if (!b64) return null;
  try {
    _sa = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    return _sa;
  } catch {
    console.error('[GoogleWallet] GOOGLE_WALLET_SA_KEY_BASE64 is not valid base64 JSON');
    return null;
  }
}

export function isGoogleWalletConfigured() {
  return !!(issuerId() && serviceAccount()?.client_email && serviceAccount()?.private_key);
}

/* ==================== OAuth (service-account JWT bearer) ==================== */

let _token = null; // { value, expiresAt }

async function getAccessToken() {
  if (_token && Date.now() < _token.expiresAt - 60_000) return _token.value;

  const sa = serviceAccount();
  const now = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign(
    { iss: sa.client_email, scope: SCOPE, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 },
    sa.private_key,
    { algorithm: 'RS256' }
  );

  const res = await fetchWithTimeout('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(`Google OAuth failed: ${data.error_description || data.error || res.status}`);
  }
  _token = { value: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 };
  return _token.value;
}

async function gapi(method, path, body) {
  const token = await getAccessToken();
  const res = await fetchWithTimeout(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

/* ==================== Ids ==================== */

// Class/object id suffixes allow only [A-Za-z0-9._-]
function safeSuffix(s) {
  return String(s).replace(/[^a-zA-Z0-9._-]/g, '_');
}

export function classIdFor(tenantId) {
  return `${issuerId()}.${safeSuffix(tenantId)}-loyalty`;
}

export function objectIdFor(serialNumber) {
  return `${issuerId()}.${safeSuffix(serialNumber)}`;
}

/* ==================== Class (per tenant, lazy) ==================== */

// Hex color for Google (they take hex directly, unlike Apple's rgb()).
function hexBgColor(config, branding) {
  const candidate = config?.wallet_bg_color?.value || branding?.primaryColor || '#0d9488';
  return /^#?[0-9a-f]{6}$/i.test(candidate.trim())
    ? (candidate.trim().startsWith('#') ? candidate.trim() : `#${candidate.trim()}`)
    : '#0d9488';
}

const _ensuredClasses = new Set(); // per-process: skip repeat GETs

/**
 * Make sure the tenant's LoyaltyClass exists and reflects current branding.
 * @param {object} p { tenantId, tenant: {name, branding}, config, host }
 */
export async function ensureLoyaltyClass({ tenantId, tenant, config, host }) {
  const id = classIdFor(tenantId);

  const branding = tenant?.branding || {};
  const logoUri = branding.logoUrl
    ? (branding.logoUrl.startsWith('http') ? branding.logoUrl : `https://${host}${branding.logoUrl}`)
    : `https://${host}/icon-192.png`;

  const cls = {
    id,
    issuerName: 'Desktop Kitchen',
    programName: tenant?.name || 'Loyalty',
    programLogo: { sourceUri: { uri: logoUri } },
    hexBackgroundColor: hexBgColor(config, branding),
    reviewStatus: 'UNDER_REVIEW',
    countryCode: 'MX',
  };

  if (_ensuredClasses.has(id)) {
    // Keep branding fresh without a GET round-trip — PATCH is cheap and
    // idempotent; failures are non-fatal (class already exists and works).
    gapiPatchClass(id, cls).catch(() => {});
    return id;
  }

  const existing = await gapi('GET', `/loyaltyClass/${encodeURIComponent(id)}`);
  if (existing.ok) {
    _ensuredClasses.add(id);
    await gapiPatchClass(id, cls).catch(() => {});
    return id;
  }
  if (existing.status !== 404) {
    throw new Error(`LoyaltyClass GET failed (${existing.status}): ${JSON.stringify(existing.data).slice(0, 200)}`);
  }

  const created = await gapi('POST', '/loyaltyClass', cls);
  if (!created.ok && created.status !== 409) {
    throw new Error(`LoyaltyClass create failed (${created.status}): ${JSON.stringify(created.data).slice(0, 200)}`);
  }
  _ensuredClasses.add(id);
  return id;
}

async function gapiPatchClass(id, cls) {
  const { issuerName, programName, programLogo, hexBackgroundColor } = cls;
  return gapi('PATCH', `/loyaltyClass/${encodeURIComponent(id)}`, {
    issuerName,
    programName,
    programLogo,
    hexBackgroundColor,
    reviewStatus: 'UNDER_REVIEW',
  });
}

/* ==================== Object (per customer) ==================== */

function objectPayload({ pass, customer, card, config, classId }) {
  const cfg = (key, dflt = '') => {
    const v = config?.[key]?.value;
    return v !== undefined && v !== null && String(v).trim() !== '' ? String(v) : dflt;
  };
  return {
    id: objectIdFor(pass.serial_number),
    classId,
    state: 'ACTIVE',
    accountId: String(customer.id),
    accountName: customer.name,
    loyaltyPoints: {
      label: cfg('wallet_label_stamps', 'Sellos'),
      balance: { string: `${card.stamps_earned} / ${card.stamps_required}` },
    },
    textModulesData: [
      {
        id: 'reward',
        header: cfg('wallet_label_reward', 'Recompensa'),
        body: card.reward_description || cfg('reward_description', 'Producto gratis'),
      },
    ],
    barcode: {
      type: 'QR_CODE',
      value: `dk-loyalty:${pass.serial_number}`,
      alternateText: customer.referral_code || undefined,
    },
  };
}

/** Create the LoyaltyObject if new, else bring it up to date. */
export async function ensureLoyaltyObject({ pass, customer, card, config, classId }) {
  const obj = objectPayload({ pass, customer, card, config, classId });
  const created = await gapi('POST', '/loyaltyObject', obj);
  if (created.ok) return obj.id;
  if (created.status === 409) {
    const patched = await gapi('PATCH', `/loyaltyObject/${encodeURIComponent(obj.id)}`, obj);
    if (!patched.ok) {
      throw new Error(`LoyaltyObject patch failed (${patched.status}): ${JSON.stringify(patched.data).slice(0, 200)}`);
    }
    return obj.id;
  }
  throw new Error(`LoyaltyObject create failed (${created.status}): ${JSON.stringify(created.data).slice(0, 200)}`);
}

/** Cheap stamp-count sync used by passSync after loyalty mutations. */
export async function updateLoyaltyObjectBalance(serialNumber, balanceString) {
  const id = objectIdFor(serialNumber);
  const res = await gapi('PATCH', `/loyaltyObject/${encodeURIComponent(id)}`, {
    loyaltyPoints: { balance: { string: balanceString } },
  });
  if (!res.ok && res.status !== 404) {
    console.error(`[GoogleWallet] balance patch failed (${res.status}) for ${id}`);
  }
  return res.ok;
}

/* ==================== Save-to-Wallet link ==================== */

export function saveLinkFor(serialNumber) {
  const sa = serviceAccount();
  const token = jwt.sign(
    {
      iss: sa.client_email,
      aud: 'google',
      typ: 'savetowallet',
      payload: { loyaltyObjects: [{ id: objectIdFor(serialNumber) }] },
    },
    sa.private_key,
    { algorithm: 'RS256' }
  );
  return `https://pay.google.com/gp/v/save/${token}`;
}
