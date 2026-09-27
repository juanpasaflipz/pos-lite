// MP Point fee extraction (server/services/mercadopago.js extractMpFees).
//
// Orders-API Point payments carry an Orders id (`PAY01…`) that
// GET /v1/payments/{id} 404s on; the classic numeric payment id that holds
// fee_details is in `reference_id`. Looking up `payment.id` left
// order_payments.processor_fee NULL on every Point payment for months
// (verified against production 2026-09-26: PAY id → 404, reference_id → 200
// with mercadopago_fee 11.94 on a $294 charge). Shapes below are copied from
// those real responses.

import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-ignore — server files are plain JS
import { extractMpFees } from '../server/services/mercadopago.js';

const ORDER = {
  id: 'ORD01M3FBXY4FAPKPS25M2AV1X5X3',
  transactions: {
    payments: [
      {
        id: 'PAY01M3FBXY4RN1RJRMVNTVZ5BYE8',
        reference_id: '128934441234',
        status: 'processed',
        status_detail: 'accredited',
        amount: '294.00',
        paid_amount: '294.00',
      },
    ],
  },
};

const PAYMENT_DETAIL = {
  id: 128934441234,
  transaction_amount: 294,
  fee_details: [{ type: 'mercadopago_fee', amount: 11.94 }],
  transaction_details: { net_received_amount: 282.06 },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('extractMpFees', () => {
  it('looks the payment up by reference_id, not the Orders-API PAY id', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.endsWith('/v1/payments/128934441234')
        ? new Response(JSON.stringify(PAYMENT_DETAIL), { status: 200 })
        : new Response('{"message":"not found"}', { status: 404 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const fees = await extractMpFees('token', ORDER);

    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe(
      'https://api.mercadopago.com/v1/payments/128934441234',
    );
    expect(fees.fee).toBeCloseTo(11.94, 2);
    expect(fees.net).toBeCloseTo(282.06, 2);
    expect(fees.raw).toEqual(PAYMENT_DETAIL);
  });

  it('falls back to payment.id when there is no reference_id (legacy shape)', async () => {
    const legacy = {
      transactions: { payments: [{ id: '555', amount: '100.00', status: 'processed' }] },
    };
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ transaction_amount: 100, fee_details: [{ amount: 4.06 }] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const fees = await extractMpFees('token', legacy);
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe('https://api.mercadopago.com/v1/payments/555');
    expect(fees.fee).toBeCloseTo(4.06, 2);
    expect(fees.net).toBeCloseTo(95.94, 2);
  });

  it('still records the payment (fee null) when MP lookup fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    const fees = await extractMpFees('token', ORDER);
    expect(fees.fee).toBeNull();
    expect(fees.net).toBeNull();
  });
});
