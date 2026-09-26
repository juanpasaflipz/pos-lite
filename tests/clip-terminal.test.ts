// Clip PinPad service tests — request shape, status mapping, cancel semantics
// and fee/tip accounting, pinned to the examples in Clip's PinPad API docs
// (developer.clip.mx, fetched 2026-09-26). Clip has no sandbox, so these are
// the only automated guard on the wire contract:
//
//   1. createPinPadPayment must send decimal pesos + `serial_number_pos` +
//      `reference`. The pre-docs scaffold sent cents, which would have asked
//      the reader for 100× the order total.
//   2. cancelPinPadPayment must report "not cancelled" (not throw, not
//      succeed) on Clip's 400 — the route relies on that to keep the order
//      pending instead of freeing an order the reader may still charge.
//   3. mapStatus must never return 'failed' for an undocumented status: a
//      false 'failed' frees the order for a second charge.

import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-ignore — server files are plain JS
import {
  createPinPadPayment,
  getPinPadPayment,
  cancelPinPadPayment,
  listPinPadDevices,
  mapStatus,
  isKnownStatus,
  summarizeClipPayment,
  ClipApiError,
} from '../server/services/clip.js';

const AUTH = 'Basic dGVzdDp0ZXN0';

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn(async () =>
    new Response(body === undefined ? '' : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createPinPadPayment: request shape', () => {
  it('sends decimal pesos, serial_number_pos and reference to /f2f/pinpad/v1/payment', async () => {
    const fetchMock = mockFetch(200, {
      pinpad_request_id: 'pinpad-6a405173-c661-414a-9a8f-ecc77a9afe3f',
      reference: 'ten-42-1',
      amount: '200.50',
      serial_number_pos: 'P8220724000042',
    });

    const out = await createPinPadPayment(AUTH, {
      amount: 200.5,
      tipAmount: 20,
      reference: 'ten-42-1',
      serialNumber: 'P8220724000042',
      webhookUrl: 'https://juanbertos.desktop.kitchen/api/payments/clip/webhook',
    });

    expect(out.pinpad_request_id).toBe('pinpad-6a405173-c661-414a-9a8f-ecc77a9afe3f');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.payclip.io/f2f/pinpad/v1/payment');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(AUTH);

    const body = JSON.parse(String(init.body));
    expect(body.amount).toBe(200.5);
    expect(body.tip_amount).toBe(20);
    expect(body.serial_number_pos).toBe('P8220724000042');
    expect(body.reference).toBe('ten-42-1');
    expect(body.webhook_url).toBe('https://juanbertos.desktop.kitchen/api/payments/clip/webhook');
    // A second tip screen on the reader would let the customer tip twice.
    expect(body.preferences.is_tip_enabled).toBe(false);
    // Legacy guessed field names must be gone.
    expect(body.pinpad_id).toBeUndefined();
    expect(body.external_reference).toBeUndefined();
  });

  it('omits tip_amount when there is no tip, and rounds to centavos', async () => {
    const fetchMock = mockFetch(200, { pinpad_request_id: 'pinpad-x' });
    await createPinPadPayment(AUTH, { amount: 99.999, reference: 'r', serialNumber: 'S1' });
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.amount).toBe(100);
    expect('tip_amount' in body).toBe(false);
    expect('webhook_url' in body).toBe(false);
  });

  it('surfaces the offline-reader error code from a 400', async () => {
    mockFetch(400, {
      code: 'PINPAD_TERMINAL_TIMEOUT_EXCEPTION',
      message: 'Unable to connect to pinpad terminal.',
    });
    const err = await createPinPadPayment(AUTH, { amount: 10, reference: 'r', serialNumber: 'S1' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClipApiError);
    expect((err as { code: string }).code).toBe('PINPAD_TERMINAL_TIMEOUT_EXCEPTION');
    expect((err as { status: number }).status).toBe(400);
  });

  it('surfaces the Health Check ERR10_04 (reader off / app closed / mid-charge)', async () => {
    mockFetch(400, {
      code: 'ERR10_04',
      name: 'STORING PAYMENT - DEVICE UNAVAILABLE',
      message: 'The Clip terminal is either offline, powered off, or the Pinpad application is closed',
    });
    const err = await createPinPadPayment(AUTH, { amount: 10, reference: 'r', serialNumber: 'S1' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClipApiError);
    expect((err as { code: string }).code).toBe('ERR10_04');
  });

  it('rejects a 200 without pinpad_request_id instead of storing undefined', async () => {
    mockFetch(200, { amount: '10.00' });
    await expect(createPinPadPayment(AUTH, { amount: 10, reference: 'r', serialNumber: 'S1' })).rejects.toThrow(
      /pinpad_request_id/,
    );
  });
});

describe('getPinPadPayment', () => {
  it('queries by pinpadRequestId with the detail header', async () => {
    const fetchMock = mockFetch(200, { pinpad_request_id: 'pinpad-1', status: 'PENDING' });
    const payment = await getPinPadPayment(AUTH, 'pinpad-1');
    expect(payment.status).toBe('PENDING');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.payclip.io/f2f/pinpad/v1/payment?pinpadRequestId=pinpad-1');
    expect((init.headers as Record<string, string>)['Pinpad-Include-Detail']).toBe('true');
  });

  it('returns null on 404', async () => {
    mockFetch(404, { code: 'NOT_FOUND' });
    expect(await getPinPadPayment(AUTH, 'pinpad-gone')).toBeNull();
  });
});

describe('cancelPinPadPayment: never claims success Clip did not give', () => {
  it('200 → cancelled', async () => {
    const fetchMock = mockFetch(200, { pinpad_request_id: 'pinpad-1' });
    expect(await cancelPinPadPayment(AUTH, 'pinpad-1')).toEqual({ cancelled: true });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.payclip.io/f2f/pinpad/v1/payment/pinpad-1');
    expect(init.method).toBe('DELETE');
  });

  it('400 PAYMENT_REQUEST_ISSUE (reader already took it) → not cancelled, with code', async () => {
    mockFetch(400, {
      code: 'PAYMENT_REQUEST_ISSUE',
      message: 'The payment requested was removed or was taken successfully by CLIP POS',
    });
    expect(await cancelPinPadPayment(AUTH, 'pinpad-1')).toEqual({
      cancelled: false,
      code: 'PAYMENT_REQUEST_ISSUE',
    });
  });

  it('5xx throws so the caller keeps the order pending', async () => {
    mockFetch(503, { code: 'UNAVAILABLE' });
    await expect(cancelPinPadPayment(AUTH, 'pinpad-1')).rejects.toBeInstanceOf(ClipApiError);
  });
});

describe('listPinPadDevices', () => {
  it('normalises the devices/status array', async () => {
    const fetchMock = mockFetch(200, [
      { merchant_id: 'uuid', serial_number: 'PP35542235000286', status: 'active', updated_at: '2024-01-15T10:30:00Z' },
      { merchant_id: 'uuid', serial_number: 'PP35542235000287', status: 'EXPIRED' },
      { merchant_id: 'uuid' },
    ]);
    const devices = await listPinPadDevices(AUTH);
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe('https://api.payclip.io/f2f/pinpad/v1/devices/status');
    expect(devices).toEqual([
      { serial_number: 'PP35542235000286', status: 'active', updated_at: '2024-01-15T10:30:00Z' },
      { serial_number: 'PP35542235000287', status: 'expired', updated_at: null },
    ]);
  });

  it('empty array is a valid "no readers" answer', async () => {
    mockFetch(200, []);
    expect(await listPinPadDevices(AUTH)).toEqual([]);
  });
});

describe('mapStatus', () => {
  it('COMPLETED → paid', () => {
    expect(mapStatus({ status: 'COMPLETED' })).toBe('paid');
  });

  it('FAILED / CANCELED → failed', () => {
    expect(mapStatus({ status: 'FAILED' })).toBe('failed');
    expect(mapStatus({ status: 'CANCELED' })).toBe('failed');
    expect(mapStatus({ status: 'cancelled' })).toBe('failed');
  });

  it('PENDING and anything undocumented stay pending — never failed', () => {
    expect(mapStatus({ status: 'PENDING' })).toBe('pending');
    expect(mapStatus({ status: 'SOMETHING_NEW' })).toBe('pending');
    expect(mapStatus({})).toBe('pending');
    expect(mapStatus(null)).toBe('pending');
  });

  it('flags undocumented statuses for logging', () => {
    expect(isKnownStatus({ status: 'COMPLETED' })).toBe(true);
    expect(isKnownStatus({ status: 'SOMETHING_NEW' })).toBe(false);
  });
});

describe('summarizeClipPayment: bill / tip / fee split', () => {
  // Shape copied from Clip's GET /payment example (Pinpad-Include-Detail: true).
  const completed = {
    pinpad_request_id: 'pinpad-0d08e174',
    reference: 'r',
    amount: '200.00',
    amount_paid: '220.00',
    tip_amount: '20.00',
    status: 'COMPLETED',
    detail: {
      results: [
        {
          status: 'approved',
          amount: 220,
          paid_amount: 220,
          net_amount: 0,
          payment_method: {
            id: 'master',
            type: 'credit_card',
            card: { last_digits: '8356', issuer: 'CITIBANAMEX' },
          },
        },
      ],
    },
  };

  it('uses the configured rate when Clip reports net_amount 0 (as in its own example)', () => {
    const s = summarizeClipPayment(completed, { orderTotal: 200, feePercent: 4.176 });
    expect(s).toMatchObject({
      gross: 220,
      bill: 200,
      tip: 20,
      fee: 9.19,
      net: 210.81,
      feeSource: 'estimated_fee_percent',
      card: { brand: 'master', type: 'credit_card', last4: '8356', issuer: 'CITIBANAMEX' },
    });
  });

  it('trusts a positive net_amount over the configured rate', () => {
    const withNet = {
      ...completed,
      detail: { results: [{ ...completed.detail.results[0], net_amount: 210.5 }] },
    };
    const s = summarizeClipPayment(withNet, { orderTotal: 200, feePercent: 4.176 });
    expect(s.fee).toBe(9.5);
    expect(s.feeSource).toBe('clip_net_amount');
  });

  it('leaves the fee null when there is no net and no configured rate — never guesses', () => {
    const s = summarizeClipPayment(completed, { orderTotal: 200, feePercent: null });
    expect(s.fee).toBeNull();
    expect(s.net).toBeNull();
  });

  it('derives the tip from amount_paid when tip_amount is absent', () => {
    const noTipField = { ...completed, tip_amount: undefined };
    const s = summarizeClipPayment(noTipField, { orderTotal: 200, feePercent: null });
    expect(s.tip).toBe(20);
    expect(s.bill).toBe(200);
  });
});
