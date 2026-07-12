import { run } from '../db/index.js';
import { tenantContext } from '../db/index.js';
import { getServiceCredentials } from './tenantCredentials.js';

// Platform-level defaults (used as fallbacks)
const PLATFORM_SID = process.env.TWILIO_ACCOUNT_SID;
const PLATFORM_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const PLATFORM_PHONE = process.env.TWILIO_PHONE_NUMBER;

const CONTENT_SID_ENV = {
  welcome: 'TWILIO_CONTENT_SID_WELCOME',
  stamp_earned: 'TWILIO_CONTENT_SID_STAMP_EARNED',
  card_completed: 'TWILIO_CONTENT_SID_CARD_COMPLETED',
  referral_success: 'TWILIO_CONTENT_SID_REFERRAL_SUCCESS',
};

/**
 * Resolve Twilio credentials + per-message-type Content SIDs.
 * Tenant-level config takes precedence; platform env vars are a fallback.
 */
async function resolveTwilio() {
  const tenantId = tenantContext.getStore()?.tenantId;
  if (tenantId) {
    const creds = await getServiceCredentials(tenantId, 'twilio', {
      account_sid: 'TWILIO_ACCOUNT_SID',
      auth_token: 'TWILIO_AUTH_TOKEN',
      phone_number: 'TWILIO_PHONE_NUMBER',
      content_sid_welcome: CONTENT_SID_ENV.welcome,
      content_sid_stamp_earned: CONTENT_SID_ENV.stamp_earned,
      content_sid_card_completed: CONTENT_SID_ENV.card_completed,
      content_sid_referral_success: CONTENT_SID_ENV.referral_success,
    });
    return {
      sid: creds.account_sid,
      token: creds.auth_token,
      sender: creds.phone_number,
      contentSids: {
        welcome: creds.content_sid_welcome,
        stamp_earned: creds.content_sid_stamp_earned,
        card_completed: creds.content_sid_card_completed,
        referral_success: creds.content_sid_referral_success,
      },
    };
  }
  return {
    sid: PLATFORM_SID,
    token: PLATFORM_TOKEN,
    sender: PLATFORM_PHONE,
    contentSids: {
      welcome: process.env[CONTENT_SID_ENV.welcome],
      stamp_earned: process.env[CONTENT_SID_ENV.stamp_earned],
      card_completed: process.env[CONTENT_SID_ENV.card_completed],
      referral_success: process.env[CONTENT_SID_ENV.referral_success],
    },
  };
}

/**
 * Format a phone number to E.164 for WhatsApp delivery. WhatsApp uses the
 * customer's real country code (+1 for US, +52 for MX — no mobile prefix
 * "+521" gymnastics, that's an SMS-only Twilio quirk). Falls back to MX.
 *
 * Always strips and re-normalizes — never trust a leading `+` to mean the
 * number is already in the correct format. A customer stored as
 * `+522281246837` (missing MX mobile prefix) would otherwise pass through
 * unchanged and hit a landline.
 */
export function toE164(phone, countryCode = 'MX') {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '';
  const cc = (countryCode || 'MX').toUpperCase();

  if (cc === 'US' || cc === 'CA') {
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
    return `+1${digits.slice(-10)}`;
  }
  // MX: WhatsApp accepts +52 + 10 digits (do NOT use the +521 mobile prefix)
  if (digits.length === 13 && digits.startsWith('521')) return `+52${digits.slice(3)}`;
  if (digits.length === 12 && digits.startsWith('52')) return `+${digits}`;
  return `+52${digits.slice(-10)}`;
}

/** Normalize the merchant's WhatsApp sender into `whatsapp:+E164` form. */
function senderAddress(sender) {
  if (!sender) return null;
  if (sender.startsWith('whatsapp:')) return sender;
  return `whatsapp:${sender.startsWith('+') ? sender : '+' + sender}`;
}

/**
 * E.164 formatter for **SMS** delivery. MX mobile numbers require the "+521"
 * mobile prefix on the Twilio SMS network (unlike WhatsApp, which uses "+52").
 *
 * Always strips and re-normalizes — never trust a leading `+` to mean the
 * number is already in the correct format. A number stored as `+522281246837`
 * (missing the mobile "1") would otherwise pass through and hit an MX
 * landline, which drops the SMS with carrier error 30008.
 */
export function toE164SMS(phone, countryCode = 'MX') {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '';
  const cc = (countryCode || 'MX').toUpperCase();

  if (cc === 'US' || cc === 'CA') {
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
    return `+1${digits.slice(-10)}`;
  }
  if (digits.length === 13 && digits.startsWith('521')) return `+${digits}`;
  if (digits.length === 12 && digits.startsWith('52')) return `+521${digits.slice(2)}`;
  return `+521${digits.slice(-10)}`;
}

// Strip characters that aren't in the GSM-7 base alphabet so the message stays
// single-segment (160 chars vs 70 in UCS-2). á/í/ó/ú, smart quotes, em dashes,
// and ellipsis all force UCS-2 → MX carriers split the message across rotated
// senders and it arrives truncated. ñ, é, è, à, ä, ö, ü, ç, ¡, ¿ are GSM-7 base
// and pass through unchanged.
const GSM7_REPLACEMENTS = {
  'á': 'a', 'í': 'i', 'ó': 'o', 'ú': 'u',
  'Á': 'A', 'Í': 'I', 'Ó': 'O', 'Ú': 'U',
  '—': '-', '–': '-',
  '\u2018': "'", '\u2019': "'",
  '\u201C': '"', '\u201D': '"',
  '…': '...',
};
function sanitizeForGsm7(text) {
  if (!text) return text;
  return String(text).replace(/[áíóúÁÍÓÚ—–\u2018\u2019\u201C\u201D…]/g, (c) => GSM7_REPLACEMENTS[c] || c);
}

const SINGLE_SMS_LIMIT = 160;

function firstSingleSegment(candidates) {
  for (const candidate of candidates) {
    const clean = sanitizeForGsm7(candidate);
    if (clean.length <= SINGLE_SMS_LIMIT) return candidate;
  }
  return candidates[candidates.length - 1];
}

/**
 * Send a free-form SMS via Twilio REST API. Loyalty wrappers pass customerId +
 * messageType so each delivery is logged to loyalty_messages for tracking.
 * Returns the Twilio message SID on success, or null on failure / missing config.
 */
// Twilio's public WhatsApp sandbox number. Cannot send SMS at all — if a
// tenant leaves this in `twilio.phone_number` after WA sandbox testing, we
// must refuse to use it as an SMS sender (Twilio rejects with error 21660).
export const TWILIO_WA_SANDBOX_NUMBER = '+14155238886';

export function isValidSmsSender(sender) {
  if (!sender) return false;
  if (sender.startsWith('whatsapp:')) return false;
  if (sender === TWILIO_WA_SANDBOX_NUMBER) return false;
  return true;
}

export async function sendSMS(to, body, customerId = null, messageType = 'general', countryCode = 'MX') {
  const { sid, token, sender } = await resolveTwilio();
  if (!sid || !token || !sender || !body) return null;

  if (!isValidSmsSender(sender)) {
    console.error(
      `[Twilio] refusing to send SMS ${messageType}: sender "${sender}" is not a valid SMS number (WhatsApp-only or sandbox).`,
    );
    if (customerId) {
      await run(
        `INSERT INTO loyalty_messages (customer_id, message_type, twilio_sid, status) VALUES ($1, $2, $3, $4)`,
        [customerId, messageType, null, 'failed'],
      );
    }
    return null;
  }

  const from = sender;
  const e164 = toE164SMS(to, countryCode);
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
  const auth = Buffer.from(`${sid}:${token}`).toString('base64');

  const cleanBody = sanitizeForGsm7(body);
  if (cleanBody.length > 160) {
    console.warn(`[Twilio] ${messageType} SMS is ${cleanBody.length} chars — will split into multiple segments and may be sender-rotated by MX carriers.`);
  }

  const params = new URLSearchParams({ To: e164, From: from, Body: cleanBody });

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params,
    });
    const data = await res.json();

    if (customerId) {
      await run(
        `INSERT INTO loyalty_messages (customer_id, message_type, twilio_sid, status) VALUES ($1, $2, $3, $4)`,
        [customerId, messageType, data.sid || null, res.ok ? 'sent' : 'failed']
      );
    }

    if (!res.ok) {
      console.error('[Twilio] SMS send failed:', data.message || data);
      return null;
    }
    return data.sid;
  } catch (err) {
    console.error('[Twilio] SMS error:', err.message);
    return null;
  }
}

/**
 * Send a WhatsApp message using a Twilio approved Content template.
 *
 * Variables map by messageType (positional, matches Twilio template {{1}}, {{2}}...):
 *   welcome:          { 1: restaurantName, 2: name,        3: referralCode }
 *   stamp_earned:     { 1: name,           2: restaurantName, 3: earned, 4: required }
 *   card_completed:   { 1: name,           2: restaurantName, 3: reward }
 *   referral_success: { 1: name,           2: refereeName,   3: restaurantName, 4: bonus }
 *
 * Templates with no placeholders ignore extra variables — safe to send anyway.
 * If no Content SID is configured for the message type, the send is skipped
 * silently (returns null) so partial template coverage doesn't crash flows.
 */
export async function sendWhatsAppTemplate(to, messageType, variables, customerId = null, countryCode = 'MX') {
  const { sid, token, sender, contentSids } = await resolveTwilio();
  if (!sid || !token || !sender) return null;

  const contentSid = contentSids[messageType];
  if (!contentSid) {
    // Tenant hasn't configured a template for this message type — skip.
    return null;
  }

  const e164 = toE164(to, countryCode);
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
  const auth = Buffer.from(`${sid}:${token}`).toString('base64');

  const params = new URLSearchParams({
    To: `whatsapp:${e164}`,
    From: senderAddress(sender),
    ContentSid: contentSid,
  });
  if (variables && Object.keys(variables).length > 0) {
    params.append('ContentVariables', JSON.stringify(variables));
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params,
    });
    const data = await res.json();

    if (customerId) {
      await run(
        `INSERT INTO loyalty_messages (customer_id, message_type, twilio_sid, status) VALUES ($1, $2, $3, $4)`,
        [customerId, messageType, data.sid || null, res.ok ? 'sent' : 'failed']
      );
    }

    if (!res.ok) {
      console.error('[Twilio] WhatsApp send failed:', data.message || data);
      return null;
    }
    return data.sid;
  } catch (err) {
    console.error('[Twilio] WhatsApp error:', err.message);
    return null;
  }
}

/**
 * Send a free-form SMS reply from a specific Twilio number. Mirrors
 * sendWhatsAppText but for the SMS channel: used by the inbound webhook
 * to reply on the same number that received the message (loyalty traffic
 * uses one MX SMS sender that also doubles as the voice-ops inbound).
 *
 * `to` and `from` must both be SMS-channel E.164 (no `whatsapp:` prefix).
 * Body is GSM-7 sanitized and warned if it would split into multi-segment.
 */
export async function sendSMSReply(to, body, { from, sid, token } = {}) {
  const accountSid = sid || PLATFORM_SID;
  const authToken = token || PLATFORM_TOKEN;
  const sender = from || PLATFORM_PHONE;
  if (!accountSid || !authToken || !sender || !body) return null;

  if (!isValidSmsSender(sender)) {
    console.error(
      `[Twilio] refusing to send SMS reply: sender "${sender}" is not a valid SMS number (WhatsApp-only or sandbox).`,
    );
    return null;
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  const cleanBody = sanitizeForGsm7(String(body));
  if (cleanBody.length > 160) {
    console.warn(`[Twilio] SMS reply is ${cleanBody.length} chars — will split into multiple segments and may be sender-rotated by MX carriers.`);
  }
  const params = new URLSearchParams({ To: to, From: sender, Body: cleanBody });

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params,
    });
    const data = await res.json();
    if (!res.ok) {
      console.error('[Twilio] SMS reply send failed:', data.message || data);
      return null;
    }
    return data.sid;
  } catch (err) {
    console.error('[Twilio] SMS reply error:', err.message);
    return null;
  }
}

/**
 * Send a free-form WhatsApp text message. Only legal inside the 24-hour
 * session window (i.e. a reply to an inbound message from the same number).
 * Used by the voice-ops webhook to send confirmation prompts + success
 * receipts back to staff. Takes platform Twilio creds since the inbound
 * webhook lives at the platform level, not inside a tenant context.
 *
 * `from` may be the bare E.164 sender or already `whatsapp:+...`.
 */
export async function sendWhatsAppText(to, body, { from, sid, token } = {}) {
  const accountSid = sid || PLATFORM_SID;
  const authToken = token || PLATFORM_TOKEN;
  const sender = from || PLATFORM_PHONE;
  if (!accountSid || !authToken || !sender || !body) return null;

  const toAddr = to.startsWith('whatsapp:') ? to : `whatsapp:${to.startsWith('+') ? to : '+' + to}`;
  const fromAddr = senderAddress(sender);
  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  const params = new URLSearchParams({ To: toAddr, From: fromAddr, Body: String(body) });

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params,
    });
    const data = await res.json();
    if (!res.ok) {
      console.error('[Twilio] WA text send failed:', data.message || data);
      return null;
    }
    return data.sid;
  } catch (err) {
    console.error('[Twilio] WA text error:', err.message);
    return null;
  }
}

// Loyalty wrappers route through SMS by default — WhatsApp template approval is
// slow and per-tenant. To re-enable WhatsApp, swap each sendSMS call below for
// sendWhatsAppTemplate with the matching messageType and positional variables.

// Append a Google review CTA when the tenant has configured a review URL.
// Kept tight (no emoji, short prefix) so we stay within a single GSM-7 segment
// after appending — multi-segment MX A2P traffic gets sender-rotated by the
// carrier and arrives as separate conversations on iOS.
// Append the review CTA only if the combined body stays single-segment (160
// GSM-7 chars). When a long reward description or restaurant name pushes us
// over, drop the CTA rather than ship a 2-segment message that MX carriers
// sender-rotate and deliver truncated.
function withReviewCta(body, reviewUrl) {
  const url = (reviewUrl || '').trim();
  if (!url) return body;
  const withCta = `${body} Resena: ${url}`;
  return withCta.length <= 160 ? withCta : body;
}

// Bodies must be GSM-7 base alphabet only — sendSMS sanitizes á/í/ó/ú and em
// dashes, but keep them out of literals so the strings here match what ships.
// Budget: 160 chars after variable substitution. Restaurant names of ~20 chars
// and reward descriptions of ~30 chars are typical worst case.

export async function sendWelcomeMessage(phone, name, referralCode, restaurantName = 'Our', countryCode = 'MX') {
  // "STOP para cancelar" appears once, in the welcome message, per MX A2P and
  // Twilio compliance guidance. STOP replies are auto-honored by Twilio.
  // Copy trimmed so this stays single-segment even for long name+restaurant
  // combinations (MX carriers rotate senders on multi-segment sends).
  const body = `Hola ${name}! Bienvenido a ${restaurantName} Rewards. Tu codigo: ${referralCode}. Compartelo y ambos ganan 2 sellos. STOP para cancelar.`;
  return sendSMS(phone, body, null, 'welcome', countryCode);
}

export async function sendStampEarnedMessage(phone, name, earned, required, customerId, restaurantName = 'us', countryCode = 'MX', reviewUrl = null) {
  const body = withReviewCta(
    `Hola ${name}! Sello ganado en ${restaurantName}: ${earned}/${required}. Sigue asi!`,
    reviewUrl,
  );
  return sendSMS(phone, body, customerId, 'stamp_earned', countryCode);
}

export async function sendCardCompletedMessage(phone, name, reward, customerId, restaurantName = 'us', countryCode = 'MX', reviewUrl = null) {
  // Review CTA moved off card_completed as of 2026-07-09 — the post-order
  // review SMS (fires 1h after every completed order) is now the single
  // review channel. Card-completed stays a pure celebration message so we
  // don't stack two review asks on the same customer within an hour.
  // reviewUrl kept in the signature so existing callers don't break.
  void reviewUrl;
  const body = `${name}, tarjeta llena en ${restaurantName}! Premio: ${reward}. Canjea en tu siguiente visita.`;
  return sendSMS(phone, body, customerId, 'card_completed', countryCode);
}

export async function sendReferralSuccessMessage(phone, name, refereeName, bonus, customerId, restaurantName = 'Our', countryCode = 'MX') {
  const body = `Hola ${name}! ${refereeName} se unio a ${restaurantName} Rewards con tu codigo. Ambos ganan ${bonus} sellos extra. Gracias!`;
  return sendSMS(phone, body, customerId, 'referral_success', countryCode);
}

// Receipt SMS — body kept single-segment so MX carriers don't sender-rotate
// (~160 GSM-7 chars). orderNumber, totalFormatted ($250.00 MXN), and url
// together usually fit comfortably under that budget.
export async function sendReceiptMessage(phone, orderNumber, totalFormatted, url, restaurantName = 'us', countryCode = 'MX') {
  const body = `${restaurantName}: Recibo #${orderNumber} ${totalFormatted}. Ver: ${url}`;
  return sendSMS(phone, body, null, 'receipt', countryCode);
}

export async function sendOrderReadyMessage(phone, name, orderNumber, customerId, restaurantName = 'us', countryCode = 'MX') {
  const firstName = name ? String(name).split(/\s+/)[0] : '';
  const body = firstSingleSegment([
    firstName
      ? `Hola ${firstName}, tu orden de ${restaurantName} esta lista.`
      : `Tu orden #${orderNumber} de ${restaurantName} esta lista.`,
    `Tu orden #${orderNumber} de ${restaurantName} esta lista.`,
    `Orden #${orderNumber} lista.`,
  ]);
  return sendSMS(phone, body, customerId, 'order_ready', countryCode);
}

export async function sendPostOrderReviewMessage(
  phone,
  name,
  customerId,
  restaurantName = 'us',
  reviewUrl,
  countryCode = 'MX',
) {
  const firstName = name ? String(name).split(/\s+/)[0] : '';
  // No review URL, no send — caller should guard, but be safe.
  if (!reviewUrl) return null;
  const body = firstSingleSegment([
    firstName
      ? `Hola ${firstName}, gracias por tu visita a ${restaurantName}. Esperamos que hayas disfrutado. ¿Nos compartes tu opinion en Google? ${reviewUrl}`
      : `Gracias por tu visita a ${restaurantName}. Esperamos que hayas disfrutado. ¿Nos compartes tu opinion en Google? ${reviewUrl}`,
    `Gracias por tu visita a ${restaurantName}. ¿Nos compartes tu opinion en Google? ${reviewUrl}`,
    `¿Nos compartes tu opinion en Google? ${reviewUrl}`,
  ]);
  return sendSMS(phone, body, customerId, 'post_order_review', countryCode);
}

export async function sendWinbackMessage(
  phone,
  name,
  customerId,
  restaurantName = 'us',
  stampsEarned = 0,
  stampsRequired = 10,
  countryCode = 'MX',
) {
  const firstName = name ? String(name).split(/\s+/)[0] : '';
  // Progress phrase only if they've earned at least one stamp — "0/10 sellos"
  // reads awkwardly for a lapsed one-time visitor. No review CTA per design
  // (winback tone is "we miss you", not "please rate us").
  const progress = stampsEarned > 0
    ? ` Tu tarjeta te espera con ${stampsEarned}/${stampsRequired} sellos.`
    : '';
  const body = firstSingleSegment([
    firstName
      ? `Hola ${firstName}, te extranamos en ${restaurantName}!${progress} Vuelve pronto.`
      : `Te extranamos en ${restaurantName}!${progress} Vuelve pronto.`,
    firstName
      ? `Hola ${firstName}, te extranamos en ${restaurantName}. Vuelve pronto.`
      : `Te extranamos en ${restaurantName}. Vuelve pronto.`,
    `Te extranamos en ${restaurantName}.`,
  ]);
  return sendSMS(phone, body, customerId, 'winback', countryCode);
}

export async function sendRewardReminderMessage(
  phone,
  name,
  customerId,
  restaurantName = 'us',
  countryCode = 'MX',
  reviewUrl = null,
) {
  const firstName = name ? String(name).split(/\s+/)[0] : '';
  // withReviewCta appends " Resena: {url}" only if it fits single-segment.
  // We try progressively shorter bodies so the review CTA rides along when
  // possible without ever forcing multi-segment on MX carriers.
  const body = firstSingleSegment([
    withReviewCta(
      firstName
        ? `Hola ${firstName}! Tu tarjeta llena en ${restaurantName} te espera. Canjea tu premio en tu proxima visita.`
        : `Tu tarjeta llena en ${restaurantName} te espera. Canjea tu premio en tu proxima visita.`,
      reviewUrl,
    ),
    withReviewCta(`Tu premio en ${restaurantName} sigue disponible. Canjealo pronto.`, reviewUrl),
    `Tu premio en ${restaurantName} sigue disponible. Canjealo pronto.`,
    `Tu premio en ${restaurantName} sigue disponible.`,
  ]);
  return sendSMS(phone, body, customerId, 'reward_reminder', countryCode);
}

export async function sendReceiptLoyaltyMessage(
  phone,
  orderNumber,
  totalFormatted,
  url,
  loyalty,
  restaurantName = 'us',
  countryCode = 'MX',
) {
  const progress = loyalty.cardCompleted
    ? 'premio listo'
    : `${loyalty.stampsEarned}/${loyalty.stampsRequired} sellos`;
  const code = loyalty.referralCode ? ` Codigo ${loyalty.referralCode}.` : '';
  const body = firstSingleSegment([
    `${restaurantName}: recibo #${orderNumber} ${totalFormatted}: ${url}. Rewards: ${progress}.${code}`,
    `Recibo #${orderNumber}: ${url}. Rewards: ${progress}.${code}`,
    `Recibo ${url}. Rewards: ${progress}.${code}`,
    `Recibo ${url}`,
  ]);
  return sendSMS(phone, body, loyalty.customerId || null, 'receipt_loyalty', countryCode);
}
