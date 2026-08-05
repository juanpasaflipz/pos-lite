// P3 — end of day: counting the line, and where the portions actually went.
//
// The thing that makes this phase worth anything is that a component count
// stops OVERWRITING the number and starts posting the difference. Overwriting
// is what made the old variance report useless: the count silently absorbed
// whatever went missing, so nothing recorded that anything had. Here the
// difference becomes a `count_adjust` ledger row, and that row IS the
// shrinkage the report reads.
//
// Also pinned: raw items and ingredients-mode tenants keep the old overwrite
// behavior byte-for-byte, and the money side (COGS via unitCostForMenuItems)
// is unchanged for tenants who never opted in.

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestTenant,
  dropTestTenant,
  asTenant,
  closePools,
  type TestTenant,
} from './helpers/db.js';
// @ts-ignore — server files are plain JS
import { adminSql } from '../server/db/index.js';
// @ts-ignore
import { updateTenant } from '../server/tenants.js';
// @ts-ignore
import inventoryRouter from '../server/routes/inventory.js';
// @ts-ignore
import prepRunsRouter from '../server/routes/prep-runs.js';
// @ts-ignore
import { unitCostForMenuItems } from '../server/helpers/inventory.js';
// @ts-ignore
import { applyStockDelta } from '../server/helpers/stockLedger.js';
// @ts-ignore
import { JWT_SECRET } from '../server/lib/constants.js';

let twoStage: TestTenant;
let plain: TestTenant;
let tsToken = '';
let plainToken = '';
let tsEmployee = 0;

function appFor(tenant: TestTenant, mode: 'ingredients' | 'two_stage') {
  const app = express();
  app.use(express.json());
  app.use((req: any, res, next) => {
    req.tenant = {
      id: tenant.id, plan: 'pro', inventory_mode: mode, timezone: 'America/Mexico_City',
    };
    void asTenant(tenant.id, () => new Promise<void>((resolve) => {
      res.on('finish', resolve);
      res.on('close', resolve);
      next();
    }));
  });
  app.use('/api/inventory', inventoryRouter);
  app.use('/api/prep-runs', prepRunsRouter);
  return app;
}

async function seedComponent(
  tenantId: string, name: string, qty: number,
  { discardOnClose = false, cost = 10 } = {}
) {
  const [row] = await adminSql`
    INSERT INTO inventory_items
      (tenant_id, name, quantity, unit, cost_price, kind, discard_on_close)
    VALUES (${tenantId}, ${name}, ${qty}, 'porción', ${cost}, 'component', ${discardOnClose})
    RETURNING id
  `;
  return Number(row.id);
}

async function seedRaw(tenantId: string, name: string, qty: number, cost = 100) {
  const [row] = await adminSql`
    INSERT INTO inventory_items (tenant_id, name, quantity, unit, cost_price, kind)
    VALUES (${tenantId}, ${name}, ${qty}, 'kg', ${cost}, 'raw')
    RETURNING id
  `;
  return Number(row.id);
}

async function qtyOf(id: number) {
  const [row] = await adminSql`SELECT quantity FROM inventory_items WHERE id = ${id}`;
  return Number(row.quantity);
}

async function ledgerOf(id: number) {
  const rows = await adminSql`
    SELECT delta, reason FROM portion_ledger WHERE inventory_item_id = ${id} ORDER BY id
  `;
  return rows.map((r: any) => ({ delta: Number(r.delta), reason: r.reason }));
}

beforeAll(async () => {
  twoStage = await createTestTenant('eod-ts');
  plain = await createTestTenant('eod-plain');
  await updateTenant(twoStage.id, { inventory_mode: 'two_stage' });

  const [emp] = await adminSql`
    INSERT INTO employees (tenant_id, name, pin, role, active)
    VALUES (${twoStage.id}, 'EOD Mgr', '9191', 'manager', true) RETURNING id
  `;
  tsEmployee = Number(emp[0]?.id ?? emp.id);
  tsToken = jwt.sign(
    { tenantId: twoStage.id, employeeId: tsEmployee, role: 'manager', type: 'employee' },
    JWT_SECRET, { expiresIn: '24h' }
  );
  const [emp2] = await adminSql`
    INSERT INTO employees (tenant_id, name, pin, role, active)
    VALUES (${plain.id}, 'Plain Mgr', '9292', 'manager', true) RETURNING id
  `;
  plainToken = jwt.sign(
    { tenantId: plain.id, employeeId: Number(emp2.id), role: 'manager', type: 'employee' },
    JWT_SECRET, { expiresIn: '24h' }
  );
}, 90_000);

afterAll(async () => {
  await dropTestTenant(twoStage.id);
  await dropTestTenant(plain.id);
  await closePools();
}, 90_000);

describe('component counts post the difference instead of overwriting', () => {
  it('records the shortfall as count_adjust and moves the cache to match', async () => {
    const id = await seedComponent(twoStage.id, 'Porción asada', 40);

    const res = await request(appFor(twoStage, 'two_stage'))
      .post(`/api/inventory/${id}/count`)
      .set('Authorization', `Bearer ${tsToken}`)
      .send({ counted_quantity: 37, notes: 'cierre' });

    expect(res.status).toBe(200);
    expect(res.body.variance).toBe(-3);
    expect(await qtyOf(id)).toBe(37);

    // The three missing portions are now a fact in the ledger, which is the
    // whole point — the old overwrite left no trace of them.
    const rows = await ledgerOf(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ delta: -3, reason: 'count_adjust' });
  });

  it('handles a surplus the same way', async () => {
    const id = await seedComponent(twoStage.id, 'Porción pollo', 10);
    await request(appFor(twoStage, 'two_stage'))
      .post(`/api/inventory/${id}/count`)
      .set('Authorization', `Bearer ${tsToken}`)
      .send({ counted_quantity: 12 });

    expect(await qtyOf(id)).toBe(12);
    expect(await ledgerOf(id)).toEqual([{ delta: 2, reason: 'count_adjust' }]);
  });

  it('writes no ledger row when the count agrees', async () => {
    const id = await seedComponent(twoStage.id, 'Porción exacta', 15);
    await request(appFor(twoStage, 'two_stage'))
      .post(`/api/inventory/${id}/count`)
      .set('Authorization', `Bearer ${tsToken}`)
      .send({ counted_quantity: 15 });

    expect(await qtyOf(id)).toBe(15);
    expect(await ledgerOf(id)).toHaveLength(0);
  });

  it('leaves the cache reconciled with the ledger after a count', async () => {
    const id = await seedComponent(twoStage.id, 'Porción reconciliada', 0);
    await asTenant(twoStage.id, () => applyStockDelta(null, {
      itemId: id, delta: 20, reason: 'prep_produce',
    }));
    await asTenant(twoStage.id, () => applyStockDelta(null, {
      itemId: id, delta: -5, reason: 'sale',
    }));
    await request(appFor(twoStage, 'two_stage'))
      .post(`/api/inventory/${id}/count`)
      .set('Authorization', `Bearer ${tsToken}`)
      .send({ counted_quantity: 13 });

    const sum = (await ledgerOf(id)).reduce((s, r) => s + r.delta, 0);
    expect(sum).toBe(13);
    expect(await qtyOf(id)).toBe(13);
  });

  it('still overwrites for a raw item — the walk-in keeps its old behavior', async () => {
    const id = await seedRaw(twoStage.id, 'Arrachera cruda', 10);
    await request(appFor(twoStage, 'two_stage'))
      .post(`/api/inventory/${id}/count`)
      .set('Authorization', `Bearer ${tsToken}`)
      .send({ counted_quantity: 8 });

    expect(await qtyOf(id)).toBe(8);
    expect(await ledgerOf(id)).toHaveLength(0);
  });

  it('still overwrites for an ingredients-mode tenant', async () => {
    const id = await seedComponent(plain.id, 'Componente viejo', 20);
    await request(appFor(plain, 'ingredients'))
      .post(`/api/inventory/${id}/count`)
      .set('Authorization', `Bearer ${plainToken}`)
      .send({ counted_quantity: 14 });

    expect(await qtyOf(id)).toBe(14);
    expect(await ledgerOf(id)).toHaveLength(0);
  });
});

describe('GET /api/inventory/eod-summary', () => {
  it('accounts for the day: carryover + produced − sold − waste', async () => {
    const id = await seedComponent(twoStage.id, 'Porción contable', 12);
    // 12 carried over, +30 prepped, −8 sold, −2 wasted → 32 on the line.
    await asTenant(twoStage.id, async () => {
      await applyStockDelta(null, { itemId: id, delta: 30, reason: 'prep_produce' });
      await applyStockDelta(null, { itemId: id, delta: -8, reason: 'sale' });
      await applyStockDelta(null, { itemId: id, delta: -2, reason: 'waste' });
    });

    const res = await request(appFor(twoStage, 'two_stage'))
      .get('/api/inventory/eod-summary')
      .set('Authorization', `Bearer ${tsToken}`);

    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('two_stage');
    const row = res.body.components.find((c: any) => c.inventory_item_id === id);
    expect(row).toMatchObject({ carryover: 12, produced: 30, sold: 8, waste: 2, current: 32 });
    // The arithmetic the kitchen is asked to check has to actually add up.
    expect(row.carryover + row.produced - row.sold - row.waste).toBe(row.expected);
  });

  it('answers with its mode rather than an error for an ingredients tenant', async () => {
    const res = await request(appFor(plain, 'ingredients'))
      .get('/api/inventory/eod-summary')
      .set('Authorization', `Bearer ${plainToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mode: 'ingredients', business_date: null, components: [] });
  });

  it('surfaces which components are meant to be binned at close', async () => {
    const id = await seedComponent(twoStage.id, 'Arroz del día', 6, { discardOnClose: true });
    const res = await request(appFor(twoStage, 'two_stage'))
      .get('/api/inventory/eod-summary')
      .set('Authorization', `Bearer ${tsToken}`);
    const row = res.body.components.find((c: any) => c.inventory_item_id === id);
    expect(row.discard_on_close).toBe(true);
  });
});

describe('POST /api/inventory/:id/discard-close', () => {
  it('bins the remainder and books it as its own reason', async () => {
    const id = await seedComponent(twoStage.id, 'Arroz sobrante', 7, { discardOnClose: true });
    const res = await request(appFor(twoStage, 'two_stage'))
      .post(`/api/inventory/${id}/discard-close`)
      .set('Authorization', `Bearer ${tsToken}`);

    expect(res.status).toBe(200);
    expect(res.body.discarded).toBe(7);
    expect(await qtyOf(id)).toBe(0);
    // Not 'waste' — a planned nightly discard and a dropped tray are different
    // stories, and the variance report needs to tell them apart.
    expect(await ledgerOf(id)).toEqual([{ delta: -7, reason: 'carryover_discard' }]);
  });

  it('is a no-op when nothing is left', async () => {
    const id = await seedComponent(twoStage.id, 'Ya vacío', 0);
    const res = await request(appFor(twoStage, 'two_stage'))
      .post(`/api/inventory/${id}/discard-close`)
      .set('Authorization', `Bearer ${tsToken}`);
    expect(res.status).toBe(200);
    expect(res.body.discarded).toBe(0);
    expect(await ledgerOf(id)).toHaveLength(0);
  });

  it('refuses raw stock — the walk-in is not discarded at close', async () => {
    const id = await seedRaw(twoStage.id, 'Crudo no descartable', 5);
    const res = await request(appFor(twoStage, 'two_stage'))
      .post(`/api/inventory/${id}/discard-close`)
      .set('Authorization', `Bearer ${tsToken}`);
    expect(res.status).toBe(400);
    expect(await qtyOf(id)).toBe(5);
  });

  it('403s an ingredients-mode tenant', async () => {
    const id = await seedComponent(plain.id, 'No aplica', 5);
    const res = await request(appFor(plain, 'ingredients'))
      .post(`/api/inventory/${id}/discard-close`)
      .set('Authorization', `Bearer ${plainToken}`);
    expect(res.status).toBe(403);
    expect(await qtyOf(id)).toBe(5);
  });
});

describe('GET /api/inventory/portion-variance', () => {
  it('reports the count_adjust as the variance, alongside accounted movement', async () => {
    const id = await seedComponent(twoStage.id, 'Porción con merma', 0);
    await asTenant(twoStage.id, async () => {
      await applyStockDelta(null, { itemId: id, delta: 25, reason: 'prep_produce' });
      await applyStockDelta(null, { itemId: id, delta: -10, reason: 'sale' });
      await applyStockDelta(null, { itemId: id, delta: -1, reason: 'waste' });
      await applyStockDelta(null, { itemId: id, delta: -4, reason: 'count_adjust' });
    });

    const res = await request(appFor(twoStage, 'two_stage'))
      .get('/api/inventory/portion-variance?days=7')
      .set('Authorization', `Bearer ${tsToken}`);

    expect(res.status).toBe(200);
    const row = res.body.rows.find((r: any) => r.inventory_item_id === id);
    expect(row).toMatchObject({ produced: 25, sold: 10, waste: 1, variance: -4 });
  });

  it('is inert for an ingredients tenant', async () => {
    const res = await request(appFor(plain, 'ingredients'))
      .get('/api/inventory/portion-variance')
      .set('Authorization', `Bearer ${plainToken}`);
    expect(res.body).toEqual({ mode: 'ingredients', days: [] });
  });
});

describe('GET /api/prep-runs/yield-trends', () => {
  it('reports portions per unit of raw, newest first', async () => {
    const raw = await seedRaw(twoStage.id, 'Arrachera rendimiento', 100, 200);
    const comp = await seedComponent(twoStage.id, 'Porción rendimiento', 0);
    const app = appFor(twoStage, 'two_stage');

    // 10 kg → 38 portions, then 10 kg → 42. The trend is the point.
    for (const portions of [38, 42]) {
      const res = await request(app)
        .post('/api/prep-runs')
        .set('Authorization', `Bearer ${tsToken}`)
        .send({
          inputs: [{ inventory_item_id: raw, quantity: 10 }],
          outputs: [{ inventory_item_id: comp, portions }],
        });
      expect(res.status).toBe(201);
    }

    const res = await request(app)
      .get(`/api/prep-runs/yield-trends?component_id=${comp}`)
      .set('Authorization', `Bearer ${tsToken}`);

    expect(res.status).toBe(200);
    expect(res.body.points).toHaveLength(2);
    const yields = res.body.points.map((p: any) => p.yield_per_unit).sort();
    expect(yields).toEqual([3.8, 4.2]);
    expect(res.body.average_yield).toBeCloseTo(4, 1);
    expect(res.body.points[0].input_unit).toBe('kg');
  });

  it('reports no yield for an inputs-free run — there is nothing to divide by', async () => {
    const comp = await seedComponent(twoStage.id, 'Porción sin insumo', 0);
    const app = appFor(twoStage, 'two_stage');
    await request(app)
      .post('/api/prep-runs')
      .set('Authorization', `Bearer ${tsToken}`)
      .send({ outputs: [{ inventory_item_id: comp, portions: 10 }] });

    const res = await request(app)
      .get(`/api/prep-runs/yield-trends?component_id=${comp}`)
      .set('Authorization', `Bearer ${tsToken}`);
    expect(res.body.points[0].yield_per_unit).toBeNull();
    expect(res.body.average_yield).toBeNull();
  });

  it('requires a component_id', async () => {
    const res = await request(appFor(twoStage, 'two_stage'))
      .get('/api/prep-runs/yield-trends')
      .set('Authorization', `Bearer ${tsToken}`);
    expect(res.status).toBe(400);
  });
});

describe('the money side is unchanged for tenants who never opted in', () => {
  it('computes COGS from ingredient costs exactly as before', async () => {
    // An ingredients-mode recipe: 2 units at $7.50 = $15.00 per plate. This is
    // the number reports.js reads in six places; two-stage must not perturb it.
    const [cat] = await adminSql`
      INSERT INTO menu_categories (tenant_id, name, sort_order)
      VALUES (${plain.id}, 'Cocina', 1) RETURNING id
    `;
    const [item] = await adminSql`
      INSERT INTO menu_items (tenant_id, category_id, name, price, active)
      VALUES (${plain.id}, ${cat.id}, 'Plato costeado', 60, true) RETURNING id
    `;
    const ing = await seedRaw(plain.id, 'Insumo costeado', 100, 7.5);
    await adminSql`
      INSERT INTO menu_item_ingredients (tenant_id, menu_item_id, inventory_item_id, quantity_used)
      VALUES (${plain.id}, ${item.id}, ${ing}, 2)
    `;

    const costs = await asTenant(plain.id, () => unitCostForMenuItems([Number(item.id)]));
    expect(costs.get(Number(item.id))).toBeCloseTo(15, 4);
  });

  it('costs a two-stage plate from its components cost-per-portion', async () => {
    const [cat] = await adminSql`
      INSERT INTO menu_categories (tenant_id, name, sort_order)
      VALUES (${twoStage.id}, 'Cocina', 1) RETURNING id
    `;
    const [item] = await adminSql`
      INSERT INTO menu_items (tenant_id, category_id, name, price, active)
      VALUES (${twoStage.id}, ${cat.id}, 'Burrito costeado', 120, true) RETURNING id
    `;
    const comp = await seedComponent(twoStage.id, 'Porción costeada', 50, { cost: 31 });
    await adminSql`
      INSERT INTO menu_item_ingredients (tenant_id, menu_item_id, inventory_item_id, quantity_used)
      VALUES (${twoStage.id}, ${item.id}, ${comp}, 1)
    `;

    const costs = await asTenant(twoStage.id, () => unitCostForMenuItems([Number(item.id)]));
    // Same helper, same query — the component's cost_price just happens to mean
    // "cost per portion", maintained by prep runs. Plate cost falls out free.
    expect(costs.get(Number(item.id))).toBeCloseTo(31, 4);
  });
});
