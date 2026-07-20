/**
 * AI inventory intelligence routes — /api/ai/*
 *
 * Backfills the server side of the client's long-standing /ai surface
 * (src/api/index.ts). The original "AI data pipeline" was removed from
 * pos-lite (see the note at the top of routes/inventory.js) but the
 * InventoryScreen "IA" tab and its types survived — this module rebuilds
 * the endpoints that tab actually consumes, computing everything LIVE from
 * orders × menu_item_ingredients × inventory_items × waste_log. No ai_*
 * tables are required (ai_inventory_velocity et al. were never created).
 *
 * Endpoints:
 *   GET /api/ai/inventory-insights          → InventoryInsights (the IA tab)
 *   GET /api/ai/inventory-forecast          → InventoryForecast[]
 *   GET /api/ai/prep-forecast?date=YYYY-MM-DD → PrepForecast
 *   GET /api/ai/suggestions/inventory-push  → InventoryPushData
 *
 * Response shapes mirror src/types/index.ts (InventoryInsights,
 * InventoryForecast, PrepForecast, InventoryPushData). Every numeric field
 * is coerced with num() — postgres.js returns NUMERIC aggregates as strings
 * and the UI calls .toFixed() on several fields.
 *
 * Conventions honored:
 *   - Tenant middleware owns the transaction; no BEGIN/COMMIT here.
 *   - Only payment_status='paid' orders count (reports.js convention).
 *   - Column-drift tolerant: expiry_date may not exist on inventory_items
 *     (same defensive pattern as routes/inventory.js).
 *   - Plan-gated: free plan (ai.mode 'none') gets 403 PLAN_UPGRADE_REQUIRED.
 *
 * i18n caveat: reason/message strings generated here are English, matching
 * existing server-generated text (e.g. shrinkage alert messages). A proper
 * i18n pass would move these to client-side keys.
 */

import { Router } from 'express';
import { all, get, run } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { getPlanLimits, planUpgradeError } from '../planLimits.js';

const router = Router();

// Tuning knobs
const WINDOW_DAYS = 14;            // velocity / waste lookback
const DOW_WINDOW_DAYS = 28;        // prep forecast same-weekday lookback
const VELOCITY_CHART_ITEMS = 8;    // top-N ingredients on the velocity chart
const REORDER_COVER_DAYS = 7;      // suggested reorder covers this many days
const PREP_EXTRA_BUFFER = 1.25;    // stock below expected×buffer → prep_extra
const WASTE_RATE_ALERT = 0.15;     // ≥15% of handled qty wasted → alert
const WASTE_COST_FLOOR = 50;       // ...and at least this much $ wasted
const OVERSTOCK_RATIO = 3;         // qty ≥ threshold×3 → overstocked
const EXPIRY_PUSH_DAYS = 3;        // expiring within N days → push its dishes
const PUSH_AVOID_LIMIT = 6;
const FORECAST_LIMIT = 50;

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const num = (v) => (v == null ? 0 : Number(v));
const round1 = (v) => Math.round(num(v) * 10) / 10;
const round2 = (v) => Math.round(num(v) * 100) / 100;

// ==================== Plan gate ====================

function requireAiPlan(req, res, next) {
  const plan = req.tenant?.plan || 'free';
  if (getPlanLimits(plan).ai.mode === 'none') {
    // Explicit requiredPlan: getRequiredPlan()'s string heuristic treats
    // mode:'none' as an unlocked value and would report 'free' here.
    return res.status(403).json(planUpgradeError('ai', plan, { requiredPlan: 'pro' }));
  }
  next();
}

router.use(requireAiPlan);

// ==================== Column drift ====================

// expiry_date landed on some databases outside the migration chain; tolerate
// its absence exactly like routes/inventory.js does.
let expiryColumnPromise = null;
function hasExpiryColumn() {
  if (!expiryColumnPromise) {
    expiryColumnPromise = get(`
      SELECT 1 AS present
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'inventory_items'
        AND column_name = 'expiry_date'
    `).then((row) => Boolean(row?.present)).catch(() => false);
  }
  return expiryColumnPromise;
}

// ==================== Builders (exported for tests) ====================

/**
 * Days (within the window) on which the tenant actually had paid orders.
 * Dividing usage by this — not by calendar days — keeps avg_daily_usage
 * honest for restaurants that close some days.
 */
async function getActiveDays(windowDays = WINDOW_DAYS) {
  const row = await get(`
    SELECT COUNT(DISTINCT DATE(created_at))::int AS days
    FROM orders
    WHERE payment_status = 'paid'
      AND created_at >= NOW() - make_interval(days => $1)
  `, [windowDays]);
  return Math.max(num(row?.days), 1);
}

/** Per-ingredient usage over the window: total + per-day rows. */
async function getUsageRows(windowDays = WINDOW_DAYS) {
  return all(`
    SELECT mii.inventory_item_id,
           ii.name,
           to_char(DATE(o.created_at), 'YYYY-MM-DD') AS date,
           SUM(mii.quantity_used * oi.quantity) AS quantity_used,
           COUNT(DISTINCT o.id)::int AS orders_count
    FROM orders o
    JOIN order_items oi ON oi.order_id = o.id
    JOIN menu_item_ingredients mii ON mii.menu_item_id = oi.menu_item_id
    JOIN inventory_items ii ON ii.id = mii.inventory_item_id
    WHERE o.payment_status = 'paid'
      AND o.created_at >= NOW() - make_interval(days => $1)
    GROUP BY mii.inventory_item_id, ii.name, DATE(o.created_at)
    ORDER BY mii.inventory_item_id, date
  `, [windowDays]);
}

/** InventoryForecast[] — stockout risk + suggested reorder per ingredient. */
export async function buildInventoryForecast() {
  const activeDays = await getActiveDays();
  const rows = await all(`
    SELECT ii.id, ii.name, ii.quantity, ii.unit, ii.category,
           COALESCE(ii.low_stock_threshold, 0) AS low_stock_threshold,
           COALESCE(u.total_used, 0) AS total_used
    FROM inventory_items ii
    LEFT JOIN (
      SELECT mii.inventory_item_id,
             SUM(mii.quantity_used * oi.quantity) AS total_used
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
      JOIN menu_item_ingredients mii ON mii.menu_item_id = oi.menu_item_id
      WHERE o.payment_status = 'paid'
        AND o.created_at >= NOW() - make_interval(days => $1)
      GROUP BY mii.inventory_item_id
    ) u ON u.inventory_item_id = ii.id
    WHERE COALESCE(u.total_used, 0) > 0
       OR ii.quantity <= COALESCE(ii.low_stock_threshold, 0)
    ORDER BY ii.name
    LIMIT $2
  `, [WINDOW_DAYS, FORECAST_LIMIT]);

  const forecasts = rows.map((r) => {
    const quantity = num(r.quantity);
    const threshold = num(r.low_stock_threshold);
    const avg = round2(num(r.total_used) / activeDays);

    let daysUntilStockout = null;
    let daysUntilLow = null;
    let suggestedReorder = null;
    let risk = 'unknown';
    let message;

    if (avg > 0) {
      daysUntilStockout = Math.max(0, Math.floor(quantity / avg));
      daysUntilLow = quantity > threshold
        ? Math.max(0, Math.floor((quantity - threshold) / avg))
        : 0;
      const target = avg * REORDER_COVER_DAYS + threshold;
      const shortfall = Math.ceil(target - quantity);
      suggestedReorder = shortfall > 0 ? shortfall : null;

      if (daysUntilStockout <= 1) risk = 'critical';
      else if (daysUntilStockout <= 3) risk = 'high';
      else if (daysUntilStockout <= REORDER_COVER_DAYS) risk = 'medium';
      else risk = 'low';
    } else if (quantity <= threshold) {
      risk = 'medium';
      message = 'Below low-stock threshold; no recent usage data to forecast';
    }

    return {
      inventory_item_id: r.id,
      name: r.name,
      current_quantity: quantity,
      unit: r.unit || '',
      category: r.category || '',
      avg_daily_usage: avg,
      days_until_stockout: daysUntilStockout,
      days_until_low: daysUntilLow,
      suggested_reorder_qty: suggestedReorder,
      risk_level: risk,
      data_days: activeDays,
      ...(message ? { message } : {}),
    };
  });

  const riskOrder = { critical: 0, high: 1, medium: 2, low: 3, unknown: 4 };
  forecasts.sort((a, b) =>
    (riskOrder[a.risk_level] - riskOrder[b.risk_level])
    || ((a.days_until_stockout ?? Infinity) - (b.days_until_stockout ?? Infinity)));
  return forecasts;
}

/** VelocityChartItem[] — top ingredients by usage, daily series. */
export async function buildVelocityChart() {
  const rows = await getUsageRows();
  const byItem = new Map();
  for (const r of rows) {
    let entry = byItem.get(r.inventory_item_id);
    if (!entry) {
      entry = { inventory_item_id: r.inventory_item_id, name: r.name, total_used: 0, daily: [] };
      byItem.set(r.inventory_item_id, entry);
    }
    const qty = round2(r.quantity_used);
    entry.total_used = round2(entry.total_used + qty);
    entry.daily.push({ date: r.date, quantity_used: qty, orders_count: num(r.orders_count) });
  }
  return Array.from(byItem.values())
    .sort((a, b) => b.total_used - a.total_used)
    .slice(0, VELOCITY_CHART_ITEMS);
}

/** PrepForecast — expected ingredient demand for a target date's weekday. */
export async function buildPrepForecast(dateStr) {
  const targetDate = dateStr || new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate) || Number.isNaN(Date.parse(`${targetDate}T00:00:00Z`))) {
    const err = new Error('Invalid date — expected YYYY-MM-DD');
    err.status = 400;
    throw err;
  }
  const dayOfWeek = new Date(`${targetDate}T00:00:00Z`).getUTCDay();

  const [ordersRow, ingredientRows, menuRows, activeDays] = await Promise.all([
    get(`
      SELECT COALESCE(AVG(c), 0) AS avg_orders
      FROM (
        SELECT DATE(created_at) AS d, COUNT(*)::int AS c
        FROM orders
        WHERE payment_status = 'paid'
          AND EXTRACT(DOW FROM created_at) = $1
          AND created_at >= NOW() - make_interval(days => $2)
        GROUP BY DATE(created_at)
      ) t
    `, [dayOfWeek, DOW_WINDOW_DAYS]),
    all(`
      SELECT mii.inventory_item_id,
             ii.name AS item_name,
             ii.unit,
             ii.quantity AS current_stock,
             SUM(mii.quantity_used * oi.quantity)
               / GREATEST(COUNT(DISTINCT DATE(o.created_at)), 1) AS expected_qty
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
      JOIN menu_item_ingredients mii ON mii.menu_item_id = oi.menu_item_id
      JOIN inventory_items ii ON ii.id = mii.inventory_item_id
      WHERE o.payment_status = 'paid'
        AND EXTRACT(DOW FROM o.created_at) = $1
        AND o.created_at >= NOW() - make_interval(days => $2)
      GROUP BY mii.inventory_item_id, ii.name, ii.unit, ii.quantity
      ORDER BY expected_qty DESC
    `, [dayOfWeek, DOW_WINDOW_DAYS]),
    all(`
      SELECT mii.inventory_item_id,
             mi.name AS menu_item_name,
             mii.quantity_used AS ingredient_per_item,
             SUM(oi.quantity)
               / GREATEST(COUNT(DISTINCT DATE(o.created_at)), 1) AS avg_sold
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
      JOIN menu_item_ingredients mii ON mii.menu_item_id = oi.menu_item_id
      JOIN menu_items mi ON mi.id = mii.menu_item_id
      WHERE o.payment_status = 'paid'
        AND EXTRACT(DOW FROM o.created_at) = $1
        AND o.created_at >= NOW() - make_interval(days => $2)
      GROUP BY mii.inventory_item_id, mi.name, mii.quantity_used
    `, [dayOfWeek, DOW_WINDOW_DAYS]),
    getActiveDays(),
  ]);

  const menuByIngredient = new Map();
  for (const m of menuRows) {
    const list = menuByIngredient.get(m.inventory_item_id) || [];
    list.push({
      menu_item_name: m.menu_item_name,
      avg_sold: round1(m.avg_sold),
      ingredient_per_item: round2(m.ingredient_per_item),
    });
    menuByIngredient.set(m.inventory_item_id, list);
  }

  const items = ingredientRows
    .filter((r) => num(r.expected_qty) > 0)
    .map((r) => {
      const expected = round2(r.expected_qty);
      const stock = num(r.current_stock);
      let prepAction = 'sufficient';
      if (stock < expected) prepAction = 'restock_needed';
      else if (stock < expected * PREP_EXTRA_BUFFER) prepAction = 'prep_extra';
      return {
        inventory_item_id: r.inventory_item_id,
        item_name: r.item_name,
        unit: r.unit || '',
        expected_quantity_needed: expected,
        current_stock: stock,
        deficit: round2(expected - stock),
        prep_action: prepAction,
        velocity_estimate: round2(expected),
        menu_items_using: (menuByIngredient.get(r.inventory_item_id) || [])
          .sort((a, b) => b.avg_sold - a.avg_sold)
          .slice(0, 5),
      };
    });

  return {
    target_date: targetDate,
    day_of_week: DAY_NAMES[dayOfWeek],
    estimated_orders: Math.round(num(ordersRow?.avg_orders)),
    items,
    // Not part of the client type, but handy context for the agent/tests:
    data_days: activeDays,
  };
}

/** Waste trend, alerts, and week-over-week percent. */
export async function buildWasteIntelligence(usageByItem = new Map()) {
  const [trendRows, alertRows, wowRow] = await Promise.all([
    all(`
      SELECT to_char(DATE(created_at), 'YYYY-MM-DD') AS date,
             SUM(cost_at_time * quantity) AS total_cost,
             COUNT(*)::int AS entry_count
      FROM waste_log
      WHERE created_at >= NOW() - make_interval(days => $1)
      GROUP BY DATE(created_at)
      ORDER BY date
    `, [WINDOW_DAYS]),
    all(`
      SELECT wl.inventory_item_id,
             ii.name AS item_name,
             SUM(wl.quantity) AS wasted_qty,
             SUM(wl.cost_at_time * wl.quantity) AS total_waste_cost,
             MODE() WITHIN GROUP (ORDER BY wl.reason) AS top_reason
      FROM waste_log wl
      JOIN inventory_items ii ON ii.id = wl.inventory_item_id
      WHERE wl.created_at >= NOW() - make_interval(days => $1)
      GROUP BY wl.inventory_item_id, ii.name
    `, [WINDOW_DAYS]),
    get(`
      SELECT COALESCE(SUM(cost_at_time * quantity)
               FILTER (WHERE created_at >= NOW() - interval '7 days'), 0) AS cur,
             COALESCE(SUM(cost_at_time * quantity)
               FILTER (WHERE created_at < NOW() - interval '7 days'), 0) AS prev
      FROM waste_log
      WHERE created_at >= NOW() - interval '14 days'
    `),
  ]);

  const wasteDailyTrend = trendRows.map((r) => ({
    date: r.date,
    total_cost: round2(r.total_cost),
    entry_count: num(r.entry_count),
  }));

  const wasteAlerts = alertRows
    .map((r) => {
      const wasted = num(r.wasted_qty);
      const used = num(usageByItem.get(r.inventory_item_id));
      const handled = wasted + used;
      const rate = handled > 0 ? wasted / handled : 0;
      return {
        type: 'high_waste_rate',
        inventory_item_id: r.inventory_item_id,
        item_name: r.item_name,
        waste_rate: round2(rate),
        total_waste_cost: round2(r.total_waste_cost),
        top_reason: r.top_reason || undefined,
        message: `${Math.round(rate * 100)}% of ${r.item_name} handled in the last ${WINDOW_DAYS} days ended as waste`,
      };
    })
    .filter((a) => a.waste_rate >= WASTE_RATE_ALERT && a.total_waste_cost >= WASTE_COST_FLOOR)
    .sort((a, b) => b.total_waste_cost - a.total_waste_cost)
    .slice(0, 5);

  const cur = num(wowRow?.cur);
  const prev = num(wowRow?.prev);
  const wasteTrendPercent = prev > 0
    ? Math.round(((cur - prev) / prev) * 100)
    : (cur > 0 ? 100 : 0);

  return { wasteDailyTrend, wasteAlerts, wasteTrendPercent };
}

/** InventoryPushData — dishes to push (overstock/expiring) and to avoid (low/out). */
export async function buildInventoryPush() {
  const expiryOk = await hasExpiryColumn();

  const lowRows = await all(`
    SELECT id, name, quantity, unit, COALESCE(low_stock_threshold, 0) AS low_stock_threshold
    FROM inventory_items
    WHERE quantity <= COALESCE(low_stock_threshold, 0)
    ORDER BY quantity ASC
    LIMIT 20
  `);

  const avoidRows = await all(`
    SELECT mi.id AS menu_item_id, mi.name, mi.price, mi.category_id,
           mc.name AS category_name,
           ii.name AS ingredient_name, ii.quantity AS ing_qty
    FROM menu_items mi
    JOIN menu_categories mc ON mc.id = mi.category_id
    JOIN menu_item_ingredients mii ON mii.menu_item_id = mi.id
    JOIN inventory_items ii ON ii.id = mii.inventory_item_id
    WHERE mi.active = true
      AND ii.quantity <= COALESCE(ii.low_stock_threshold, 0)
    ORDER BY ii.quantity ASC
  `);

  // NULLIF guards against legacy empty-string expiry values (column is TEXT
  // on some databases); a bad cast here would 500 the whole endpoint.
  const expiryClause = expiryOk
    ? `OR (NULLIF(ii.expiry_date::text, '') IS NOT NULL
           AND NULLIF(ii.expiry_date::text, '')::date <= CURRENT_DATE + make_interval(days => $1)
           AND ii.quantity > 0)`
    : '';
  const pushRows = await all(`
    SELECT mi.id AS menu_item_id, mi.name, mi.price, mi.category_id,
           mc.name AS category_name,
           ii.name AS ingredient_name,
           ${expiryOk
             ? `CASE WHEN NULLIF(ii.expiry_date::text, '') IS NOT NULL
                       AND NULLIF(ii.expiry_date::text, '')::date <= CURRENT_DATE + make_interval(days => $1)
                     THEN 'expiring' ELSE 'overstock' END`
             : `'overstock'`} AS push_kind
    FROM menu_items mi
    JOIN menu_categories mc ON mc.id = mi.category_id
    JOIN menu_item_ingredients mii ON mii.menu_item_id = mi.id
    JOIN inventory_items ii ON ii.id = mii.inventory_item_id
    WHERE mi.active = true
      AND (
        (COALESCE(ii.low_stock_threshold, 0) > 0
         AND ii.quantity >= ii.low_stock_threshold * ${OVERSTOCK_RATIO})
        ${expiryClause}
      )
  `, expiryOk ? [EXPIRY_PUSH_DAYS] : []);

  // Collapse to one row per menu item, worst ingredient first.
  const avoidByItem = new Map();
  for (const r of avoidRows) {
    if (!avoidByItem.has(r.menu_item_id)) {
      avoidByItem.set(r.menu_item_id, {
        menu_item_id: r.menu_item_id,
        name: r.name,
        price: num(r.price),
        category_id: r.category_id,
        category_name: r.category_name,
        reason: num(r.ing_qty) <= 0 ? 'Ingredient out of stock' : 'Ingredient running low',
        ingredient_name: r.ingredient_name,
        _soldOut: num(r.ing_qty) <= 0,
      });
    } else if (num(r.ing_qty) <= 0) {
      const entry = avoidByItem.get(r.menu_item_id);
      entry._soldOut = true;
      entry.reason = 'Ingredient out of stock';
      entry.ingredient_name = r.ingredient_name;
    }
  }

  const pushByItem = new Map();
  for (const r of pushRows) {
    if (avoidByItem.has(r.menu_item_id)) continue; // never push a starved dish
    const existing = pushByItem.get(r.menu_item_id);
    if (!existing || (r.push_kind === 'expiring' && existing._kind !== 'expiring')) {
      pushByItem.set(r.menu_item_id, {
        menu_item_id: r.menu_item_id,
        name: r.name,
        price: num(r.price),
        category_id: r.category_id,
        category_name: r.category_name,
        reason: r.push_kind === 'expiring'
          ? 'Uses an ingredient expiring soon'
          : 'Uses an overstocked ingredient',
        ingredient_name: r.ingredient_name,
        _kind: r.push_kind,
      });
    }
  }

  const avoidItems = Array.from(avoidByItem.values());
  const strip = ({ _soldOut, _kind, ...item }) => item;

  return {
    pushItems: Array.from(pushByItem.values()).slice(0, PUSH_AVOID_LIMIT).map(strip),
    avoidItems: avoidItems.slice(0, PUSH_AVOID_LIMIT).map(strip),
    lowIngredients: lowRows.slice(0, 10).map((r) => ({
      id: r.id,
      name: r.name,
      quantity: num(r.quantity),
      unit: r.unit || '',
      low_stock_threshold: num(r.low_stock_threshold),
    })),
    soldOutItemIds: avoidItems.filter((i) => i._soldOut).map((i) => i.menu_item_id),
    lowStockItemIds: avoidItems.filter((i) => !i._soldOut).map((i) => i.menu_item_id),
  };
}

/** The full InventoryInsights payload for the IA tab. */
export async function buildInventoryInsights() {
  const [forecasts, velocityChart, prepForecast, push] = await Promise.all([
    buildInventoryForecast(),
    buildVelocityChart(),
    buildPrepForecast(),
    buildInventoryPush(),
  ]);

  // Usage map for waste-rate math must cover ALL ingredients with usage, not
  // just the top-N charted ones — otherwise lightly-used items divide by ~0
  // and false-fire the waste alert. Reconstruct totals from the forecasts.
  const usageByItem = new Map(
    forecasts
      .filter((f) => f.avg_daily_usage > 0)
      .map((f) => [f.inventory_item_id, f.avg_daily_usage * f.data_days]));
  const { wasteDailyTrend, wasteAlerts, wasteTrendPercent } =
    await buildWasteIntelligence(usageByItem);

  const criticalCount = forecasts.filter((f) => f.risk_level === 'critical').length;
  const highCount = forecasts.filter((f) => f.risk_level === 'high').length;

  // Suggestion acceptance = of kiosk suggestions shown, the share that
  // converted to an order over the last 30d. Fed by the kiosk telemetry loop
  // (kiosk_suggestion_events; RLS scopes rows to this tenant). Whole percent
  // for the KPI card; 0 when there's no data yet (nothing shown).
  const acceptRows = await all(`
    SELECT
      count(*) FILTER (WHERE event_type = 'shown')   AS shown,
      count(*) FILTER (WHERE event_type = 'ordered') AS ordered
    FROM kiosk_suggestion_events
    WHERE created_at >= NOW() - INTERVAL '30 days'
  `);
  const shownCount = Number(acceptRows?.[0]?.shown) || 0;
  const orderedCount = Number(acceptRows?.[0]?.ordered) || 0;
  const acceptanceRate = shownCount > 0 ? Math.round((orderedCount / shownCount) * 100) : 0;

  return {
    kpis: {
      itemsAtRisk: criticalCount + highCount,
      criticalCount,
      highCount,
      prepActionsNeeded: prepForecast.items.filter((i) => i.prep_action !== 'sufficient').length,
      wasteTrendPercent,
      acceptanceRate,
    },
    forecasts,
    prepForecast,
    velocityChart,
    wasteAlerts,
    pushItems: push.pushItems,
    avoidItems: push.avoidItems,
    wasteDailyTrend,
  };
}

// ==================== Routes ====================

router.get('/inventory-insights', async (_req, res) => {
  try {
    res.json(await buildInventoryInsights());
  } catch (error) {
    console.error('Error building inventory insights:', error);
    res.status(500).json({ error: 'Failed to build inventory insights' });
  }
});

router.get('/inventory-forecast', async (_req, res) => {
  try {
    res.json(await buildInventoryForecast());
  } catch (error) {
    console.error('Error building inventory forecast:', error);
    res.status(500).json({ error: 'Failed to build inventory forecast' });
  }
});

router.get('/prep-forecast', async (req, res) => {
  try {
    res.json(await buildPrepForecast(req.query.date));
  } catch (error) {
    if (error.status === 400) return res.status(400).json({ error: error.message });
    console.error('Error building prep forecast:', error);
    res.status(500).json({ error: 'Failed to build prep forecast' });
  }
});

router.get('/suggestions/inventory-push', async (_req, res) => {
  try {
    res.json(await buildInventoryPush());
  } catch (error) {
    console.error('Error building inventory push suggestions:', error);
    res.status(500).json({ error: 'Failed to build inventory push suggestions' });
  }
});

// Category roles power the KDS station filter (Todo/Cocina/Bar). The client
// has called GET /ai/category-roles since the beginning (silently ignoring
// the 404), and migration 0088 codified the ai_category_roles table — this
// closes the loop. Roles: e.g. 'kitchen' | 'bar' (free-form text; the KDS
// filter matches on the stored string).
router.get('/category-roles', async (_req, res) => {
  try {
    const rows = await all(`
      SELECT acr.id, acr.category_id, acr.role, mc.name AS category_name
      FROM ai_category_roles acr
      JOIN menu_categories mc ON mc.id = acr.category_id
      ORDER BY mc.name
    `);
    res.json(rows);
  } catch (error) {
    console.error('Error fetching category roles:', error);
    res.status(500).json({ error: 'Failed to fetch category roles' });
  }
});

router.put('/category-roles/:categoryId', requireAuth('manage_menu'), async (req, res) => {
  try {
    const categoryId = Number(req.params.categoryId);
    const role = typeof req.body?.role === 'string' ? req.body.role.trim() : '';
    if (!Number.isInteger(categoryId) || !role) {
      return res.status(400).json({ error: 'categoryId and role are required' });
    }
    const category = await get('SELECT id FROM menu_categories WHERE id = $1', [categoryId]);
    if (!category) return res.status(404).json({ error: 'Category not found' });

    await run(`
      INSERT INTO ai_category_roles (category_id, role)
      VALUES ($1, $2)
      ON CONFLICT (tenant_id, category_id) DO UPDATE SET role = EXCLUDED.role
    `, [categoryId, role]);
    res.json({ category_id: categoryId, role });
  } catch (error) {
    console.error('Error updating category role:', error);
    res.status(500).json({ error: 'Failed to update category role' });
  }
});

export default router;
