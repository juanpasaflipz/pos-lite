// Kiosk-claim guard — resolveKioskTerminalCharge (server/routes/kiosk.js).
//
// A pay-first kiosk order waiting on the MP terminal is still
// status='draft_kiosk', so it shows in the cashier's banner as a plain held
// draft. Claiming used to DELETE it while the charge was live; the customer
// tapped seconds later and MP approved a payment for a vanished order
// (2026-08-03, 09-01, 09-05, and three suspects on 09-26). The claim route now
// asks this helper first. The invariants:
//
//   1. MP says paid          → 'paid', and the order is settled (never deleted).
//   2. MP says pending, cancel succeeds → 'withdrawn' (safe to claim).
//   3. MP says pending, cancel refused  → 'in_progress' (claim must refuse).
//   4. Card cleared between cancel and re-read → 'paid', not 'withdrawn'.
//   5. No terminal charge on the order → 'none' (claim behaves as before).
//
// MP is mocked; the DB is the Neon test branch like every other suite.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mp = vi.hoisted(() => ({
  getPointOrder: vi.fn(),
  cancelPointOrder: vi.fn(),
  ensureFreshToken: vi.fn(async () => 'test-token'),
}));

vi.mock('../server/services/mercadopago.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, ...mp };
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
import { resolveKioskTerminalCharge } from '../server/routes/kiosk.js';
// @ts-ignore
import { updateTenant } from '../server/tenants.js';

const PENDING = { id: 'ORD_TEST', status: 'at_terminal', transactions: { payments: [{ status: 'pending' }] } };
const PAID = {
  id: 'ORD_TEST',
  status: 'processed',
  total_amount: '116.00',
  transactions: { payments: [{ id: 'PAY_TEST', status: 'processed', amount: '116.00', paid_amount: '116.00' }] },
};
const CANCELED = { id: 'ORD_TEST', status: 'canceled', transactions: { payments: [{ status: 'canceled' }] } };

let tenant: TestTenant;
let employeeId: number;

async function insertKioskDraftOnTerminal(paymentStatus = 'pending_terminal'): Promise<number> {
  return asTenant(tenant.id, async () => {
    const row = await get(
      `INSERT INTO orders
         (order_number, employee_id, status, subtotal, tax, total, payment_status, payment_method,
          source, mp_order_id, mp_terminal_id)
       VALUES ($1, $2, 'draft_kiosk', 100, 16, 116, $3, 'card', 'customer_kiosk', 'ORD_TEST', 'NEWLAND_TEST')
       RETURNING id`,
      [Date.now() % 1_000_000, employeeId, paymentStatus],
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
  tenant = await createTestTenant('kclaim');
  // Go through updateTenant rather than a raw UPDATE — createTenant already
  // warmed the 60s tenantCache without a token, and resolveKioskTerminalCharge
  // reads the tenant through that cache (a stale read returns 'in_progress').
  await updateTenant(tenant.id, {
    mp_access_token: 'test-token',
    mp_token_expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });
  await asTenant(tenant.id, async () => {
    const emp = await get(
      `INSERT INTO employees (name, pin, role) VALUES ('Kiosk', '8888', 'cashier') RETURNING id`,
    );
    employeeId = Number(emp.id);
  });
});

afterAll(async () => {
  await dropTestTenant(tenant.id);
  await closePools();
});

beforeEach(() => {
  mp.getPointOrder.mockReset();
  mp.cancelPointOrder.mockReset();
});

describe('resolveKioskTerminalCharge', () => {
  it('card already cleared → paid, and the order is settled instead of left for deletion', async () => {
    const id = await insertKioskDraftOnTerminal();
    mp.getPointOrder.mockResolvedValue(PAID);

    expect(await resolveKioskTerminalCharge(id, tenant.id)).toBe('paid');
    expect(mp.cancelPointOrder).not.toHaveBeenCalled();
    expect(await orderState(id)).toMatchObject({ status: 'active', payment_status: 'paid' });
  });

  it('pending + cancel accepted → withdrawn', async () => {
    const id = await insertKioskDraftOnTerminal();
    mp.getPointOrder.mockResolvedValueOnce(PENDING).mockResolvedValueOnce(CANCELED);
    mp.cancelPointOrder.mockResolvedValue(undefined);

    expect(await resolveKioskTerminalCharge(id, tenant.id)).toBe('withdrawn');
    expect(mp.cancelPointOrder).toHaveBeenCalledWith('test-token', 'NEWLAND_TEST', 'ORD_TEST');
  });

  it('pending + cancel refused (terminal mid-transaction) → in_progress', async () => {
    const id = await insertKioskDraftOnTerminal();
    mp.getPointOrder.mockResolvedValue(PENDING);
    mp.cancelPointOrder.mockRejectedValue(new Error('MP cancelPointOrder failed: 409'));

    expect(await resolveKioskTerminalCharge(id, tenant.id)).toBe('in_progress');
    expect(await orderState(id)).toMatchObject({ payment_status: 'pending_terminal' });
  });

  it('card clears between the cancel attempt and the re-read → paid', async () => {
    const id = await insertKioskDraftOnTerminal();
    mp.getPointOrder.mockResolvedValueOnce(PENDING).mockResolvedValueOnce(PAID);
    mp.cancelPointOrder.mockRejectedValue(new Error('MP cancelPointOrder failed: 409'));

    expect(await resolveKioskTerminalCharge(id, tenant.id)).toBe('paid');
    expect(await orderState(id)).toMatchObject({ payment_status: 'paid' });
  });

  it('no charge on the terminal → none, MP never called', async () => {
    const id = await insertKioskDraftOnTerminal('unpaid');
    expect(await resolveKioskTerminalCharge(id, tenant.id)).toBe('none');
    expect(mp.getPointOrder).not.toHaveBeenCalled();
  });
});
