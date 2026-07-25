// Meta WhatsApp Cloud API client + webhook utilities.
//
// Serves the coexistence number (+52 56 1309 6835): the number stays on the
// WhatsApp Business app on the restaurant phone (humans answer to-go orders
// and DK sales leads there) while this API connection runs employee voice-ops
// — and, later, the order bot. Twilio is NOT involved on this number; Twilio
// remains the SMS/loyalty sender only.
//
// Env (all unset = feature dormant; route mounts but rejects traffic):
//   WA_CLOUD_ACCESS_TOKEN     Graph API bearer token (from Meta / the BSP)
//   WA_CLOUD_PHONE_NUMBER_ID  The number's Cloud API phone-number id
//   WA_CLOUD_APP_SECRET       App secret used to sign webhooks (X-Hub-Signature-256)
//   WA_CLOUD_VERIFY_TOKEN     Static token echoed in the GET webhook handshake
//   WA_GRAPH_VERSION          Graph version, default v23.0
//   WA_CLOUD_ALLOW_UNSIGNED   'on' = accept unsigned webhooks (onboarding/testing ONLY)
//
// https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples

import crypto from 'crypto';
import { fetchWithTimeout } from '../lib/http.js';

const GRAPH_VERSION = process.env.WA_GRAPH_VERSION || 'v23.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

function accessToken() { return process.env.WA_CLOUD_ACCESS_TOKEN; }
function phoneNumberId() { return process.env.WA_CLOUD_PHONE_NUMBER_ID; }

export function isCloudConfigured() {
  return Boolean(accessToken() && phoneNumberId());
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

async function graphFetch(path, options = {}) {
  const res = await fetchWithTimeout(`${GRAPH_BASE}${path}`, {
    timeoutMs: 15000,
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken()}`,
      ...(options.headers || {}),
    },
  });
  return res;
}

/**
 * Download a media attachment: media id → short-lived URL → bytes.
 * Both hops require the bearer token.
 */
export async function fetchCloudMedia(mediaId) {
  const metaRes = await graphFetch(`/${mediaId}`);
  if (!metaRes.ok) {
    throw new Error(`Cloud media meta ${metaRes.status}: ${await metaRes.text().catch(() => '')}`);
  }
  const meta = await metaRes.json();
  if (!meta.url) throw new Error('Cloud media meta missing url');

  const binRes = await fetchWithTimeout(meta.url, {
    timeoutMs: 20000,
    headers: { Authorization: `Bearer ${accessToken()}` },
    redirect: 'follow',
  });
  if (!binRes.ok) {
    throw new Error(`Cloud media download ${binRes.status}: ${await binRes.text().catch(() => '')}`);
  }
  const contentType = binRes.headers.get('content-type') || meta.mime_type || 'application/octet-stream';
  const buffer = Buffer.from(await binRes.arrayBuffer());
  return { buffer, contentType };
}

/**
 * Send a free-form text message. Only valid inside the 24h customer-service
 * window, which always holds here — we only ever send as a REPLY to an
 * inbound message. Returns the wamid on success, null on failure (logged).
 */
export async function sendCloudText(to, body) {
  if (!isCloudConfigured() || !to || !body) return null;
  try {
    const res = await graphFetch(`/${phoneNumberId()}/messages`, {
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
export async function markCloudRead(messageId) {
  if (!isCloudConfigured() || !messageId) return;
  try {
    await graphFetch(`/${phoneNumberId()}/messages`, {
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
