import { Router } from 'express';
import { all, get, run, getTenantId } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { getChargeFees } from '../stripe.js';
import { getPlanLimits, planUpgradeError } from '../planLimits.js';
import { computeSnapshot } from './payroll.js';

const router = Router();

/** YYYY-MM-DD for "today" in the given IANA timezone. */
function tzToday(tz) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

/**
 * Compute the start/end date strings (YYYY-MM-DD inclusive) for a named
 * period anchored to the tenant's local timezone. All SQL must filter with
 *   (COALESCE(paid_at, created_at) AT TIME ZONE $tz)::date BETWEEN $start AND $end
 * so the optional "previous period" buttons (yesterday, last_week, last_month)
 * also have an upper bound — without it they'd run from start-of-last-period
 * to today and over-count.
 *
 * weekStartDow: 0=Sun, 1=Mon, ..., 6=Sat — used to anchor week and last_week.
 * Defaults to 1 (Monday) to match payroll_settings.period_start_dow default
 * and the way most MX restaurants schedule.
 */
function getPeriodRange(period, tz = 'UTC', weekStartDow = 1) {
  const todayStr = tzToday(tz);
  const [y, m, d] = todayStr.split('-').map(Number);
  const today = new Date(Date.UTC(y, m - 1, d));
  const fmt = (dt) => dt.toISOString().slice(0, 10);
  const dow = ((Number(weekStartDow) % 7) + 7) % 7;
  const daysBack = ((today.getUTCDay() - dow + 7) % 7);

  switch (period) {
    case 'daily':
    case 'today':
      return { start: todayStr, end: todayStr };
    case 'yesterday': {
      const y1 = new Date(today);
      y1.setUTCDate(today.getUTCDate() - 1);
      const s = fmt(y1);
      return { start: s, end: s };
    }
    case 'weekly':
    case 'week': {
      const start = new Date(today);
      start.setUTCDate(today.getUTCDate() - daysBack);
      return { start: fmt(start), end: todayStr };
    }
    case 'last_week': {
      const thisWeekStart = new Date(today);
      thisWeekStart.setUTCDate(today.getUTCDate() - daysBack);
      const lastEnd = new Date(thisWeekStart);
      lastEnd.setUTCDate(thisWeekStart.getUTCDate() - 1);
      const lastStart = new Date(lastEnd);
      lastStart.setUTCDate(lastEnd.getUTCDate() - 6);
      return { start: fmt(lastStart), end: fmt(lastEnd) };
    }
    case 'monthly':
    case 'month':
      return { start: `${todayStr.slice(0, 8)}01`, end: todayStr };
    case 'last_month': {
      const firstOfThisMonth = new Date(Date.UTC(y, m - 1, 1));
      const lastEnd = new Date(firstOfThisMonth);
      lastEnd.setUTCDate(firstOfThisMonth.getUTCDate() - 1);
      const lastStart = new Date(Date.UTC(lastEnd.getUTCFullYear(), lastEnd.getUTCMonth(), 1));
      return { start: fmt(lastStart), end: fmt(lastEnd) };
    }
    default:
      return { start: todayStr, end: todayStr };
  }
}

/** Back-compat: start-only string. */
function getDateRange(period, tz = 'UTC', weekStartDow = 1) {
  return getPeriodRange(period, tz, weekStartDow).start;
}

/**
 * Resolve a YYYY-MM-DD {start, end} range from a request.
 *
 * Honors explicit start_date/end_date params when both present (used by the
 * "Custom range" picker and by every preset chip so the frontend's
 * weekStartDow choice is authoritative). Falls back to legacy
 * `period=` + `week_start_dow=` params for compatibility with older clients
 * and the CSV exporter.
 */
function resolveDateRange(req, tz = 'UTC') {
  const { start_date, end_date, period = 'today', week_start_dow } = req.query || {};
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (typeof start_date === 'string' && typeof end_date === 'string'
      && dateRe.test(start_date) && dateRe.test(end_date)) {
    const start = start_date <= end_date ? start_date : end_date;
    const end = start_date <= end_date ? end_date : start_date;
    return { start, end };
  }
  const dow = week_start_dow !== undefined ? Number(week_start_dow) : 1;
  return getPeriodRange(String(period), tz, Number.isFinite(dow) ? dow : 1);
}

function paymentSourceSql(alias = '') {
  const p = alias ? `${alias}.` : '';
  return `
    CASE
      WHEN ${p}payment_method = 'cash' THEN 'cash'
      WHEN ${p}payment_method = 'getnet_card' THEN 'getnet_card'
      WHEN ${p}payment_method = 'getnet_tap' THEN 'getnet_tap'
      WHEN ${p}payment_method = 'oxxo' THEN 'oxxo'
      WHEN ${p}payment_method = 'spei' THEN 'spei'
      WHEN ${p}payment_method = 'transfer' THEN 'transfer'
      WHEN ${p}payment_method = 'split' THEN 'split'
      WHEN ${p}payment_method = 'card' AND ${p}mp_order_id IS NOT NULL THEN 'mercado_pago_terminal'
      WHEN ${p}payment_method = 'card' AND ${p}clip_payment_id IS NOT NULL THEN 'clip_terminal'
      WHEN ${p}payment_method = 'card' AND ${p}payment_intent_id IS NOT NULL THEN 'stripe_card'
      WHEN ${p}payment_method = 'card' THEN 'card'
      ELSE COALESCE(${p}payment_method, 'unknown')
    END
  `;
}

const PAYMENT_SOURCE_LABELS = {
  cash: 'Cash',
  mercado_pago_terminal: 'Mercado Pago terminal',
  stripe_card: 'Stripe card',
  clip_terminal: 'Clip terminal',
  getnet_card: 'Getnet card',
  getnet_tap: 'Getnet tap',
  card: 'Card',
  split: 'Split payment',
  transfer: 'Transfer',
  oxxo: 'OXXO',
  spei: 'SPEI',
  unknown: 'Unknown',
};

// GET /api/reports/sales - sales summary
router.get('/sales', async (req, res) => {
  try {
    const { period = 'daily' } = req.query;
    const tz = req.tenant?.timezone || 'UTC';
    const { start: startDate, end: endDate } = resolveDateRange(req, tz);

    const stats = await get(`
      SELECT
        COUNT(*) as order_count,
        ROUND(SUM(subtotal), 2) as total_revenue,
        ROUND(AVG(total), 2) as avg_ticket,
        ROUND(SUM(tip), 2) as tip_total,
        ROUND(SUM(tax), 2) as tax_total,
        ROUND(SUM(COALESCE(discount_amount, 0)), 2) as discount_total,
        COUNT(*) FILTER (WHERE COALESCE(discount_amount, 0) > 0) as discounted_order_count
      FROM orders
      WHERE (COALESCE(paid_at, created_at) AT TIME ZONE $3)::date BETWEEN $1 AND $2
        AND payment_status = 'paid'
    `, [startDate, endDate, tz]);

    res.json({
      period,
      startDate,
      endDate,
      ...stats,
    });
  } catch (error) {
    console.error('Error fetching sales report:', error);
    res.status(500).json({ error: 'Failed to fetch sales report' });
  }
});

// GET /api/reports/top-items - top selling items
router.get('/top-items', async (req, res) => {
  try {
    const { period = 'daily', limit = 10 } = req.query;
    const tz = req.tenant?.timezone || 'UTC';
    const { start: startDate, end: endDate } = resolveDateRange(req, tz);
    const limitNum = Math.min(parseInt(limit) || 10, 100);

    const items = await all(`
      SELECT
        oi.item_name,
        SUM(oi.quantity) as quantity_sold,
        ROUND(SUM(oi.quantity * oi.unit_price), 2) as revenue
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      WHERE (COALESCE(o.paid_at, o.created_at) AT TIME ZONE $4)::date BETWEEN $1 AND $2
        AND o.payment_status = 'paid'
      GROUP BY oi.item_name
      ORDER BY quantity_sold DESC
      LIMIT $3
    `, [startDate, endDate, limitNum, tz]);

    res.json(items);
  } catch (error) {
    console.error('Error fetching top items report:', error);
    res.status(500).json({ error: 'Failed to fetch top items report' });
  }
});

// GET /api/reports/item-sales - exact item/category sales with operational filters
router.get('/item-sales', async (req, res) => {
  try {
    const {
      period = 'daily',
      customer_id,
      hour,
      min_quantity,
      related_item_id,
    } = req.query;
    const tz = req.tenant?.timezone || 'UTC';
    const { start: startDate, end: endDate } = resolveDateRange(req, tz);

    const where = [
      `(COALESCE(o.paid_at, o.created_at) AT TIME ZONE $3)::date BETWEEN $1 AND $2`,
      `o.payment_status = 'paid'`,
    ];
    const params = [startDate, endDate, tz];

    if (customer_id && customer_id !== 'all') {
      params.push(Number(customer_id));
      where.push(`o.loyalty_customer_id = $${params.length}`);
    }

    if (hour !== undefined && hour !== null && hour !== '' && hour !== 'all') {
      params.push(Number(hour));
      where.push(`EXTRACT(HOUR FROM COALESCE(o.paid_at, o.created_at) AT TIME ZONE $3)::int = $${params.length}`);
    }

    if (related_item_id && related_item_id !== 'all') {
      params.push(Number(related_item_id));
      where.push(`EXISTS (
        SELECT 1
        FROM order_items sibling
        WHERE sibling.order_id = o.id
          AND sibling.menu_item_id = $${params.length}
      )`);
    }

    const whereSql = where.join(' AND ');
    const havingSql = min_quantity && Number(min_quantity) > 0
      ? `HAVING SUM(oi.quantity) >= ${Math.max(0, Math.floor(Number(min_quantity)))}`
      : '';

    const rows = await all(`
      SELECT
        COALESCE(mc.id, 0) as category_id,
        COALESCE(mc.name, 'Uncategorized') as category_name,
        COALESCE(mi.id, oi.menu_item_id, 0) as item_id,
        oi.item_name,
        SUM(oi.quantity)::int as quantity_sold,
        COUNT(DISTINCT o.id)::int as orders_count,
        COUNT(DISTINCT o.loyalty_customer_id) FILTER (WHERE o.loyalty_customer_id IS NOT NULL)::int as customer_count,
        ROUND(SUM(oi.quantity * oi.unit_price), 2) as revenue,
        ROUND(AVG(oi.unit_price), 2) as avg_unit_price
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      LEFT JOIN menu_items mi ON oi.menu_item_id = mi.id
      LEFT JOIN menu_categories mc ON mi.category_id = mc.id
      WHERE ${whereSql}
      GROUP BY COALESCE(mc.id, 0), COALESCE(mc.name, 'Uncategorized'), COALESCE(mi.id, oi.menu_item_id, 0), oi.item_name
      ${havingSql}
      ORDER BY quantity_sold DESC, revenue DESC, oi.item_name ASC
    `, params);

    const totalQuantity = rows.reduce((sum, row) => sum + Number(row.quantity_sold || 0), 0);
    const totalRevenue = rows.reduce((sum, row) => sum + Number(row.revenue || 0), 0);
    const categoryMap = new Map();

    for (const row of rows) {
      row.category_id = Number(row.category_id) || 0;
      row.item_id = Number(row.item_id) || 0;
      row.quantity_sold = Number(row.quantity_sold) || 0;
      row.orders_count = Number(row.orders_count) || 0;
      row.customer_count = Number(row.customer_count) || 0;
      row.revenue = Number(row.revenue) || 0;
      row.avg_unit_price = Number(row.avg_unit_price) || 0;
      row.item_mix_percent = totalQuantity > 0
        ? Math.round((row.quantity_sold / totalQuantity) * 1000) / 10
        : 0;

      const current = categoryMap.get(row.category_id) || {
        category_id: row.category_id,
        category_name: row.category_name,
        quantity_sold: 0,
        revenue: 0,
        item_count: 0,
        item_mix_percent: 0,
      };
      current.quantity_sold += row.quantity_sold;
      current.revenue += row.revenue;
      current.item_count += 1;
      categoryMap.set(row.category_id, current);
    }

    const categories = Array.from(categoryMap.values())
      .map(category => ({
        ...category,
        revenue: Math.round(category.revenue * 100) / 100,
        item_mix_percent: totalQuantity > 0
          ? Math.round((category.quantity_sold / totalQuantity) * 1000) / 10
          : 0,
      }))
      .sort((a, b) => b.quantity_sold - a.quantity_sold || b.revenue - a.revenue);

    const customers = await all(`
      SELECT DISTINCT
        lc.id,
        lc.name,
        lc.phone
      FROM orders o
      JOIN loyalty_customers lc ON lc.id = o.loyalty_customer_id
      WHERE (COALESCE(o.paid_at, o.created_at) AT TIME ZONE $3)::date BETWEEN $1 AND $2
        AND o.payment_status = 'paid'
      ORDER BY lc.name ASC
      LIMIT 200
    `, [startDate, endDate, tz]);

    const itemOptions = await all(`
      SELECT
        COALESCE(mi.id, oi.menu_item_id, 0) as item_id,
        oi.item_name,
        SUM(oi.quantity)::int as quantity_sold
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      LEFT JOIN menu_items mi ON oi.menu_item_id = mi.id
      WHERE (COALESCE(o.paid_at, o.created_at) AT TIME ZONE $3)::date BETWEEN $1 AND $2
        AND o.payment_status = 'paid'
        AND oi.menu_item_id IS NOT NULL
      GROUP BY COALESCE(mi.id, oi.menu_item_id, 0), oi.item_name
      ORDER BY quantity_sold DESC, oi.item_name ASC
      LIMIT 200
    `, [startDate, endDate, tz]);

    res.json({
      period,
      startDate,
      endDate,
      filters: {
        customer_id: customer_id || 'all',
        hour: hour || 'all',
        min_quantity: Number(min_quantity) || 0,
        related_item_id: related_item_id || 'all',
      },
      totals: {
        quantity_sold: totalQuantity,
        revenue: Math.round(totalRevenue * 100) / 100,
        unique_items: rows.length,
      },
      categories,
      items: rows,
      customers,
      item_options: itemOptions.map(item => ({
        item_id: Number(item.item_id) || 0,
        item_name: item.item_name,
        quantity_sold: Number(item.quantity_sold) || 0,
      })),
    });
  } catch (error) {
    console.error('Error fetching item sales report:', error);
    res.status(500).json({ error: 'Failed to fetch item sales report' });
  }
});

// GET /api/reports/employee-performance - sales by employee
router.get('/employee-performance', async (req, res) => {
  try {
    const { period = 'daily' } = req.query;
    const tz = req.tenant?.timezone || 'UTC';
    const { start: startDate, end: endDate } = resolveDateRange(req, tz);

    const employees = await all(`
      SELECT
        e.id as employee_id,
        e.name as employee_name,
        COUNT(o.id) as orders_processed,
        ROUND(SUM(o.subtotal), 2) as total_sales,
        ROUND(AVG(o.total), 2) as avg_ticket,
        ROUND(SUM(o.tip), 2) as tips_received
      FROM employees e
      LEFT JOIN orders o ON e.id = o.employee_id AND (COALESCE(o.paid_at, o.created_at) AT TIME ZONE $3)::date BETWEEN $1 AND $2 AND o.payment_status = 'paid'
      GROUP BY e.id, e.name
      ORDER BY total_sales DESC
    `, [startDate, endDate, tz]);

    res.json(employees);
  } catch (error) {
    console.error('Error fetching employee performance report:', error);
    res.status(500).json({ error: 'Failed to fetch employee performance report' });
  }
});

// GET /api/reports/hourly - orders by hour of day
router.get('/hourly', async (req, res) => {
  try {
    const tz = req.tenant?.timezone || 'UTC';
    const today = tzToday(tz);

    const hourly = await all(`
      SELECT
        EXTRACT(HOUR FROM COALESCE(paid_at, created_at) AT TIME ZONE $2)::int as hour,
        COUNT(*) as orders,
        ROUND(SUM(subtotal), 2) as revenue,
        ROUND(AVG(total), 2) as avg_ticket
      FROM orders
      WHERE (COALESCE(paid_at, created_at) AT TIME ZONE $2)::date = $1
        AND payment_status = 'paid'
      GROUP BY hour
      ORDER BY hour ASC
    `, [today, tz]);

    // Fill in missing hours with 0 values
    const hourlyMap = {};
    for (let i = 0; i < 24; i++) {
      hourlyMap[i] = {
        hour: i,
        orders: 0,
        revenue: 0,
        avg_ticket: 0,
      };
    }

    hourly.forEach(row => {
      hourlyMap[row.hour] = row;
    });

    const result = Object.values(hourlyMap);

    res.json(result);
  } catch (error) {
    console.error('Error fetching hourly report:', error);
    res.status(500).json({ error: 'Failed to fetch hourly report' });
  }
});

// GET /api/reports/cash-card-breakdown - cash vs card stats
router.get('/cash-card-breakdown', async (req, res) => {
  try {
    const { period = 'daily' } = req.query;
    const tz = req.tenant?.timezone || 'UTC';
    const { start: startDate, end: endDate } = resolveDateRange(req, tz);

    const breakdown = await all(`
      SELECT
        ${paymentSourceSql()} as payment_source,
        MIN(payment_method) as payment_method,
        COUNT(*) as count,
        ROUND(SUM(subtotal + tip), 2) as total,
        ROUND(SUM(tip), 2) as tips
      FROM orders
      WHERE (COALESCE(paid_at, created_at) AT TIME ZONE $3)::date BETWEEN $1 AND $2
        AND payment_status = 'paid'
        AND payment_method IS NOT NULL
      GROUP BY 1
      ORDER BY total DESC
    `, [startDate, endDate, tz]);

    // Coerce Postgres numeric/bigint strings to JS numbers
    for (const b of breakdown) {
      b.count = Number(b.count) || 0;
      b.total = Number(b.total) || 0;
      b.tips = Number(b.tips) || 0;
    }

    const totalOrders = breakdown.reduce((sum, b) => sum + b.count, 0);
    const totalRevenue = breakdown.reduce((sum, b) => sum + b.total, 0);

    const result = breakdown.map(b => ({
      ...b,
      display_name: PAYMENT_SOURCE_LABELS[b.payment_source] || b.payment_source,
      percentage: totalOrders > 0 ? Math.round((b.count / totalOrders) * 100) : 0,
      revenue_percentage: totalRevenue > 0 ? Math.round((b.total / totalRevenue) * 100) : 0,
    }));

    res.json({
      period,
      startDate,
      total_orders: totalOrders,
      total_revenue: totalRevenue,
      breakdown: result,
    });
  } catch (error) {
    console.error('Error fetching cash/card breakdown:', error);
    res.status(500).json({ error: 'Failed to fetch cash/card breakdown' });
  }
});

// GET /api/reports/cogs-summary - high-level COGS + waste + margin for a period
router.get('/cogs-summary', async (req, res) => {
  try {
    const { period = 'today', start_date, end_date } = req.query;
    const tz = req.tenant?.timezone || 'UTC';
    const startDate = start_date || getDateRange(period, tz);
    const endDate = end_date || tzToday(tz);

    // Revenue
    const revRow = await get(`
      SELECT COALESCE(SUM(subtotal), 0) as revenue
      FROM orders
      WHERE (COALESCE(paid_at, created_at) AT TIME ZONE $3)::date >= $1 AND (COALESCE(paid_at, created_at) AT TIME ZONE $3)::date <= $2
        AND payment_status = 'paid'
    `, [startDate, endDate, tz]);
    const revenue = Number(revRow?.revenue || 0);

    // COGS from order deductions
    const cogsRow = await get(`
      SELECT COALESCE(SUM(mii.quantity_used * oi.quantity * ii.cost_price), 0) as cogs
      FROM order_items oi
      JOIN menu_item_ingredients mii ON oi.menu_item_id = mii.menu_item_id
      JOIN inventory_items ii ON mii.inventory_item_id = ii.id
      JOIN orders o ON oi.order_id = o.id
      WHERE (COALESCE(o.paid_at, o.created_at) AT TIME ZONE $3)::date >= $1 AND (COALESCE(o.paid_at, o.created_at) AT TIME ZONE $3)::date <= $2
        AND o.payment_status = 'paid'
    `, [startDate, endDate, tz]);
    const cogs = Number(cogsRow?.cogs || 0);

    // Waste cost
    let wasteCost = 0;
    try {
      const wasteRow = await get(`
        SELECT COALESCE(SUM(cost_at_time), 0) as waste_cost
        FROM waste_log
        WHERE (created_at AT TIME ZONE $3)::date >= $1 AND (created_at AT TIME ZONE $3)::date <= $2
      `, [startDate, endDate, tz]);
      wasteCost = Number(wasteRow?.waste_cost || 0);
    } catch {
      // waste_log table may not exist yet
    }

    const totalFoodCost = Math.round((cogs + wasteCost) * 100) / 100;
    const foodCostPercent = revenue > 0
      ? Math.round(((cogs + wasteCost) / revenue) * 1000) / 10
      : 0;
    const grossProfit = Math.round((revenue - cogs - wasteCost) * 100) / 100;
    const grossMarginPercent = revenue > 0
      ? Math.round(((revenue - cogs - wasteCost) / revenue) * 1000) / 10
      : 0;

    res.json({
      period,
      start_date: startDate,
      revenue: Math.round(revenue * 100) / 100,
      cogs: Math.round(cogs * 100) / 100,
      waste_cost: Math.round(wasteCost * 100) / 100,
      total_food_cost: totalFoodCost,
      food_cost_percent: foodCostPercent,
      gross_profit: grossProfit,
      gross_margin_percent: grossMarginPercent,
    });
  } catch (error) {
    console.error('Error fetching COGS summary:', error);
    res.status(500).json({ error: 'Failed to fetch COGS summary' });
  }
});

// GET /api/reports/cogs - per-item COGS and margin
router.get('/cogs', async (req, res) => {
  try {
    const { period = 'daily' } = req.query;
    const tz = req.tenant?.timezone || 'UTC';
    const { start: startDate, end: endDate } = resolveDateRange(req, tz);

    // Get revenue per menu item
    const items = await all(`
      SELECT
        oi.menu_item_id,
        oi.item_name,
        SUM(oi.quantity) as quantity_sold,
        ROUND(SUM(oi.quantity * oi.unit_price), 2) as revenue
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      WHERE (COALESCE(o.paid_at, o.created_at) AT TIME ZONE $3)::date BETWEEN $1 AND $2
        AND o.payment_status = 'paid'
      GROUP BY oi.menu_item_id, oi.item_name
      ORDER BY revenue DESC
    `, [startDate, endDate, tz]);

    // Calculate COGS per item via menu_item_ingredients JOIN inventory_items.cost_price
    const result = [];
    for (const item of items) {
      const ingredients = await all(`
        SELECT mii.quantity_used, ii.cost_price
        FROM menu_item_ingredients mii
        JOIN inventory_items ii ON mii.inventory_item_id = ii.id
        WHERE mii.menu_item_id = $1
      `, [item.menu_item_id]);

      const cogsPerUnit = ingredients.reduce((sum, ing) => sum + (Number(ing.quantity_used) * Number(ing.cost_price)), 0);
      const revenue = Number(item.revenue) || 0;
      const qtySold = Number(item.quantity_sold) || 0;
      const totalCogs = Math.round(cogsPerUnit * qtySold * 100) / 100;
      const margin = revenue - totalCogs;
      const marginPercent = revenue > 0 ? Math.round((margin / revenue) * 100) : 0;

      result.push({
        menu_item_id: item.menu_item_id,
        item_name: item.item_name,
        quantity_sold: qtySold,
        revenue,
        cogs: totalCogs,
        margin,
        margin_percent: marginPercent,
      });
    }

    const totals = {
      total_revenue: result.reduce((s, r) => s + r.revenue, 0),
      total_cogs: result.reduce((s, r) => s + r.cogs, 0),
      total_margin: result.reduce((s, r) => s + r.margin, 0),
    };
    totals.overall_margin_percent = totals.total_revenue > 0
      ? Math.round((totals.total_margin / totals.total_revenue) * 100)
      : 0;

    res.json({ period, startDate, items: result, totals });
  } catch (error) {
    console.error('Error fetching COGS report:', error);
    res.status(500).json({ error: 'Failed to fetch COGS report' });
  }
});

// GET /api/reports/category-margins - per-category revenue/COGS/margin
router.get('/category-margins', async (req, res) => {
  try {
    const { period = 'daily' } = req.query;
    const tz = req.tenant?.timezone || 'UTC';
    const { start: startDate, end: endDate } = resolveDateRange(req, tz);

    const categories = await all(`
      SELECT
        mc.id as category_id,
        mc.name as category_name,
        SUM(oi.quantity) as quantity_sold,
        ROUND(SUM(oi.quantity * oi.unit_price), 2) as revenue
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      JOIN menu_items mi ON oi.menu_item_id = mi.id
      JOIN menu_categories mc ON mi.category_id = mc.id
      WHERE (COALESCE(o.paid_at, o.created_at) AT TIME ZONE $3)::date BETWEEN $1 AND $2
        AND o.payment_status = 'paid'
      GROUP BY mc.id, mc.name
      ORDER BY revenue DESC
    `, [startDate, endDate, tz]);

    const result = [];
    for (const cat of categories) {
      // Get all menu items in this category that were sold
      const catItems = await all(`
        SELECT DISTINCT oi.menu_item_id
        FROM order_items oi
        JOIN orders o ON oi.order_id = o.id
        JOIN menu_items mi ON oi.menu_item_id = mi.id
        WHERE mi.category_id = $1
          AND (COALESCE(o.paid_at, o.created_at) AT TIME ZONE $4)::date BETWEEN $2 AND $3
          AND o.payment_status = 'paid'
      `, [cat.category_id, startDate, endDate, tz]);

      let totalCogs = 0;
      for (const item of catItems) {
        const sold = await get(`
          SELECT SUM(oi.quantity) as qty
          FROM order_items oi
          JOIN orders o ON oi.order_id = o.id
          WHERE oi.menu_item_id = $1
            AND (COALESCE(o.paid_at, o.created_at) AT TIME ZONE $4)::date BETWEEN $2 AND $3
            AND o.payment_status = 'paid'
        `, [item.menu_item_id, startDate, endDate, tz]);

        const ingredients = await all(`
          SELECT mii.quantity_used, ii.cost_price
          FROM menu_item_ingredients mii
          JOIN inventory_items ii ON mii.inventory_item_id = ii.id
          WHERE mii.menu_item_id = $1
        `, [item.menu_item_id]);

        const cogsPerUnit = ingredients.reduce((sum, ing) => sum + (ing.quantity_used * ing.cost_price), 0);
        totalCogs += cogsPerUnit * (sold?.qty || 0);
      }

      totalCogs = Math.round(totalCogs * 100) / 100;
      const margin = cat.revenue - totalCogs;
      const marginPercent = cat.revenue > 0 ? Math.round((margin / cat.revenue) * 100) : 0;

      result.push({
        ...cat,
        cogs: totalCogs,
        margin,
        margin_percent: marginPercent,
      });
    }

    res.json({ period, startDate, categories: result });
  } catch (error) {
    console.error('Error fetching category margins:', error);
    res.status(500).json({ error: 'Failed to fetch category margins' });
  }
});

// GET /api/reports/contribution-margin - daily revenue minus COGS
router.get('/contribution-margin', async (req, res) => {
  try {
    const { period = 'weekly', group_by = 'day' } = req.query;
    const tz = req.tenant?.timezone || 'UTC';
    const { start: startDate, end: endDate } = resolveDateRange(req, tz);

    const dailyRevenue = await all(`
      SELECT
        (COALESCE(o.paid_at, o.created_at) AT TIME ZONE $3)::date as date,
        ROUND(SUM(oi.quantity * oi.unit_price), 2) as revenue,
        COUNT(DISTINCT o.id) as orders
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      WHERE (COALESCE(o.paid_at, o.created_at) AT TIME ZONE $3)::date BETWEEN $1 AND $2
        AND o.payment_status = 'paid'
      GROUP BY (COALESCE(o.paid_at, o.created_at) AT TIME ZONE $3)::date
      ORDER BY date ASC
    `, [startDate, endDate, tz]);

    const result = [];
    for (const day of dailyRevenue) {
      // Calculate COGS for all items sold that day
      const dayItems = await all(`
        SELECT oi.menu_item_id, SUM(oi.quantity) as qty
        FROM order_items oi
        JOIN orders o ON oi.order_id = o.id
        WHERE (COALESCE(o.paid_at, o.created_at) AT TIME ZONE $2)::date = $1
          AND o.payment_status = 'paid'
        GROUP BY oi.menu_item_id
      `, [day.date, tz]);

      let dayCogs = 0;
      for (const item of dayItems) {
        const ingredients = await all(`
          SELECT mii.quantity_used, ii.cost_price
          FROM menu_item_ingredients mii
          JOIN inventory_items ii ON mii.inventory_item_id = ii.id
          WHERE mii.menu_item_id = $1
        `, [item.menu_item_id]);

        const cogsPerUnit = ingredients.reduce((sum, ing) => sum + (ing.quantity_used * ing.cost_price), 0);
        dayCogs += cogsPerUnit * item.qty;
      }

      dayCogs = Math.round(dayCogs * 100) / 100;
      const margin = Math.round((day.revenue - dayCogs) * 100) / 100;
      const marginPercent = day.revenue > 0 ? Math.round((margin / day.revenue) * 100) : 0;

      result.push({
        date: day.date,
        revenue: day.revenue,
        cogs: dayCogs,
        contribution_margin: margin,
        margin_percent: marginPercent,
        orders: day.orders,
      });
    }

    res.json({ period, startDate, data: result });
  } catch (error) {
    console.error('Error fetching contribution margin:', error);
    res.status(500).json({ error: 'Failed to fetch contribution margin' });
  }
});

// GET /api/reports/live - today's live KPIs + hourly trend
router.get('/live', async (req, res) => {
  try {
    const tz = req.tenant?.timezone || 'UTC';
    const today = tzToday(tz);

    // Today's KPIs
    const kpis = await get(`
      SELECT
        COUNT(*) as order_count,
        ROUND(SUM(subtotal), 2) as revenue,
        ROUND(AVG(total), 2) as avg_ticket,
        ROUND(SUM(tip), 2) as tips,
        SUM(CASE WHEN payment_method = 'cash' THEN 1 ELSE 0 END) as cash_orders,
        SUM(CASE WHEN payment_method <> 'cash' THEN 1 ELSE 0 END) as card_orders,
        ROUND(SUM(CASE WHEN payment_method = 'cash' THEN subtotal + tip ELSE 0 END), 2) as cash_revenue,
        ROUND(SUM(CASE WHEN payment_method <> 'cash' THEN subtotal + tip ELSE 0 END), 2) as card_revenue
      FROM orders
      WHERE (COALESCE(paid_at, created_at) AT TIME ZONE $2)::date = $1
        AND payment_status = 'paid'
    `, [today, tz]);

    // Hourly trend
    const hourly = await all(`
      SELECT
        EXTRACT(HOUR FROM COALESCE(paid_at, created_at) AT TIME ZONE $2)::int as hour,
        COUNT(*) as orders,
        ROUND(SUM(subtotal), 2) as revenue
      FROM orders
      WHERE (COALESCE(paid_at, created_at) AT TIME ZONE $2)::date = $1
        AND payment_status = 'paid'
      GROUP BY hour
      ORDER BY hour ASC
    `, [today, tz]);

    // Source breakdown
    const sources = await all(`
      SELECT
        COALESCE(source, 'pos') as source,
        COUNT(*) as count,
        ROUND(SUM(subtotal), 2) as revenue
      FROM orders
      WHERE (COALESCE(paid_at, created_at) AT TIME ZONE $2)::date = $1
        AND payment_status = 'paid'
      GROUP BY source
    `, [today, tz]);

    const paymentSources = await all(`
      SELECT
        ${paymentSourceSql()} as payment_source,
        MIN(payment_method) as payment_method,
        COUNT(*) as count,
        ROUND(SUM(subtotal + tip), 2) as revenue,
        ROUND(SUM(tip), 2) as tips
      FROM orders
      WHERE (COALESCE(paid_at, created_at) AT TIME ZONE $2)::date = $1
        AND payment_status = 'paid'
        AND payment_method IS NOT NULL
      GROUP BY 1
      ORDER BY revenue DESC
    `, [today, tz]);

    const payment_sources = paymentSources.map((source) => ({
      ...source,
      count: Number(source.count) || 0,
      revenue: Number(source.revenue) || 0,
      tips: Number(source.tips) || 0,
      display_name: PAYMENT_SOURCE_LABELS[source.payment_source] || source.payment_source,
    }));

    // Top 5 items today
    const topItems = await all(`
      SELECT oi.item_name, SUM(oi.quantity) as qty
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      WHERE (COALESCE(o.paid_at, o.created_at) AT TIME ZONE $2)::date = $1
        AND o.payment_status = 'paid'
      GROUP BY oi.item_name
      ORDER BY qty DESC
      LIMIT 5
    `, [today, tz]);

    res.json({
      date: today,
      kpis: kpis || { order_count: 0, revenue: 0, avg_ticket: 0, tips: 0, cash_orders: 0, card_orders: 0, cash_revenue: 0, card_revenue: 0 },
      hourly,
      sources,
      payment_sources,
      topItems,
    });
  } catch (error) {
    console.error('Error fetching live report:', error);
    res.status(500).json({ error: 'Failed to fetch live report' });
  }
});

// GET /api/reports/delivery-margins - per-platform delivery margins
router.get('/delivery-margins', async (req, res) => {
  try {
    const { period = 'daily' } = req.query;
    const tz = req.tenant?.timezone || 'UTC';
    const { start: startDate, end: endDate } = resolveDateRange(req, tz);

    const platforms = await all(`
      SELECT
        dp.id as platform_id,
        dp.display_name,
        dp.commission_percent,
        COUNT(o.id) as order_count,
        ROUND(SUM(o.subtotal), 2) as revenue,
        ROUND(SUM(CASE WHEN o.id IS NOT NULL THEN dor.delivery_fee ELSE 0 END), 2) as total_delivery_fees,
        ROUND(SUM(CASE WHEN o.id IS NOT NULL THEN dor.platform_commission ELSE 0 END), 2) as total_commission
      FROM delivery_platforms dp
      LEFT JOIN delivery_orders dor ON dp.id = dor.platform_id
      LEFT JOIN orders o ON dor.order_id = o.id
        AND (COALESCE(o.paid_at, o.created_at) AT TIME ZONE $3)::date BETWEEN $1 AND $2
        AND o.payment_status = 'paid'
      GROUP BY dp.id, dp.display_name, dp.commission_percent
    `, [startDate, endDate, tz]);

    const result = platforms.map(p => {
      const netRevenue = (p.revenue || 0) - (p.total_commission || 0);
      return {
        ...p,
        net_revenue: Math.round(netRevenue * 100) / 100,
        margin_percent: p.revenue > 0 ? Math.round((netRevenue / p.revenue) * 100) : 0,
      };
    });

    res.json({ period, startDate, platforms: result });
  } catch (error) {
    console.error('Error fetching delivery margins:', error);
    res.status(500).json({ error: 'Failed to fetch delivery margins' });
  }
});

// GET /api/reports/channel-comparison - POS vs delivery channels
router.get('/channel-comparison', async (req, res) => {
  try {
    const { period = 'daily' } = req.query;
    const tz = req.tenant?.timezone || 'UTC';
    const { start: startDate, end: endDate } = resolveDateRange(req, tz);

    const channels = await all(`
      SELECT
        COALESCE(o.source, 'pos') as channel,
        COUNT(*) as order_count,
        ROUND(SUM(o.subtotal), 2) as revenue,
        ROUND(AVG(o.total), 2) as avg_ticket
      FROM orders o
      WHERE (COALESCE(o.paid_at, o.created_at) AT TIME ZONE $3)::date BETWEEN $1 AND $2
        AND o.payment_status = 'paid'
      GROUP BY o.source
      ORDER BY revenue DESC
    `, [startDate, endDate, tz]);

    res.json({ period, startDate, channels });
  } catch (error) {
    console.error('Error fetching channel comparison:', error);
    res.status(500).json({ error: 'Failed to fetch channel comparison' });
  }
});

// GET /api/reports/reconciliation - match DB orders to Stripe charges
router.get('/reconciliation', requireAuth('view_reports'), async (req, res) => {
  try {
    const tz = req.tenant?.timezone || 'UTC';
    const { start_date, end_date } = req.query;
    const startDate = start_date || tzToday(tz);
    const endDate = end_date || startDate;

    // Get card orders in range
    const orders = await all(`
      SELECT id, order_number, total, tip, payment_intent_id, payment_status, refund_total
      FROM orders
      WHERE (COALESCE(paid_at, created_at) AT TIME ZONE $3)::date >= $1 AND (COALESCE(paid_at, created_at) AT TIME ZONE $3)::date <= $2
        AND payment_method = 'card'
        AND payment_intent_id IS NOT NULL
      ORDER BY created_at ASC
    `, [startDate, endDate, tz]);

    const rows = [];
    for (const order of orders) {
      let stripeFee = 0;
      let stripeAmount = 0;
      let netAmount = 0;
      let matched = false;

      try {
        const fees = await getChargeFees(order.payment_intent_id);
        stripeAmount = fees.gross;
        stripeFee = fees.fee;
        netAmount = fees.net;
        matched = Math.abs(stripeAmount - (Number(order.total) + Number(order.tip))) < 0.02;
      } catch {
        // If Stripe call fails, leave as unmatched
      }

      rows.push({
        order_id: order.id,
        order_number: order.order_number,
        order_total: Number(order.total) + Number(order.tip),
        refund_total: Number(order.refund_total) || 0,
        stripe_amount: stripeAmount,
        stripe_fee: stripeFee,
        net_amount: netAmount,
        matched,
      });
    }

    res.json({ start_date: startDate, end_date: endDate, rows });
  } catch (error) {
    console.error('Error fetching reconciliation:', error);
    res.status(500).json({ error: 'Failed to fetch reconciliation' });
  }
});

// GET /api/reports/payment-fees - aggregate fee + tip report across all processors
router.get('/payment-fees', requireAuth('view_reports'), async (req, res) => {
  try {
    const { period = 'daily' } = req.query;
    const tz = req.tenant?.timezone || 'UTC';
    const { start: startDate, end: endDate } = resolveDateRange(req, tz);

    const daily = {};
    const byProcessor = {};
    let totalRevenue = 0;
    let totalFees = 0;
    let totalNet = 0;
    let totalTips = 0;

    const bump = (dateKey, processor, { revenue = 0, fees = 0, net = 0, tips = 0, count = 0 }) => {
      if (!daily[dateKey]) daily[dateKey] = { date: dateKey, revenue: 0, fees: 0, net: 0, order_count: 0 };
      daily[dateKey].revenue += revenue;
      daily[dateKey].fees += fees;
      daily[dateKey].net += net;
      daily[dateKey].order_count += count;
      if (!byProcessor[processor]) byProcessor[processor] = { processor, revenue: 0, fees: 0, net: 0, tips: 0, count: 0 };
      byProcessor[processor].revenue += revenue;
      byProcessor[processor].fees += fees;
      byProcessor[processor].net += net;
      byProcessor[processor].tips += tips;
      byProcessor[processor].count += count;
      totalRevenue += revenue;
      totalFees += fees;
      totalNet += net;
      totalTips += tips;
    };

    // 1) Stripe-backed card payments — fees fetched live from Stripe.
    const stripeOrders = await all(`
      SELECT id, payment_intent_id, created_at
      FROM orders
      WHERE (COALESCE(paid_at, created_at) AT TIME ZONE $3)::date BETWEEN $1 AND $2
        AND payment_method = 'card'
        AND payment_intent_id IS NOT NULL
        AND payment_status = 'paid'
      ORDER BY created_at ASC
    `, [startDate, endDate, tz]);

    for (const order of stripeOrders) {
      const dateKey = order.created_at.split(' ')[0] || order.created_at.split('T')[0];
      try {
        const fees = await getChargeFees(order.payment_intent_id);
        bump(dateKey, 'stripe', { revenue: fees.gross, fees: fees.fee, net: fees.net, count: 1 });
      } catch {
        // Skip failed Stripe lookups
      }
    }

    // 2) MP Terminal (and any future processor) — fees stored locally in order_payments.
    const localPayments = await all(`
      SELECT payment_method,
             COALESCE(amount, 0)         AS amount,
             COALESCE(tip, 0)            AS tip,
             COALESCE(processor_fee, 0)  AS processor_fee,
             COALESCE(processor_net, COALESCE(amount, 0) - COALESCE(processor_fee, 0)) AS processor_net,
             created_at
      FROM order_payments
      WHERE (created_at AT TIME ZONE $3)::date BETWEEN $1 AND $2
        AND status = 'paid'
        AND payment_method = 'mp_terminal'
      ORDER BY created_at ASC
    `, [startDate, endDate, tz]);

    for (const p of localPayments) {
      const ts = typeof p.created_at === 'string' ? p.created_at : p.created_at.toISOString();
      const dateKey = ts.split(' ')[0] || ts.split('T')[0];
      bump(dateKey, p.payment_method, {
        revenue: Number(p.amount),
        fees: Number(p.processor_fee),
        net: Number(p.processor_net),
        tips: Number(p.tip),
        count: 1,
      });
    }

    const round2 = (n) => Math.round(n * 100) / 100;
    const feePercent = totalRevenue > 0 ? round2((totalFees / totalRevenue) * 100) : 0;

    res.json({
      period,
      total_revenue: round2(totalRevenue),
      total_fees: round2(totalFees),
      net_revenue: round2(totalNet),
      fee_percent: feePercent,
      tips_collected: round2(totalTips),
      daily: Object.values(daily).map(d => ({
        ...d,
        revenue: round2(d.revenue),
        fees: round2(d.fees),
        net: round2(d.net),
      })),
      by_processor: Object.values(byProcessor).map(p => ({
        ...p,
        revenue: round2(p.revenue),
        fees: round2(p.fees),
        net: round2(p.net),
        tips: round2(p.tips),
        fee_percent: p.revenue > 0 ? round2((p.fees / p.revenue) * 100) : 0,
      })),
    });
  } catch (error) {
    console.error('Error fetching payment fees:', error);
    res.status(500).json({ error: 'Failed to fetch payment fees' });
  }
});

// GET /api/reports/refund-summary - refund analytics
router.get('/refund-summary', requireAuth('view_reports'), async (req, res) => {
  try {
    const { period = 'daily' } = req.query;
    const tz = req.tenant?.timezone || 'UTC';
    const { start: startDate, end: endDate } = resolveDateRange(req, tz);

    const summary = await get(`
      SELECT
        COUNT(*) as total_refunds,
        ROUND(SUM(amount), 2) as total_refunded,
        ROUND(AVG(amount), 2) as avg_refund
      FROM refunds
      WHERE (created_at AT TIME ZONE $3)::date BETWEEN $1 AND $2
    `, [startDate, endDate, tz]);

    const byReason = await all(`
      SELECT
        COALESCE(reason, 'unspecified') as reason,
        COUNT(*) as count,
        ROUND(SUM(amount), 2) as total
      FROM refunds
      WHERE (created_at AT TIME ZONE $3)::date BETWEEN $1 AND $2
      GROUP BY reason
      ORDER BY count DESC
    `, [startDate, endDate, tz]);

    const byEmployee = await all(`
      SELECT
        e.name as employee_name,
        COUNT(r.id) as refund_count,
        ROUND(SUM(r.amount), 2) as total_refunded
      FROM refunds r
      LEFT JOIN employees e ON r.refunded_by = e.id
      WHERE (r.created_at AT TIME ZONE $3)::date BETWEEN $1 AND $2
      GROUP BY r.refunded_by, e.name
      ORDER BY refund_count DESC
    `, [startDate, endDate, tz]);

    const daily = await all(`
      SELECT
        (created_at AT TIME ZONE $3)::date as date,
        COUNT(*) as count,
        ROUND(SUM(amount), 2) as total
      FROM refunds
      WHERE (created_at AT TIME ZONE $3)::date BETWEEN $1 AND $2
      GROUP BY (created_at AT TIME ZONE $3)::date
      ORDER BY date ASC
    `, [startDate, endDate, tz]);

    res.json({
      period,
      summary: summary || { total_refunds: 0, total_refunded: 0, avg_refund: 0 },
      byReason,
      byEmployee,
      daily,
    });
  } catch (error) {
    console.error('Error fetching refund summary:', error);
    res.status(500).json({ error: 'Failed to fetch refund summary' });
  }
});

// ==================== Financial Projection Endpoints ====================

const COST_CATEGORIES = [
  { key: 'food_cost', label: 'Food Cost', auto: true },
  { key: 'labor', label: 'Labor', auto: true },
  { key: 'rent', label: 'Rent', auto: false },
  { key: 'utilities', label: 'Utilities', auto: false },
  { key: 'mp_terminal_fees', label: 'MP Terminal Fees', auto: true },
  { key: 'delivery_commissions', label: 'Delivery Commissions', auto: true },
  { key: 'marketing', label: 'Marketing', auto: false },
  { key: 'insurance', label: 'Insurance', auto: false },
  { key: 'supplies', label: 'Supplies/Packaging', auto: false },
];

// GET /api/reports/financial-projection?month=YYYY-MM
router.get('/financial-projection', requireAuth('view_reports'), async (req, res) => {
  try {
    const tz = req.tenant?.timezone || 'UTC';
    const month = req.query.month || tzToday(tz).slice(0, 7);
    const startDate = `${month}-01`;
    // End date: last day of month
    const [year, mon] = month.split('-').map(Number);
    const lastDay = new Date(year, mon, 0).getDate();
    const endDate = `${month}-${String(lastDay).padStart(2, '0')}`;

    // Revenue: SUM(subtotal) from paid orders in month
    const revRow = await get(`
      SELECT COALESCE(SUM(subtotal), 0) as revenue
      FROM orders
      WHERE (COALESCE(paid_at, created_at) AT TIME ZONE $3)::date >= $1 AND (COALESCE(paid_at, created_at) AT TIME ZONE $3)::date <= $2
        AND payment_status = 'paid'
    `, [startDate, endDate, tz]);
    const revenue = revRow?.revenue || 0;

    // Auto-calculate food COGS
    const soldItems = await all(`
      SELECT oi.menu_item_id, SUM(oi.quantity) as qty
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      WHERE (COALESCE(o.paid_at, o.created_at) AT TIME ZONE $3)::date >= $1 AND (COALESCE(o.paid_at, o.created_at) AT TIME ZONE $3)::date <= $2
        AND o.payment_status = 'paid'
      GROUP BY oi.menu_item_id
    `, [startDate, endDate, tz]);

    let foodCost = 0;
    for (const item of soldItems) {
      const ingredients = await all(`
        SELECT mii.quantity_used, ii.cost_price
        FROM menu_item_ingredients mii
        JOIN inventory_items ii ON mii.inventory_item_id = ii.id
        WHERE mii.menu_item_id = $1
      `, [item.menu_item_id]);
      const cogsPerUnit = ingredients.reduce((sum, ing) => sum + (ing.quantity_used * (ing.cost_price || 0)), 0);
      foodCost += cogsPerUnit * item.qty;
    }
    foodCost = Math.round(foodCost * 100) / 100;

    // Auto-calculate MP Terminal fees (stored locally on order_payments).
    const mpFeesRow = await get(`
      SELECT COALESCE(SUM(processor_fee), 0) AS total
      FROM order_payments
      WHERE (created_at AT TIME ZONE $3)::date >= $1
        AND (created_at AT TIME ZONE $3)::date <= $2
        AND payment_method = 'mp_terminal'
        AND status = 'paid'
    `, [startDate, endDate, tz]);
    const mpTerminalFees = Math.round((Number(mpFeesRow?.total) || 0) * 100) / 100;

    // Auto-calculate Labor — sum base pay across the month from shifts × rates.
    // computeSnapshot is keyed on [period_start, period_end) so passing the
    // month start and the first-of-next-month gives the full-month range.
    let laborCost = 0;
    try {
      const nextMonth = new Date(year, mon, 1);
      const monthEndExclusive = `${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, '0')}-01`;
      const snapshot = await computeSnapshot({
        period_start: startDate,
        period_end: monthEndExclusive,
        tz,
      });
      laborCost = Math.round((snapshot.totals.base_pay_cents || 0)) / 100;
    } catch (err) {
      console.warn('Labor auto-calc failed:', err.message);
    }

    // Auto-calculate delivery commissions
    const delRow = await get(`
      SELECT COALESCE(SUM(dor.platform_commission), 0) as total
      FROM delivery_orders dor
      JOIN orders o ON dor.order_id = o.id
      WHERE (COALESCE(o.paid_at, o.created_at) AT TIME ZONE $3)::date >= $1 AND (COALESCE(o.paid_at, o.created_at) AT TIME ZONE $3)::date <= $2
        AND o.payment_status = 'paid'
    `, [startDate, endDate, tz]);
    const deliveryCommissions = Math.round((delRow?.total || 0) * 100) / 100;

    // Cache auto-calculated values (only if not manually overridden)
    const autoValues = {
      food_cost: foodCost,
      mp_terminal_fees: mpTerminalFees,
      delivery_commissions: deliveryCommissions,
      labor: laborCost,
    };
    for (const [cat, amount] of Object.entries(autoValues)) {
      // Check if a manual override exists
      const existing = await get(`SELECT auto_calculated FROM financial_actuals WHERE category = $1 AND period = $2`, [cat, month]);
      if (!existing || existing.auto_calculated === true) {
        const tid = getTenantId();
        await run(`INSERT INTO financial_actuals (tenant_id, category, period, amount, auto_calculated)
             VALUES ($1, $2, $3, $4, true)
             ON CONFLICT(tenant_id, category, period)
             DO UPDATE SET amount = $4, auto_calculated = true`, [tid, cat, month, amount]);
      }
    }

    // Load all targets
    const targets = await all(`SELECT category, target_percent FROM financial_targets`);
    const targetMap = {};
    for (const t of targets) {
      targetMap[t.category] = t.target_percent;
    }

    // Load all actuals for this month
    const actuals = await all(`SELECT category, amount FROM financial_actuals WHERE period = $1`, [month]);
    const actualMap = {};
    for (const a of actuals) {
      actualMap[a.category] = a.amount;
    }

    // Build rows
    const rows = COST_CATEGORIES.map(cat => {
      const targetPercent = targetMap[cat.key] || 0;
      const targetAmount = Math.round(revenue * (targetPercent / 100) * 100) / 100;
      const actualAmount = actualMap[cat.key] || 0;
      const diffAmount = Math.round((actualAmount - targetAmount) * 100) / 100;
      const diffPercent = revenue > 0
        ? Math.round(((actualAmount / revenue) * 100 - targetPercent) * 100) / 100
        : 0;

      return {
        category: cat.key,
        label: cat.label,
        auto_calculated: cat.auto,
        target_percent: targetPercent,
        target_amount: targetAmount,
        actual_amount: actualAmount,
        diff_amount: diffAmount,
        diff_percent: diffPercent,
      };
    });

    const totalActualCosts = rows.reduce((sum, r) => sum + r.actual_amount, 0);
    const totalTargetCosts = rows.reduce((sum, r) => sum + r.target_amount, 0);
    const netProfit = Math.round((revenue - totalActualCosts) * 100) / 100;
    const targetNetProfit = Math.round((revenue - totalTargetCosts) * 100) / 100;

    res.json({ month, revenue, rows, net_profit: netProfit, target_net_profit: targetNetProfit });
  } catch (error) {
    console.error('Error fetching financial projection:', error);
    res.status(500).json({ error: 'Failed to fetch financial projection' });
  }
});

// PUT /api/reports/financial-targets
router.put('/financial-targets', requireAuth('view_reports'), async (req, res) => {
  try {
    // Plan check — free cannot edit variables
    const plan = req.tenant?.plan || 'free';
    const limits = getPlanLimits(plan);
    if (!limits.reports.editVariables) {
      return res.status(403).json(planUpgradeError('reports', plan));
    }

    const employee = req.employee;
    if (!['admin', 'manager'].includes(employee.role)) {
      return res.status(403).json({ error: 'Only admin or manager can edit targets' });
    }

    const { targets } = req.body;
    if (!Array.isArray(targets)) {
      return res.status(400).json({ error: 'targets must be an array' });
    }

    for (const t of targets) {
      if (!t.category || t.target_percent == null) continue;
      const tid = getTenantId();
      await run(`INSERT INTO financial_targets (tenant_id, category, target_percent, updated_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT(tenant_id, category)
           DO UPDATE SET target_percent = $3, updated_at = NOW()`,
        [tid, t.category, t.target_percent]);
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error updating financial targets:', error);
    res.status(500).json({ error: 'Failed to update financial targets' });
  }
});

// PUT /api/reports/financial-actuals
router.put('/financial-actuals', requireAuth('view_reports'), async (req, res) => {
  try {
    // Plan check — free cannot edit variables
    const plan = req.tenant?.plan || 'free';
    const limits = getPlanLimits(plan);
    if (!limits.reports.editVariables) {
      return res.status(403).json(planUpgradeError('reports', plan));
    }

    const employee = req.employee;
    if (!['admin', 'manager'].includes(employee.role)) {
      return res.status(403).json({ error: 'Only admin or manager can edit actuals' });
    }

    const { period, category, amount } = req.body;
    if (!period || !category || amount == null) {
      return res.status(400).json({ error: 'period, category, and amount are required' });
    }

    const tid = getTenantId();
    await run(`INSERT INTO financial_actuals (tenant_id, category, period, amount, auto_calculated)
         VALUES ($1, $2, $3, $4, false)
         ON CONFLICT(tenant_id, category, period)
         DO UPDATE SET amount = $4, auto_calculated = false`,
      [tid, category, period, amount]);

    res.json({ success: true });
  } catch (error) {
    console.error('Error updating financial actuals:', error);
    res.status(500).json({ error: 'Failed to update financial actuals' });
  }
});

// GET /api/reports/menu-engineering - BCG matrix classification (Star/Workhorse/Puzzle/Dog)
router.get('/menu-engineering', async (req, res) => {
  try {
    const { period = 'monthly' } = req.query;
    const tz = req.tenant?.timezone || 'UTC';
    const { start: startDate, end: endDate } = resolveDateRange(req, tz);

    // Get all sold items with quantities and revenue
    const items = await all(`
      SELECT
        oi.menu_item_id,
        oi.item_name,
        mc.name as category_name,
        mi.price as current_price,
        SUM(oi.quantity) as quantity_sold,
        ROUND(SUM(oi.quantity * oi.unit_price), 2) as revenue
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      LEFT JOIN menu_items mi ON oi.menu_item_id = mi.id
      LEFT JOIN menu_categories mc ON mi.category_id = mc.id
      WHERE (COALESCE(o.paid_at, o.created_at) AT TIME ZONE $3)::date BETWEEN $1 AND $2
        AND o.payment_status = 'paid'
        AND oi.menu_item_id IS NOT NULL
      GROUP BY oi.menu_item_id, oi.item_name, mc.name, mi.price
      ORDER BY quantity_sold DESC
    `, [startDate, endDate, tz]);

    if (items.length === 0) {
      return res.json({
        period,
        startDate,
        items: [],
        summary: {
          total_items: 0, stars: 0, workhorses: 0, puzzles: 0, dogs: 0,
          avg_contribution_margin: 0, avg_popularity_index: 0,
          total_revenue: 0, total_contribution: 0,
        },
        recommendations: [],
      });
    }

    // Calculate total items sold across all menu items
    const totalItemsSold = items.reduce((sum, it) => sum + Number(it.quantity_sold), 0);

    // Calculate COGS per unit for each item via menu_item_ingredients
    const result = [];
    for (const item of items) {
      const ingredients = await all(`
        SELECT mii.quantity_used, ii.cost_price
        FROM menu_item_ingredients mii
        JOIN inventory_items ii ON mii.inventory_item_id = ii.id
        WHERE mii.menu_item_id = $1
      `, [item.menu_item_id]);

      const cogsPerUnit = ingredients.reduce((sum, ing) => sum + (Number(ing.quantity_used) * Number(ing.cost_price)), 0);
      const price = Number(item.current_price) || (Number(item.revenue) / Number(item.quantity_sold));
      const contributionMargin = Math.round((price - cogsPerUnit) * 100) / 100;
      const qtySold = Number(item.quantity_sold);
      const totalContribution = Math.round(contributionMargin * qtySold * 100) / 100;
      const popularityIndex = totalItemsSold > 0
        ? Math.round((qtySold / totalItemsSold) * 10000) / 100
        : 0;

      result.push({
        menu_item_id: item.menu_item_id,
        item_name: item.item_name,
        category_name: item.category_name || 'Uncategorized',
        price: Math.round(price * 100) / 100,
        cogs_per_unit: Math.round(cogsPerUnit * 100) / 100,
        contribution_margin: contributionMargin,
        total_contribution: totalContribution,
        quantity_sold: qtySold,
        revenue: Number(item.revenue),
        popularity_index: popularityIndex,
        classification: '', // will be set below
      });
    }

    // Calculate averages for classification thresholds
    const avgMargin = result.reduce((s, r) => s + r.contribution_margin, 0) / result.length;
    const avgPopularity = result.reduce((s, r) => s + r.popularity_index, 0) / result.length;

    // Kasavana-Smith method: 70% of average as popularity threshold
    const popularityThreshold = avgPopularity * 0.7;
    const marginThreshold = avgMargin;

    // Classify items
    for (const item of result) {
      const highMargin = item.contribution_margin >= marginThreshold;
      const highPopularity = item.popularity_index >= popularityThreshold;

      if (highMargin && highPopularity) item.classification = 'star';
      else if (!highMargin && highPopularity) item.classification = 'workhorse';
      else if (highMargin && !highPopularity) item.classification = 'puzzle';
      else item.classification = 'dog';
    }

    // Summary
    const summary = {
      total_items: result.length,
      stars: result.filter(r => r.classification === 'star').length,
      workhorses: result.filter(r => r.classification === 'workhorse').length,
      puzzles: result.filter(r => r.classification === 'puzzle').length,
      dogs: result.filter(r => r.classification === 'dog').length,
      avg_contribution_margin: Math.round(avgMargin * 100) / 100,
      avg_popularity_index: Math.round(avgPopularity * 100) / 100,
      popularity_threshold: Math.round(popularityThreshold * 100) / 100,
      margin_threshold: Math.round(marginThreshold * 100) / 100,
      total_revenue: result.reduce((s, r) => s + r.revenue, 0),
      total_contribution: result.reduce((s, r) => s + r.total_contribution, 0),
    };

    // Generate recommendations
    const recommendations = [];
    const stars = result.filter(r => r.classification === 'star').map(r => r.item_name);
    const workhorses = result.filter(r => r.classification === 'workhorse').map(r => r.item_name);
    const puzzles = result.filter(r => r.classification === 'puzzle').map(r => r.item_name);
    const dogs = result.filter(r => r.classification === 'dog').map(r => r.item_name);

    if (stars.length > 0) {
      recommendations.push({
        type: 'star',
        items: stars,
        action: 'Protect & Promote',
        detail: 'These are your best items. Highlight them on the menu (top-right or center). Maintain quality and consider a small price increase to boost margins further.',
      });
    }
    if (workhorses.length > 0) {
      recommendations.push({
        type: 'workhorse',
        items: workhorses,
        action: 'Improve Margins',
        detail: 'Popular but low profit. Increase price gradually (2-5%), reduce portion cost, use cheaper ingredient substitutes, or bundle with high-margin sides and drinks.',
      });
    }
    if (puzzles.length > 0) {
      recommendations.push({
        type: 'puzzle',
        items: puzzles,
        action: 'Boost Popularity',
        detail: 'High profit but low sales. Rename or rebrand them, improve menu placement, train staff to recommend them, add them to combos, or use better photos/descriptions.',
      });
    }
    if (dogs.length > 0) {
      recommendations.push({
        type: 'dog',
        items: dogs,
        action: 'Re-evaluate or Remove',
        detail: 'Low profit and low sales. Consider removing from the menu, replacing with new items, or significantly reducing ingredient costs. Keep only if they serve a strategic purpose.',
      });
    }

    res.json({ period, startDate, items: result, summary, recommendations });
  } catch (error) {
    console.error('Error fetching menu engineering report:', error);
    res.status(500).json({ error: 'Failed to fetch menu engineering report' });
  }
});

export default router;
