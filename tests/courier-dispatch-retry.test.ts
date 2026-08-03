// Courier dispatch retry — the customer has already paid by the time
// dispatchPendingCourier runs, so a failed booking must stay re-bookable.
// Clearing pending_dispatch on failure used to strand the order: the payload
// was the only copy of the dropoff details.
//
// No network here. The test tenant has no uber_direct credentials, so
// getAccessToken() throws before any fetch — which is also a faithful
// "unknown outcome" failure (no HTTP status ⇒ retry_safe false).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestTenant, dropTestTenant, closePools, type TestTenant } from './helpers/db.js';
// @ts-ignore — server files are plain JS
import { adminSql } from '../server/db/index.js';
// @ts-ignore
import { initMigrations, runMigrations } from '../server/db/migrate.js';
// @ts-ignore
import { dispatchPendingCourier } from '../server/routes/kiosk.js';

let tenant: TestTenant;
let employeeId: number;
let platformId: number;

const DROPOFF = {
  quote_id: 'dqt_test',
  pickup_name: "Juanberto's",
  pickup_address: 'Coahuila 192 Roma Sur 06700 CDMX',
  pickup_phone_number: '+525613096835',
  dropoff_name: 'Test Customer',
  dropoff_address: 'Av. Álvaro Obregón 100, Roma Norte, CDMX',
  dropoff_phone_number: '+525613096835',
};

/** Paid order + delivery_orders row in the given dispatch state. */
async function seedDeliveryOrder(
  platformStatus: string,
  pendingDispatch: Record<string, unknown> | null
): Promise<number> {
  const [order] = await adminSql`
    INSERT INTO orders
      (tenant_id, order_number, employee_id, status, payment_status,
       subtotal, tax, total, paid_at)
    VALUES
      (${tenant.id}, ${Math.floor(Math.random() * 1e9)}, ${employeeId}, 'active', 'paid',
       200, 0, 200, NOW())
    RETURNING id
  `;
  await adminSql`
    INSERT INTO order_items (tenant_id, order_id, item_name, quantity, unit_price)
    VALUES (${tenant.id}, ${order.id}, 'Burrito', 1, 200)
  `;
  await adminSql`
    INSERT INTO delivery_orders
      (tenant_id, order_id, platform_id, platform_status, pending_dispatch)
    VALUES
      (${tenant.id}, ${order.id}, ${platformId}, ${platformStatus}, ${pendingDispatch})
  `;
  return order.id;
}

async function readDispatch(orderId: number) {
  const [row] = await adminSql`
    SELECT platform_status, pending_dispatch
    FROM delivery_orders
    WHERE tenant_id = ${tenant.id} AND order_id = ${orderId}
  `;
  return row;
}

beforeAll(async () => {
  await initMigrations();
  await runMigrations('courier-dispatch-retry-tests');
  tenant = await createTestTenant('courier-retry');
  const [emp] = await adminSql`
    INSERT INTO employees (tenant_id, name, pin, role)
    VALUES (${tenant.id}, 'Dispatch Test', '0000', 'cashier')
    RETURNING id
  `;
  employeeId = emp.id;
  const [platform] = await adminSql`
    INSERT INTO delivery_platforms (tenant_id, name, display_name)
    VALUES (${tenant.id}, 'uber_direct', 'Uber Direct')
    RETURNING id
  `;
  platformId = platform.id;
});

afterAll(async () => {
  await dropTestTenant(tenant.id);
  await closePools();
});

describe('dispatchPendingCourier — failure preserves the payload', () => {
  it('keeps pending_dispatch and records attempt bookkeeping when dispatch fails', async () => {
    const orderId = await seedDeliveryOrder('pending_payment', DROPOFF);

    const result = await dispatchPendingCourier(orderId, tenant.id);
    expect(result.delivery).toBeNull();
    expect(result.delivery_error).toBeTruthy();

    const row = await readDispatch(orderId);
    expect(row.platform_status).toBe('dispatch_failed');
    // The gap: this used to be NULL, making the order impossible to re-book.
    expect(row.pending_dispatch).not.toBeNull();
    expect(row.pending_dispatch.dropoff_address).toBe(DROPOFF.dropoff_address);
    expect(row.pending_dispatch.attempts).toBe(1);
    expect(row.pending_dispatch.last_error).toBeTruthy();
    expect(row.pending_dispatch.last_attempt_at).toBeTruthy();
    // A credentials error carries no HTTP status ⇒ outcome unknown ⇒ not auto-retried.
    expect(row.pending_dispatch.retry_safe).toBe(false);
  });

  it('re-attempts a retry-safe failure once the cooldown has elapsed', async () => {
    const orderId = await seedDeliveryOrder('dispatch_failed', {
      ...DROPOFF,
      attempts: 1,
      retry_safe: true,
      last_error: 'Card declined',
      last_attempt_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    });

    const result = await dispatchPendingCourier(orderId, tenant.id);
    expect(result.delivery).toBeNull();

    const row = await readDispatch(orderId);
    expect(row.pending_dispatch.attempts).toBe(2); // the gate opened
    expect(row.pending_dispatch.dropoff_address).toBe(DROPOFF.dropoff_address);
  });
});

describe('dispatchPendingCourier — retry guards', () => {
  it('refuses to auto-retry when the previous outcome was unknown', async () => {
    const orderId = await seedDeliveryOrder('dispatch_failed', {
      ...DROPOFF,
      attempts: 1,
      retry_safe: false,
      last_error: 'socket hang up',
      last_attempt_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    });

    const result = await dispatchPendingCourier(orderId, tenant.id);
    expect(result.delivery).toBeNull();
    expect(result.delivery_error).toContain('needs manual review');

    const row = await readDispatch(orderId);
    expect(row.pending_dispatch.attempts).toBe(1); // untouched — no second courier
  });

  it('stops after the attempt cap', async () => {
    const orderId = await seedDeliveryOrder('dispatch_failed', {
      ...DROPOFF,
      attempts: 3,
      retry_safe: true,
      last_error: 'Card declined',
      last_attempt_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    });

    const result = await dispatchPendingCourier(orderId, tenant.id);
    expect(result.delivery_error).toContain('attempts exhausted');
    const row = await readDispatch(orderId);
    expect(row.pending_dispatch.attempts).toBe(3);
  });

  it('holds off inside the cooldown window', async () => {
    const orderId = await seedDeliveryOrder('dispatch_failed', {
      ...DROPOFF,
      attempts: 1,
      retry_safe: true,
      last_error: 'Card declined',
      last_attempt_at: new Date().toISOString(),
    });

    const result = await dispatchPendingCourier(orderId, tenant.id);
    expect(result.delivery_error).toContain('cooling down');
    const row = await readDispatch(orderId);
    expect(row.pending_dispatch.attempts).toBe(1);
  });

  it('force overrides every guard — the manual re-dispatch escape hatch', async () => {
    // Worst case for the auto path: unknown outcome AND the cap spent AND
    // inside the cooldown. An operator who checked the Uber dashboard can
    // still re-book, which is the whole point of the button.
    const orderId = await seedDeliveryOrder('dispatch_failed', {
      ...DROPOFF,
      attempts: 5,
      retry_safe: false,
      last_error: 'socket hang up',
      last_attempt_at: new Date().toISOString(),
    });

    const blocked = await dispatchPendingCourier(orderId, tenant.id);
    expect(blocked.delivery_error).toContain('needs manual review');
    expect((await readDispatch(orderId)).pending_dispatch.attempts).toBe(5);

    await dispatchPendingCourier(orderId, tenant.id, { force: true });
    const row = await readDispatch(orderId);
    expect(row.pending_dispatch.attempts).toBe(6); // it actually tried
    expect(row.pending_dispatch.dropoff_address).toBe(DROPOFF.dropoff_address);
  });

  it('leaves legacy failures (payload already discarded) reporting the old error', async () => {
    const orderId = await seedDeliveryOrder('dispatch_failed', null);

    const result = await dispatchPendingCourier(orderId, tenant.id);
    expect(result.delivery).toBeNull();
    expect(result.delivery_error).toBe('Courier dispatch previously failed');
  });

  it('does not re-dispatch an order that already has a courier', async () => {
    const orderId = await seedDeliveryOrder('pickup', null);
    await adminSql`
      UPDATE delivery_orders
      SET external_order_id = 'del_existing', tracking_url = 'https://track.example'
      WHERE tenant_id = ${tenant.id} AND order_id = ${orderId}
    `;

    const result = await dispatchPendingCourier(orderId, tenant.id);
    expect(result.delivery_error).toBeNull();
    expect(result.delivery?.external_id).toBe('del_existing');
  });
});
