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
 */
function toE164(phone, countryCode = 'MX') {
  const raw = String(phone || '');
  if (raw.startsWith('+')) return raw;
  const digits = raw.replace(/\D/g, '');
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
 */
function toE164SMS(phone, countryCode = 'MX') {
  const raw = String(phone || '');
  if (raw.startsWith('+')) return raw;
  const digits = raw.replace(/\D/g, '');
  const cc = (countryCode || 'MX').toUpperCase();

  if (cc === 'US' || cc === 'CA') {
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
    return `+1${digits.slice(-10)}`;
  }
  if (digits.length === 13 && digits.startsWith('521')) return `+${digits}`;
  if (digits.length === 12 && digits.startsWith('52')) return `+521${digits.slice(2)}`;
  return `+521${digits.slice(-10)}`;
}

/**
 * Send a free-form SMS (used for non-template flows like delivery recapture).
 * Returns the Twilio message SID on success, or null on failure / missing config.
 */
export async function sendSMS(to, body, countryCode = 'MX') {
  const { sid, token, sender } = await resolveTwilio();
  if (!sid || !token || !sender || !body) return null;

  const from = sender.startsWith('whatsapp:') ? sender.replace(/^whatsapp:/, '') : sender;
  const e164 = toE164SMS(to, countryCode);
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
  const auth = Buffer.from(`${sid}:${token}`).toString('base64');

  const params = new URLSearchParams({ To: e164, From: from, Body: body });

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

export async function sendWelcomeMessage(phone, name, referralCode, restaurantName = 'Our', countryCode = 'MX') {
  return sendWhatsAppTemplate(
    phone,
    'welcome',
    { 1: restaurantName, 2: name, 3: referralCode },
    null,
    countryCode,
  );
}

export async function sendStampEarnedMessage(phone, name, earned, required, customerId, restaurantName = 'us', countryCode = 'MX') {
  return sendWhatsAppTemplate(
    phone,
    'stamp_earned',
    { 1: name, 2: restaurantName, 3: String(earned), 4: String(required) },
    customerId,
    countryCode,
  );
}

export async function sendCardCompletedMessage(phone, name, reward, customerId, restaurantName = 'us', countryCode = 'MX') {
  return sendWhatsAppTemplate(
    phone,
    'card_completed',
    { 1: name, 2: restaurantName, 3: reward },
    customerId,
    countryCode,
  );
}

export async function sendReferralSuccessMessage(phone, name, refereeName, bonus, customerId, restaurantName = 'Our', countryCode = 'MX') {
  return sendWhatsAppTemplate(
    phone,
    'referral_success',
    { 1: name, 2: refereeName, 3: restaurantName, 4: String(bonus) },
    customerId,
    countryCode,
  );
}
