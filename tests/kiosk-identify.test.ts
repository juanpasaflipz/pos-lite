// Kiosk deferred identity — firing the kitchen ticket before the guest has
// typed their call-out name.
//
// The kiosk used to ask both of its closing questions up front and only create
// the order once it had the answers. It now fires on the "¿para aquí o para
// llevar?" tap and patches the name on afterwards, so the kitchen gets the
// ticket a screen earlier — the on-screen keyboard being the slow step.
//
// The asymmetry is the whole design and is what these tests protect: fulfillment
// is a packaging INSTRUCTION and is answered before the ticket exists, while the
// name is a LABEL whose absence the KDS has always rendered honestly (it falls
// back to the order number). Four properties hold that line:
//
//   1. When a caller does defer the fulfillment answer, it is stored NULL — not
//      the 'to_go' column default. The current kiosk always sends the answer, so
//      this is the floor rather than the hot path: no caller may cause a guessed
//      packaging instruction to appear on a live ticket. (The KDS renders NULL
//      as its own neutral pill — KitchenDisplay's orders.fulfillmentPending.)
//   2. An explicit fulfillment choice survives alongside a deferred name — the
//      actual shape every order now takes.
//   3. Without `identify_later` the old "name required" guard still bites. The
//      Android kiosk APK is frozen between rebuilds, so older tablets keep
//      sending the name at creation and must keep getting the old contract.
//   4. /orders/:id/identify writes only the fields it was given, and refuses
//      orders that aren't kiosk-born-and-still-unpaid. Both directions of
//      partial patch are real client behavior: name-only on the way forward,
//      fulfillment-only when a guest steps back to change their answer.

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
import { adminSql, get } from '../server/db/index.js';
// @ts-ignore
import kioskRouter from '../server/routes/kiosk.js';
// @ts-ignore
import { updateTenant } from '../server/tenants.js';
// @ts-ignore
import { JWT_SECRET } from '../server/lib/constants.js';

let tenant: TestTenant;
let kioskToken = '';
let menuItemId = 0;

/** /api/kiosk mounts before tenantMiddleware in prod, so nothing else is needed. */
function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/kiosk', kioskRouter);
  return a;
}

function post(path: string, body: unknown) {
  return request(app())
    .post(`/api/kiosk${path}`)
    .set('Authorization', `Bearer ${kioskToken}`)
    .set('x-tenant-id', tenant.id)
    .send(body as object);
}

const CART = () => [{ menu_item_id: menuItemId, quantity: 1, modifier_ids: [] }];

beforeAll(async () => {
  tenant = await createTestTenant('kioskid');

  // Kiosk is a Pro feature; createTestTenant makes free tenants. Go through
  // updateTenant rather than a raw UPDATE — createTenant already warmed the
  // 60s tenantCache with plan='free', and requireKioskPlan reads that cache.
  await updateTenant(tenant.id, { plan: 'pro' });

  await asTenant(tenant.id, async () => {
    await get(`INSERT INTO employees (name, pin, role) VALUES ('Kiosk Cashier', '9911', 'cashier') RETURNING id`);
    const cat = await get(`INSERT INTO menu_categories (name, sort_order) VALUES ('Kiosk Cat', 1) RETURNING id`);
    const item = await get(
      `INSERT INTO menu_items (category_id, name, price, active) VALUES ($1, 'Kiosk Burrito', 100, true) RETURNING id`,
      [Number(cat.id)],
    );
    menuItemId = Number(item.id);
  });

  kioskToken = jwt.sign({ type: 'kiosk', tenantId: tenant.id }, JWT_SECRET, { expiresIn: '1h' });
}, 60_000);

afterAll(async () => {
  await dropTestTenant(tenant.id);
  await closePools();
}, 30_000);

describe('send-to-kitchen with deferred identity', () => {
  it('never invents a packaging instruction when fulfillment is omitted', async () => {
    const res = await post('/orders/send-to-kitchen', { items: CART(), identify_later: true });

    expect(res.status).toBe(201);
    expect(res.body.customer_call_name).toBeNull();
    // NULL, not 'to_go' — the column default must not stand in for an answer
    // nobody has given.
    expect(res.body.order_fulfillment_type).toBeNull();

    const [row] = await adminSql`
      SELECT order_fulfillment_type FROM orders WHERE tenant_id = ${tenant.id} AND id = ${res.body.id}
    `;
    expect(row.order_fulfillment_type).toBeNull();
  });

  it('still requires a name when the client does not defer (frozen APKs)', async () => {
    const res = await post('/orders/send-to-kitchen', { items: CART() });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/call name/i);
  });

  // The shape every dine-in / takeout order now takes: the guest answered the
  // packaging question, which is what fired this call in the first place.
  it('honors an explicit fulfillment choice even when deferring the name', async () => {
    const res = await post('/orders/send-to-kitchen', {
      items: CART(),
      identify_later: true,
      fulfillment_type: 'for_here',
    });

    expect(res.status).toBe(201);
    expect(res.body.order_fulfillment_type).toBe('for_here');
  });
});

describe('POST /orders/:id/identify', () => {
  /** Mirrors the fulfillment screen: packaging answered, name still outstanding. */
  async function fireOrder(): Promise<number> {
    const res = await post('/orders/send-to-kitchen', {
      items: CART(),
      identify_later: true,
      fulfillment_type: 'for_here',
    });
    expect(res.status).toBe(201);
    return Number(res.body.id);
  }

  // The forward path: the name screen sends nothing but the name.
  it('patches the name without disturbing the fulfillment answer', async () => {
    const id = await fireOrder();

    const res = await post(`/orders/${id}/identify`, { customer_call_name: '  Juan  ' });

    expect(res.status).toBe(200);
    expect(res.body.customer_call_name).toBe('Juan');
    expect(res.body.order_fulfillment_type).toBe('for_here');
  });

  // The correction path: the guest taps "Atrás" from the name screen and picks
  // the other option. That re-entry must patch the ticket it already has, not
  // ring up a second one, and must not blank a name already typed.
  it('a fulfillment-only patch changes the answer and keeps the name', async () => {
    const id = await fireOrder();
    await post(`/orders/${id}/identify`, { customer_call_name: 'Ana' });

    const res = await post(`/orders/${id}/identify`, { fulfillment_type: 'to_go' });

    expect(res.status).toBe(200);
    expect(res.body.customer_call_name).toBe('Ana');
    expect(res.body.order_fulfillment_type).toBe('to_go');
  });

  it('refuses an order that has already been paid', async () => {
    const id = await fireOrder();
    await adminSql`
      UPDATE orders SET payment_status = 'paid', paid_at = NOW()
      WHERE tenant_id = ${tenant.id} AND id = ${id}
    `;

    const res = await post(`/orders/${id}/identify`, { customer_call_name: 'Too Late' });

    expect(res.status).toBe(404);
  });

  it('refuses an order the kiosk did not create', async () => {
    const id = await fireOrder();
    await adminSql`
      UPDATE orders SET source = 'pos' WHERE tenant_id = ${tenant.id} AND id = ${id}
    `;

    const res = await post(`/orders/${id}/identify`, { customer_call_name: 'Not Yours' });

    expect(res.status).toBe(404);
  });

  it('rejects a non-numeric order id', async () => {
    const res = await post('/orders/not-a-number/identify', { customer_call_name: 'X' });

    expect(res.status).toBe(400);
  });
});
