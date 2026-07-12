// Pure-function tests for the generic-concept CFDI pipeline.
//
// No DB, no HTTP — these exercise the money math, the payload shape, and
// the post-stamp verification. The load-bearing invariants are:
//
//   1. splitTaxInclusive(total).subtotal + tax === total, always. If naive
//      rounding of total/1.16 leaves a 1-cent drift, the drift is folded
//      back into the subtotal so the CFDI Total matches the ticket Total
//      to the cent (spec §"Requirements for the math" #2).
//
//   2. The generic-concept payload carries exactly one IVA tax node — no
//      IEPS, ever. Beer/michelada IEPS stays embedded in the tax-inclusive
//      ticket price per LIEPS Art. 19-II.
//
//   3. verifyStampedTotal() flags any 1-cent divergence between Facturapi's
//      recomputed Total and our expected total; the route layer uses this
//      to auto-cancel + hard-fail so a legally-broken CFDI never reaches
//      the customer.

import { describe, expect, it } from 'vitest';
// @ts-ignore
import { toCents, fromCents, splitTaxInclusive, IVA_RATE_BPS } from '../server/helpers/money.js';
// @ts-ignore
import {
  buildGenericInvoicePayload,
  verifyStampedTotal,
  extractCfdiTotals,
  GENERIC_DESCRIPTION,
  GENERIC_PRODUCT_KEY,
  GENERIC_UNIT_KEY,
} from '../server/helpers/cfdiConcept.js';

// ---------- money.js ----------

describe('toCents / fromCents', () => {
  it('round-trips clean two-decimal values', () => {
    expect(toCents(288.37)).toBe(28837);
    expect(toCents(0.01)).toBe(1);
    expect(toCents(1000)).toBe(100000);
    expect(fromCents(28837)).toBe(288.37);
    expect(fromCents(1)).toBe(0.01);
  });

  it('rejects non-finite input', () => {
    expect(() => toCents(NaN)).toThrow();
    expect(() => toCents(Infinity)).toThrow();
    expect(() => fromCents(1.5 as unknown as number)).toThrow();
  });
});

// ---------- splitTaxInclusive: adversarial totals ----------
//
// The whole point of the "adjust subtotal by remainder" branch is to handle
// totals that are NOT expressible as x × 1.16 for any 2-decimal x. Naive
// division would either leave a 1-cent drift or fail to add back to the
// original total. Enumerate a mix of clean-and-drift cases and assert the
// invariant on every one.

describe('splitTaxInclusive — subtotal + tax === total, always', () => {
  const cases: Array<{ label: string; total: number }> = [
    // "Clean" totals — divisible cleanly by 1.16 at 2 decimals.
    { label: '$116.00 (exact)', total: 116.00 },
    { label: '$0.01 (edge)', total: 0.01 },
    { label: '$1.00', total: 1.00 },

    // Totals from the spec — chosen precisely to stress rounding.
    { label: '$288.37', total: 288.37 },
    { label: '$101.00', total: 101.00 },
    { label: '$73.37', total: 73.37 },
    { label: '$99.99', total: 99.99 },

    // Extra: user asked for totals that are demonstrably NOT × 1.16 clean,
    // to prove the drift-reconciliation branch actually runs.
    { label: '$100.01 (not × 1.16)', total: 100.01 },
    { label: '$50.01 (not × 1.16)', total: 50.01 },
    { label: '$0.10', total: 0.10 },
    { label: '$1234.56', total: 1234.56 },
    { label: '$16.00', total: 16.00 },
  ];

  for (const { label, total } of cases) {
    it(`invariant holds for ${label}`, () => {
      const totalCents = toCents(total);
      const { subtotalCents, taxCents } = splitTaxInclusive(totalCents, IVA_RATE_BPS);
      expect(subtotalCents + taxCents).toBe(totalCents);
      // Also sanity-check the IVA is in the right ballpark (within 1 cent
      // of 16% of subtotal — that 1 cent is exactly the reconciled drift).
      const naiveIva = Math.round(subtotalCents * 0.16);
      expect(Math.abs(taxCents - naiveIva)).toBeLessThanOrEqual(1);
    });
  }

  it('at least one adversarial total actually triggers drift reconciliation', () => {
    // Prove the branch isn't dead code: for $100.01, the naive IVA
    // (subtotal × 0.16, rounded) diverges from our reconciled taxCents by
    // exactly 1 cent. If we never diverged, the whole helper would be
    // trivial and the whole test file would be pointless.
    const { subtotalCents, taxCents } = splitTaxInclusive(toCents(100.01), IVA_RATE_BPS);
    const naiveIva = Math.round(subtotalCents * 0.16);
    expect(taxCents).not.toBe(naiveIva);
  });

  it('rejects non-integer input', () => {
    expect(() => splitTaxInclusive(288.37 as unknown as number)).toThrow();
    expect(() => splitTaxInclusive(28837, -1)).toThrow();
  });
});

// ---------- buildGenericInvoicePayload ----------

const RECEPTOR = {
  rfc: 'ABC010203XYZ',
  name: 'ACME SA DE CV',
  tax_regime: '601',
  postal_code: '01000',
  uso_cfdi: 'G03',
};

const CONFIG = { invoice_series: 'DK' };

describe('buildGenericInvoicePayload — payload shape', () => {
  it('produces a single concept with SAT keys 90101500 / E48 / Servicio', () => {
    const { payload } = buildGenericInvoicePayload({
      order: { total: 288.37 },
      receptor: RECEPTOR,
      config: CONFIG,
      formaPago: '01',
    });
    expect(payload.items).toHaveLength(1);
    const item = payload.items[0];
    expect(item.quantity).toBe(1);
    expect(item.product.description).toBe(GENERIC_DESCRIPTION);
    expect(item.product.product_key).toBe(GENERIC_PRODUCT_KEY);
    expect(item.product.product_key).toBe('90101500');
    expect(item.product.unit_key).toBe(GENERIC_UNIT_KEY);
    expect(item.product.unit_key).toBe('E48');
    expect(item.product.unit_name).toBe('Servicio');
    // tax_included=true: Facturapi does the back-split so the stamped
    // Total lands on the ticket total exactly. See the module header on
    // cfdiConcept.js for the sandbox evidence behind this choice.
    expect(item.product.tax_included).toBe(true);
  });

  it('carries exactly one IVA tax node — no IEPS on the generic concept', () => {
    // Simulate an "order with IEPS products" (beer/michelada). The generic
    // concept intentionally ignores per-item IEPS: it stays embedded in the
    // price per LIEPS Art. 19-II. Only IVA is broken out.
    const orderWithIeps = {
      total: 250.00,
      items: [
        { name: 'Michelada', unit_price: 120, has_ieps: true },
        { name: 'Taco', unit_price: 130, has_ieps: false },
      ],
    };
    const { payload } = buildGenericInvoicePayload({
      order: orderWithIeps,
      receptor: RECEPTOR,
      config: CONFIG,
      formaPago: '01',
    });
    const taxes = payload.items[0].product.taxes;
    expect(taxes).toHaveLength(1);
    expect(taxes[0].type).toBe('IVA');
    expect(taxes[0].rate).toBeCloseTo(0.16, 6);
    // Explicit negative assertion: no IEPS node anywhere.
    expect(taxes.some((t: { type: string }) => t.type === 'IEPS')).toBe(false);
  });

  it('sets receptor + payment fields on the payload', () => {
    const { payload } = buildGenericInvoicePayload({
      order: { total: 100 },
      receptor: RECEPTOR,
      config: CONFIG,
      formaPago: '04',
      metodoPago: 'PUE',
    });
    expect(payload.type).toBe('I');
    expect(payload.customer.tax_id).toBe('ABC010203XYZ');
    expect(payload.customer.legal_name).toBe('ACME SA DE CV');
    expect(payload.customer.tax_system).toBe('601');
    expect(payload.customer.address.zip).toBe('01000');
    expect(payload.use).toBe('G03');
    expect(payload.payment_form).toBe('04');
    expect(payload.payment_method).toBe('PUE');
    expect(payload.series).toBe('DK');
  });

  it('carries the CFDI 4.0 global node when passed (público en general path)', () => {
    // The XAXX path attaches a `global` periodicity object; the builder
    // must preserve it verbatim and NOT swap in UsoCFDI defaults meant for
    // named receptors.
    const publicoReceptor = {
      rfc: 'XAXX010101000',
      name: 'PUBLICO EN GENERAL',
      tax_regime: '616',
      postal_code: '01000',
      uso_cfdi: 'S01',
    };
    const global = { periodicity: 'day', months: '07', year: 2026 };
    const { payload } = buildGenericInvoicePayload({
      order: { total: 288.37 },
      receptor: publicoReceptor,
      config: CONFIG,
      formaPago: '01',
      global,
    });
    expect(payload.global).toEqual(global);
    expect(payload.use).toBe('S01');
    expect(payload.customer.tax_id).toBe('XAXX010101000');
    // Global path still uses the generic concept — the periodicity node is
    // additive, not a replacement for the concept structure.
    expect(payload.items).toHaveLength(1);
    expect(payload.items[0].product.product_key).toBe('90101500');
  });

  it('returns cents that reconcile to the ticket total', () => {
    const { subtotalCents, taxCents, totalCents } = buildGenericInvoicePayload({
      order: { total: 100.01 },
      receptor: RECEPTOR,
      config: CONFIG,
      formaPago: '01',
    });
    expect(totalCents).toBe(10001);
    expect(subtotalCents + taxCents).toBe(totalCents);
  });

  it('sends the ticket total as the concept price (tax_included: true)', () => {
    const { payload, totalCents } = buildGenericInvoicePayload({
      order: { total: 288.37 },
      receptor: RECEPTOR,
      config: CONFIG,
      formaPago: '01',
    });
    expect(payload.items[0].product.price).toBe(totalCents / 100);
    expect(payload.items[0].product.price).toBe(288.37);
    expect(payload.items[0].product.tax_included).toBe(true);
  });

  it('refuses zero or negative totals', () => {
    expect(() =>
      buildGenericInvoicePayload({
        order: { total: 0 },
        receptor: RECEPTOR,
        config: CONFIG,
        formaPago: '01',
      }),
    ).toThrow();
    expect(() =>
      buildGenericInvoicePayload({
        order: { total: -10 },
        receptor: RECEPTOR,
        config: CONFIG,
        formaPago: '01',
      }),
    ).toThrow();
  });
});

// ---------- verifyStampedTotal ----------

describe('verifyStampedTotal — post-stamp reconciliation gate', () => {
  it('passes when Facturapi total matches expected cents', () => {
    const result = verifyStampedTotal({ total: 288.37 }, 28837);
    expect(result.ok).toBe(true);
  });

  it('flags a 1-cent divergence (the real-world Facturapi drift case)', () => {
    // The classic mismatch: we sent subtotal=$248.59 expecting IVA=$39.78
    // and Total=$288.37, but Facturapi rounded IVA differently and stamped
    // Total=$288.36 (1 cent under).
    const result = verifyStampedTotal({ total: 288.36 }, 28837);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.expected).toBe(28837);
      expect(result.actual).toBe(28836);
      expect(result.deltaCents).toBe(-1);
    }
  });

  it('flags any other divergence too', () => {
    const result = verifyStampedTotal({ total: 300 }, 28837);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.deltaCents).toBe(1163);
  });

  it('flags a missing total on the response', () => {
    const result = verifyStampedTotal({}, 28837);
    expect(result.ok).toBe(false);
  });
});

// ---------- extractCfdiTotals — SAT-authoritative parse ----------
//
// The CFDI XML is the tax-reporting source of truth. Its 2-decimal
// SubTotal + TotalImpuestosTrasladados are what Facturapi puts on the
// printed invoice and what SAT records; persisting those (rather than our
// advisory local split) means our DB matches IVA declarations exactly.
//
// Regex-level parse — no XML lib — so these tests pin the attribute
// grep shape against real CFDI structure (verified against a Facturapi
// sandbox stamp of $100.01).

describe('extractCfdiTotals — parses SAT-authoritative CFDI attributes', () => {
  // Minimal but real-shape CFDI 4.0 fragment. Root attribute order matches
  // Facturapi's actual output: SubTotal appears before Total.
  const xml = `<?xml version="1.0" encoding="UTF-8"?>` +
    `<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" ` +
      `Certificado="MII..." SubTotal="86.22" Total="100.01" Moneda="MXN">` +
    `<cfdi:Impuestos TotalImpuestosTrasladados="13.79">` +
      `<cfdi:Traslados>` +
        `<cfdi:Traslado Base="86.215517" Importe="13.794483" Impuesto="002" TasaOCuota="0.160000" TipoFactor="Tasa"/>` +
      `</cfdi:Traslados>` +
    `</cfdi:Impuestos>` +
    `</cfdi:Comprobante>`;

  it('extracts the 2-decimal display values from the root + Impuestos node', () => {
    const out = extractCfdiTotals(xml);
    expect(out).not.toBeNull();
    expect(out!.subtotalCents).toBe(8622);
    expect(out!.taxCents).toBe(1379);
    expect(out!.totalCents).toBe(10001);
    // Reconciliation invariant: SubTotal + IVA = Total (from the XML itself).
    expect(out!.subtotalCents + out!.taxCents).toBe(out!.totalCents);
  });

  it('does not confuse the root Total attribute with TotalImpuestosTrasladados', () => {
    // Guard against a naive /Total="[^"]+"/ regex matching the aggregate
    // IVA attribute first — that would swap Total and IVA in the output.
    const swappedShape = `<cfdi:Comprobante SubTotal="248.60" Total="288.37">` +
      `<cfdi:Impuestos TotalImpuestosTrasladados="39.77"></cfdi:Impuestos></cfdi:Comprobante>`;
    const out = extractCfdiTotals(swappedShape);
    expect(out).not.toBeNull();
    expect(out!.totalCents).toBe(28837);
    expect(out!.taxCents).toBe(3977);
  });

  it('returns null for missing / malformed XML', () => {
    expect(extractCfdiTotals('')).toBeNull();
    expect(extractCfdiTotals('<invoice></invoice>')).toBeNull();
    expect(extractCfdiTotals(null as unknown as string)).toBeNull();
    expect(extractCfdiTotals(undefined as unknown as string)).toBeNull();
  });

  it('derives taxCents from Total - SubTotal when TotalImpuestosTrasladados is absent', () => {
    // Not the normal case (Facturapi always emits the aggregate node for
    // taxed invoices), but a legitimate fallback for degenerate XML.
    const noAggregate = `<cfdi:Comprobante SubTotal="86.22" Total="100.01"/>`;
    const out = extractCfdiTotals(noAggregate);
    expect(out).not.toBeNull();
    expect(out!.subtotalCents).toBe(8622);
    expect(out!.totalCents).toBe(10001);
    expect(out!.taxCents).toBe(1379);
  });
});
