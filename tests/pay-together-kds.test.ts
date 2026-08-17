// "Cobrar Juntas" must not take the ticket off the kitchen rail.
//
// Paying is not finishing. Since kiosk orders fire to the kitchen *before* the
// customer pays (tenants.kiosk_fire_before_payment), an order can be paid while
// the food is still on the line — so any tender that closes the order at payment
// time erases a ticket the cooks are actively working.
//
// That is exactly what /payments/pay-together's cash branch did: it set
// status='completed' + completed_at=NOW(), while its own card branch and every
// other tender in the file left the order in flight. Two real juanbertos tickets
// (#20260817004/005, payment_group 2) were closed with completed_at == paid_at
// to the millisecond, having never been marked ready.
//
// This exercises the ROUTE rather than a copy of its UPDATE, so re-introducing
// the close fails here instead of quietly passing a mirrored-SQL assertion.

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
import paymentsRouter from '../server/routes/payments.js';
// @ts-ignore
import { JWT_SECRET } from '../server/lib/constants.js';

// The KDS's own status filter — server/routes/orders.js GET /kitchen/active.
// An order outside this set is invisible to the kitchen.
const KDS_STATUSES = ['pending', 'confirmed', 'preparing', 'active'];

let tenant: TestTenant;
let employeeId: number;
let token = '';

function app() {
  const a = express();
  a.use(express.json());
  a.use((req: any, res, next) => {
    req.tenant = { id: tenant.id, plan: 'pro', timezone: 'America/Mexico_City' };
    void asTenant(tenant.id, () => new Promise<void>((resolve) => {
      res.on('finish', resolve);
      res.on('close', resolve);
      next();
    }));
  });
  a.use('/api/payments', paymentsRouter);
  return a;
}

/** A kiosk ticket already sent to the kitchen and still awaiting payment. */
async function firedUnpaidOrder(status = 'active'): Promise<number> {
  return asTenant(tenant.id, async () => {
    const row = await get(
      `INSERT INTO orders
         (order_number, employee_id, status, subtotal, tax, total, payment_status,
          source, kitchen_fire_at)
       VALUES ($1, $2, $3, 100, 16, 116, 'unpaid', 'customer_kiosk', NOW())
       RETURNING id`,
      [Date.now() % 1_000_000 + Math.floor(performance.now() % 1000), employeeId, status],
    );
    return Number(row.id);
  });
}

async function readOrder(id: number) {
  const [row] = await adminSql`
    SELECT status, payment_status, payment_method, completed_at, paid_at, payment_group_id
    FROM orders WHERE tenant_id = ${tenant.id} AND id = ${id}
  `;
  return row;
}

beforeAll(async () => {
  tenant = await createTestTenant('paytog');
  await asTenant(tenant.id, async () => {
    const emp = await get(
      `INSERT INTO employees (name, pin, role, active) VALUES ('Caja', '9922', 'cashier', true) RETURNING id`,
    );
    employeeId = Number(emp.id);
  });
  token = jwt.sign(
    { tenantId: tenant.id, employeeId, role: 'cashier', type: 'employee' },
    JWT_SECRET,
    { expiresIn: '24h' },
  );
}, 60_000);

afterAll(async () => {
  await dropTestTenant(tenant.id);
  await closePools();
}, 30_000);

describe('POST /payments/pay-together — cash', () => {
  it('leaves both tickets on the kitchen rail after payment', async () => {
    const a = await firedUnpaidOrder();
    const b = await firedUnpaidOrder();

    const res = await request(app())
      .post('/api/payments/pay-together')
      .set('Authorization', `Bearer ${token}`)
      .send({ order_ids: [a, b], payment_method: 'cash', cash_received: 300 });

    expect(res.status).toBe(200);

    for (const id of [a, b]) {
      const row = await readOrder(id);
      // The money landed...
      expect(row.payment_status).toBe('paid');
      expect(row.payment_method).toBe('cash');
      expect(row.payment_group_id).not.toBeNull();
      // ...and the kitchen still has the ticket.
      expect(KDS_STATUSES).toContain(row.status);
      // completed_at is the kitchen's to set, not the till's. It being equal to
      // paid_at was the fingerprint of this bug in production.
      expect(row.completed_at).toBeNull();
    }
  });

  it('does not shove an already-ready ticket back onto the rail', async () => {
    // The other half of "leave status alone": a cook who finished before the
    // customer paid must not see the order reappear as in-progress.
    const a = await firedUnpaidOrder('ready');
    const b = await firedUnpaidOrder('ready');
    await adminSql`
      UPDATE orders SET ready_at = NOW()
      WHERE tenant_id = ${tenant.id} AND id IN (${a}, ${b})
    `;

    const res = await request(app())
      .post('/api/payments/pay-together')
      .set('Authorization', `Bearer ${token}`)
      .send({ order_ids: [a, b], payment_method: 'cash' });

    expect(res.status).toBe(200);

    for (const id of [a, b]) {
      const row = await readOrder(id);
      expect(row.payment_status).toBe('paid');
      expect(row.status).toBe('ready');
    }
  });
});
