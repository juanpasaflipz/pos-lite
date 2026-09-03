// Open-amount ("monto abierto") order lines — migration 0109.
//
// The cashier types a figure into a keypad, it rings as a cart line, and the
// ordinary Cobrar path pushes it at the card terminal. That makes this the ONLY
// place in the order path where the price comes from the client instead of
// menu_items, so the invariants worth guarding are:
//
//   1. THE SERVER RE-VALIDATES THE PRICE. Missing, zero, negative, non-numeric
//      and absurd figures are refused; a good one is rounded to centavos and
//      drives subtotal/tax/total.
//   2. A REGULAR LINE STILL CANNOT SET ITS OWN PRICE. Sending unit_price on a
//      normal item must remain inert — otherwise this feature quietly turns
//      every order into a price-injection surface.
//   3. THE LINE IS MONEY, NOT FOOD. It carries menu_item_id NULL and
//      is_open_amount TRUE, and the KDS never renders it. An order that is
//      nothing but open amounts never reaches the rail at all.
//   4. NULL menu_item_id IS NOT THE MARKER. delivery.js writes NULL for
//      marketplace items it could not match to our menu, and those DO have to
//      be cooked. The KDS filter keys on is_open_amount — anyone who
//      "simplifies" it to `menu_item_id IS NULL` drops real Uber/Rappi/DiDi
//      tickets off the rail, which is what the last test in this file catches.

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
import { all, get, run } from '../server/db/index.js';
// @ts-ignore
import ordersRouter, { resolveOpenAmountLine } from '../server/routes/orders.js';
// @ts-ignore
import { JWT_SECRET } from '../server/lib/constants.js';

// Matches the status list GET /kitchen/active filters on.
const KDS_STATUSES = ['pending', 'confirmed', 'preparing', 'active'];

let tenant: TestTenant;
let employeeId = 0;
let categoryId = 0;
let menuItemId = 0;
let token = '';

function app() {
  const a = express();
  a.use(express.json());
  a.use((req: any, res, next) => {
    req.tenant = { id: tenant.id, plan: 'pro', inventory_mode: 'ingredients' };
    void asTenant(tenant.id, () => new Promise<void>((resolve) => {
      res.on('finish', resolve);
      res.on('close', resolve);
      next();
    }));
  });
  a.use('/api/orders', ordersRouter);
  return a;
}

function createOrder(body: unknown) {
  return request(app())
    .post('/api/orders')
    .set('Authorization', `Bearer ${token}`)
    .send(body as object);
}

// Distinct offline_temp_id per call — createOrder dedups on it, so reusing one
// would silently return the first order and make later assertions test nothing.
let submitSeq = 0;
const nextSubmitId = () => `open-amount-test-${submitSeq++}`;

beforeAll(async () => {
  tenant = await createTestTenant('openamt');

  await asTenant(tenant.id, async () => {
    const emp = await get(
      `INSERT INTO employees (name, pin, role) VALUES ('Open Amount Cashier', '9922', 'manager') RETURNING id`,
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

  token = jwt.sign(
    { tenantId: tenant.id, employeeId, role: 'manager', type: 'employee' },
    JWT_SECRET,
    { expiresIn: '24h' },
  );
}, 60_000);

afterAll(async () => {
  await dropTestTenant(tenant.id);
  await closePools();
}, 30_000);

// The two clauses added to GET /kitchen/active. Returns null when the order
// never reached the rail, otherwise the item names on its ticket.
async function kdsTicket(orderId: number): Promise<string[] | null> {
  return asTenant(tenant.id, async () => {
    const rows = await all(
      `SELECT oi.item_name
       FROM orders o
       LEFT JOIN order_items oi ON oi.order_id = o.id
         AND (oi.voided_at IS NULL OR oi.voided_at > NOW() - INTERVAL '90 seconds')
         AND NOT oi.is_open_amount
       WHERE o.status = ANY($1::text[]) AND o.id = $2
         AND NOT (
           EXISTS (SELECT 1 FROM order_items x WHERE x.order_id = o.id AND x.is_open_amount)
           AND NOT EXISTS (SELECT 1 FROM order_items x WHERE x.order_id = o.id AND NOT x.is_open_amount)
         )
       ORDER BY oi.id`,
      [KDS_STATUSES, orderId],
    );
    if (rows.length === 0) return null;
    return rows.map((r: any) => r.item_name).filter((n: string | null) => n !== null);
  });
}

describe('POST /api/orders with an open-amount line', () => {
  it('rings the cashier-typed price and label, with menu_item_id NULL', async () => {
    const res = await createOrder({
      employee_id: employeeId,
      offline_temp_id: nextSubmitId(),
      items: [{ open_amount: true, quantity: 1, unit_price: 450, item_name: 'Anticipo evento' }],
    });

    expect(res.status).toBe(201);
    expect(Number(res.body.total)).toBe(450);

    const items = await asTenant(tenant.id, () =>
      all(
        `SELECT menu_item_id, item_name, unit_price, is_open_amount
         FROM order_items WHERE order_id = $1`,
        [res.body.id],
      ),
    );
    expect(items).toHaveLength(1);
    expect(items[0].menu_item_id).toBeNull();
    expect(items[0].item_name).toBe('Anticipo evento');
    expect(Number(items[0].unit_price)).toBe(450);
    expect(items[0].is_open_amount).toBe(true);
  });

  it('falls back to a default label when the cashier leaves the concepto blank', async () => {
    const res = await createOrder({
      employee_id: employeeId,
      offline_temp_id: nextSubmitId(),
      items: [{ open_amount: true, quantity: 1, unit_price: 75.5 }],
    });

    expect(res.status).toBe(201);
    const items = await asTenant(tenant.id, () =>
      all(`SELECT item_name FROM order_items WHERE order_id = $1`, [res.body.id]),
    );
    expect(items[0].item_name).toBe('Monto abierto');
  });

  it('mixes with menu items — the total is the sum of both', async () => {
    const res = await createOrder({
      employee_id: employeeId,
      offline_temp_id: nextSubmitId(),
      items: [
        { menu_item_id: menuItemId, quantity: 2 },
        { open_amount: true, quantity: 1, unit_price: 40, item_name: 'Extra' },
      ],
    });

    expect(res.status).toBe(201);
    expect(Number(res.body.total)).toBe(240);
  });

  it('extracts IVA from the typed figure like any other line', async () => {
    const res = await createOrder({
      employee_id: employeeId,
      offline_temp_id: nextSubmitId(),
      items: [{ open_amount: true, quantity: 1, unit_price: 116 }],
    });

    expect(res.status).toBe(201);
    expect(Number(res.body.tax)).toBeCloseTo(16, 2);
    expect(Number(res.body.subtotal)).toBeCloseTo(100, 2);
  });

  it('refuses a price that is missing, zero, negative, or over the cap', async () => {
    for (const unit_price of [undefined, 0, -50, 'abc', 1_000_000]) {
      const res = await createOrder({
        employee_id: employeeId,
        offline_temp_id: nextSubmitId(),
        items: [{ open_amount: true, quantity: 1, unit_price }],
      });
      expect(res.status).toBe(400);
    }
  });

  // Price injection guard: open_amount is what unlocks a client-set price, and
  // nothing else may. A regular line still takes menu_items.price.
  it('ignores unit_price on a regular menu line', async () => {
    const res = await createOrder({
      employee_id: employeeId,
      offline_temp_id: nextSubmitId(),
      items: [{ menu_item_id: menuItemId, quantity: 1, unit_price: 1, item_name: 'Casi gratis' }],
    });

    expect(res.status).toBe(201);
    expect(Number(res.body.total)).toBe(100);

    const items = await asTenant(tenant.id, () =>
      all(`SELECT item_name, unit_price, is_open_amount FROM order_items WHERE order_id = $1`, [res.body.id]),
    );
    expect(items[0].item_name).toBe('Test Burrito');
    expect(Number(items[0].unit_price)).toBe(100);
    expect(items[0].is_open_amount).toBe(false);
  });
});

describe('the kitchen never sees an open amount', () => {
  async function ring(items: unknown[]): Promise<number> {
    const res = await createOrder({
      employee_id: employeeId,
      offline_temp_id: nextSubmitId(),
      items,
    });
    expect(res.status).toBe(201);
    // POS orders are born in a KDS-visible status; assert it rather than
    // assume, so a future status change surfaces here instead of making the
    // KDS assertions below vacuously pass.
    expect(KDS_STATUSES).toContain(res.body.status);
    return Number(res.body.id);
  }

  it('drops an order that is nothing but an open amount', async () => {
    const orderId = await ring([{ open_amount: true, quantity: 1, unit_price: 500 }]);
    expect(await kdsTicket(orderId)).toBeNull();
  });

  it('keeps the food on a mixed order and strips the money line', async () => {
    const orderId = await ring([
      { menu_item_id: menuItemId, quantity: 1 },
      { open_amount: true, quantity: 1, unit_price: 500, item_name: 'Anticipo' },
    ]);
    expect(await kdsTicket(orderId)).toEqual(['Test Burrito']);
  });

  it('leaves an ordinary order untouched', async () => {
    const orderId = await ring([{ menu_item_id: menuItemId, quantity: 1 }]);
    expect(await kdsTicket(orderId)).toEqual(['Test Burrito']);
  });

  it('still shows an unmatched marketplace line (menu_item_id NULL, not open)', async () => {
    const orderId = await ring([{ menu_item_id: menuItemId, quantity: 1 }]);
    // Exactly what delivery.js writes when it cannot match an Uber/Rappi/DiDi
    // item to our menu: no menu_item_id, but real food that must be cooked.
    await asTenant(tenant.id, () =>
      run(
        `INSERT INTO order_items (order_id, menu_item_id, item_name, quantity, unit_price)
         VALUES ($1, NULL, 'Combo Uber sin match', 1, 180)`,
        [orderId],
      ),
    );
    expect(await kdsTicket(orderId)).toEqual(['Test Burrito', 'Combo Uber sin match']);
  });
});

describe('resolveOpenAmountLine', () => {
  it('rounds to centavos and defaults the label', () => {
    expect(resolveOpenAmountLine({ unit_price: 45.005 })).toEqual({
      item_name: 'Monto abierto',
      unit_price: 45.01,
    });
  });

  it('trims the label and caps it at 60 chars', () => {
    expect(resolveOpenAmountLine({ unit_price: 10, item_name: '  Anticipo  ' }).item_name)
      .toBe('Anticipo');
    expect(resolveOpenAmountLine({ unit_price: 10, item_name: 'x'.repeat(200) }).item_name)
      .toHaveLength(60);
  });

  it('rejects a price that is missing, zero, negative, or not a number', () => {
    for (const unit_price of [undefined, null, 0, -5, 'abc', NaN, Infinity]) {
      expect(() => resolveOpenAmountLine({ unit_price })).toThrow(/greater than 0/);
    }
  });

  it('rejects a price above the cap', () => {
    expect(() => resolveOpenAmountLine({ unit_price: 1_000_000 })).toThrow(/cap at/);
  });
});
