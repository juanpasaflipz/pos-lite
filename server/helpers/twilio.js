import { run } from '../db/index.js';
import { tenantContext } from '../db/index.js';
import { getServiceCredentials } from './tenantCredentials.js';

// Platform-level defaults (used as fallbacks)
const PLATFORM_SID = process.env.TWILIO_ACCOUNT_SID;
const PLATFORM_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const PLATFORM_PHONE = process.env.TWILIO_PHONE_NUMBER;

/**
 * Resolve Twilio credentials: tenant-level first, then platform env vars.
 */
async function resolveTwilio() {
  const tenantId = tenantContext.getStore()?.tenantId;
  if (tenantId) {
    const creds = await getServiceCredentials(tenantId, 'twilio', {
      account_sid: 'TWILIO_ACCOUNT_SID',
      auth_token: 'TWILIO_AUTH_TOKEN',
      phone_number: 'TWILIO_PHONE_NUMBER',
    });
    return { sid: creds.account_sid, token: creds.auth_token, phone: creds.phone_number };
  }
  return { sid: PLATFORM_SID, token: PLATFORM_TOKEN, phone: PLATFORM_PHONE };
}

/**
 * Format a 10-digit MX number to E.164 (+521XXXXXXXXXX) for Twilio.
 */
function toE164(phone) {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('+')) return digits;
  if (digits.length === 10) return `+521${digits}`;
  if (digits.length === 12 && digits.startsWith('52')) return `+${digits}`;
  if (digits.length === 13 && digits.startsWith('521')) return `+${digits}`;
  return `+521${digits.slice(-10)}`;
}

/**
 * Send SMS via Twilio REST API (no SDK).
 * Automatically resolves tenant credentials via AsyncLocalStorage.
 * Returns the message SID on success, null on failure or when unconfigured.
 */
export async function sendSMS(to, body, customerId = null, messageType = 'general') {
  const { sid, token, phone } = await resolveTwilio();
  if (!sid || !token || !phone) return null;

  const e164 = toE164(to);
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
  const auth = Buffer.from(`${sid}:${token}`).toString('base64');

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: e164, From: phone, Body: body }),
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

export async function sendWelcomeSMS(phone, name, referralCode, restaurantName = 'Our') {
  const body = `Welcome to ${restaurantName} Rewards, ${name}! You'll earn a stamp with every order. Share your code ${referralCode} with friends — you both get 2 bonus stamps!`;
  return sendSMS(phone, body, null, 'welcome');
}

export async function sendStampEarnedSMS(phone, name, earned, required, customerId, restaurantName = 'us') {
  const body = `Hey ${name}! You earned a stamp at ${restaurantName}! ${earned}/${required} stamps collected. Keep going!`;
  return sendSMS(phone, body, customerId, 'stamp_earned');
}

export async function sendCardCompletedSMS(phone, name, reward, customerId, restaurantName = 'us') {
  const body = `Congrats ${name}! You completed your stamp card at ${restaurantName}! Your reward: ${reward}. Redeem it on your next visit!`;
  return sendSMS(phone, body, customerId, 'card_completed');
}

export async function sendReferralSuccessSMS(phone, name, refereeName, bonus, customerId, restaurantName = 'Our') {
  const body = `Hey ${name}! Your friend ${refereeName} joined ${restaurantName} Rewards using your code. You both earned ${bonus} bonus stamps!`;
  return sendSMS(phone, body, customerId, 'referral_success');
}
