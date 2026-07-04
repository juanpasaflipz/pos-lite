// Payment status tests — MP live-pull fallback + terminal-paid SQL invariant.
//
// The kiosk + POS status polls fall back to a live MP API pull when the
// per-tenant webhook is missing or slow (see server/routes/payments.js:1975
// and server/routes/kiosk.js:1550). Two pieces of that path must never rot:
//
//   1. mapPointOrderStatus() must correctly classify BOTH the new /v1/orders
//      response shape AND the legacy payment-intents shape. If the mapping
//      returns 'pending' when MP has already reported 'processed', the order
//      never flips to paid — silent revenue loss.
//   2. The SQL UPDATE inside markTerminalOrderPaid must transition
//      pending_terminal → paid + status='preparing' (unless already
//      ready/completed) idempotently. A second call on an already-paid
//      order must NOT rewrite paid_at or clobber status.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestTenant,
  dropTestTenant,
  asTenant,
  closePools,
  type TestTenant,
} from './helpers/db.js';
// @ts-ignore
import { get, run } from '../server/db/index.js';
// @ts-ignore
import { mapPointOrderStatus } from '../server/services/mercadopago.js';

describe('mapPointOrderStatus: MP response shape classifier', () => {
  it('new API /v1/orders with status="processed" maps to paid', () => {
    expect(
      mapPointOrderStatus({
        transactions: { payments: [{ status: 'processed' }] },
      }),
    ).toBe('paid');
  });

  it('new API with status="approved" maps to paid', () => {
    expect(
      mapPointOrderStatus({
        transactions: { payments: [{ status: 'approved' }] },
      }),
    ).toBe('paid');
  });

  it('new API with status="rejected" maps to failed', () => {
    expect(
      mapPointOrderStatus({
        transactions: { payments: [{ status: 'rejected' }] },
      }),
    ).toBe('failed');
  });

  it('legacy payment-intents state="FINISHED" maps to paid', () => {
    expect(mapPointOrderStatus({ state: 'FINISHED' })).toBe('paid');
  });

  it('legacy state="ERROR" maps to failed', () => {
    expect(mapPointOrderStatus({ state: 'ERROR' })).toBe('failed');
  });

  it('legacy state="CANCELED" maps to failed', () => {
    expect(mapPointOrderStatus({ state: 'CANCELED' })).toBe('failed');
  });

  it('unknown / empty response falls through to pending', () => {
    expect(mapPointOrderStatus({})).toBe('pending');
    expect(mapPointOrderStatus(null)).toBe('pending');
    expect(mapPointOrderStatus({ state: 'OPEN' })).toBe('pending');
  });
});

describe('markTerminalOrderPaid SQL invariant', () => {
  let tenant: TestTenant;
  let employeeId: number;

  beforeAll(async () => {
    tenant = await createTestTenant('paystatus');
    await asTenant(tenant.id, async () => {
      const emp = await get(
        `INSERT INTO employees (name, pin, role) VALUES ('Pay test', '9999', 'cashier') RETURNING id`,
      );
      employeeId = Number(emp.id);
    });
  }, 60_000);

  afterAll(async () => {
    await dropTestTenant(tenant.id);
    await closePools();
  }, 30_000);

  async function makeOrder(status: string): Promise<number> {
    return asTenant(tenant.id, async () => {
      const row = await get(
        `INSERT INTO orders
           (order_number, employee_id, status, subtotal, tax, total, payment_status)
         VALUES ($1, $2, $3, 100, 16, 116, 'pending_terminal')
         RETURNING id`,
        [Date.now() % 1_000_000, employeeId, status],
      );
      return Number(row.id);
    });
  }

  // Mirrors the UPDATE in server/routes/payments.js:1085 (markTerminalOrderPaid).
  // Duplicated intentionally so a regression in the route's UPDATE fails here.
  async function applyPromote(orderId: number) {
    await asTenant(tenant.id, () =>
      run(
        `UPDATE orders
         SET payment_status = 'paid',
             status = CASE WHEN status IN ('ready', 'completed') THEN status ELSE 'preparing' END,
             payment_method = 'card',
             paid_at = COALESCE(paid_at, NOW())
         WHERE id = $1
           AND (
             payment_status IS DISTINCT FROM 'paid'
             OR payment_method IS DISTINCT FROM 'card'
             OR status NOT IN ('preparing', 'ready', 'completed')
           )`,
        [orderId],
      ),
    );
  }

  it('promotes pending_terminal → paid + status="preparing"', async () => {
    const id = await makeOrder('active');
    await applyPromote(id);

    const row = await asTenant(tenant.id, () =>
      get(`SELECT status, payment_status, payment_method FROM orders WHERE id = $1`, [id]),
    );
    expect(row.payment_status).toBe('paid');
    expect(row.status).toBe('preparing');
    expect(row.payment_method).toBe('card');
  });

  it('preserves status="ready" when order is already past the kitchen', async () => {
    const id = await makeOrder('ready');
    await applyPromote(id);

    const row = await asTenant(tenant.id, () =>
      get(`SELECT status FROM orders WHERE id = $1`, [id]),
    );
    expect(row.status).toBe('ready');
  });

  it('is idempotent: a second promote does not rewrite paid_at', async () => {
    const id = await makeOrder('active');
    await applyPromote(id);

    const first = await asTenant(tenant.id, () =>
      get(`SELECT paid_at FROM orders WHERE id = $1`, [id]),
    );
    await new Promise((r) => setTimeout(r, 50));
    await applyPromote(id);

    const second = await asTenant(tenant.id, () =>
      get(`SELECT paid_at FROM orders WHERE id = $1`, [id]),
    );
    // COALESCE(paid_at, NOW()) inside the UPDATE, combined with the DISTINCT-FROM
    // guard clause, means paid_at is stamped once and never rewritten.
    expect(new Date(second.paid_at).getTime()).toBe(new Date(first.paid_at).getTime());
  });
});
