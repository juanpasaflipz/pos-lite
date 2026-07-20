// AI inventory intelligence tests — routes/ai.js (/api/ai/* backfill).
//
// Invariants guarded here:
//   1. Forecast math: avg_daily_usage divides by ACTIVE days (days with paid
//      orders), risk levels map from days-until-stockout, and suggested
//      reorder targets REORDER_COVER_DAYS of cover above the threshold.
//   2. Only payment_status='paid' orders feed usage — a draft_kiosk order
//      never moves a forecast (mirrors reports.js / org-dashboard).
//   3. RLS scoping: tenant B's identical fixtures never leak into tenant A's
//      insights (all builders run on the tenant-scoped connection).
//   4. The composite insights payload matches the client's InventoryInsights
//      shape (kpis/forecasts/prepForecast/velocityChart/wasteDailyTrend all
//      present, numbers are numbers — the UI calls .toFixed() on them).
//   5. Push/avoid: an out-of-stock ingredient puts its dish in avoidItems +
//      soldOutItemIds and never in pushItems; overstock pushes its dish.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestTenant,
  dropTestTenant,
  asTenant,
  closePools,
  type TestTenant,
} from './helpers/db.js';
// @ts-ignore — server files are plain JS
import { get, run } from '../server/db/index.js';
// @ts-ignore
import {
  buildInventoryForecast,
  buildInventoryInsights,
  buildInventoryPush,
  buildPrepForecast,
  buildVelocityChart,
} from '../server/routes/ai.js';

let tenantA: TestTenant;
let tenantB: TestTenant;

interface Fixture {
  quesoId: number;
  masaId: number;
  sobranteId: number;
  quesadillaId: number;
  sopeId: number;
}
const fx: Record<string, Fixture> = {};

/**
 * Seed one tenant with a small but fully-wired kitchen:
 *   - queso: 10 units on hand, threshold 4, used 2/order      (the risk item)
 *   - masa: 500 on hand, threshold 10, used 1/order           (comfortable)
 *   - sobrante: 90 on hand, threshold 10 (×9 = overstocked), on "Sope"
 *   - agotado: 0 on hand, threshold 2, on "Sope"              (starves Sope)
 *   - 3 paid orders of 2× Quesadilla each across 3 distinct days
 *     → queso usage 12 over 3 active days = 4/day
 *   - 1 unpaid draft order of 50× Quesadilla (must not count)
 *   - waste: 6 units of queso (≥15% rate vs 12 used, cost 300)
 */
async function seedKitchen(tenantId: string): Promise<Fixture> {
  return asTenant(tenantId, async () => {
    const emp = await get(
      `INSERT INTO employees (name, pin, role) VALUES ('AI Test', '0000', 'cashier') RETURNING id`,
    );

    const cat = await get(
      `INSERT INTO menu_categories (name) VALUES ('Antojitos') RETURNING id`,
    );

    const queso = await get(
      `INSERT INTO inventory_items (name, quantity, unit, low_stock_threshold, category, cost_price)
       VALUES ('Queso Oaxaca', 10, 'kg', 4, 'dairy', 50) RETURNING id`,
    );
    const masa = await get(
      `INSERT INTO inventory_items (name, quantity, unit, low_stock_threshold, category, cost_price)
       VALUES ('Masa', 500, 'kg', 10, 'dry', 20) RETURNING id`,
    );
    const sobrante = await get(
      `INSERT INTO inventory_items (name, quantity, unit, low_stock_threshold, category, cost_price)
       VALUES ('Frijol Sobrante', 90, 'kg', 10, 'dry', 30) RETURNING id`,
    );
    const agotado = await get(
      `INSERT INTO inventory_items (name, quantity, unit, low_stock_threshold, category, cost_price)
       VALUES ('Crema Agotada', 0, 'l', 2, 'dairy', 40) RETURNING id`,
    );

    const quesadilla = await get(
      `INSERT INTO menu_items (name, price, category_id, active)
       VALUES ('Quesadilla', 60, $1, true) RETURNING id`,
      [(cat as any).id],
    );
    const sope = await get(
      `INSERT INTO menu_items (name, price, category_id, active)
       VALUES ('Sope', 45, $1, true) RETURNING id`,
      [(cat as any).id],
    );

    // Recipes: Quesadilla = 2 queso + 1 masa; Sope = 1 sobrante + 1 agotado
    for (const [menuId, invId, qty] of [
      [(quesadilla as any).id, (queso as any).id, 2],
      [(quesadilla as any).id, (masa as any).id, 1],
      [(sope as any).id, (sobrante as any).id, 1],
      [(sope as any).id, (agotado as any).id, 1],
    ] as Array<[number, number, number]>) {
      await run(
        `INSERT INTO menu_item_ingredients (menu_item_id, inventory_item_id, quantity_used)
         VALUES ($1, $2, $3)`,
        [menuId, invId, qty],
      );
    }

    // 3 paid orders (2× Quesadilla each) on 3 distinct recent days.
    for (const daysAgo of [1, 2, 3]) {
      const order = await get(
        `INSERT INTO orders
           (order_number, employee_id, status, subtotal, tax, total,
            payment_status, payment_method, created_at, paid_at)
         VALUES ($1, $2, 'completed', 120, 0, 120, 'paid', 'cash',
                 NOW() - make_interval(days => $3), NOW() - make_interval(days => $3))
         RETURNING id`,
        [Date.now() % 1_000_000 + daysAgo, (emp as any).id, daysAgo],
      );
      await run(
        `INSERT INTO order_items (order_id, menu_item_id, item_name, quantity, unit_price)
         VALUES ($1, $2, 'Quesadilla', 2, 60)`,
        [(order as any).id, (quesadilla as any).id],
      );
    }

    // Unpaid draft — must never influence any forecast.
    const draft = await get(
      `INSERT INTO orders (order_number, employee_id, status, subtotal, tax, total, payment_status)
       VALUES ($1, $2, 'draft_kiosk', 3000, 0, 3000, 'unpaid') RETURNING id`,
      [Date.now() % 1_000_000 + 99, (emp as any).id],
    );
    await run(
      `INSERT INTO order_items (order_id, menu_item_id, item_name, quantity, unit_price)
       VALUES ($1, $2, 'Quesadilla', 50, 60)`,
      [(draft as any).id, (quesadilla as any).id],
    );

    // Waste: 6 kg of queso at 50 each → cost 300, rate 6/(6+12) = 33%.
    await run(
      `INSERT INTO waste_log (inventory_item_id, quantity, unit, reason, cost_at_time)
       VALUES ($1, 6, 'kg', 'spoilage', 50)`,
      [(queso as any).id],
    );

    return {
      quesoId: (queso as any).id,
      masaId: (masa as any).id,
      sobranteId: (sobrante as any).id,
      quesadillaId: (quesadilla as any).id,
      sopeId: (sope as any).id,
    };
  });
}

beforeAll(async () => {
  tenantA = await createTestTenant('ai-a');
  tenantB = await createTestTenant('ai-b');
  fx.a = await seedKitchen(tenantA.id);
  fx.b = await seedKitchen(tenantB.id);
}, 120_000);

afterAll(async () => {
  await dropTestTenant(tenantA.id);
  await dropTestTenant(tenantB.id);
  await closePools();
}, 60_000);

describe('inventory forecast', () => {
  it('computes avg daily usage over active days and maps risk levels', async () => {
    const forecasts = await asTenant(tenantA.id, () => buildInventoryForecast());

    const queso = forecasts.find((f: any) => f.inventory_item_id === fx.a.quesoId);
    expect(queso).toBeDefined();
    // 12 used over 3 active days = 4/day; 10 on hand → 2.5 → floor 2 days.
    expect(queso.avg_daily_usage).toBeCloseTo(4, 5);
    expect(queso.days_until_stockout).toBe(2);
    expect(queso.risk_level).toBe('high');
    // Cover 7 days (28) + threshold (4) − on-hand (10) = 22.
    expect(queso.suggested_reorder_qty).toBe(22);
    expect(queso.data_days).toBe(3);

    const masa = forecasts.find((f: any) => f.inventory_item_id === fx.a.masaId);
    expect(masa.risk_level).toBe('low'); // 500 / 2-per-day = 250 days
  });

  it('ignores unpaid orders (the 50-unit draft would flip every risk level)', async () => {
    const forecasts = await asTenant(tenantA.id, () => buildInventoryForecast());
    const queso = forecasts.find((f: any) => f.inventory_item_id === fx.a.quesoId);
    // If the draft counted, usage would be 112/3 ≈ 37/day → critical.
    expect(queso.risk_level).toBe('high');
  });
});

describe('velocity chart', () => {
  it('returns per-day series with numeric quantities', async () => {
    const chart = await asTenant(tenantA.id, () => buildVelocityChart());
    const queso = chart.find((c: any) => c.inventory_item_id === fx.a.quesoId);
    expect(queso).toBeDefined();
    expect(queso.daily).toHaveLength(3);
    expect(queso.total_used).toBeCloseTo(12, 5);
    for (const day of queso.daily) {
      expect(typeof day.quantity_used).toBe('number');
      expect(day.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe('prep forecast', () => {
  it('rejects malformed dates and returns the client shape for valid ones', async () => {
    await expect(
      asTenant(tenantA.id, () => buildPrepForecast('not-a-date')),
    ).rejects.toThrow(/YYYY-MM-DD/);

    const prep = await asTenant(tenantA.id, () => buildPrepForecast());
    expect(prep.target_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(typeof prep.estimated_orders).toBe('number');
    expect(Array.isArray(prep.items)).toBe(true);
    for (const item of prep.items) {
      expect(['restock_needed', 'prep_extra', 'sufficient']).toContain(item.prep_action);
      expect(typeof item.expected_quantity_needed).toBe('number');
    }
  });
});

describe('push / avoid suggestions', () => {
  it('avoids dishes with starved ingredients and pushes overstocked ones', async () => {
    const push = await asTenant(tenantA.id, () => buildInventoryPush());

    // Sope uses Crema Agotada (qty 0) → avoid + soldOut, never pushed
    // (even though it also uses overstocked Frijol Sobrante).
    const sopeAvoid = push.avoidItems.find((i: any) => i.menu_item_id === fx.a.sopeId);
    expect(sopeAvoid).toBeDefined();
    expect(sopeAvoid.reason).toMatch(/out of stock/i);
    expect(push.soldOutItemIds).toContain(fx.a.sopeId);
    expect(push.pushItems.some((i: any) => i.menu_item_id === fx.a.sopeId)).toBe(false);

    // Quesadilla's ingredients are fine → not in avoid.
    expect(push.avoidItems.some((i: any) => i.menu_item_id === fx.a.quesadillaId)).toBe(false);

    // Crema Agotada shows up in lowIngredients.
    expect(push.lowIngredients.some((i: any) => i.name === 'Crema Agotada')).toBe(true);

    // Masa is overstocked (500 ≥ threshold 10 × 3) → Quesadilla gets pushed.
    const quesadillaPush = push.pushItems.find(
      (i: any) => i.menu_item_id === fx.a.quesadillaId,
    );
    expect(quesadillaPush).toBeDefined();
    expect(quesadillaPush.reason).toMatch(/overstocked/i);
    expect(quesadillaPush.ingredient_name).toBe('Masa');
  });
});

describe('composite insights payload', () => {
  it('matches the InventoryInsights client shape with numeric fields', async () => {
    const insights = await asTenant(tenantA.id, () => buildInventoryInsights());

    expect(insights.kpis).toBeDefined();
    for (const key of [
      'itemsAtRisk', 'criticalCount', 'highCount',
      'prepActionsNeeded', 'wasteTrendPercent', 'acceptanceRate',
    ]) {
      expect(typeof (insights.kpis as any)[key]).toBe('number');
    }
    // queso is 'high' risk → at least one item at risk.
    expect(insights.kpis.itemsAtRisk).toBeGreaterThanOrEqual(1);

    expect(Array.isArray(insights.forecasts)).toBe(true);
    expect(Array.isArray(insights.velocityChart)).toBe(true);
    expect(Array.isArray(insights.wasteAlerts)).toBe(true);
    expect(Array.isArray(insights.wasteDailyTrend)).toBe(true);
    expect(insights.prepForecast).toBeDefined();

    // Waste: 300 wasted at 33% rate → alert present with numeric fields.
    const quesoAlert = insights.wasteAlerts.find(
      (a: any) => a.inventory_item_id === fx.a.quesoId,
    );
    expect(quesoAlert).toBeDefined();
    expect(quesoAlert.total_waste_cost).toBeCloseTo(300, 1);
    expect(quesoAlert.waste_rate).toBeGreaterThanOrEqual(0.15);

    // Trend rows are chart-ready.
    for (const day of insights.wasteDailyTrend) {
      expect(typeof day.total_cost).toBe('number');
    }
  });
});

describe('tenant isolation', () => {
  it("tenant A's insights never include tenant B's rows", async () => {
    const insights = await asTenant(tenantA.id, () => buildInventoryInsights());
    const ids = new Set(insights.forecasts.map((f: any) => f.inventory_item_id));
    expect(ids.has(fx.b.quesoId)).toBe(false);
    expect(ids.has(fx.b.masaId)).toBe(false);
    // Same fixture shape on both tenants → identical counts, disjoint ids.
    const insightsB = await asTenant(tenantB.id, () => buildInventoryInsights());
    expect(insightsB.forecasts.length).toBe(insights.forecasts.length);
  });
});
