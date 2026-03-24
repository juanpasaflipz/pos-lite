import { Router } from 'express';
import { all, get, run, getTenantId } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { getChargeFees } from '../stripe.js';
import { getPlanLimits, planUpgradeError } from '../planLimits.js';

const router = Router();

function getDateRange(period) {
  const now = new Date();
  let startDate;

  switch (period) {
    case 'daily':
    case 'today':
      startDate = new Date(now);
      startDate.setHours(0, 0, 0, 0);
      break;
    case 'weekly':
    case 'week':
      startDate = new Date(now);
      startDate.setDate(now.getDate() - now.getDay());
      startDate.setHours(0, 0, 0, 0);
      break;
    case 'monthly':
    case 'month':
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      break;
    default:
      startDate = new Date(now);
      startDate.setHours(0, 0, 0, 0);
  }

  return startDate.toISOString().split('T')[0];
}

// GET /api/reports/sales - sales summary
router.get('/sales', async (req, res) => {
  try {
    const { period = 'daily' } = req.query;
    const startDate = getDateRange(period);

    const stats = await get(`
      SELECT
        COUNT(*) as order_count,
        ROUND(SUM(subtotal), 2) as total_revenue,
        ROUND(AVG(total), 2) as avg_ticket,
        ROUND(SUM(tip), 2) as tip_total,
        ROUND(SUM(tax), 2) as tax_total
      FROM orders
      WHERE created_at::date >= $1
        AND payment_status = 'paid'
    `, [startDate]);

    res.json({
      period,
      startDate,
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
    const startDate = getDateRange(period);
    const limitNum = Math.min(parseInt(limit) || 10, 100);

    const items = await all(`
      SELECT
        oi.item_name,
        SUM(oi.quantity) as quantity_sold,
        ROUND(SUM(oi.quantity * oi.unit_price), 2) as revenue
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      WHERE o.created_at::date >= $1
        AND o.payment_status = 'paid'
      GROUP BY oi.item_name
      ORDER BY quantity_sold DESC
      LIMIT $2
    `, [startDate, limitNum]);

    res.json(items);
  } catch (error) {
    console.error('Error fetching top items report:', error);
    res.status(500).json({ error: 'Failed to fetch top items report' });
  }
});

// GET /api/reports/employee-performance - sales by employee
router.get('/employee-performance', async (req, res) => {
  try {
    const { period = 'daily' } = req.query;
    const startDate = getDateRange(period);

    const employees = await all(`
      SELECT
        e.id as employee_id,
        e.name as employee_name,
        COUNT(o.id) as orders_processed,
        ROUND(SUM(o.subtotal), 2) as total_sales,
        ROUND(AVG(o.total), 2) as avg_ticket,
        ROUND(SUM(o.tip), 2) as tips_received
      FROM employees e
      LEFT JOIN orders o ON e.id = o.employee_id AND o.created_at::date >= $1 AND o.payment_status = 'paid'
      GROUP BY e.id, e.name
      ORDER BY total_sales DESC
    `, [startDate]);

    res.json(employees);
  } catch (error) {
    console.error('Error fetching employee performance report:', error);
    res.status(500).json({ error: 'Failed to fetch employee performance report' });
  }
});

// GET /api/reports/hourly - orders by hour of day
router.get('/hourly', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];

    const hourly = await all(`
      SELECT
        EXTRACT(HOUR FROM created_at)::int as hour,
        COUNT(*) as orders,
        ROUND(SUM(subtotal), 2) as revenue,
        ROUND(AVG(total), 2) as avg_ticket
      FROM orders
      WHERE created_at::date = $1
        AND payment_status = 'paid'
      GROUP BY hour
      ORDER BY hour ASC
    `, [today]);

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
    const startDate = getDateRange(period);

    const breakdown = await all(`
      SELECT
        payment_method,
        COUNT(*) as count,
        ROUND(SUM(subtotal + tip), 2) as total,
        ROUND(SUM(tip), 2) as tips
      FROM orders
      WHERE created_at::date >= $1
        AND payment_status = 'paid'
        AND payment_method IS NOT NULL
      GROUP BY payment_method
    `, [startDate]);

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
    const startDate = start_date || getDateRange(period);
    const endDate = end_date || new Date().toISOString().split('T')[0];

    // Revenue
    const revRow = await get(`
      SELECT COALESCE(SUM(subtotal), 0) as revenue
      FROM orders
      WHERE created_at::date >= $1 AND created_at::date <= $2
        AND payment_status = 'paid'
    `, [startDate, endDate]);
    const revenue = Number(revRow?.revenue || 0);

    // COGS from order deductions
    const cogsRow = await get(`
      SELECT COALESCE(SUM(mii.quantity_used * oi.quantity * ii.cost_price), 0) as cogs
      FROM order_items oi
      JOIN menu_item_ingredients mii ON oi.menu_item_id = mii.menu_item_id
      JOIN inventory_items ii ON mii.inventory_item_id = ii.id
      JOIN orders o ON oi.order_id = o.id
      WHERE o.created_at::date >= $1 AND o.created_at::date <= $2
        AND o.payment_status = 'paid'
    `, [startDate, endDate]);
    const cogs = Number(cogsRow?.cogs || 0);

    // Waste cost
    let wasteCost = 0;
    try {
      const wasteRow = await get(`
        SELECT COALESCE(SUM(cost_at_time), 0) as waste_cost
        FROM waste_log
        WHERE created_at::date >= $1 AND created_at::date <= $2
      `, [startDate, endDate]);
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
    const startDate = getDateRange(period);

    // Get revenue per menu item
    const items = await all(`
      SELECT
        oi.menu_item_id,
        oi.item_name,
        SUM(oi.quantity) as quantity_sold,
        ROUND(SUM(oi.quantity * oi.unit_price), 2) as revenue
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      WHERE o.created_at::date >= $1
        AND o.payment_status = 'paid'
      GROUP BY oi.menu_item_id, oi.item_name
      ORDER BY revenue DESC
    `, [startDate]);

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
    const startDate = getDateRange(period);

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
      WHERE o.created_at::date >= $1
        AND o.payment_status = 'paid'
      GROUP BY mc.id, mc.name
      ORDER BY revenue DESC
    `, [startDate]);

    const result = [];
    for (const cat of categories) {
      // Get all menu items in this category that were sold
      const catItems = await all(`
        SELECT DISTINCT oi.menu_item_id
        FROM order_items oi
        JOIN orders o ON oi.order_id = o.id
        JOIN menu_items mi ON oi.menu_item_id = mi.id
        WHERE mi.category_id = $1
          AND o.created_at::date >= $2
          AND o.payment_status = 'paid'
      `, [cat.category_id, startDate]);

      let totalCogs = 0;
      for (const item of catItems) {
        const sold = await get(`
          SELECT SUM(oi.quantity) as qty
          FROM order_items oi
          JOIN orders o ON oi.order_id = o.id
          WHERE oi.menu_item_id = $1
            AND o.created_at::date >= $2
            AND o.payment_status = 'paid'
        `, [item.menu_item_id, startDate]);

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
    const startDate = getDateRange(period);

    const dailyRevenue = await all(`
      SELECT
        o.created_at::date as date,
        ROUND(SUM(oi.quantity * oi.unit_price), 2) as revenue,
        COUNT(DISTINCT o.id) as orders
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      WHERE o.created_at::date >= $1
        AND o.payment_status = 'paid'
      GROUP BY o.created_at::date
      ORDER BY date ASC
    `, [startDate]);

    const result = [];
    for (const day of dailyRevenue) {
      // Calculate COGS for all items sold that day
      const dayItems = await all(`
        SELECT oi.menu_item_id, SUM(oi.quantity) as qty
        FROM order_items oi
        JOIN orders o ON oi.order_id = o.id
        WHERE o.created_at::date = $1
          AND o.payment_status = 'paid'
        GROUP BY oi.menu_item_id
      `, [day.date]);

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
    const today = new Date().toISOString().split('T')[0];

    // Today's KPIs
    const kpis = await get(`
      SELECT
        COUNT(*) as order_count,
        ROUND(SUM(subtotal), 2) as revenue,
        ROUND(AVG(total), 2) as avg_ticket,
        ROUND(SUM(tip), 2) as tips,
        SUM(CASE WHEN payment_method = 'cash' THEN 1 ELSE 0 END) as cash_orders,
        SUM(CASE WHEN payment_method = 'card' THEN 1 ELSE 0 END) as card_orders,
        ROUND(SUM(CASE WHEN payment_method = 'cash' THEN subtotal + tip ELSE 0 END), 2) as cash_revenue,
        ROUND(SUM(CASE WHEN payment_method = 'card' THEN subtotal + tip ELSE 0 END), 2) as card_revenue
      FROM orders
      WHERE created_at::date = $1
        AND payment_status = 'paid'
    `, [today]);

    // Hourly trend
    const hourly = await all(`
      SELECT
        EXTRACT(HOUR FROM created_at)::int as hour,
        COUNT(*) as orders,
        ROUND(SUM(subtotal), 2) as revenue
      FROM orders
      WHERE created_at::date = $1
        AND payment_status = 'paid'
      GROUP BY hour
      ORDER BY hour ASC
    `, [today]);

    // Source breakdown
    const sources = await all(`
      SELECT
        COALESCE(source, 'pos') as source,
        COUNT(*) as count,
        ROUND(SUM(subtotal), 2) as revenue
      FROM orders
      WHERE created_at::date = $1
        AND payment_status = 'paid'
      GROUP BY source
    `, [today]);

    // Top 5 items today
    const topItems = await all(`
      SELECT oi.item_name, SUM(oi.quantity) as qty
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      WHERE o.created_at::date = $1
        AND o.payment_status = 'paid'
      GROUP BY oi.item_name
      ORDER BY qty DESC
      LIMIT 5
    `, [today]);

    res.json({
      date: today,
      kpis: kpis || { order_count: 0, revenue: 0, avg_ticket: 0, tips: 0, cash_orders: 0, card_orders: 0, cash_revenue: 0, card_revenue: 0 },
      hourly,
      sources,
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
    const startDate = getDateRange(period);

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
        AND o.created_at::date >= $1
        AND o.payment_status = 'paid'
      GROUP BY dp.id, dp.display_name, dp.commission_percent
    `, [startDate]);

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
    const startDate = getDateRange(period);

    const channels = await all(`
      SELECT
        COALESCE(o.source, 'pos') as channel,
        COUNT(*) as order_count,
        ROUND(SUM(o.subtotal), 2) as revenue,
        ROUND(AVG(o.total), 2) as avg_ticket
      FROM orders o
      WHERE o.created_at::date >= $1
        AND o.payment_status = 'paid'
      GROUP BY o.source
      ORDER BY revenue DESC
    `, [startDate]);

    res.json({ period, startDate, channels });
  } catch (error) {
    console.error('Error fetching channel comparison:', error);
    res.status(500).json({ error: 'Failed to fetch channel comparison' });
  }
});

// GET /api/reports/reconciliation - match DB orders to Stripe charges
router.get('/reconciliation', requireAuth('view_reports'), async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    const startDate = start_date || new Date().toISOString().split('T')[0];
    const endDate = end_date || startDate;

    // Get card orders in range
    const orders = await all(`
      SELECT id, order_number, total, tip, payment_intent_id, payment_status, refund_total
      FROM orders
      WHERE created_at::date >= $1 AND created_at::date <= $2
        AND payment_method = 'card'
        AND payment_intent_id IS NOT NULL
      ORDER BY created_at ASC
    `, [startDate, endDate]);

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

// GET /api/reports/payment-fees - aggregate fee report
router.get('/payment-fees', requireAuth('view_reports'), async (req, res) => {
  try {
    const { period = 'daily' } = req.query;
    const startDate = getDateRange(period);

    const orders = await all(`
      SELECT id, total, tip, payment_intent_id, created_at
      FROM orders
      WHERE created_at::date >= $1
        AND payment_method = 'card'
        AND payment_intent_id IS NOT NULL
        AND payment_status = 'paid'
      ORDER BY created_at ASC
    `, [startDate]);

    let totalGross = 0;
    let totalFees = 0;
    let totalNet = 0;

    const dailyFees = {};
    for (const order of orders) {
      const dateKey = order.created_at.split(' ')[0] || order.created_at.split('T')[0];
      try {
        const fees = await getChargeFees(order.payment_intent_id);
        totalGross += fees.gross;
        totalFees += fees.fee;
        totalNet += fees.net;

        if (!dailyFees[dateKey]) dailyFees[dateKey] = { date: dateKey, gross: 0, fees: 0, net: 0, count: 0 };
        dailyFees[dateKey].gross += fees.gross;
        dailyFees[dateKey].fees += fees.fee;
        dailyFees[dateKey].net += fees.net;
        dailyFees[dateKey].count++;
      } catch {
        // Skip failed Stripe lookups
      }
    }

    const feePercent = totalGross > 0 ? Math.round((totalFees / totalGross) * 10000) / 100 : 0;

    res.json({
      period,
      total_gross: Math.round(totalGross * 100) / 100,
      total_fees: Math.round(totalFees * 100) / 100,
      total_net: Math.round(totalNet * 100) / 100,
      fee_percent: feePercent,
      daily: Object.values(dailyFees),
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
    const startDate = getDateRange(period);

    const summary = await get(`
      SELECT
        COUNT(*) as total_refunds,
        ROUND(SUM(amount), 2) as total_refunded,
        ROUND(AVG(amount), 2) as avg_refund
      FROM refunds
      WHERE created_at::date >= $1
    `, [startDate]);

    const byReason = await all(`
      SELECT
        COALESCE(reason, 'unspecified') as reason,
        COUNT(*) as count,
        ROUND(SUM(amount), 2) as total
      FROM refunds
      WHERE created_at::date >= $1
      GROUP BY reason
      ORDER BY count DESC
    `, [startDate]);

    const byEmployee = await all(`
      SELECT
        e.name as employee_name,
        COUNT(r.id) as refund_count,
        ROUND(SUM(r.amount), 2) as total_refunded
      FROM refunds r
      LEFT JOIN employees e ON r.refunded_by = e.id
      WHERE r.created_at::date >= $1
      GROUP BY r.refunded_by, e.name
      ORDER BY refund_count DESC
    `, [startDate]);

    const daily = await all(`
      SELECT
        created_at::date as date,
        COUNT(*) as count,
        ROUND(SUM(amount), 2) as total
      FROM refunds
      WHERE created_at::date >= $1
      GROUP BY created_at::date
      ORDER BY date ASC
    `, [startDate]);

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
  { key: 'labor', label: 'Labor', auto: false },
  { key: 'rent', label: 'Rent', auto: false },
  { key: 'utilities', label: 'Utilities', auto: false },
  { key: 'stripe_fees', label: 'Stripe Fees', auto: true },
  { key: 'delivery_commissions', label: 'Delivery Commissions', auto: true },
  { key: 'marketing', label: 'Marketing', auto: false },
  { key: 'insurance', label: 'Insurance', auto: false },
  { key: 'supplies', label: 'Supplies/Packaging', auto: false },
];

// GET /api/reports/financial-projection?month=YYYY-MM
router.get('/financial-projection', requireAuth('view_reports'), async (req, res) => {
  try {
    const month = req.query.month || new Date().toISOString().slice(0, 7);
    const startDate = `${month}-01`;
    // End date: last day of month
    const [year, mon] = month.split('-').map(Number);
    const lastDay = new Date(year, mon, 0).getDate();
    const endDate = `${month}-${String(lastDay).padStart(2, '0')}`;

    // Revenue: SUM(subtotal) from paid orders in month
    const revRow = await get(`
      SELECT COALESCE(SUM(subtotal), 0) as revenue
      FROM orders
      WHERE created_at::date >= $1 AND created_at::date <= $2
        AND payment_status = 'paid'
    `, [startDate, endDate]);
    const revenue = revRow?.revenue || 0;

    // Auto-calculate food COGS
    const soldItems = await all(`
      SELECT oi.menu_item_id, SUM(oi.quantity) as qty
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      WHERE o.created_at::date >= $1 AND o.created_at::date <= $2
        AND o.payment_status = 'paid'
      GROUP BY oi.menu_item_id
    `, [startDate, endDate]);

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

    // Auto-calculate Stripe fees
    let stripeFees = 0;
    const cardOrders = await all(`
      SELECT payment_intent_id
      FROM orders
      WHERE created_at::date >= $1 AND created_at::date <= $2
        AND payment_method = 'card'
        AND payment_intent_id IS NOT NULL
        AND payment_status = 'paid'
    `, [startDate, endDate]);

    for (const order of cardOrders) {
      try {
        const fees = await getChargeFees(order.payment_intent_id);
        stripeFees += fees.fee || 0;
      } catch {
        // Skip failed Stripe lookups
      }
    }
    stripeFees = Math.round(stripeFees * 100) / 100;

    // Auto-calculate delivery commissions
    const delRow = await get(`
      SELECT COALESCE(SUM(dor.platform_commission), 0) as total
      FROM delivery_orders dor
      JOIN orders o ON dor.order_id = o.id
      WHERE o.created_at::date >= $1 AND o.created_at::date <= $2
        AND o.payment_status = 'paid'
    `, [startDate, endDate]);
    const deliveryCommissions = Math.round((delRow?.total || 0) * 100) / 100;

    // Cache auto-calculated values (only if not manually overridden)
    const autoValues = { food_cost: foodCost, stripe_fees: stripeFees, delivery_commissions: deliveryCommissions };
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
    const startDate = getDateRange(period);

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
      WHERE o.created_at::date >= $1
        AND o.payment_status = 'paid'
        AND oi.menu_item_id IS NOT NULL
      GROUP BY oi.menu_item_id, oi.item_name, mc.name, mi.price
      ORDER BY quantity_sold DESC
    `, [startDate]);

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
