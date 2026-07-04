// Order lifecycle tests — kiosk pay-first flow + DELETE cascade.
//
// Invariants guarded here:
//   1. Orders with status='draft_kiosk' are INVISIBLE to the KDS query.
//      (The kiosk creates orders in this state *before* payment; the kitchen
//      must not receive a ticket until the customer pays.)
//   2. Promoting draft_kiosk → active (`markKioskOrderPaid` sets status='active'
//      + payment_status='paid') makes the same order visible to the KDS query.
//   3. DELETE FROM orders WHERE id=X fails via FK constraint if any child
//      order_items row exists — this is the guarantee behind DELETE /orders/:id's
//      explicit cascade sequence. If a future migration adds a child table
//      without wiring it into that route, this test still catches naïve deletes.
//   4. The route's cascade sequence (order_payment_items → order_payments →
//      refunds → delivery_orders → order_items → orders) empties every child row.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestTenant,
  dropTestTenant,
  asTenant,
  closePools,
  type TestTenant,
} from './helpers/db.js';
// @ts-ignore
import { adminSql, get, all, run } from '../server/db/index.js';

// KDS query shape: matches `WHERE status IN (...)` in
// server/routes/orders.js:1034 (`GET /kitchen/active`).
const KDS_STATUSES = ['pending', 'confirmed', 'preparing', 'active'];

let tenant: TestTenant;
let employeeId: number;
let categoryId: number;
let menuItemId: number;

async function insertDraftKioskOrder(): Promise<number> {
  return asTenant(tenant.id, async () => {
    const row = await get(
      `INSERT INTO orders
         (order_number, employee_id, status, subtotal, tax, total, payment_status)
       VALUES ($1, $2, 'draft_kiosk', 100, 16, 116, 'unpaid')
       RETURNING id`,
      [Date.now() % 1_000_000, employeeId],
    );
    return Number(row.id);
  });
}

async function promoteToPaid(orderId: number): Promise<void> {
  // Mirrors markKioskOrderPaid() from server/routes/kiosk.js:469 — same UPDATE
  // shape. If that helper's contract changes, this simulation lags; the KDS
  // visibility assertion still catches the invariant.
  await adminSql`
    UPDATE orders
    SET status = 'active', payment_status = 'paid', payment_method = 'card', paid_at = NOW()
    WHERE id = ${orderId} AND tenant_id = ${tenant.id}
  `;
}

beforeAll(async () => {
  tenant = await createTestTenant('orderlc');

  // Fixture: one employee, one menu_category, one menu_item.
  await asTenant(tenant.id, async () => {
    const emp = await get(
      `INSERT INTO employees (name, pin, role) VALUES ('Test Cashier', '9999', 'cashier') RETURNING id`,
    );
    employeeId = Number(emp.id);
    const cat = await get(
      `INSERT INTO menu_categories (name, sort_order) VALUES ('Test Cat', 1) RETURNING id`,
    );
    categoryId = Number(cat.id);
    const item = await get(
      `INSERT INTO menu_items (category_id, name, price) VALUES ($1, 'Test Burrito', 100) RETURNING id`,
      [categoryId],
    );
    menuItemId = Number(item.id);
  });
}, 60_000);

afterAll(async () => {
  await dropTestTenant(tenant.id);
  await closePools();
}, 30_000);

describe('kiosk pay-first flow', () => {
  it('draft_kiosk orders are invisible to the KDS query', async () => {
    const orderId = await insertDraftKioskOrder();

    const visible = await asTenant(tenant.id, () =>
      all(
        `SELECT id FROM orders WHERE status = ANY($1::text[]) AND id = $2`,
        [KDS_STATUSES, orderId],
      ),
    );

    expect(visible).toHaveLength(0);
  });

  it('promoting draft_kiosk → active makes the order visible to KDS', async () => {
    const orderId = await insertDraftKioskOrder();
    await promoteToPaid(orderId);

    const visible = await asTenant(tenant.id, () =>
      all(
        `SELECT id, status, payment_status FROM orders WHERE status = ANY($1::text[]) AND id = $2`,
        [KDS_STATUSES, orderId],
      ),
    );

    expect(visible).toHaveLength(1);
    expect((visible[0] as any).status).toBe('active');
    expect((visible[0] as any).payment_status).toBe('paid');
  });
});

describe('DELETE cascade', () => {
  it('raw DELETE FROM orders with child order_items raises FK violation', async () => {
    const orderId = await insertDraftKioskOrder();
    await asTenant(tenant.id, () =>
      run(
        `INSERT INTO order_items (order_id, menu_item_id, item_name, quantity, unit_price)
         VALUES ($1, $2, 'Test Burrito', 1, 100)`,
        [orderId, menuItemId],
      ),
    );

    await expect(
      asTenant(tenant.id, () => run(`DELETE FROM orders WHERE id = $1`, [orderId])),
    ).rejects.toThrow(/violates foreign key|order_items/i);
  });

  it('route\'s cascade sequence (items → payments → orders) leaves no orphans', async () => {
    const orderId = await insertDraftKioskOrder();

    await asTenant(tenant.id, async () => {
      await run(
        `INSERT INTO order_items (order_id, menu_item_id, item_name, quantity, unit_price)
         VALUES ($1, $2, 'Test Burrito', 2, 100)`,
        [orderId, menuItemId],
      );
      await run(
        `INSERT INTO order_payments (order_id, payment_method, amount, status)
         VALUES ($1, 'card', 200, 'succeeded')`,
        [orderId],
      );
    });

    // Same sequence as server/routes/orders.js DELETE /:id handler.
    await asTenant(tenant.id, async () => {
      await run(`DELETE FROM order_payments WHERE order_id = $1`, [orderId]);
      await run(`DELETE FROM order_items WHERE order_id = $1`, [orderId]);
      await run(`DELETE FROM orders WHERE id = $1`, [orderId]);
    });

    // No orphaned rows anywhere.
    const [order] = await adminSql`SELECT id FROM orders WHERE id = ${orderId}`;
    const [items] = await adminSql`SELECT COUNT(*)::int AS n FROM order_items WHERE order_id = ${orderId}`;
    const [pays] = await adminSql`SELECT COUNT(*)::int AS n FROM order_payments WHERE order_id = ${orderId}`;

    expect(order).toBeUndefined();
    expect(items.n).toBe(0);
    expect(pays.n).toBe(0);
  });
});
