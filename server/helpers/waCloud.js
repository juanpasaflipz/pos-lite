// Meta WhatsApp Cloud API client + webhook utilities.
//
// Multi-number by design: we run as our own Meta Tech Provider, so the same
// app onboards DK's coexistence number (+52 56 1309 6835) AND each tenant
// restaurant's own WhatsApp Business number. A number in coexistence stays on
// the WhatsApp Business app on the restaurant phone (humans answer to-go
// orders there) while this API connection runs employee voice-ops — and,
// later, the order bot. Twilio is NOT involved on these numbers; Twilio
// remains the SMS/loyalty sender only.
//
// Credentials split, because it is not obvious:
//   PER-TENANT (tenant_credentials, service='whatsapp') — the things that
//     differ per number: access_token, phone_number_id, waba_id.
//   PLATFORM (env) — the things that are ours, not the tenant's. Every tenant
//     WABA delivers to ONE webhook URL signed with OUR app secret, so
//     signature verification and the GET handshake are number-independent.
//
// Env (WA_CLOUD_ACCESS_TOKEN/PHONE_NUMBER_ID unset = no platform fallback;
// tenants with stored credentials still work):
//   WA_CLOUD_ACCESS_TOKEN     Fallback Graph API bearer token (DK's own number)
//   WA_CLOUD_PHONE_NUMBER_ID  Fallback Cloud API phone-number id
//   WA_CLOUD_APP_SECRET       App secret used to sign webhooks (X-Hub-Signature-256)
//   WA_CLOUD_VERIFY_TOKEN     Static token echoed in the GET webhook handshake
//   WA_GRAPH_VERSION          Graph version, default v23.0
//   WA_CLOUD_ALLOW_UNSIGNED   'on' = accept unsigned webhooks (onboarding/testing ONLY)
//
// https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples

import crypto from 'crypto';
import { fetchWithTimeout } from '../lib/http.js';
import { adminSql } from '../db/index.js';
import { getServiceCredentials } from './tenantCredentials.js';

const GRAPH_VERSION = process.env.WA_GRAPH_VERSION || 'v23.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

// Media downloads are unbounded on the wire — a 100 MB video from a registered
// employee would otherwise be pulled into memory, base64'd (+33%) into the
// Claude request, and only THEN rejected for its content type. Receipts and
// shelf photos are ~1-5 MB; voice notes far less.
const MAX_MEDIA_BYTES = 10 * 1024 * 1024;

/**
 * A tenant's Cloud API credentials. Falls back to the platform env values so
 * DK's own number keeps working with zero rows in tenant_credentials.
 * @typedef {{ accessToken: string, phoneNumberId: string }} CloudConfig
 */

/** The platform (env) config — DK's own number. */
export function envCloudConfig() {
  return {
    accessToken: process.env.WA_CLOUD_ACCESS_TOKEN || '',
    phoneNumberId: process.env.WA_CLOUD_PHONE_NUMBER_ID || '',
  };
}

export function isCloudConfigured(cfg = envCloudConfig()) {
  return Boolean(cfg?.accessToken && cfg?.phoneNumberId);
}

// phone_number_id → tenant_id. Hit on every inbound message and the mapping
// only changes at onboarding time, so it is memoized with a short TTL rather
// than queried per webhook. Negative results are cached too — an unrecognized
// WABA hammering the endpoint shouldn't mean a DB round-trip per message.
const TENANT_CACHE_TTL_MS = 5 * 60 * 1000;
const _tenantCache = new Map(); // phoneNumberId → { tenantId, at }

/** Test seam — drop the memoized phone_number_id → tenant mapping. */
export function clearCloudTenantCache() {
  _tenantCache.clear();
}

/**
 * Find the tenant that owns an inbound number. Returns null when the number
 * isn't ours — callers must NOT guess a tenant in that case.
 *
 * Uses adminSql (bypasses RLS): the webhook runs before any tenant context
 * exists, which is the whole point of this lookup. Same shape as the
 * print-agent token lookup in middleware/agentAuth.js.
 */
export async function resolveTenantByPhoneNumberId(phoneNumberId) {
  const id = String(phoneNumberId || '').trim();
  if (!id) return null;

  const hit = _tenantCache.get(id);
  if (hit && Date.now() - hit.at < TENANT_CACHE_TTL_MS) return hit.tenantId;

  const rows = await adminSql`
    SELECT tenant_id FROM tenant_credentials
    WHERE service = 'whatsapp' AND key = 'phone_number_id' AND value = ${id}
    LIMIT 1
  `;
  const tenantId = rows[0]?.tenant_id || null;
  _tenantCache.set(id, { tenantId, at: Date.now() });
  return tenantId;
}

/**
 * Credentials for a tenant, with env fallback. Passing a null tenantId yields
 * the platform config, which is what keeps the pre-multi-tenant pilot working.
 */
export async function cloudConfigFor(tenantId) {
  if (!tenantId) return envCloudConfig();
  const creds = await getServiceCredentials(tenantId, 'whatsapp', {
    access_token: 'WA_CLOUD_ACCESS_TOKEN',
    phone_number_id: 'WA_CLOUD_PHONE_NUMBER_ID',
  });
  return {
    accessToken: creds.access_token || '',
    phoneNumberId: creds.phone_number_id || '',
  };
}

/**
 * Verify X-Hub-Signature-256 over the raw request body.
 * Header format: `sha256=<hex hmac>`. Returns false on any mismatch or
 * malformed input; never throws.
 */
export function verifyCloudSignature(rawBody, signatureHeader, secret = process.env.WA_CLOUD_APP_SECRET) {
  if (!secret || !signatureHeader || !rawBody) return false;
  const header = String(signatureHeader);
  if (!header.startsWith('sha256=')) return false;
  const theirs = header.slice('sha256='.length);
  const ours = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  try {
    const a = Buffer.from(theirs, 'utf8');
    const b = Buffer.from(ours, 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Flatten a webhook payload into [{ field, value }] changes.
 * Fields seen on a coexistence number:
 *   'messages'            inbound customer/employee messages + statuses
 *   'smb_message_echoes'  messages a human sent from the phone app (mirrored)
 *   'smb_app_state_sync'  contact/app state sync events (ignore)
 */
export function extractChanges(payload) {
  if (!payload || payload.object !== 'whatsapp_business_account') return [];
  const out = [];
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      if (change && change.field) out.push({ field: change.field, value: change.value || {} });
    }
  }
  return out;
}

/**
 * Cloud API `from` is bare digits (no `+`). MX arrives as `521` + 10 digits on
 * some WABAs and `52` + 10 on others — normalize to the WhatsApp-canonical
 * `+52` + 10 form (matches how employees.phone is stored; phoneVariants in the
 * voice-ops engine absorbs the rest).
 */
export function normalizeCloudFrom(from) {
  const digits = String(from || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 13 && digits.startsWith('521')) return `+52${digits.slice(3)}`;
  return `+${digits}`;
}

/**
 * Best-effort text extraction across message types. Interactive replies
 * (button/list taps) surface their title so downstream flows can treat them
 * as typed text.
 */
export function messageText(message) {
  if (!message) return '';
  switch (message.type) {
    case 'text': return message.text?.body || '';
    case 'button': return message.button?.text || '';
    case 'interactive':
      return message.interactive?.button_reply?.title
        || message.interactive?.list_reply?.title
        || '';
    case 'audio': return '';                      // caption-less by design
    case 'image': return message.image?.caption || '';
    case 'video': return message.video?.caption || '';
    case 'document': return message.document?.caption || '';
    default: return '';
  }
}

/** The media id for audio/image/etc., or null. */
export function messageMediaId(message) {
  if (!message) return null;
  const media = message.audio || message.image || message.video || message.document || message.sticker;
  return media?.id || null;
}

async function graphFetch(cfg, path, options = {}) {
  const res = await fetchWithTimeout(`${GRAPH_BASE}${path}`, {
    timeoutMs: 15000,
    ...options,
    headers: {
      Authorization: `Bearer ${cfg.accessToken}`,
      ...(options.headers || {}),
    },
  });
  return res;
}

/**
 * Download a media attachment: media id → short-lived URL → bytes.
 * Both hops require the bearer token.
 *
 * Rejects anything over MAX_MEDIA_BYTES. Meta reports file_size on the meta
 * hop, so oversized media is refused before a single byte is transferred;
 * Content-Length is the backstop when it isn't.
 */
export async function fetchCloudMedia(cfg, mediaId) {
  const metaRes = await graphFetch(cfg, `/${mediaId}`);
  if (!metaRes.ok) {
    throw new Error(`Cloud media meta ${metaRes.status}: ${await metaRes.text().catch(() => '')}`);
  }
  const meta = await metaRes.json();
  if (!meta.url) throw new Error('Cloud media meta missing url');
  if (Number(meta.file_size) > MAX_MEDIA_BYTES) {
    throw new Error(`Cloud media too large: ${meta.file_size} bytes (max ${MAX_MEDIA_BYTES})`);
  }

  const binRes = await fetchWithTimeout(meta.url, {
    timeoutMs: 20000,
    headers: { Authorization: `Bearer ${cfg.accessToken}` },
    redirect: 'follow',
  });
  if (!binRes.ok) {
    throw new Error(`Cloud media download ${binRes.status}: ${await binRes.text().catch(() => '')}`);
  }
  const declared = Number(binRes.headers.get('content-length'));
  if (declared > MAX_MEDIA_BYTES) {
    throw new Error(`Cloud media too large: ${declared} bytes (max ${MAX_MEDIA_BYTES})`);
  }
  const contentType = binRes.headers.get('content-type') || meta.mime_type || 'application/octet-stream';
  const buffer = Buffer.from(await binRes.arrayBuffer());
  if (buffer.length > MAX_MEDIA_BYTES) {
    throw new Error(`Cloud media too large: ${buffer.length} bytes (max ${MAX_MEDIA_BYTES})`);
  }
  return { buffer, contentType };
}

/**
 * Send a free-form text message. Only valid inside the 24h customer-service
 * window, which always holds here — we only ever send as a REPLY to an
 * inbound message. Returns the wamid on success, null on failure (logged).
 */
export async function sendCloudText(cfg, to, body) {
  if (!isCloudConfigured(cfg) || !to || !body) return null;
  try {
    const res = await graphFetch(cfg, `/${cfg.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: String(to).replace(/^\+/, ''),
        type: 'text',
        text: { preview_url: false, body },
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error('[WACloud] send failed:', data?.error?.message || res.status);
      return null;
    }
    return data?.messages?.[0]?.id || null;
  } catch (err) {
    console.error('[WACloud] send error:', err.message);
    return null;
  }
}

/**
 * Mark an inbound message read (grey → blue ticks). Best-effort; failures are
 * silent — read receipts are cosmetic.
 */
export async function markCloudRead(cfg, messageId) {
  if (!isCloudConfigured(cfg) || !messageId) return;
  try {
    await graphFetch(cfg, `/${cfg.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
      }),
    });
  } catch { /* cosmetic */ }
}
