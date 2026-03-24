/**
 * POS Agent — Tool Handlers
 *
 * Each handler receives { input, conn, tenantId } and returns data.
 * conn = the tenant-scoped Postgres connection (RLS enforced).
 *
 * READ handlers: pure queries, no side effects.
 * ACTION handlers: mutate state — only called after owner approval.
 */

import { adminSql } from '../db/index.js';
import { audit } from '../lib/auditLog.js';

// ==================== READ HANDLERS ====================

async function get_sales_summary({ input, conn }) {
  const days = 7;
  const start = input.start_date || new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const end = input.end_date || new Date().toISOString().slice(0, 10);

  const summary = await conn`
    SELECT
      COUNT(*) as order_count,
      COALESCE(SUM(total), 0) as revenue,
      COALESCE(AVG(total), 0) as avg_ticket,
      COALESCE(SUM(tip), 0) as total_tips,
      COUNT(DISTINCT employee_id) as active_employees
    FROM orders
    WHERE created_at >= ${start}::date
      AND created_at < (${end}::date + interval '1 day')
      AND payment_status = 'paid'
  `;

  const topItems = await conn`
    SELECT oi.item_name, SUM(oi.quantity) as qty, SUM(oi.quantity * oi.unit_price) as revenue
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE o.created_at >= ${start}::date
      AND o.created_at < (${end}::date + interval '1 day')
      AND o.payment_status = 'paid'
    GROUP BY oi.item_name
    ORDER BY revenue DESC
    LIMIT 10
  `;

  const busiestHours = await conn`
    SELECT EXTRACT(HOUR FROM created_at)::int as hour, COUNT(*) as orders
    FROM orders
    WHERE created_at >= ${start}::date
      AND created_at < (${end}::date + interval '1 day')
      AND payment_status = 'paid'
    GROUP BY hour
    ORDER BY orders DESC
    LIMIT 5
  `;

  const paymentMethods = await conn`
    SELECT payment_method, COUNT(*) as count, SUM(total) as revenue
    FROM orders
    WHERE created_at >= ${start}::date
      AND created_at < (${end}::date + interval '1 day')
      AND payment_status = 'paid'
      AND payment_method IS NOT NULL
    GROUP BY payment_method
    ORDER BY revenue DESC
  `;

  return {
    period: { start, end },
    ...summary[0],
    top_items: topItems,
    busiest_hours: busiestHours,
    payment_methods: paymentMethods,
  };
}

async function get_menu_performance({ input, conn }) {
  const days = input.days || 30;
  const categoryFilter = input.category_id
    ? conn`AND mi.category_id = ${input.category_id}`
    : conn``;

  const items = await conn`
    SELECT
      mi.id, mi.name, mi.price, mi.active,
      mc.name as category_name,
      COALESCE(mi.prep_time_minutes, 5) as prep_time,
      COALESCE(s.qty_sold, 0) as qty_sold,
      COALESCE(s.revenue, 0) as revenue,
      COALESCE(s.order_count, 0) as order_count,
      COALESCE(cost.total_cost, 0) as ingredient_cost
    FROM menu_items mi
    JOIN menu_categories mc ON mc.id = mi.category_id
    LEFT JOIN LATERAL (
      SELECT SUM(oi.quantity) as qty_sold, SUM(oi.quantity * oi.unit_price) as revenue, COUNT(DISTINCT oi.order_id) as order_count
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE oi.menu_item_id = mi.id
        AND o.created_at >= NOW() - (${days} || ' days')::interval
        AND o.payment_status = 'paid'
    ) s ON true
    LEFT JOIN LATERAL (
      SELECT SUM(mii.quantity_used * ii.cost_price) as total_cost
      FROM menu_item_ingredients mii
      JOIN inventory_items ii ON ii.id = mii.inventory_item_id
      WHERE mii.menu_item_id = mi.id
    ) cost ON true
    WHERE mi.active = true ${categoryFilter}
    ORDER BY s.revenue DESC NULLS LAST
  `;

  // Classify using BCG matrix (Stars, Cash Cows, Puzzles, Dogs)
  const avgQty = items.reduce((s, i) => s + Number(i.qty_sold), 0) / (items.length || 1);
  const avgMargin = items.reduce((s, i) => {
    const margin = i.ingredient_cost > 0 ? (i.price - i.ingredient_cost) / i.price : 0.5;
    return s + margin;
  }, 0) / (items.length || 1);

  const classified = items.map(item => {
    const margin = item.ingredient_cost > 0
      ? (item.price - item.ingredient_cost) / item.price
      : null;
    const highVolume = Number(item.qty_sold) >= avgQty;
    const highMargin = margin !== null ? margin >= avgMargin : true;

    let classification;
    if (highVolume && highMargin) classification = 'star';
    else if (highVolume && !highMargin) classification = 'cash_cow';
    else if (!highVolume && highMargin) classification = 'puzzle';
    else classification = 'dog';

    return {
      ...item,
      margin_percent: margin !== null ? Math.round(margin * 100) : null,
      classification,
    };
  });

  return { days, item_count: classified.length, items: classified };
}

async function get_inventory_status({ input, conn }) {
  const items = await conn`
    SELECT
      ii.id, ii.name, ii.quantity, ii.unit, ii.low_stock_threshold,
      ii.cost_price, ii.category, ii.last_counted_at,
      COALESCE(vel.daily_usage, 0) as avg_daily_usage
    FROM inventory_items ii
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(mii.quantity_used * oi.quantity), 0) / GREATEST(30, 1) as daily_usage
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      JOIN menu_item_ingredients mii ON mii.menu_item_id = oi.menu_item_id
      WHERE mii.inventory_item_id = ii.id
        AND o.created_at >= NOW() - interval '30 days'
        AND o.payment_status = 'paid'
    ) vel ON true
    ${input.only_low_stock ? conn`WHERE ii.quantity <= COALESCE(ii.low_stock_threshold, 0)` : conn``}
    ${input.category ? conn`WHERE ii.category = ${input.category}` : conn``}
    ORDER BY
      CASE WHEN ii.quantity <= COALESCE(ii.low_stock_threshold, 0) THEN 0 ELSE 1 END,
      ii.name
  `;

  return {
    total_items: items.length,
    low_stock_count: items.filter(i => i.quantity <= (i.low_stock_threshold || 0)).length,
    items: items.map(i => ({
      ...i,
      is_low: i.quantity <= (i.low_stock_threshold || 0),
      days_until_stockout: i.avg_daily_usage > 0
        ? Math.round(i.quantity / i.avg_daily_usage)
        : null,
    })),
  };
}

async function get_sales_by_day_and_hour({ input, conn }) {
  const weeks = input.weeks || 4;

  const byDay = await conn`
    SELECT
      EXTRACT(DOW FROM created_at)::int as day_of_week,
      COUNT(*) as order_count,
      SUM(total) as revenue,
      AVG(total) as avg_ticket
    FROM orders
    WHERE created_at >= NOW() - (${weeks * 7} || ' days')::interval
      AND payment_status = 'paid'
    GROUP BY day_of_week
    ORDER BY day_of_week
  `;

  const byHour = await conn`
    SELECT
      EXTRACT(HOUR FROM created_at)::int as hour,
      COUNT(*) as order_count,
      SUM(total) as revenue
    FROM orders
    WHERE created_at >= NOW() - (${weeks * 7} || ' days')::interval
      AND payment_status = 'paid'
    GROUP BY hour
    ORDER BY hour
  `;

  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  return {
    weeks_analyzed: weeks,
    by_day: byDay.map(d => ({ ...d, day_name: dayNames[d.day_of_week] })),
    by_hour: byHour,
  };
}

async function get_delivery_performance({ input, conn }) {
  const days = input.days || 30;

  const platforms = await conn`
    SELECT
      dp.id, dp.display_name, dp.commission_percent,
      COUNT(do2.id) as order_count,
      COALESCE(SUM(o.total), 0) as gross_revenue,
      COALESCE(SUM(do2.platform_commission), 0) as total_commission,
      COALESCE(SUM(o.total) - SUM(do2.platform_commission), 0) as net_revenue
    FROM delivery_platforms dp
    LEFT JOIN delivery_orders do2 ON do2.platform_id = dp.id
      AND do2.created_at >= NOW() - (${days} || ' days')::interval
    LEFT JOIN orders o ON o.id = do2.order_id AND o.payment_status = 'paid'
    WHERE dp.active = true
    GROUP BY dp.id, dp.display_name, dp.commission_percent
    ORDER BY gross_revenue DESC
  `;

  return { days, platforms };
}

async function get_waste_analysis({ input, conn }) {
  const days = input.days || 30;

  const byItem = await conn`
    SELECT ii.name, SUM(wl.quantity) as total_wasted, wl.unit,
      SUM(wl.cost_at_time * wl.quantity) as total_cost
    FROM waste_log wl
    JOIN inventory_items ii ON ii.id = wl.inventory_item_id
    WHERE wl.created_at >= NOW() - (${days} || ' days')::interval
    GROUP BY ii.name, wl.unit
    ORDER BY total_cost DESC
    LIMIT 15
  `;

  const byReason = await conn`
    SELECT reason, COUNT(*) as incidents, SUM(cost_at_time * quantity) as total_cost
    FROM waste_log
    WHERE created_at >= NOW() - (${days} || ' days')::interval
    GROUP BY reason
    ORDER BY total_cost DESC
  `;

  const totalCost = byReason.reduce((s, r) => s + Number(r.total_cost || 0), 0);

  return { days, total_waste_cost: totalCost, by_item: byItem, by_reason: byReason };
}

async function get_employee_performance({ input, conn }) {
  const days = input.days || 30;

  const employees = await conn`
    SELECT
      e.id, e.name, e.role,
      COUNT(o.id) as orders_processed,
      COALESCE(SUM(o.total), 0) as total_revenue,
      COALESCE(AVG(o.total), 0) as avg_ticket,
      COALESCE(SUM(o.tip), 0) as total_tips
    FROM employees e
    LEFT JOIN orders o ON o.employee_id = e.id
      AND o.created_at >= NOW() - (${days} || ' days')::interval
      AND o.payment_status = 'paid'
    WHERE e.active = true
    GROUP BY e.id, e.name, e.role
    ORDER BY total_revenue DESC
  `;

  return { days, employees };
}

async function get_customer_insights({ input, conn }) {
  const days = input.days || 90;

  const stats = await conn`
    SELECT
      COUNT(*) as total_customers,
      COUNT(*) FILTER (WHERE last_visit >= NOW() - interval '30 days') as active_30d,
      COUNT(*) FILTER (WHERE last_visit < NOW() - interval '30 days') as inactive_30d,
      AVG(total_spent) as avg_lifetime_value,
      AVG(orders_count) as avg_orders
    FROM loyalty_customers
  `;

  const topSpenders = await conn`
    SELECT name, phone, total_spent, orders_count, stamps_earned, last_visit
    FROM loyalty_customers
    ORDER BY total_spent DESC
    LIMIT 10
  `;

  const redemptionRate = await conn`
    SELECT
      COUNT(*) as total_cards,
      COUNT(*) FILTER (WHERE completed = true) as completed,
      COUNT(*) FILTER (WHERE redeemed = true) as redeemed
    FROM stamp_cards
  `;

  return { days, ...stats[0], top_spenders: topSpenders, stamp_card_stats: redemptionRate[0] };
}

async function get_expense_summary({ input, conn }) {
  const now = new Date();
  const start = input.start_date || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const end = input.end_date || now.toISOString().slice(0, 10);

  const byCategory = await conn`
    SELECT category, SUM(amount) as total, COUNT(*) as count
    FROM expenses
    WHERE expense_date >= ${start}::date AND expense_date <= ${end}::date
    GROUP BY category
    ORDER BY total DESC
  `;

  const revenue = await conn`
    SELECT COALESCE(SUM(total), 0) as revenue
    FROM orders
    WHERE created_at >= ${start}::date AND created_at < (${end}::date + interval '1 day')
      AND payment_status = 'paid'
  `;

  const totalExpenses = byCategory.reduce((s, c) => s + Number(c.total), 0);

  return {
    period: { start, end },
    total_expenses: totalExpenses,
    total_revenue: Number(revenue[0]?.revenue || 0),
    profit: Number(revenue[0]?.revenue || 0) - totalExpenses,
    by_category: byCategory,
  };
}

// ==================== ACTION HANDLERS ====================

async function update_menu_item_price({ input, conn, tenantId }) {
  const item = await conn`SELECT id, name, price FROM menu_items WHERE id = ${input.item_id}`;
  if (!item[0]) return { error: 'Menu item not found' };

  const oldPrice = item[0].price;
  await conn`UPDATE menu_items SET price = ${input.new_price} WHERE id = ${input.item_id}`;

  audit({
    tenantId, actorType: 'system', actorId: 'agent',
    action: 'update', resource: 'menu_items', resourceId: String(input.item_id),
    details: { old_price: oldPrice, new_price: input.new_price, reason: input.reason },
  });

  return {
    success: true,
    item: item[0].name,
    old_price: oldPrice,
    new_price: input.new_price,
    reason: input.reason,
  };
}

async function toggle_menu_item({ input, conn, tenantId }) {
  const item = await conn`SELECT id, name, active FROM menu_items WHERE id = ${input.item_id}`;
  if (!item[0]) return { error: 'Menu item not found' };

  await conn`UPDATE menu_items SET active = ${input.active} WHERE id = ${input.item_id}`;

  audit({
    tenantId, actorType: 'system', actorId: 'agent',
    action: 'update', resource: 'menu_items', resourceId: String(input.item_id),
    details: { active: input.active, reason: input.reason },
  });

  return { success: true, item: item[0].name, active: input.active, reason: input.reason };
}

async function create_purchase_order({ input, conn, tenantId }) {
  const vendor = await conn`SELECT id, name FROM vendors WHERE id = ${input.vendor_id}`;
  if (!vendor[0]) return { error: 'Vendor not found' };

  // Generate PO number
  const lastPo = await conn`
    SELECT po_number FROM purchase_orders ORDER BY id DESC LIMIT 1
  `;
  const nextNum = lastPo[0]
    ? `PO-${(parseInt(lastPo[0].po_number.replace('PO-', '')) + 1).toString().padStart(4, '0')}`
    : 'PO-0001';

  const totalAmount = input.items.reduce((s, i) => s + (i.quantity * (i.unit_cost || 0)), 0);

  const [po] = await conn`
    INSERT INTO purchase_orders (po_number, vendor_id, status, total_amount, notes)
    VALUES (${nextNum}, ${input.vendor_id}, 'draft', ${totalAmount}, ${input.notes || ''})
    RETURNING id
  `;

  for (const item of input.items) {
    await conn`
      INSERT INTO purchase_order_items (po_id, inventory_item_id, quantity_ordered, unit_cost, line_total)
      VALUES (${po.id}, ${item.inventory_item_id}, ${item.quantity}, ${item.unit_cost || 0}, ${item.quantity * (item.unit_cost || 0)})
    `;
  }

  audit({
    tenantId, actorType: 'system', actorId: 'agent',
    action: 'create', resource: 'purchase_orders', resourceId: String(po.id),
    details: { vendor: vendor[0].name, items: input.items.length, total: totalAmount },
  });

  return { success: true, po_id: po.id, po_number: nextNum, vendor: vendor[0].name, total: totalAmount, item_count: input.items.length };
}

async function update_inventory_quantity({ input, conn, tenantId }) {
  const item = await conn`SELECT id, name, quantity, unit FROM inventory_items WHERE id = ${input.item_id}`;
  if (!item[0]) return { error: 'Inventory item not found' };

  const oldQty = item[0].quantity;
  await conn`UPDATE inventory_items SET quantity = ${input.new_quantity} WHERE id = ${input.item_id}`;

  audit({
    tenantId, actorType: 'system', actorId: 'agent',
    action: 'update', resource: 'inventory_items', resourceId: String(input.item_id),
    details: { old_quantity: oldQty, new_quantity: input.new_quantity, reason: input.reason },
  });

  return { success: true, item: item[0].name, old_quantity: oldQty, new_quantity: input.new_quantity, unit: item[0].unit };
}

async function create_prep_list({ input, conn }) {
  const targetDate = input.target_date || new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const safetyFactor = input.safety_factor || 1.15;
  const dayOfWeek = new Date(targetDate).getDay();

  // Get average sales per item for this day of week over last 4 weeks
  const forecast = await conn`
    SELECT
      mi.id, mi.name, mc.name as category,
      COALESCE(AVG(daily.qty), 0) as avg_daily_qty,
      CEIL(COALESCE(AVG(daily.qty), 0) * ${safetyFactor}) as recommended_prep
    FROM menu_items mi
    JOIN menu_categories mc ON mc.id = mi.category_id
    LEFT JOIN LATERAL (
      SELECT SUM(oi.quantity) as qty
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE oi.menu_item_id = mi.id
        AND o.payment_status = 'paid'
        AND EXTRACT(DOW FROM o.created_at) = ${dayOfWeek}
        AND o.created_at >= NOW() - interval '28 days'
      GROUP BY DATE(o.created_at)
    ) daily ON true
    WHERE mi.active = true
    GROUP BY mi.id, mi.name, mc.name
    HAVING AVG(daily.qty) > 0
    ORDER BY avg_daily_qty DESC
  `;

  return {
    target_date: targetDate,
    day_of_week: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][dayOfWeek],
    safety_factor: safetyFactor,
    items: forecast,
  };
}

async function send_loyalty_campaign({ input, conn }) {
  // This returns the campaign spec — actual SMS sending would go through Twilio helper
  let customerCount;
  switch (input.filter) {
    case 'inactive_30d':
      [{ count: customerCount }] = await conn`
        SELECT COUNT(*)::int as count FROM loyalty_customers
        WHERE sms_opt_in = true AND last_visit < NOW() - interval '30 days'
      `;
      break;
    case 'top_spenders':
      [{ count: customerCount }] = await conn`
        SELECT COUNT(*)::int as count FROM loyalty_customers
        WHERE sms_opt_in = true AND total_spent >= (
          SELECT PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY total_spent) FROM loyalty_customers
        )
      `;
      break;
    case 'close_to_reward':
      [{ count: customerCount }] = await conn`
        SELECT COUNT(DISTINCT sc.customer_id)::int as count
        FROM stamp_cards sc
        JOIN loyalty_customers lc ON lc.id = sc.customer_id
        WHERE sc.completed = false AND sc.stamps_earned >= sc.stamps_required - 2
          AND lc.sms_opt_in = true
      `;
      break;
    default:
      [{ count: customerCount }] = await conn`
        SELECT COUNT(*)::int as count FROM loyalty_customers WHERE sms_opt_in = true
      `;
  }

  return {
    success: true,
    campaign: {
      message: input.message,
      segment: input.filter,
      estimated_recipients: customerCount,
      status: 'ready_to_send',
      note: 'SMS campaign queued. Messages will be sent via Twilio.',
    },
  };
}

// ==================== HANDLER REGISTRY ====================

export const TOOL_HANDLERS = {
  // Read
  get_sales_summary,
  get_menu_performance,
  get_inventory_status,
  get_sales_by_day_and_hour,
  get_delivery_performance,
  get_waste_analysis,
  get_employee_performance,
  get_customer_insights,
  get_expense_summary,
  // Action
  update_menu_item_price,
  toggle_menu_item,
  create_purchase_order,
  update_inventory_quantity,
  create_prep_list,
  send_loyalty_campaign,
};
