// Late Clip approvals on kiosk orders.
//
// A decline on the Clip reader is not final — the guest can pay the same intent
// with another card. We used to stop reading the intent the moment the order
// was marked 'failed', so the reader collected the money and the order stayed
// "sin cobrar" (order 20261110013, 2026-11-10). The invariants:
//
//   1. failed order, Clip now APPROVED   → settled: paid + active.
//   2. failed order, Clip still REJECTED → untouched.
//   3. A cancelled (pay-first) order whose intent is approved is revived to
//      'active' — the money is in, the kitchen has to make it.
//   4. An order a cashier reset to 'unpaid' still settles from its old intent.
//   5. resolveKioskTerminalCharge (cashier claim / kiosk retry) reports 'paid'
//      for a late approval and 'none' otherwise — and never cancels the intent.
//   6. The background sweep finds and settles a late approval on its own.
//   7. A paid order is never re-read.
//
// Clip is mocked (no sandbox exists); the DB is the Neon test branch.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const clip = vi.hoisted(() => ({
  getClipAuthHeader: vi.fn(async () => 'Basic dGVzdDp0ZXN0'),
  getPinPadPayment: vi.fn(),
  cancelPinPadPayment: vi.fn(),
}));

vi.mock('../server/services/clip.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, ...clip };
});

import {
  createTestTenant,
  dropTestTenant,
  asTenant,
  closePools,
  type TestTenant,
} from './helpers/db.js';
// @ts-ignore
import { adminSql, get } from '../server/db/index.js';
// @ts-ignore
import { resolveKioskTerminalCharge, syncKioskClipCharge } from '../server/routes/kiosk.js';
// @ts-ignore
import { sweepKioskClipLateApprovals } from '../server/lib/kioskClipLateApprovals.js';

const INTENT = 'pinpad-test-late-approval';
const APPROVED = { pinpad_request_id: INTENT, status: 'APPROVED', amount: 116 };
const REJECTED = { pinpad_request_id: INTENT, status: 'REJECTED', amount: 116 };

let tenant: TestTenant;
let employeeId: number;
let seq = 0;

async function insertKioskOrder(opts: {
  paymentStatus: string;
  status?: string;
  fired?: boolean;
  intent?: string | null;
}): Promise<number> {
  const { paymentStatus, status = 'active', fired = true, intent = INTENT } = opts;
  seq += 1;
  return asTenant(tenant.id, async () => {
    const row = await get(
      `INSERT INTO orders
         (order_number, employee_id, status, subtotal, tax, total, payment_status, payment_method,
          source, clip_payment_id, clip_terminal_id, kitchen_fire_at)
       VALUES ($1, $2, $3, 100, 16, 116, $4, 'card', 'customer_kiosk', $5, 'CLIP_TEST',
               CASE WHEN $6 THEN NOW() ELSE NULL END)
       RETURNING id`,
      [(Date.now() % 1_000_000) + seq, employeeId, status, paymentStatus, intent, fired],
    );
    return Number(row.id);
  });
}

async function orderState(id: number) {
  const [row] = await adminSql`
    SELECT status, payment_status FROM orders WHERE id = ${id} AND tenant_id = ${tenant.id}
  `;
  return row;
}

beforeAll(async () => {
  tenant = await createTestTenant('kcliplate');
  await asTenant(tenant.id, async () => {
    const emp = await get(
      `INSERT INTO employees (name, pin, role) VALUES ('Kiosk', '8877', 'cashier') RETURNING id`,
    );
    employeeId = Number(emp.id);
  });
});

afterAll(async () => {
  await dropTestTenant(tenant.id);
  await closePools();
});

beforeEach(async () => {
  clip.getPinPadPayment.mockReset();
  clip.cancelPinPadPayment.mockReset();
  // Each test starts with no leftover recheckable rows, so the sweep test only
  // sees its own order.
  await adminSql`
    UPDATE orders SET clip_payment_id = NULL
    WHERE tenant_id = ${tenant.id} AND payment_status <> 'paid'
  `;
});

describe('syncKioskClipCharge — late approval', () => {
  it('failed order whose intent is now approved → paid and active', async () => {
    const id = await insertKioskOrder({ paymentStatus: 'failed' });
    clip.getPinPadPayment.mockResolvedValue(APPROVED);

    const synced = await syncKioskClipCharge(id, tenant.id);

    expect(synced?.mapped).toBe('paid');
    expect(await orderState(id)).toMatchObject({ status: 'active', payment_status: 'paid' });
  });

  it('failed order whose intent is still rejected → untouched', async () => {
    const id = await insertKioskOrder({ paymentStatus: 'failed' });
    clip.getPinPadPayment.mockResolvedValue(REJECTED);

    const synced = await syncKioskClipCharge(id, tenant.id);

    expect(synced?.mapped).toBe('failed');
    expect(await orderState(id)).toMatchObject({ status: 'active', payment_status: 'failed' });
  });

  it('cancelled pay-first order whose intent is approved → revived to active', async () => {
    const id = await insertKioskOrder({ paymentStatus: 'failed', status: 'cancelled', fired: false });
    clip.getPinPadPayment.mockResolvedValue(APPROVED);

    await syncKioskClipCharge(id, tenant.id);

    expect(await orderState(id)).toMatchObject({ status: 'active', payment_status: 'paid' });
  });

  it('order a cashier reset to unpaid still settles from its old intent', async () => {
    const id = await insertKioskOrder({ paymentStatus: 'unpaid' });
    clip.getPinPadPayment.mockResolvedValue(APPROVED);

    await syncKioskClipCharge(id, tenant.id);

    expect(await orderState(id)).toMatchObject({ payment_status: 'paid' });
  });

  it('a paid order is never re-read', async () => {
    const id = await insertKioskOrder({ paymentStatus: 'paid' });

    expect(await syncKioskClipCharge(id, tenant.id)).toBeNull();
    expect(clip.getPinPadPayment).not.toHaveBeenCalled();
  });
});

describe('resolveKioskTerminalCharge — late approval', () => {
  it('failed + approved → paid, without cancelling the intent', async () => {
    const id = await insertKioskOrder({ paymentStatus: 'failed' });
    clip.getPinPadPayment.mockResolvedValue(APPROVED);

    expect(await resolveKioskTerminalCharge(id, tenant.id)).toBe('paid');
    expect(clip.cancelPinPadPayment).not.toHaveBeenCalled();
    expect(await orderState(id)).toMatchObject({ payment_status: 'paid' });
  });

  it('failed + still rejected → none, order untouched', async () => {
    const id = await insertKioskOrder({ paymentStatus: 'failed' });
    clip.getPinPadPayment.mockResolvedValue(REJECTED);

    expect(await resolveKioskTerminalCharge(id, tenant.id)).toBe('none');
    expect(clip.cancelPinPadPayment).not.toHaveBeenCalled();
    expect(await orderState(id)).toMatchObject({ payment_status: 'failed' });
  });

  it('Clip unreachable → none (the claim behaves as before)', async () => {
    const id = await insertKioskOrder({ paymentStatus: 'failed' });
    clip.getPinPadPayment.mockRejectedValue(new Error('Clip getPinPadPayment failed: 503'));

    expect(await resolveKioskTerminalCharge(id, tenant.id)).toBe('none');
    expect(await orderState(id)).toMatchObject({ payment_status: 'failed' });
  });

  it('failed order with no Clip intent → none, Clip never called', async () => {
    const id = await insertKioskOrder({ paymentStatus: 'failed', intent: null });

    expect(await resolveKioskTerminalCharge(id, tenant.id)).toBe('none');
    expect(clip.getPinPadPayment).not.toHaveBeenCalled();
  });
});

describe('sweepKioskClipLateApprovals', () => {
  it('settles a failed order Clip approved, and leaves a rejected one alone', async () => {
    const approvedId = await insertKioskOrder({ paymentStatus: 'failed', intent: 'pinpad-sweep-approved' });
    const rejectedId = await insertKioskOrder({ paymentStatus: 'failed', intent: 'pinpad-sweep-rejected' });
    clip.getPinPadPayment.mockImplementation(async (_auth: string, intent: string) =>
      intent === 'pinpad-sweep-approved' ? { ...APPROVED, pinpad_request_id: intent } : { ...REJECTED, pinpad_request_id: intent },
    );

    await sweepKioskClipLateApprovals();

    expect(await orderState(approvedId)).toMatchObject({ status: 'active', payment_status: 'paid' });
    expect(await orderState(rejectedId)).toMatchObject({ payment_status: 'failed' });
  });
});
