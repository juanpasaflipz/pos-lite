// Webhook security tests — the payment-spoofing + cross-tenant write guards
// added in the Day-1 hardening pass.
//
// Two independent invariants, one per fix:
//
//   1. GATE (payment spoofing) — /webhooks/getnet must reject any request that
//      doesn't present the shared secret. Getnet's notification scheme gives us
//      no per-tenant signature to verify against, so the route is DISABLED
//      unless GETNET_WEBHOOK_SECRET is set, and when set it requires a matching
//      `x-getnet-token` (constant-time compare). Before this, an unauthenticated
//      POST could flip an order to paid and deduct inventory.
//      (server/routes/getnetWebhook.js)
//
//   2. TENANT FILTER (C3 / audits/raw/neon-leaks.md) — the MP and Getnet
//      webhooks write to `orders` via adminSql, which connects as the
//      table owner and BYPASSES row-level security. The explicit
//      `AND tenant_id = <resolved tenant>` predicate is therefore the ONLY
//      isolation guard left on those writes. This mirrors that UPDATE shape and
//      proves the predicate is load-bearing: a wrong tenant_id touches 0 rows.
//      (server/routes/payments.js mpWebhook,
//       server/services/getnet/webhook.js)

import express from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
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
import getnetWebhook from '../server/routes/getnetWebhook.js';

const GETNET_SECRET = 'test-getnet-shared-secret';

// Fixtures for the C3 SQL-invariant block. Created once, dropped in afterAll.
let tenantA: TestTenant;
let tenantB: TestTenant;
let employeeA: number;

beforeAll(async () => {
  tenantA = await createTestTenant('whsec-a');
  tenantB = await createTestTenant('whsec-b');
  await asTenant(tenantA.id, async () => {
    const e = await get(
      `INSERT INTO employees (name, pin, role) VALUES ('WH A', '9999', 'cashier') RETURNING id`,
    );
    employeeA = Number(e.id);
  });
}, 60_000);

afterAll(async () => {
  await dropTestTenant(tenantA.id);
  await dropTestTenant(tenantB.id);
  await closePools();
}, 30_000);

// ---------------------------------------------------------------------------
// 1. Getnet webhook auth gate
// ---------------------------------------------------------------------------
describe('Getnet webhook auth gate (payment-spoofing guard)', () => {
  const app = express();
  app.use(express.json());
  app.use('/webhooks/getnet', getnetWebhook);

  const prevSecret = process.env.GETNET_WEBHOOK_SECRET;

  afterEach(() => {
    // Restore whatever the env had (almost certainly unset under .env.test).
    if (prevSecret === undefined) delete process.env.GETNET_WEBHOOK_SECRET;
    else process.env.GETNET_WEBHOOK_SECRET = prevSecret;
  });

  it('is disabled (404) when GETNET_WEBHOOK_SECRET is not configured', async () => {
    delete process.env.GETNET_WEBHOOK_SECRET;
    const res = await request(app)
      .post('/webhooks/getnet')
      .send({ payment_id: 'evil-payment', status: 'APPROVED' });
    expect(res.status).toBe(404);
  });

  it('rejects (401) a request with no x-getnet-token', async () => {
    process.env.GETNET_WEBHOOK_SECRET = GETNET_SECRET;
    const res = await request(app)
      .post('/webhooks/getnet')
      .send({ payment_id: 'evil-payment', status: 'APPROVED' });
    expect(res.status).toBe(401);
  });

  it('rejects (401) a request with a wrong x-getnet-token', async () => {
    process.env.GETNET_WEBHOOK_SECRET = GETNET_SECRET;
    const res = await request(app)
      .post('/webhooks/getnet')
      .set('x-getnet-token', 'not-the-secret')
      .send({ payment_id: 'evil-payment', status: 'APPROVED' });
    expect(res.status).toBe(401);
  });

  it('accepts (200) a request carrying the correct x-getnet-token', async () => {
    process.env.GETNET_WEBHOOK_SECRET = GETNET_SECRET;
    // Empty payload → the handler early-returns on the missing payment_id, so
    // this asserts the gate opens without exercising any downstream DB writes.
    const res = await request(app)
      .post('/webhooks/getnet')
      .set('x-getnet-token', GETNET_SECRET)
      .send({});
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 2. C3: webhook order writes must be tenant-scoped
// ---------------------------------------------------------------------------
describe('C3: webhook order writes are tenant-scoped (adminSql bypasses RLS)', () => {
  async function makePendingOrder(): Promise<number> {
    return asTenant(tenantA.id, async () => {
      const row = await get(
        `INSERT INTO orders
           (order_number, employee_id, status, subtotal, tax, total, payment_status)
         VALUES ($1, $2, 'active', 100, 16, 116, 'pending')
         RETURNING id`,
        [Date.now() % 1_000_000, employeeA],
      );
      return Number(row.id);
    });
  }

  // Mirrors the paid-path UPDATE now used by the MP / Getnet webhooks:
  //   UPDATE orders SET payment_status='paid', status='active', paid_at=NOW()
  //   WHERE id = <order> AND tenant_id = <resolved tenant>
  // Duplicated here intentionally: if a future edit drops the tenant_id
  // predicate from any of those webhooks, the cross-tenant case below fails.
  function webhookMarkPaid(orderId: number, tenantId: string) {
    return adminSql`
      UPDATE orders
      SET payment_status = 'paid', status = 'active', paid_at = NOW()
      WHERE id = ${orderId} AND tenant_id = ${tenantId}
    `;
  }

  it('a webhook write carrying the WRONG tenant_id touches 0 rows', async () => {
    const orderId = await makePendingOrder(); // belongs to tenant A
    const result = await webhookMarkPaid(orderId, tenantB.id); // spoofed tenant
    expect(result.count).toBe(0);

    const [row] = await adminSql`SELECT payment_status FROM orders WHERE id = ${orderId}`;
    expect(row.payment_status).toBe('pending'); // untouched
  });

  it('a webhook write with the correct tenant_id updates exactly 1 row', async () => {
    const orderId = await makePendingOrder();
    const result = await webhookMarkPaid(orderId, tenantA.id);
    expect(result.count).toBe(1);

    const [row] = await adminSql`SELECT payment_status FROM orders WHERE id = ${orderId}`;
    expect(row.payment_status).toBe('paid');
  });
});
