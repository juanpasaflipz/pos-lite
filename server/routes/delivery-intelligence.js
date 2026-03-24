import { Router } from 'express';
import { all, get, run, exec, getTenantId } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePlanFeature } from '../planLimits.js';
import { sendSMS } from '../helpers/twilio.js';

import { cleanBoardSettings, toJsonbString, VALID_BOARD_KEYS } from '../lib/boardSettings.js';

const router = Router();

// Gate all delivery intelligence endpoints behind the delivery plan feature
router.use(requirePlanFeature('delivery'));

// ==================== P&L Analytics ====================

/**
 * GET /api/delivery/analytics — delivery P&L breakdown
 * Query: ?start=YYYY-MM-DD&end=YYYY-MM-DD
 */
router.get('/analytics', requireAuth('view_reports'), async (req, res) => {
  try {
    const { start, end } = req.query;
    const startDate = start || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const endDate = end || new Date().toISOString().slice(0, 10);

    // Revenue and commission per platform
    const platformStats = await all(`
      SELECT
        dp.id as platform_id,
        dp.name,
        dp.display_name,
        dp.commission_percent,
        COUNT(do2.id) as order_count,
        COALESCE(SUM(o.total), 0) as gross_revenue,
        COALESCE(SUM(do2.platform_commission), 0) as total_commission,
        COALESCE(SUM(do2.delivery_fee), 0) as total_delivery_fees,
        COALESCE(SUM(o.total) - SUM(do2.platform_commission), 0) as net_revenue,
        COALESCE(AVG(o.total), 0) as avg_order_value
      FROM delivery_platforms dp
      LEFT JOIN delivery_orders do2 ON do2.platform_id = dp.id
      LEFT JOIN orders o ON o.id = do2.order_id
        AND o.created_at::date >= $1 AND o.created_at::date <= $2
      GROUP BY dp.id, dp.name, dp.display_name, dp.commission_percent
      ORDER BY gross_revenue DESC
    `, [startDate, endDate]);

    // POS vs delivery comparison
    const posStats = await get(`
      SELECT
        COUNT(*) as order_count,
        COALESCE(SUM(total), 0) as revenue,
        COALESCE(AVG(total), 0) as avg_order
      FROM orders
      WHERE source = 'pos'
        AND created_at::date >= $1 AND created_at::date <= $2
        AND status NOT IN ('cancelled')
    `, [startDate, endDate]);

    const deliveryStats = await get(`
      SELECT
        COUNT(*) as order_count,
        COALESCE(SUM(total), 0) as revenue,
        COALESCE(AVG(total), 0) as avg_order
      FROM orders
      WHERE source != 'pos'
        AND created_at::date >= $1 AND created_at::date <= $2
        AND status NOT IN ('cancelled')
    `, [startDate, endDate]);

    // Daily trend
    const dailyTrend = await all(`
      SELECT
        o.created_at::date as day,
        o.source,
        COUNT(*) as orders,
        COALESCE(SUM(o.total), 0) as revenue
      FROM orders o
      WHERE o.created_at::date >= $1 AND o.created_at::date <= $2
        AND o.status NOT IN ('cancelled')
      GROUP BY o.created_at::date, o.source
      ORDER BY o.created_at::date
    `, [startDate, endDate]);

    res.json({
      period: { start: startDate, end: endDate },
      platforms: platformStats,
      pos: posStats,
      delivery: deliveryStats,
      dailyTrend,
    });
  } catch (error) {
    console.error('Delivery analytics error:', error);
    res.status(500).json({ error: 'Failed to fetch delivery analytics' });
  }
});

// ==================== Markup Rules ====================

/**
 * GET /api/delivery/markup-rules — list all markup rules
 */
router.get('/markup-rules', requireAuth('manage_delivery'), async (req, res) => {
  try {
    const rules = await all(`
      SELECT dmr.*,
        dp.display_name as platform_name,
        mi.name as item_name,
        mc.name as category_name
      FROM delivery_markup_rules dmr
      JOIN delivery_platforms dp ON dp.id = dmr.platform_id
      LEFT JOIN menu_items mi ON mi.id = dmr.menu_item_id
      LEFT JOIN menu_categories mc ON mc.id = dmr.category_id
      ORDER BY dp.display_name, dmr.id
    `);
    res.json(rules);
  } catch (error) {
    console.error('Markup rules fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch markup rules' });
  }
});

/**
 * POST /api/delivery/markup-rules — create a markup rule
 * Body: { platform_id, menu_item_id?, category_id?, markup_type, markup_value }
 */
router.post('/markup-rules', requireAuth('manage_delivery'), async (req, res) => {
  try {
    const { platform_id, menu_item_id, category_id, markup_type, markup_value } = req.body;

    if (!platform_id || markup_value === undefined) {
      return res.status(400).json({ error: 'platform_id and markup_value required' });
    }
    if (!menu_item_id && !category_id) {
      return res.status(400).json({ error: 'Either menu_item_id or category_id required' });
    }

    const tid = getTenantId();
    const result = await run(
      `INSERT INTO delivery_markup_rules (tenant_id, platform_id, menu_item_id, category_id, markup_type, markup_value)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [tid, platform_id, menu_item_id || null, category_id || null, markup_type || 'percent', markup_value]
    );

    res.status(201).json({ id: result.lastInsertRowid });
  } catch (error) {
    if (error.message?.includes('UNIQUE') || error.message?.includes('unique') || error.code === '23505') {
      return res.status(409).json({ error: 'Markup rule already exists for this platform/item combination' });
    }
    console.error('Markup rule create error:', error);
    res.status(500).json({ error: 'Failed to create markup rule' });
  }
});

/**
 * PUT /api/delivery/markup-rules/:id — update a markup rule
 */
router.put('/markup-rules/:id', requireAuth('manage_delivery'), async (req, res) => {
  try {
    const { id } = req.params;
    const { markup_type, markup_value, active } = req.body;

    const rule = await get('SELECT * FROM delivery_markup_rules WHERE id = $1', [id]);
    if (!rule) return res.status(404).json({ error: 'Rule not found' });

    await run(
      `UPDATE delivery_markup_rules SET markup_type = $1, markup_value = $2, active = $3 WHERE id = $4`,
      [markup_type ?? rule.markup_type, markup_value ?? rule.markup_value, active !== undefined ? active : rule.active, id]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Markup rule update error:', error);
    res.status(500).json({ error: 'Failed to update markup rule' });
  }
});

/**
 * DELETE /api/delivery/markup-rules/:id
 */
router.delete('/markup-rules/:id', requireAuth('manage_delivery'), async (req, res) => {
  try {
    await run('DELETE FROM delivery_markup_rules WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    console.error('Markup rule delete error:', error);
    res.status(500).json({ error: 'Failed to delete markup rule' });
  }
});

/**
 * GET /api/delivery/markup-preview/:platformId — preview menu with markups applied
 */
router.get('/markup-preview/:platformId', requireAuth('manage_delivery'), async (req, res) => {
  try {
    const { platformId } = req.params;

    const items = await all(`
      SELECT
        mi.id, mi.name, mi.price as base_price,
        mc.name as category_name,
        COALESCE(dmr_item.markup_value, dmr_cat.markup_value, dp.default_markup_percent, 0) as markup_value,
        COALESCE(dmr_item.markup_type, dmr_cat.markup_type, 'percent') as markup_type,
        CASE
          WHEN COALESCE(dmr_item.markup_type, dmr_cat.markup_type, 'percent') = 'percent'
          THEN mi.price * (1 + COALESCE(dmr_item.markup_value, dmr_cat.markup_value, dp.default_markup_percent, 0) / 100.0)
          ELSE mi.price + COALESCE(dmr_item.markup_value, dmr_cat.markup_value, 0)
        END as delivery_price
      FROM menu_items mi
      JOIN menu_categories mc ON mc.id = mi.category_id
      JOIN delivery_platforms dp ON dp.id = $1
      LEFT JOIN delivery_markup_rules dmr_item ON dmr_item.platform_id = dp.id AND dmr_item.menu_item_id = mi.id AND dmr_item.active = true
      LEFT JOIN delivery_markup_rules dmr_cat ON dmr_cat.platform_id = dp.id AND dmr_cat.category_id = mi.category_id AND dmr_cat.active = true
      WHERE mi.active = true
      ORDER BY mc.sort_order, mi.name
    `, [platformId]);

    res.json(items);
  } catch (error) {
    console.error('Markup preview error:', error);
    res.status(500).json({ error: 'Failed to generate markup preview' });
  }
});

// ==================== Virtual Brands ====================

/**
 * GET /api/delivery/virtual-brands — list virtual brands
 */
router.get('/virtual-brands', requireAuth('manage_delivery'), async (req, res) => {
  try {
    const brands = await all(`
      SELECT vb.*,
        COALESCE(dp.display_name, 'Menu Board') as platform_name,
        (SELECT COUNT(*) FROM virtual_brand_items WHERE virtual_brand_id = vb.id AND active = true) as item_count
      FROM virtual_brands vb
      LEFT JOIN delivery_platforms dp ON dp.id = vb.platform_id
      ORDER BY vb.name
    `);
    // Normalize board_settings to prevent corrupted data reaching the frontend
    for (const b of brands) {
      b.board_settings = cleanBoardSettings(b.board_settings);
    }
    res.json(brands);
  } catch (error) {
    console.error('Virtual brands fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch virtual brands' });
  }
});

/**
 * POST /api/delivery/virtual-brands — create virtual brand
 * Body: { name, platform_id, description?, logo_url? }
 */
router.post('/virtual-brands', requireAuth('manage_delivery'), async (req, res) => {
  try {
    const { name, platform_id, description, logo_url, display_type, primary_color, secondary_color, font_family, dark_bg, slug, show_in_pos, template_slug, board_settings } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'name required' });
    }

    // Menu board brands don't require a delivery platform
    const isMenuBoard = display_type === 'menu_board' || display_type === 'both';
    if (!platform_id && !isMenuBoard) {
      return res.status(400).json({ error: 'platform_id required for delivery brands' });
    }

    const tid = getTenantId();
    const result = await run(
      `INSERT INTO virtual_brands (tenant_id, name, platform_id, description, logo_url, display_type, primary_color, secondary_color, font_family, dark_bg, slug, show_in_pos, template_slug, board_settings)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [tid, name, platform_id || null, description || null, logo_url || null, display_type || 'delivery', primary_color || null, secondary_color || null, font_family || null, dark_bg || null, slug || null, show_in_pos !== undefined ? show_in_pos : true, template_slug || null, toJsonbString(board_settings)]
    );

    res.status(201).json({ id: result.lastInsertRowid });
  } catch (error) {
    console.error('Virtual brand create error:', error);
    res.status(500).json({ error: 'Failed to create virtual brand' });
  }
});

/**
 * PUT /api/delivery/virtual-brands/:id
 */
router.put('/virtual-brands/:id', requireAuth('manage_delivery'), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, logo_url, active, display_type, primary_color, secondary_color, font_family, dark_bg, slug, show_in_pos, template_slug, board_settings } = req.body;

    const brand = await get('SELECT * FROM virtual_brands WHERE id = $1', [id]);
    if (!brand) return res.status(404).json({ error: 'Virtual brand not found' });

    const settingsValue = toJsonbString(board_settings !== undefined ? board_settings : brand.board_settings);

    await run(
      `UPDATE virtual_brands SET name = $1, description = $2, logo_url = $3, active = $4, display_type = $5, primary_color = $6, secondary_color = $7, font_family = $8, dark_bg = $9, slug = $10, show_in_pos = $11, template_slug = $12, board_settings = $13 WHERE id = $14`,
      [
        name ?? brand.name,
        description ?? brand.description,
        logo_url ?? brand.logo_url,
        active !== undefined ? active : brand.active,
        display_type ?? brand.display_type,
        primary_color ?? brand.primary_color,
        secondary_color ?? brand.secondary_color,
        font_family ?? brand.font_family,
        dark_bg ?? brand.dark_bg,
        slug ?? brand.slug,
        show_in_pos !== undefined ? show_in_pos : brand.show_in_pos,
        template_slug !== undefined ? template_slug : brand.template_slug,
        settingsValue,
        id
      ]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Virtual brand update error:', error);
    res.status(500).json({ error: 'Failed to update virtual brand' });
  }
});

/**
 * DELETE /api/delivery/virtual-brands/:id — delete a virtual brand and its items
 */
router.delete('/virtual-brands/:id', requireAuth('manage_delivery'), async (req, res) => {
  try {
    const { id } = req.params;
    const brand = await get('SELECT * FROM virtual_brands WHERE id = $1', [id]);
    if (!brand) return res.status(404).json({ error: 'Virtual brand not found' });

    // Delete items first (FK constraint), then the brand
    await run('DELETE FROM virtual_brand_items WHERE virtual_brand_id = $1', [id]);
    await run('DELETE FROM virtual_brands WHERE id = $1', [id]);

    res.json({ success: true });
  } catch (error) {
    console.error('Virtual brand delete error:', error);
    res.status(500).json({ error: 'Failed to delete virtual brand' });
  }
});

/**
 * DELETE /api/delivery/virtual-brands/:brandId/items/:itemId — remove item from virtual brand
 */
router.delete('/virtual-brands/:brandId/items/:itemId', requireAuth('manage_delivery'), async (req, res) => {
  try {
    const { brandId, itemId } = req.params;
    await run('DELETE FROM virtual_brand_items WHERE virtual_brand_id = $1 AND menu_item_id = $2', [brandId, itemId]);
    res.json({ success: true });
  } catch (error) {
    console.error('Virtual brand item delete error:', error);
    res.status(500).json({ error: 'Failed to remove item from brand' });
  }
});

/**
 * POST /api/delivery/virtual-brands/:id/items — assign items to virtual brand
 * Body: { items: [{ menu_item_id, custom_name?, custom_price?, show_image? }] }
 */
router.post('/virtual-brands/:id/items', requireAuth('manage_delivery'), async (req, res) => {
  try {
    const { id } = req.params;
    const { items } = req.body;

    if (!Array.isArray(items)) {
      return res.status(400).json({ error: 'items array required' });
    }

    const brand = await get('SELECT * FROM virtual_brands WHERE id = $1', [id]);
    if (!brand) return res.status(404).json({ error: 'Virtual brand not found' });

    const tid = getTenantId();
    for (const item of items) {
      const showImage = item.show_image !== undefined ? item.show_image : true;
      await run(
        `INSERT INTO virtual_brand_items (tenant_id, virtual_brand_id, menu_item_id, custom_name, custom_price, show_image, active)
         VALUES ($1, $2, $3, $4, $5, $6, true)
         ON CONFLICT (tenant_id, virtual_brand_id, menu_item_id) DO UPDATE SET custom_name = EXCLUDED.custom_name, custom_price = EXCLUDED.custom_price, show_image = EXCLUDED.show_image, active = true`,
        [tid, id, item.menu_item_id, item.custom_name || null, item.custom_price || null, showImage]
      );
    }

    res.json({ success: true, count: items.length });
  } catch (error) {
    console.error('Virtual brand items error:', error);
    res.status(500).json({ error: 'Failed to assign items' });
  }
});

/**
 * GET /api/delivery/virtual-brands/:id/items — get items for a virtual brand
 */
router.get('/virtual-brands/:id/items', requireAuth('manage_delivery'), async (req, res) => {
  try {
    const items = await all(`
      SELECT vbi.*, mi.name as original_name, mi.price as original_price, mc.name as category_name
      FROM virtual_brand_items vbi
      JOIN menu_items mi ON mi.id = vbi.menu_item_id
      JOIN menu_categories mc ON mc.id = mi.category_id
      WHERE vbi.virtual_brand_id = $1
      ORDER BY mc.sort_order, mi.name
    `, [req.params.id]);

    res.json(items);
  } catch (error) {
    console.error('Virtual brand items fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch virtual brand items' });
  }
});

// ==================== Customer Recapture ====================

/**
 * GET /api/delivery/recapture/candidates — delivery-only customers to win back
 * Returns customers who ordered via delivery but never via POS
 */
router.get('/recapture/candidates', requireAuth('manage_delivery'), async (req, res) => {
  try {
    const { days } = req.query;
    const lookbackDays = days || 60;

    const candidates = await all(`
      SELECT
        do2.customer_name,
        do2.id as delivery_order_id,
        dp.display_name as platform,
        o.total as last_order_total,
        o.created_at as last_order_date,
        dr.sms_sent_at,
        dr.converted
      FROM delivery_orders do2
      JOIN orders o ON o.id = do2.order_id
      JOIN delivery_platforms dp ON dp.id = do2.platform_id
      LEFT JOIN delivery_recapture dr ON dr.last_delivery_order_id = do2.id
      WHERE do2.customer_name IS NOT NULL
        AND do2.customer_name != ''
        AND o.created_at::date >= (NOW() - INTERVAL '1 day' * $1)::date
      GROUP BY do2.customer_name, do2.id, dp.display_name, o.total, o.created_at, dr.sms_sent_at, dr.converted
      HAVING MAX(o.created_at) = o.created_at
      ORDER BY o.created_at DESC
      LIMIT 50
    `, [lookbackDays]);

    res.json(candidates);
  } catch (error) {
    console.error('Recapture candidates error:', error);
    res.status(500).json({ error: 'Failed to fetch recapture candidates' });
  }
});

/**
 * POST /api/delivery/recapture/send — send recapture SMS
 * Body: { phone, customer_name, platform, delivery_order_id, message? }
 */
router.post('/recapture/send', requireAuth('manage_delivery'), async (req, res) => {
  try {
    const { phone, customer_name, platform, delivery_order_id, message } = req.body;

    if (!phone || !customer_name) {
      return res.status(400).json({ error: 'phone and customer_name required' });
    }

    const brandName = req.tenant?.name || 'Restaurant';
    const defaultMsg = `Hey ${customer_name}! We noticed you love ordering from us on ${platform}. Visit us in-store for 10% off your next order! Show this text at checkout. — ${brandName}`;
    const body = message || defaultMsg;

    const sid = await sendSMS(phone, body);

    // Track recapture attempt
    const tid = getTenantId();
    await run(
      `INSERT INTO delivery_recapture (tenant_id, customer_phone, customer_name, platform, last_delivery_order_id, sms_sent_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [tid, phone, customer_name, platform, delivery_order_id || null]
    );

    res.json({ success: !!sid, twilio_sid: sid });
  } catch (error) {
    console.error('Recapture send error:', error);
    res.status(500).json({ error: 'Failed to send recapture SMS' });
  }
});

/**
 * POST /api/delivery/recapture/:id/convert — mark recapture as converted
 */
router.post('/recapture/:id/convert', requireAuth('manage_delivery'), async (req, res) => {
  try {
    await run('UPDATE delivery_recapture SET converted = true WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    console.error('Recapture convert error:', error);
    res.status(500).json({ error: 'Failed to mark conversion' });
  }
});

export default router;
