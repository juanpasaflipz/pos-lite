import crypto from 'crypto';
import { all, get, run } from '../db/index.js';
import {
  sendWelcomeMessage,
  sendStampEarnedMessage,
  sendCardCompletedMessage,
  sendReferralSuccessMessage,
} from './twilio.js';

/* ==================== Helpers ==================== */

export async function generateReferralCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 10; attempt++) {
    let code = 'JB';
    for (let i = 0; i < 4; i++) {
      code += chars[crypto.randomInt(0, chars.length)];
    }
    const existing = await get('SELECT id FROM loyalty_customers WHERE referral_code = $1', [code]);
    if (!existing) return code;
  }
  // Fallback: longer code
  return 'JB' + Date.now().toString(36).toUpperCase().slice(-6);
}

// Strip leading country-code digits and return the 10-digit local number.
// countryCode is the ISO code we're storing in loyalty_customers ('MX', 'US', ...).
// US/CA numbers may be entered as 10-digit local or with a leading 1; MX numbers
// may be entered as 10-digit local, "52" + 10 digits, or "521" + 10 digits.
export function normalizePhone(phone, countryCode = 'MX') {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '';
  const cc = (countryCode || 'MX').toUpperCase();

  if (cc === 'US' || cc === 'CA') {
    if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
    return digits.slice(-10);
  }
  // MX (default)
  if (digits.length === 13 && digits.startsWith('521')) return digits.slice(3);
  if (digits.length === 12 && digits.startsWith('52')) return digits.slice(2);
  return digits.slice(-10);
}

/* ==================== Config ==================== */

export async function getLoyaltyConfig() {
  const rows = await all('SELECT key, value, description, updated_at FROM loyalty_config');
  const config = {};
  for (const row of rows) {
    config[row.key] = { value: row.value, description: row.description, updated_at: row.updated_at };
  }
  return config;
}

export async function getConfigValue(key, defaultVal = null) {
  const row = await get('SELECT value FROM loyalty_config WHERE key = $1', [key]);
  return row ? row.value : defaultVal;
}

export async function updateLoyaltyConfig(key, value) {
  await run(
    `INSERT INTO loyalty_config (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT(tenant_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, value]
  );
}

/* ==================== Stamp Cards ==================== */

export async function getActiveStampCard(customerId) {
  let card = await get(
    `SELECT * FROM stamp_cards WHERE customer_id = $1 AND completed = false ORDER BY id DESC LIMIT 1`,
    [customerId]
  );
  if (!card) {
    const stampsRequired = parseInt(await getConfigValue('stamps_required', '10'));
    const rewardDesc = await getConfigValue('reward_description', 'Free item of your choice');
    const { lastInsertRowid } = await run(
      `INSERT INTO stamp_cards (customer_id, stamps_required, reward_description) VALUES ($1, $2, $3)`,
      [customerId, stampsRequired, rewardDesc]
    );
    card = await get('SELECT * FROM stamp_cards WHERE id = $1', [lastInsertRowid]);
  }
  return card;
}

/* ==================== Customer Operations ==================== */

export async function findOrCreateCustomer(
  phone,
  name,
  referralCodeUsed,
  smsOptIn = false,
  restaurantName = 'Our',
  countryCode = 'MX',
  options = {},
) {
  const { sendWelcomeSms = true } = options;
  const cc = (countryCode || 'MX').toUpperCase();
  const normalized = normalizePhone(phone, cc);
  let customer = await get(
    'SELECT * FROM loyalty_customers WHERE phone = $1 AND country_code = $2',
    [normalized, cc]
  );

  if (customer) {
    return { customer, created: false };
  }

  const referralCode = await generateReferralCode();
  const { lastInsertRowid } = await run(
    `INSERT INTO loyalty_customers (phone, country_code, name, referral_code, sms_opt_in) VALUES ($1, $2, $3, $4, $5)`,
    [normalized, cc, name, referralCode, smsOptIn]
  );

  customer = await get('SELECT * FROM loyalty_customers WHERE id = $1', [lastInsertRowid]);

  // Create first stamp card
  await getActiveStampCard(customer.id);

  // Process referral if code provided
  if (referralCodeUsed) {
    await processReferral(referralCodeUsed, customer.id, restaurantName);
  }

  // Send welcome SMS (non-blocking)
  const smsEnabled = await getConfigValue('sms_enabled', 'true');
  if (sendWelcomeSms && customer.sms_opt_in && smsEnabled === 'true') {
    sendWelcomeMessage(normalized, name, referralCode, restaurantName, cc).catch(() => {});
  }

  return { customer: await get('SELECT * FROM loyalty_customers WHERE id = $1', [customer.id]), created: true };
}

/* ==================== Stamp Operations ==================== */

export async function addStampsForOrder(customerId, orderId, count = null, restaurantName = 'us', options = {}) {
  // `sendSms` kept as a shortcut for "silence everything" — receipt-flow
  // enrollment uses it because the receipt SMS is the single loyalty touch.
  // The per-event flags let POS suppress the routine stamp-earned SMS while
  // keeping the rare "🎉 tarjeta llena" celebration on.
  const {
    sendSms = true,
    sendStampEarnedSms = sendSms,
    sendCardCompletedSms = sendSms,
  } = options;
  // Load the order once so we can (a) compute count when the caller passes
  // null and (b) roll the order total into loyalty_customers.total_spent
  // below. Previously total_spent was updated only inside the /customers/:id/stamp
  // route, so kiosk + POS auto-stamp paths left it at 0 forever.
  let orderTotal = 0;
  if (orderId) {
    const order = await get('SELECT total FROM orders WHERE id = $1', [orderId]);
    orderTotal = Number(order?.total) || 0;
  }
  // count=null → compute from order total: 1 base stamp + 1 extra per stamp_bonus_threshold spent.
  // Falls back to 1 stamp if the order can't be loaded.
  if (count === null || count === undefined) {
    const threshold = parseFloat(await getConfigValue('stamp_bonus_threshold', '400')) || 400;
    count = 1 + Math.floor(orderTotal / threshold);
  }
  count = Math.max(1, parseInt(count, 10) || 1);

  const card = await getActiveStampCard(customerId);
  const newStamps = card.stamps_earned + count;
  const cardCompleted = newStamps >= card.stamps_required;

  await run(
    `UPDATE stamp_cards SET stamps_earned = $1, completed = $2, completed_at = $3 WHERE id = $4`,
    [
      Math.min(newStamps, card.stamps_required),
      cardCompleted,
      cardCompleted ? new Date().toISOString() : null,
      card.id,
    ]
  );

  await run(
    `INSERT INTO stamp_events (stamp_card_id, order_id, stamps_added, event_type) VALUES ($1, $2, $3, 'purchase')`,
    [card.id, orderId, count]
  );

  // Update customer totals — stamps + order count + spend + last_visit in one
  // write. total_spent rolls up the order total so the Loyalty y CRM "Gastado"
  // column stays accurate regardless of which caller granted the stamp.
  await run(
    `UPDATE loyalty_customers
       SET stamps_earned = stamps_earned + $1,
           orders_count  = orders_count + 1,
           total_spent   = total_spent + $2,
           last_visit    = NOW()
     WHERE id = $3`,
    [count, orderTotal, customerId]
  );

  // Link order to customer
  await run(`UPDATE orders SET loyalty_customer_id = $1 WHERE id = $2`, [customerId, orderId]);

  // Get updated card
  const updatedCard = await get('SELECT * FROM stamp_cards WHERE id = $1', [card.id]);
  const customer = await get('SELECT * FROM loyalty_customers WHERE id = $1', [customerId]);

  // Send SMS notifications (non-blocking)
  const smsEnabled = await getConfigValue('sms_enabled', 'true');
  if (customer.sms_opt_in && smsEnabled === 'true') {
    const reviewUrl = await getConfigValue('google_review_url', '');
    if (cardCompleted) {
      if (sendCardCompletedSms) {
        sendCardCompletedMessage(customer.phone, customer.name, updatedCard.reward_description, customerId, restaurantName, customer.country_code, reviewUrl).catch(() => {});
      }
      // Auto-create next card
      await getActiveStampCard(customerId);
    } else if (sendStampEarnedSms) {
      sendStampEarnedMessage(customer.phone, customer.name, updatedCard.stamps_earned, updatedCard.stamps_required, customerId, restaurantName, customer.country_code, reviewUrl).catch(() => {});
    }
  } else if (cardCompleted) {
    // Still auto-create next card even if SMS disabled
    await getActiveStampCard(customerId);
  }

  return {
    stampCard: await get('SELECT * FROM stamp_cards WHERE id = $1', [card.id]),
    cardCompleted,
    customer: await get('SELECT * FROM loyalty_customers WHERE id = $1', [customerId]),
  };
}

export async function addBonusStamps(customerId, count, eventType = 'manual') {
  const card = await getActiveStampCard(customerId);
  const newStamps = card.stamps_earned + count;
  const cardCompleted = newStamps >= card.stamps_required;

  await run(
    `UPDATE stamp_cards SET stamps_earned = $1, completed = $2, completed_at = $3 WHERE id = $4`,
    [
      Math.min(newStamps, card.stamps_required),
      cardCompleted,
      cardCompleted ? new Date().toISOString() : null,
      card.id,
    ]
  );

  await run(
    `INSERT INTO stamp_events (stamp_card_id, stamps_added, event_type) VALUES ($1, $2, $3)`,
    [card.id, count, eventType]
  );

  await run(
    `UPDATE loyalty_customers SET stamps_earned = stamps_earned + $1 WHERE id = $2`,
    [count, customerId]
  );

  if (cardCompleted) {
    await getActiveStampCard(customerId); // auto-create next card
  }

  return await get('SELECT * FROM stamp_cards WHERE id = $1', [card.id]);
}

/* ==================== Referral ==================== */

export async function processReferral(referralCode, newCustomerId, restaurantName = 'Our') {
  const referrer = await get('SELECT * FROM loyalty_customers WHERE referral_code = $1', [referralCode]);
  if (!referrer) return null;
  if (referrer.id === newCustomerId) return null; // can't refer yourself

  // Check if this referral already happened
  const existing = await get(
    'SELECT id FROM referral_events WHERE referrer_id = $1 AND referee_id = $2',
    [referrer.id, newCustomerId]
  );
  if (existing) return null;

  const bonus = parseInt(await getConfigValue('referral_bonus_stamps', '2'));

  // Add bonus stamps to both
  await addBonusStamps(referrer.id, bonus, 'referral_bonus');
  await addBonusStamps(newCustomerId, bonus, 'referral_bonus');

  // Record referral
  await run(
    `INSERT INTO referral_events (referrer_id, referee_id, referrer_stamps_added, referee_stamps_added) VALUES ($1, $2, $3, $4)`,
    [referrer.id, newCustomerId, bonus, bonus]
  );

  // Update referred_by
  await run(`UPDATE loyalty_customers SET referred_by = $1 WHERE id = $2`, [referrer.id, newCustomerId]);

  // Notify referrer via SMS
  const referee = await get('SELECT * FROM loyalty_customers WHERE id = $1', [newCustomerId]);
  const smsEnabled = await getConfigValue('sms_enabled', 'true');
  if (referrer.sms_opt_in && smsEnabled === 'true') {
    sendReferralSuccessMessage(referrer.phone, referrer.name, referee.name, bonus, referrer.id, restaurantName, referrer.country_code).catch(() => {});
  }

  return { referrer_id: referrer.id, referee_id: newCustomerId, bonus };
}

/* ==================== Redemption ==================== */

export async function redeemReward(stampCardId) {
  const card = await get('SELECT * FROM stamp_cards WHERE id = $1', [stampCardId]);
  if (!card) throw new Error('Stamp card not found');
  if (!card.completed) throw new Error('Card is not completed');
  if (card.redeemed) throw new Error('Card already redeemed');

  await run(
    `UPDATE stamp_cards SET redeemed = true, redeemed_at = NOW() WHERE id = $1`,
    [stampCardId]
  );

  return await get('SELECT * FROM stamp_cards WHERE id = $1', [stampCardId]);
}

/* ==================== Queries ==================== */

export async function getCustomerWithCard(customerId) {
  const customer = await get('SELECT * FROM loyalty_customers WHERE id = $1', [customerId]);
  if (!customer) return null;

  const activeCard = await getActiveStampCard(customerId);
  const allCards = await all(
    'SELECT * FROM stamp_cards WHERE customer_id = $1 ORDER BY id DESC',
    [customerId]
  );
  const events = await all(
    `SELECT se.*, sc.stamps_required FROM stamp_events se
     JOIN stamp_cards sc ON sc.id = se.stamp_card_id
     WHERE sc.customer_id = $1 ORDER BY se.id DESC LIMIT 20`,
    [customerId]
  );

  return { ...customer, activeCard, cards: allCards, recentEvents: events };
}
