import { Router } from 'express';
import { all, get, run } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import {
  normalizePhone,
  findOrCreateCustomer,
  addStampsForOrder,
  addBonusStamps,
  redeemReward,
  getCustomerWithCard,
  getActiveStampCard,
  getLoyaltyConfig,
  updateLoyaltyConfig,
} from '../helpers/loyalty.js';
import { getPlanLimits, requirePlanFeature } from '../planLimits.js';

const router = Router();

/* ==================== Customer Endpoints ==================== */

// GET /customers — List/search (paginated)
router.get('/customers', requireAuth('manage_loyalty'), async (req, res) => {
  try {
    const { search, page = 1, limit: rawLimit = 20 } = req.query;
    const limit = Math.min(Math.max(parseInt(rawLimit) || 20, 1), 200);
    const offset = (Math.max(parseInt(page) || 1, 1) - 1) * limit;

    let where = '';
    const params = [];

    if (search) {
      // Escape LIKE special characters to prevent pattern injection
      const escaped = search.replace(/[%_\\]/g, '\\$&');
      where = `WHERE (name LIKE $1 ESCAPE '\\' OR phone LIKE $2 ESCAPE '\\')`;
      params.push(`%${escaped}%`, `%${escaped}%`);
    }

    const countResult = await get(`SELECT COUNT(*) as total FROM loyalty_customers ${where}`, params);

    const limitParamIdx = params.length + 1;
    const offsetParamIdx = params.length + 2;
    const customers = await all(
      `SELECT * FROM loyalty_customers ${where} ORDER BY created_at DESC LIMIT $${limitParamIdx} OFFSET $${offsetParamIdx}`,
      [...params, limit, offset]
    );

    // Attach active stamp card to each customer
    const enriched = [];
    for (const c of customers) {
      const card = await getActiveStampCard(c.id);
      enriched.push({ ...c, activeCard: card });
    }

    res.json({ data: enriched, total: countResult.total, page: Math.max(parseInt(page) || 1, 1), limit });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /customers/:id — Detail + stamp cards + events
router.get('/customers/:id', requireAuth('manage_loyalty'), async (req, res) => {
  try {
    const data = await getCustomerWithCard(parseInt(req.params.id));
    if (!data) return res.status(404).json({ error: 'Customer not found' });
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /customers/phone/:phone — Lookup by phone (POS checkout)
router.get('/customers/phone/:phone', requireAuth('pos_access'), async (req, res) => {
  try {
    const normalized = normalizePhone(req.params.phone);
    const customer = await get('SELECT * FROM loyalty_customers WHERE phone = $1', [normalized]);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const activeCard = await getActiveStampCard(customer.id);
    res.json({ ...customer, activeCard });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /customers — Register new customer
router.post('/customers', requireAuth('pos_access'), requirePlanFeature('loyalty'), async (req, res) => {
  try {
    const { phone, name, referral_code_used, sms_opt_in } = req.body;
    if (!phone || !name) return res.status(400).json({ error: 'Phone and name are required' });

    const normalized = normalizePhone(phone);
    if (normalized.length < 10) return res.status(400).json({ error: 'Invalid phone number' });

    const { customer, created } = await findOrCreateCustomer(normalized, name, referral_code_used, sms_opt_in, req.tenant?.name || 'Restaurant');

    if (!created && sms_opt_in !== undefined) {
      await run('UPDATE loyalty_customers SET sms_opt_in = $1 WHERE id = $2', [sms_opt_in ? true : false, customer.id]);
    }

    const activeCard = await getActiveStampCard(customer.id);
    res.status(created ? 201 : 200).json({ ...customer, activeCard, created });
  } catch (err) {
    if (err.message?.includes('UNIQUE')) {
      return res.status(409).json({ error: 'A customer with this phone number already exists' });
    }
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /customers/:id — Update customer info
router.put('/customers/:id', requireAuth('manage_loyalty'), async (req, res) => {
  try {
    const { name, sms_opt_in } = req.body;
    const id = parseInt(req.params.id);
    const customer = await get('SELECT * FROM loyalty_customers WHERE id = $1', [id]);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    if (name !== undefined) await run('UPDATE loyalty_customers SET name = $1 WHERE id = $2', [name, id]);
    if (sms_opt_in !== undefined) await run('UPDATE loyalty_customers SET sms_opt_in = $1 WHERE id = $2', [sms_opt_in ? true : false, id]);

    res.json(await get('SELECT * FROM loyalty_customers WHERE id = $1', [id]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/* ==================== Stamp Operations ==================== */

// POST /customers/:id/stamps — Add stamp after payment
router.post('/customers/:id/stamps', requireAuth('pos_access'), requirePlanFeature('loyalty'), async (req, res) => {
  try {
    const { order_id } = req.body;
    const customerId = parseInt(req.params.id);

    const customer = await get('SELECT * FROM loyalty_customers WHERE id = $1', [customerId]);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const result = await addStampsForOrder(customerId, order_id, 1, req.tenant?.name || 'Restaurant');

    // Update total_spent from order
    if (order_id) {
      const order = await get('SELECT total FROM orders WHERE id = $1', [order_id]);
      if (order) {
        await run('UPDATE loyalty_customers SET total_spent = total_spent + $1 WHERE id = $2', [order.total, customerId]);
      }
    }

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /customers/:id/stamps/manual — Manager manual stamp add
router.post('/customers/:id/stamps/manual', requireAuth('manage_loyalty'), requirePlanFeature('loyalty'), async (req, res) => {
  try {
    const { count = 1 } = req.body;
    const customerId = parseInt(req.params.id);

    const customer = await get('SELECT * FROM loyalty_customers WHERE id = $1', [customerId]);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const card = await addBonusStamps(customerId, parseInt(count), 'manual');
    const updatedCustomer = await get('SELECT * FROM loyalty_customers WHERE id = $1', [customerId]);

    res.json({ stampCard: card, customer: updatedCustomer });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /customers/:id/redeem — Redeem completed card
router.post('/customers/:id/redeem', requireAuth('pos_access'), requirePlanFeature('loyalty'), async (req, res) => {
  try {
    const customerId = parseInt(req.params.id);
    const customer = await get('SELECT * FROM loyalty_customers WHERE id = $1', [customerId]);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    // Find the oldest completed but unredeemed card
    const card = await get(
      'SELECT * FROM stamp_cards WHERE customer_id = $1 AND completed = true AND redeemed = false ORDER BY completed_at ASC LIMIT 1',
      [customerId]
    );
    if (!card) return res.status(400).json({ error: 'No completed cards available to redeem' });

    const redeemed = await redeemReward(card.id);
    res.json(redeemed);
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: 'Redemption failed' });
  }
});

/* ==================== Analytics ==================== */

// GET /analytics — Metrics
router.get('/analytics', requireAuth('manage_loyalty'), async (req, res) => {
  try {
    const totalMembers = (await get('SELECT COUNT(*) as count FROM loyalty_customers'))?.count || 0;

    const newThisMonth = (await get(
      `SELECT COUNT(*) as count FROM loyalty_customers
       WHERE created_at >= date_trunc('month', NOW())`
    ))?.count || 0;

    const activeCards = (await get(
      'SELECT COUNT(*) as count FROM stamp_cards WHERE completed = false'
    ))?.count || 0;

    const completedCards = (await get(
      'SELECT COUNT(*) as count FROM stamp_cards WHERE completed = true'
    ))?.count || 0;

    const redeemedCards = (await get(
      'SELECT COUNT(*) as count FROM stamp_cards WHERE redeemed = true'
    ))?.count || 0;

    const redemptionRate = completedCards > 0
      ? Math.round((redeemedCards / completedCards) * 100)
      : 0;

    const topCustomers = await all(
      `SELECT id, name, phone, stamps_earned, orders_count, total_spent, last_visit
       FROM loyalty_customers ORDER BY total_spent DESC LIMIT 10`
    );

    const signupsByMonth = await all(
      `SELECT to_char(created_at, 'YYYY-MM') as month, COUNT(*) as count
       FROM loyalty_customers
       GROUP BY month ORDER BY month DESC LIMIT 12`
    );

    res.json({
      totalMembers,
      newThisMonth,
      activeCards,
      completedCards,
      redeemedCards,
      redemptionRate,
      topCustomers,
      signupsByMonth,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/* ==================== Referrals ==================== */

// GET /referrals — Referral leaderboard
router.get('/referrals', requireAuth('manage_loyalty'), async (req, res) => {
  try {
    const leaderboard = await all(
      `SELECT lc.id, lc.name, lc.phone, lc.referral_code,
              COUNT(re.id) as referral_count,
              SUM(re.referrer_stamps_added) as total_bonus_stamps
       FROM loyalty_customers lc
       LEFT JOIN referral_events re ON re.referrer_id = lc.id
       GROUP BY lc.id
       HAVING COUNT(re.id) > 0
       ORDER BY referral_count DESC
       LIMIT 20`
    );

    const recentReferrals = await all(
      `SELECT re.*,
              r.name as referrer_name, r.phone as referrer_phone,
              e.name as referee_name, e.phone as referee_phone
       FROM referral_events re
       JOIN loyalty_customers r ON r.id = re.referrer_id
       JOIN loyalty_customers e ON e.id = re.referee_id
       ORDER BY re.created_at DESC LIMIT 20`
    );

    const totalReferrals = (await get('SELECT COUNT(*) as count FROM referral_events'))?.count || 0;

    res.json({ leaderboard, recentReferrals, totalReferrals });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/* ==================== Config ==================== */

// GET /config — Get loyalty settings
router.get('/config', requireAuth('manage_loyalty'), async (req, res) => {
  try {
    res.json(await getLoyaltyConfig());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /config — Update loyalty settings
router.put('/config', requireAuth('manage_loyalty'), requirePlanFeature('loyalty'), async (req, res) => {
  try {
    const { key, value } = req.body;
    if (!key || value === undefined) return res.status(400).json({ error: 'Key and value are required' });

    await updateLoyaltyConfig(key, String(value));
    res.json(await getLoyaltyConfig());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
