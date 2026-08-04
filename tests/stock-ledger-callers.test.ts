// The two mutators migrated onto portion_ledger in P1: receipt→stock
// (applyInventoryMatches, reached through POST /api/expenses) and waste
// (POST /api/waste).
//
// Both paths existed before the ledger and had NO test coverage at all, which
// is why these tests are written against observable behavior rather than the
// refactor: the point is to prove the split of "quantity moves through
// applyStockDelta" from "cost_price still uses the weighted average" did not
// change a single number the operator sees.
//
// The weighted-average cost math (unchanged) is the part worth staring at:
// buying 10 units at $12 on top of 10 units held at $10 must land at $11, and
// restocking an item that was at zero must RESET the cost rather than blend it.

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
import { adminSql, get, all } from '../server/db/index.js';
// @ts-ignore
import expensesRouter from '../server/routes/expenses.js';
// @ts-ignore
import wasteRouter from '../server/routes/waste.js';
// @ts-ignore
import { JWT_SECRET } from '../server/lib/constants.js';

let tenant: TestTenant;
let managerId = 0;
let managerToken = '';

function appForTenant(tenantId: string, plan = 'pro') {
  const app = express();
  app.use(express.json());
  app.use((req: any, res, next) => {
    req.tenant = { id: tenantId, plan };
    // Reproduces tenantMiddleware: an RLS-scoped connection on
    // AsyncLocalStorage, so the routers' get()/run() and applyStockDelta hit
    // the tenant pool inside one BEGIN/COMMIT instead of falling back to
    // adminSql.
    void asTenant(tenantId, () => new Promise<void>((resolve) => {
      res.on('finish', resolve);
      res.on('close', resolve);
      next();
    }));
  });
  app.use('/api/expenses', expensesRouter);
  app.use('/api/waste', wasteRouter);
  return app;
}

async function seedItem(name: string, quantity: number, costPrice: number): Promise<number> {
  const [row] = await adminSql`
    INSERT INTO inventory_items (tenant_id, name, quantity, unit, cost_price, kind)
    VALUES (${tenant.id}, ${name}, ${quantity}, 'kg', ${costPrice}, 'raw')
    RETURNING id
  `;
  return Number(row.id);
}

async function itemRow(id: number) {
  const [row] = await adminSql`SELECT quantity, cost_price FROM inventory_items WHERE id = ${id}`;
  return { quantity: Number(row.quantity), cost_price: Number(row.cost_price) };
}

async function ledgerFor(itemId: number) {
  const rows = await adminSql`
    SELECT delta, reason, ref_type, ref_id, employee_id
      FROM portion_ledger WHERE inventory_item_id = ${itemId} ORDER BY id
  `;
  return rows.map((r: any) => ({
    delta: Number(r.delta),
    reason: r.reason,
    ref_type: r.ref_type,
    ref_id: r.ref_id == null ? null : Number(r.ref_id),
    employee_id: r.employee_id == null ? null : Number(r.employee_id),
  }));
}

beforeAll(async () => {
  tenant = await createTestTenant('ledgercallers');
  const mgr = await adminSql`
    INSERT INTO employees (tenant_id, name, pin, role, active)
    VALUES (${tenant.id}, 'Ledger Mgr', '4242', 'manager', true) RETURNING id
  `;
  managerId = Number(mgr[0].id);
  managerToken = jwt.sign(
    { tenantId: tenant.id, employeeId: managerId, role: 'manager', type: 'employee' },
    JWT_SECRET,
    { expiresIn: '24h' },
  );
});

afterAll(async () => {
  await dropTestTenant(tenant.id);
  await closePools();
});

describe('POST /api/expenses — receipt lines restock the raw layer', () => {
  it('adds the quantity, blends the cost, and leaves a purchase row in the ledger', async () => {
    const itemId = await seedItem('Arrachera', 10, 10);
    const app = appForTenant(tenant.id);

    const res = await request(app)
      .post('/api/expenses')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({
        amount: 120,
        category: 'food_cost',
        description: 'Nota carnicería',
        expense_date: '2026-08-01',
        inventory_matches: [
          { inventory_item_id: itemId, quantity: 10, cost_price: 12, raw_description: 'ARRACHERA KG' },
        ],
      });

    expect(res.status).toBeLessThan(300);

    const after = await itemRow(itemId);
    expect(after.quantity).toBe(20);
    // (10×10 + 10×12) / 20 = 11 — the weighted average, unchanged by the refactor.
    expect(after.cost_price).toBe(11);

    const ledger = await ledgerFor(itemId);
    expect(ledger).toHaveLength(1);
    expect(ledger[0].delta).toBe(10);
    expect(ledger[0].reason).toBe('purchase');
    expect(ledger[0].ref_type).toBe('expense');
    expect(ledger[0].ref_id).toBeGreaterThan(0);
  });

  it('resets rather than blends the cost when the item was at zero', async () => {
    const itemId = await seedItem('Cebolla', 0, 8);
    const app = appForTenant(tenant.id);

    await request(app)
      .post('/api/expenses')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({
        amount: 75,
        category: 'food_cost',
        expense_date: '2026-08-01',
        inventory_matches: [{ inventory_item_id: itemId, quantity: 5, cost_price: 15 }],
      });

    const after = await itemRow(itemId);
    expect(after.quantity).toBe(5);
    // Nothing on hand to average against, so the new price wins outright.
    expect(after.cost_price).toBe(15);
  });

  it('still stamps last_restocked_at from the expense date, not today', async () => {
    const itemId = await seedItem('Queso', 2, 40);
    const app = appForTenant(tenant.id);

    await request(app)
      .post('/api/expenses')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({
        amount: 200,
        category: 'food_cost',
        expense_date: '2026-07-15',
        inventory_matches: [{ inventory_item_id: itemId, quantity: 5, cost_price: 40 }],
      });

    const [row] = await adminSql`
      SELECT to_char(last_restocked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS d
        FROM inventory_items WHERE id = ${itemId}
    `;
    expect(row.d).toBe('2026-07-15');
  });

  it('writes the expense_items audit row alongside the ledger row', async () => {
    const itemId = await seedItem('Tortilla', 0, 0);
    const app = appForTenant(tenant.id);

    await request(app)
      .post('/api/expenses')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({
        amount: 52.67,
        category: 'food_cost',
        expense_date: '2026-08-02',
        inventory_matches: [
          { inventory_item_id: itemId, quantity: 100, cost_price: 0.5267, raw_description: 'TORTILLA' },
        ],
      });

    const items = await adminSql`
      SELECT quantity, unit_cost FROM expense_items WHERE inventory_item_id = ${itemId}
    `;
    expect(items).toHaveLength(1);
    expect(Number(items[0].quantity)).toBe(100);

    const ledger = await ledgerFor(itemId);
    expect(ledger).toHaveLength(1);
    expect(ledger[0].delta).toBe(100);
  });
});

describe('POST /api/waste', () => {
  it('deducts the quantity and records who threw it away', async () => {
    const itemId = await seedItem('Crema', 10, 30);
    const app = appForTenant(tenant.id);

    const res = await request(app)
      .post('/api/waste')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ inventory_item_id: itemId, quantity: 3, reason: 'spoilage', notes: 'se cortó' });

    expect(res.status).toBe(200);
    expect(res.body.cost_at_time).toBe(90); // 3 × $30, unchanged

    expect((await itemRow(itemId)).quantity).toBe(7);

    const ledger = await ledgerFor(itemId);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      delta: -3,
      reason: 'waste',
      ref_type: 'waste_log',
      employee_id: managerId,
    });

    // The ledger row points at the waste_log row it came from.
    const [waste] = await adminSql`
      SELECT id FROM waste_log WHERE inventory_item_id = ${itemId}
    `;
    expect(ledger[0].ref_id).toBe(Number(waste.id));
  });

  it('floors the cache at zero but keeps the real delta in the ledger', async () => {
    const itemId = await seedItem('Guacamole', 2, 50);
    const app = appForTenant(tenant.id);

    await request(app)
      .post('/api/waste')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ inventory_item_id: itemId, quantity: 5, reason: 'dropped' });

    expect((await itemRow(itemId)).quantity).toBe(0);
    expect((await ledgerFor(itemId))[0].delta).toBe(-5);
  });

  it('rejects an unknown item without writing anything', async () => {
    const app = appForTenant(tenant.id);
    const res = await request(app)
      .post('/api/waste')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ inventory_item_id: 2147483001, quantity: 1, reason: 'other' });

    expect(res.status).toBe(404);
    expect(await ledgerFor(2147483001)).toHaveLength(0);
  });

  it('still validates quantity and reason', async () => {
    const itemId = await seedItem('Salsa', 5, 20);
    const app = appForTenant(tenant.id);

    const badQty = await request(app)
      .post('/api/waste')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ inventory_item_id: itemId, quantity: 0, reason: 'spoilage' });
    expect(badQty.status).toBe(400);

    const badReason = await request(app)
      .post('/api/waste')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ inventory_item_id: itemId, quantity: 1, reason: 'shrinkage' });
    expect(badReason.status).toBe(400);

    // Neither attempt moved stock.
    expect((await itemRow(itemId)).quantity).toBe(5);
    expect(await ledgerFor(itemId)).toHaveLength(0);
  });
});
