import { all, get, run } from '../db/index.js';
import {
  sendWelcomeSMS,
  sendStampEarnedSMS,
  sendCardCompletedSMS,
  sendReferralSuccessSMS,
} from './twilio.js';

/* ==================== Helpers ==================== */

export async function generateReferralCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 10; attempt++) {
    let code = 'JB';
    for (let i = 0; i < 4; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    const existing = await get('SELECT id FROM loyalty_customers WHERE referral_code = $1', [code]);
    if (!existing) return code;
  }
  // Fallback: longer code
  return 'JB' + Date.now().toString(36).toUpperCase().slice(-6);
}

export function normalizePhone(phone) {
  const digits = phone.replace(/\D/g, '');
  // Accept 10-digit MX numbers, or with country code prefix
  if (digits.length === 10) return digits;
  if (digits.length === 12 && digits.startsWith('52')) return digits.slice(2);
  if (digits.length === 13 && digits.startsWith('521')) return digits.slice(3);
  return digits.slice(-10); // best effort
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

export async function findOrCreateCustomer(phone, name, referralCodeUsed, smsOptIn = false, restaurantName = 'Our') {
  const normalized = normalizePhone(phone);
  let customer = await get('SELECT * FROM loyalty_customers WHERE phone = $1', [normalized]);

  if (customer) {
    return { customer, created: false };
  }

  const referralCode = await generateReferralCode();
  const { lastInsertRowid } = await run(
    `INSERT INTO loyalty_customers (phone, name, referral_code, sms_opt_in) VALUES ($1, $2, $3, $4)`,
    [normalized, name, referralCode, smsOptIn]
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
  if (customer.sms_opt_in && smsEnabled === 'true') {
    sendWelcomeSMS(normalized, name, referralCode, restaurantName).catch(() => {});
  }

  return { customer: await get('SELECT * FROM loyalty_customers WHERE id = $1', [customer.id]), created: true };
}

/* ==================== Stamp Operations ==================== */

export async function addStampsForOrder(customerId, orderId, count = 1, restaurantName = 'us') {
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

  // Update customer totals
  await run(
    `UPDATE loyalty_customers SET stamps_earned = stamps_earned + $1, orders_count = orders_count + 1, last_visit = NOW() WHERE id = $2`,
    [count, customerId]
  );

  // Link order to customer
  await run(`UPDATE orders SET loyalty_customer_id = $1 WHERE id = $2`, [customerId, orderId]);

  // Get updated card
  const updatedCard = await get('SELECT * FROM stamp_cards WHERE id = $1', [card.id]);
  const customer = await get('SELECT * FROM loyalty_customers WHERE id = $1', [customerId]);

  // Send SMS notifications (non-blocking)
  const smsEnabled = await getConfigValue('sms_enabled', 'true');
  if (customer.sms_opt_in && smsEnabled === 'true') {
    if (cardCompleted) {
      sendCardCompletedSMS(customer.phone, customer.name, updatedCard.reward_description, customerId, restaurantName).catch(() => {});
      // Auto-create next card
      await getActiveStampCard(customerId);
    } else {
      sendStampEarnedSMS(customer.phone, customer.name, updatedCard.stamps_earned, updatedCard.stamps_required, customerId, restaurantName).catch(() => {});
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
    sendReferralSuccessSMS(referrer.phone, referrer.name, referee.name, bonus, referrer.id, restaurantName).catch(() => {});
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
