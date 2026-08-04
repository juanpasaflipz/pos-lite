// P2 — sales consume prepped portions, and the menu 86s itself.
//
// The whole phase is a semantic move (deduct at ring-up instead of at payment)
// layered on top of a deduction path that was already live in nine places. So
// the tests that matter most are the ones about NOT doing it twice:
//
//   1. EXACTLY ONCE. A two-stage order deducts when it is rung, and the payment
//      path that used to do the deducting must now be a no-op for it.
//   2. INGREDIENTS MODE IS UNTOUCHED. Every tenant on the platform is on the old
//      model; creation must deduct nothing and payment must behave as before.
//   3. EDITS AND REVERSALS ARE SYMMETRIC. Quantity changes, voids, refunds and
//      deletes give back exactly what was taken — never more.
//   4. AVAILABILITY IS DERIVED CORRECTLY, including the cases where it must NOT
//      fire: no recipe, auto_86 off, raw-only recipes.

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
import ordersRouter from '../server/routes/orders.js';
// @ts-ignore
import {
  sellableCountsFor,
  deductInventoryForOrder,
  attachSellable,
} from '../server/helpers/inventory.js';
// @ts-ignore
import { JWT_SECRET } from '../server/lib/constants.js';

let twoStage: TestTenant;
let plain: TestTenant;
let tsEmployee = 0;
let plainEmployee = 0;
let tsToken = '';
let plainToken = '';
let tsCategory = 0;
let plainCategory = 0;

function appFor(tenant: TestTenant, mode: 'ingredients' | 'two_stage') {
  const app = express();
  app.use(express.json());
  app.use((req: any, res, next) => {
    // Mirrors tenantMiddleware, including inventory_mode — the routes branch
    // on req.tenant.inventory_mode, so omitting it here would silently test
    // the wrong path.
    req.tenant = { id: tenant.id, plan: 'pro', inventory_mode: mode };
    void asTenant(tenant.id, () => new Promise<void>((resolve) => {
      res.on('finish', resolve);
      res.on('close', resolve);
      next();
    }));
  });
  app.use('/api/orders', ordersRouter);
  return app;
}

function tokenFor(tenantId: string, employeeId: number) {
  return jwt.sign(
    { tenantId, employeeId, role: 'manager', type: 'employee' },
    JWT_SECRET,
    { expiresIn: '24h' },
  );
}

/** A menu item backed by one component, with `portions` on the line. */
async function seedDish(
  tenantId: string,
  categoryId: number,
  name: string,
  portions: number,
  { quantityUsed = 1, kind = 'component', auto86 = true, soldOutManual = false, threshold = null as number | null } = {}
) {
  const [item] = await adminSql`
    INSERT INTO menu_items (tenant_id, category_id, name, price, active)
    VALUES (${tenantId}, ${categoryId}, ${name}, 100, true) RETURNING id
  `;
  const [comp] = await adminSql`
    INSERT INTO inventory_items
      (tenant_id, name, quantity, unit, cost_price, kind, auto_86, sold_out_manual, low_threshold_portions)
    VALUES (${tenantId}, ${`${name} base`}, ${portions}, 'porción', 10,
            ${kind}, ${auto86}, ${soldOutManual}, ${threshold})
    RETURNING id
  `;
  await adminSql`
    INSERT INTO menu_item_ingredients (tenant_id, menu_item_id, inventory_item_id, quantity_used)
    VALUES (${tenantId}, ${item.id}, ${comp.id}, ${quantityUsed})
  `;
  return { menuItemId: Number(item.id), componentId: Number(comp.id) };
}

async function qtyOf(componentId: number): Promise<number> {
  const [row] = await adminSql`SELECT quantity FROM inventory_items WHERE id = ${componentId}`;
  return Number(row.quantity);
}

async function ledgerOf(componentId: number) {
  const rows = await adminSql`
    SELECT delta, reason, ref_type, ref_id FROM portion_ledger
    WHERE inventory_item_id = ${componentId} ORDER BY id
  `;
  return rows.map((r: any) => ({
    delta: Number(r.delta), reason: r.reason, ref_type: r.ref_type, ref_id: Number(r.ref_id),
  }));
}

async function createOrder(
  tenant: TestTenant,
  mode: 'ingredients' | 'two_stage',
  employeeId: number,
  token: string,
  items: { menu_item_id: number; quantity: number }[],
  extra: Record<string, unknown> = {}
) {
  return request(appFor(tenant, mode))
    .post('/api/orders')
    .set('Authorization', `Bearer ${token}`)
    .send({
      employee_id: employeeId,
      items: items.map((i) => ({ ...i, quantity: i.quantity })),
      ...extra,
    });
}

beforeAll(async () => {
  twoStage = await createTestTenant('avail-ts');
  plain = await createTestTenant('avail-plain');
  await updateTenant(twoStage.id, { inventory_mode: 'two_stage' });

  for (const [t, setEmp] of [
    [twoStage, (id: number) => { tsEmployee = id; }],
    [plain, (id: number) => { plainEmployee = id; }],
  ] as const) {
    const [emp] = await adminSql`
      INSERT INTO employees (tenant_id, name, pin, role, active)
      VALUES (${t.id}, 'Avail Mgr', '7777', 'manager', true) RETURNING id
    `;
    setEmp(Number(emp.id));
  }
  tsToken = tokenFor(twoStage.id, tsEmployee);
  plainToken = tokenFor(plain.id, plainEmployee);

  const [c1] = await adminSql`
    INSERT INTO menu_categories (tenant_id, name, sort_order) VALUES (${twoStage.id}, 'Comida', 1) RETURNING id
  `;
  tsCategory = Number(c1.id);
  const [c2] = await adminSql`
    INSERT INTO menu_categories (tenant_id, name, sort_order) VALUES (${plain.id}, 'Comida', 1) RETURNING id
  `;
  plainCategory = Number(c2.id);
}, 90_000);

afterAll(async () => {
  await dropTestTenant(twoStage.id);
  await dropTestTenant(plain.id);
  await closePools();
}, 90_000);

describe('exactly once — the double-deduction guard', () => {
  it('deducts components when the order is rung, not when it is paid', async () => {
    const { menuItemId, componentId } = await seedDish(twoStage.id, tsCategory, 'Burrito uno', 20);

    const res = await createOrder(twoStage, 'two_stage', tsEmployee, tsToken, [
      { menu_item_id: menuItemId, quantity: 3 },
    ]);
    expect(res.status).toBe(201);
    expect(await qtyOf(componentId)).toBe(17);

    const rows = await ledgerOf(componentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ delta: -3, reason: 'sale', ref_type: 'order_item' });
  });

  it('makes the payment-time path a no-op for a two-stage order', async () => {
    const { menuItemId, componentId } = await seedDish(twoStage.id, tsCategory, 'Burrito dos', 10);
    const res = await createOrder(twoStage, 'two_stage', tsEmployee, tsToken, [
      { menu_item_id: menuItemId, quantity: 2 },
    ]);
    const orderId = res.body.id ?? res.body.order_id;
    expect(await qtyOf(componentId)).toBe(8);

    // This is what every payment route calls. If the mode guard regressed, the
    // count would drop to 6 and every sale in prod would be counted twice.
    await asTenant(twoStage.id, () => deductInventoryForOrder(orderId));
    expect(await qtyOf(componentId)).toBe(8);
  });

  it('survives a replayed deduction for the same line', async () => {
    const { menuItemId, componentId } = await seedDish(twoStage.id, tsCategory, 'Burrito tres', 10);
    const res = await createOrder(twoStage, 'two_stage', tsEmployee, tsToken, [
      { menu_item_id: menuItemId, quantity: 1 },
    ]);
    const orderId = res.body.id ?? res.body.order_id;

    const [line] = await adminSql`SELECT id, menu_item_id, quantity FROM order_items WHERE order_id = ${orderId}`;
    const { deductComponentsForOrderLines } = await import('../server/helpers/inventory.js');
    await asTenant(twoStage.id, () => deductComponentsForOrderLines(null, {
      lines: [{ order_item_id: Number(line.id), menu_item_id: Number(line.menu_item_id), quantity: Number(line.quantity) }],
    }));

    // Idempotent by construction: the line already has a 'sale' row.
    expect(await qtyOf(componentId)).toBe(9);
    expect(await ledgerOf(componentId)).toHaveLength(1);
  });
});

describe('ingredients mode is untouched', () => {
  it('does not deduct at order creation', async () => {
    const { menuItemId, componentId } = await seedDish(plain.id, plainCategory, 'Plato viejo', 20);
    await createOrder(plain, 'ingredients', plainEmployee, plainToken, [
      { menu_item_id: menuItemId, quantity: 3 },
    ]);
    expect(await qtyOf(componentId)).toBe(20);
    expect(await ledgerOf(componentId)).toHaveLength(0);
  });

  it('still deducts at payment time, and now skips voided lines', async () => {
    const { menuItemId, componentId } = await seedDish(plain.id, plainCategory, 'Plato viejo 2', 20);
    const res = await createOrder(plain, 'ingredients', plainEmployee, plainToken, [
      { menu_item_id: menuItemId, quantity: 2 },
    ]);
    const orderId = res.body.id ?? res.body.order_id;

    // Void the line before paying: it was never sold, so it must not deduct.
    await adminSql`UPDATE order_items SET voided_at = NOW() WHERE order_id = ${orderId}`;
    await asTenant(plain.id, () => deductInventoryForOrder(orderId));
    expect(await qtyOf(componentId)).toBe(20);

    // Un-void and pay: now it deducts, exactly as it always has.
    await adminSql`UPDATE order_items SET voided_at = NULL WHERE order_id = ${orderId}`;
    await asTenant(plain.id, () => deductInventoryForOrder(orderId));
    expect(await qtyOf(componentId)).toBe(18);
  });

  it('gets no availability fields in its menu payload', async () => {
    const items = [{ id: 1, name: 'x' }];
    const decorated = await attachSellable(items, { mode: 'ingredients' });
    expect(decorated[0]).toEqual({ id: 1, name: 'x' });
    expect('sellable_count' in decorated[0]).toBe(false);
  });
});

describe('edits give back exactly what they took', () => {
  it('raising the quantity consumes the difference', async () => {
    const { menuItemId, componentId } = await seedDish(twoStage.id, tsCategory, 'Editable A', 20);
    const created = await createOrder(twoStage, 'two_stage', tsEmployee, tsToken, [
      { menu_item_id: menuItemId, quantity: 2 },
    ]);
    const orderId = created.body.id ?? created.body.order_id;
    const [line] = await adminSql`SELECT id FROM order_items WHERE order_id = ${orderId}`;
    expect(await qtyOf(componentId)).toBe(18);

    const res = await request(appFor(twoStage, 'two_stage'))
      .patch(`/api/orders/${orderId}/items/${line.id}`)
      .set('Authorization', `Bearer ${tsToken}`)
      .send({ quantity: 5 });
    expect(res.status).toBe(200);
    expect(await qtyOf(componentId)).toBe(15); // three more portions gone
  });

  it('lowering the quantity hands the difference back', async () => {
    const { menuItemId, componentId } = await seedDish(twoStage.id, tsCategory, 'Editable B', 20);
    const created = await createOrder(twoStage, 'two_stage', tsEmployee, tsToken, [
      { menu_item_id: menuItemId, quantity: 5 },
    ]);
    const orderId = created.body.id ?? created.body.order_id;
    const [line] = await adminSql`SELECT id FROM order_items WHERE order_id = ${orderId}`;
    expect(await qtyOf(componentId)).toBe(15);

    await request(appFor(twoStage, 'two_stage'))
      .patch(`/api/orders/${orderId}/items/${line.id}`)
      .set('Authorization', `Bearer ${tsToken}`)
      .send({ quantity: 1 });
    expect(await qtyOf(componentId)).toBe(19);
  });

  it('voiding a line restores it, and never more than it took', async () => {
    const { menuItemId, componentId } = await seedDish(twoStage.id, tsCategory, 'Void me', 20);
    const other = await seedDish(twoStage.id, tsCategory, 'Keep me', 20);
    const created = await createOrder(twoStage, 'two_stage', tsEmployee, tsToken, [
      { menu_item_id: menuItemId, quantity: 4 },
      { menu_item_id: other.menuItemId, quantity: 1 },
    ]);
    const orderId = created.body.id ?? created.body.order_id;
    const lines = await adminSql`
      SELECT id, menu_item_id FROM order_items WHERE order_id = ${orderId} ORDER BY id
    `;
    const target = lines.find((l: any) => Number(l.menu_item_id) === menuItemId);
    expect(await qtyOf(componentId)).toBe(16);

    const res = await request(appFor(twoStage, 'two_stage'))
      .delete(`/api/orders/${orderId}/items/${target.id}`)
      .set('Authorization', `Bearer ${tsToken}`)
      .send({ void_reason: 'customer changed mind' });
    expect(res.status).toBe(200);
    expect(await qtyOf(componentId)).toBe(20);

    // The restore nets the line to zero, so a second reversal adds nothing.
    const net = (await ledgerOf(componentId)).reduce((s, r) => s + r.delta, 0);
    expect(net).toBe(0);
  });

  it('deleting the whole order gives every line back', async () => {
    const { menuItemId, componentId } = await seedDish(twoStage.id, tsCategory, 'Delete me', 20);
    const created = await createOrder(twoStage, 'two_stage', tsEmployee, tsToken, [
      { menu_item_id: menuItemId, quantity: 6 },
    ]);
    const orderId = created.body.id ?? created.body.order_id;
    expect(await qtyOf(componentId)).toBe(14);

    const res = await request(appFor(twoStage, 'two_stage'))
      .delete(`/api/orders/${orderId}`)
      .set('Authorization', `Bearer ${tsToken}`);
    expect(res.status).toBe(200);
    expect(await qtyOf(componentId)).toBe(20);
  });
});

describe('sellableCountsFor', () => {
  it('takes the floor of the limiting component', async () => {
    // One dish, one component at 7 portions, each plate eats 2 → 3 plates.
    const { menuItemId } = await seedDish(twoStage.id, tsCategory, 'Floor test', 7, { quantityUsed: 2 });
    const counts = await asTenant(twoStage.id, () => sellableCountsFor(null, [menuItemId]));
    expect(counts.get(menuItemId).sellable).toBe(3);
  });

  it('reports zero when a component is manually 86ed, whatever the count says', async () => {
    const { menuItemId } = await seedDish(twoStage.id, tsCategory, 'Manual 86', 50, { soldOutManual: true });
    const counts = await asTenant(twoStage.id, () => sellableCountsFor(null, [menuItemId]));
    expect(counts.get(menuItemId).sellable).toBe(0);
  });

  it('leaves items with no component recipe absent — unlimited, not zero', async () => {
    const [item] = await adminSql`
      INSERT INTO menu_items (tenant_id, category_id, name, price, active)
      VALUES (${twoStage.id}, ${tsCategory}, 'Sin receta', 50, true) RETURNING id
    `;
    const counts = await asTenant(twoStage.id, () => sellableCountsFor(null, [Number(item.id)]));
    expect(counts.has(Number(item.id))).toBe(false);

    const [decorated] = await attachSellable([{ id: Number(item.id) }], { mode: 'two_stage' });
    expect(decorated.sellable_count).toBeNull();
    expect(decorated.sold_out).toBe(false);
  });

  it('ignores raw-only recipes — raw is consumed by prep runs, not by sales', async () => {
    const { menuItemId } = await seedDish(twoStage.id, tsCategory, 'Solo crudo', 0, { kind: 'raw' });
    const counts = await asTenant(twoStage.id, () => sellableCountsFor(null, [menuItemId]));
    expect(counts.has(menuItemId)).toBe(false); // at 0 raw, still not sold out
  });

  it('does not let an auto_86=false component gate the dish', async () => {
    const { menuItemId } = await seedDish(twoStage.id, tsCategory, 'Guarnición', 0, { auto86: false });
    const counts = await asTenant(twoStage.id, () => sellableCountsFor(null, [menuItemId]));
    expect(counts.has(menuItemId)).toBe(false);
  });

  it('flags low stock at or below the portion threshold', async () => {
    const { menuItemId } = await seedDish(twoStage.id, tsCategory, 'Casi se acaba', 3, { threshold: 5 });
    const counts = await asTenant(twoStage.id, () => sellableCountsFor(null, [menuItemId]));
    expect(counts.get(menuItemId)).toMatchObject({ sellable: 3, low: true });
  });
});

describe('the submit-time guard', () => {
  it('rejects an item that was already at zero, naming it', async () => {
    const { menuItemId } = await seedDish(twoStage.id, tsCategory, 'Agotado', 0);
    const res = await createOrder(twoStage, 'two_stage', tsEmployee, tsToken, [
      { menu_item_id: menuItemId, quantity: 1 },
    ]);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ITEMS_SOLD_OUT');
    expect(res.body.sold_out_menu_item_ids).toContain(menuItemId);
  });

  it('lets a race loser through rather than failing a customer at the counter', async () => {
    // One portion left, three ordered: the order succeeds and the count floors.
    const { menuItemId, componentId } = await seedDish(twoStage.id, tsCategory, 'Ultima porción', 1);
    const res = await createOrder(twoStage, 'two_stage', tsEmployee, tsToken, [
      { menu_item_id: menuItemId, quantity: 3 },
    ]);
    expect(res.status).toBe(201);
    expect(await qtyOf(componentId)).toBe(0);
    // The ledger keeps the oversell visible even though the cache floors.
    const net = (await ledgerOf(componentId)).reduce((s, r) => s + r.delta, 0);
    expect(net).toBe(-3);
  });

  it('honours a manager override', async () => {
    const { menuItemId } = await seedDish(twoStage.id, tsCategory, 'Override me', 0);
    const res = await createOrder(
      twoStage, 'two_stage', tsEmployee, tsToken,
      [{ menu_item_id: menuItemId, quantity: 1 }],
      { sold_out_override: true }
    );
    expect(res.status).toBe(201);
  });

  it('never fires for an ingredients-mode tenant', async () => {
    const { menuItemId } = await seedDish(plain.id, plainCategory, 'Sin guard', 0);
    const res = await createOrder(plain, 'ingredients', plainEmployee, plainToken, [
      { menu_item_id: menuItemId, quantity: 1 },
    ]);
    expect(res.status).toBe(201);
  });

  it('rolls the order back entirely when it rejects', async () => {
    const { menuItemId } = await seedDish(twoStage.id, tsCategory, 'Rollback', 0);
    const before = await adminSql`SELECT COUNT(*)::int AS c FROM orders WHERE tenant_id = ${twoStage.id}`;
    await createOrder(twoStage, 'two_stage', tsEmployee, tsToken, [
      { menu_item_id: menuItemId, quantity: 1 },
    ]);
    const after = await adminSql`SELECT COUNT(*)::int AS c FROM orders WHERE tenant_id = ${twoStage.id}`;
    expect(after[0].c).toBe(before[0].c);
  });
});
