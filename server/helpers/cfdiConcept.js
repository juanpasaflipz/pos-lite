// Generic-concept CFDI 4.0 payload builder for restaurant tickets.
//
// Restaurants in Mexico invoice a ticket as a single Concepto ("Consumo de
// alimentos y bebidas") rather than itemizing each product. This has two
// legal consequences:
//   1. The one concept carries only IVA — any IEPS embedded in beer /
//      michelada prices STAYS embedded in the price per LIEPS Art. 19-II.
//      Do not add IEPS tax nodes here.
//   2. The stamped CFDI Total must equal the ticket total the customer
//      paid, to the cent.
//
// TAX MODE — how we send the concept to Facturapi:
//   We send `tax_included: true` with `price = ticket_total`, and let
//   Facturapi back-split the tax-inclusive amount internally. This is the
//   ONLY mode that guarantees `stamped.total === ticket_total` on
//   adversarial totals like $100.01 or $288.37. The two alternatives we
//   tested against the live sandbox both failed:
//     - tax_included=false + rate-only: Facturapi recomputes IVA as
//       round(subtotal*0.16); for some totals no 2-decimal subtotal exists
//       such that subtotal + round(subtotal*0.16) == ticket_total. Drift
//       ±1 cent, verified on $100.01 (stamped 100.02) and $288.37
//       (stamped 288.36).
//     - tax_included=false + explicit `amount` on the tax node: rejected
//       by Facturapi with `"items[0].product.taxes[0].amount" is not allowed`.
//   The local splitTaxInclusive() is therefore ADVISORY — used only for
//   populating cfdi_invoices.subtotal / cfdi_invoices.tax_total for our
//   own accounting/audit. Facturapi's internal split (baked into the
//   stamped XML) is authoritative; the response does not surface it, so
//   the local value is a best-effort mirror within ±1 cent.
//
// The route layer wraps buildGenericInvoicePayload + verifyStampedTotal
// around Facturapi createInvoice; verify only checks TOTAL (subtotal
// isn't returned by Facturapi), and on mismatch the route persists a
// row with status='stamped_mismatch' + best-effort cancel so the partial
// unique index keeps blocking double-stamps.

import { IVA_RATE_BPS, splitTaxInclusive, toCents, fromCents } from './money.js';

// Default description text. Named constant because it will eventually be
// tenant-configurable in Desktop Kitchen (some merchants prefer "Consumo
// de alimentos" without "y bebidas").
export const GENERIC_DESCRIPTION = 'Consumo de alimentos y bebidas';

// SAT catalog constants for the restaurant generic concept.
//   90101500 — Establecimientos para comer y beber (industry class)
//   E48      — Unidad de servicio
export const GENERIC_PRODUCT_KEY = '90101500';
export const GENERIC_UNIT_KEY = 'E48';
export const GENERIC_UNIT_NAME = 'Servicio';

// Facturapi expects the rate as a decimal fraction (0.16, not "16" or
// 1600). Derive it once from IVA_RATE_BPS so there's still exactly one
// source of truth for the rate itself.
const IVA_RATE_DECIMAL = IVA_RATE_BPS / 10000;

/**
 * Build the Facturapi payload for a generic-concept restaurant CFDI.
 *
 * Contract: the concept carries the tax-inclusive ticket total as its
 * unit price, with tax_included=true and a single IVA traslado node.
 * Facturapi back-splits the total internally, guaranteeing that the
 * stamped CFDI Total equals the ticket total to the cent even on
 * adversarial totals like $100.01. The route layer STILL calls
 * verifyStampedTotal() as a defense-in-depth check against provider
 * regressions.
 *
 * @param {object} args
 * @param {object} args.order - Order row. Must have `total` (tax-inclusive,
 *   after discounts + platform adjustments). Only `total` is read; the
 *   order's own subtotal/tax fields are ignored on purpose — the CFDI
 *   subtotal is derived from `total` so the ticket the customer paid is
 *   authoritative (see plan: "Persist computed values, not orders.subtotal").
 * @param {object} args.receptor - Validated receptor { rfc, name, tax_regime, postal_code, uso_cfdi }.
 * @param {object} args.config - cfdi_config row. Reads: invoice_series.
 * @param {string} args.formaPago - SAT forma de pago code (e.g. '01', '04').
 * @param {string} [args.metodoPago='PUE'] - SAT metodo de pago.
 * @param {object} [args.global] - Optional CFDI 4.0 global node (público en general path).
 * @param {string} [args.description=GENERIC_DESCRIPTION] - Concept description override.
 * @returns {{
 *   payload: object,
 *   subtotalCents: number,
 *   taxCents: number,
 *   totalCents: number,
 * }}
 */
export function buildGenericInvoicePayload({
  order,
  receptor,
  config,
  formaPago,
  metodoPago = 'PUE',
  global,
  description = GENERIC_DESCRIPTION,
}) {
  if (!order || order.total == null) {
    throw new Error('buildGenericInvoicePayload: order.total is required');
  }
  if (!receptor || !receptor.rfc) {
    throw new Error('buildGenericInvoicePayload: receptor is required');
  }

  const totalCents = toCents(order.total);
  if (totalCents <= 0) {
    throw new Error(`buildGenericInvoicePayload: order total must be > 0 (got ${order.total})`);
  }

  const { subtotalCents, taxCents } = splitTaxInclusive(totalCents, IVA_RATE_BPS);

  const payload = {
    type: 'I', // Ingreso
    customer: {
      legal_name: receptor.name,
      tax_id: receptor.rfc,
      tax_system: receptor.tax_regime,
      address: { zip: receptor.postal_code },
    },
    use: receptor.uso_cfdi || 'G03',
    payment_form: formaPago,
    payment_method: metodoPago,
    items: [
      {
        quantity: 1,
        product: {
          description,
          product_key: GENERIC_PRODUCT_KEY,
          unit_key: GENERIC_UNIT_KEY,
          unit_name: GENERIC_UNIT_NAME,
          // Ticket total as the unit price, marked tax-inclusive. See the
          // module header for why: this is the only mode Facturapi accepts
          // that guarantees stamped Total == ticket total on adversarial
          // amounts like $100.01. Facturapi back-splits internally.
          price: fromCents(totalCents),
          tax_included: true,
          // IEPS is intentionally absent. Beer/michelada IEPS stays embedded
          // in the ticket price per LIEPS Art. 19-II; only IVA is broken
          // out on customer-facing invoices.
          taxes: [
            { type: 'IVA', rate: IVA_RATE_DECIMAL, factor: 'Tasa' },
          ],
        },
      },
    ],
  };

  if (config?.invoice_series) payload.series = config.invoice_series;
  if (global) payload.global = global;

  return { payload, subtotalCents, taxCents, totalCents };
}

/**
 * Extract the authoritative SubTotal / IVA / Total from a stamped CFDI 4.0
 * XML. These are the 2-decimal display values that appear on the printed
 * invoice and that SAT holds on record — what an accountant will
 * reconcile IVA declarations against.
 *
 * Uses attribute-level regex (no XML parser) — three attributes at fixed
 * positions in the cfdi:Comprobante and cfdi:Impuestos elements. If the
 * XML is missing or malformed, returns null and the caller falls back to
 * the advisory local split.
 *
 * The Total regex is anchored on a leading `[\s<]` to avoid matching the
 * `TotalImpuestosTrasladados` attribute on `<cfdi:Impuestos>`, which also
 * starts with "Total".
 *
 * @param {string} xml - Stamped CFDI 4.0 XML content.
 * @returns {{ subtotalCents: number, taxCents: number, totalCents: number } | null}
 */
export function extractCfdiTotals(xml) {
  if (typeof xml !== 'string' || xml.length === 0) return null;

  const subMatch = xml.match(/\bSubTotal="([^"]+)"/);
  const totMatch = xml.match(/[\s<]Total="([^"]+)"/);
  const ivaMatch = xml.match(/\bTotalImpuestosTrasladados="([^"]+)"/);

  if (!subMatch || !totMatch) return null;

  const subNum = Number(subMatch[1]);
  const totNum = Number(totMatch[1]);
  // Fallback `totNum - subNum` is only valid because the generic-concept
  // CFDI carries IVA trasladado and nothing else — no IEPS, no retenciones.
  // If a future invoice type adds retenciones the identity becomes
  //   Total = SubTotal + Traslados − Retenciones
  // and this derivation is wrong; require the aggregate node then.
  const ivaNum = ivaMatch ? Number(ivaMatch[1]) : totNum - subNum;

  if (!Number.isFinite(subNum) || !Number.isFinite(totNum) || !Number.isFinite(ivaNum)) return null;

  return {
    subtotalCents: toCents(subNum),
    taxCents: toCents(ivaNum),
    totalCents: toCents(totNum),
  };
}

/**
 * Post-stamp verification: assert that Facturapi's stamped Total agrees
 * with the ticket total to the cent. Under Mode C (tax_included=true,
 * price=total) Facturapi's back-split should always match; this check is
 * defense-in-depth against a provider regression.
 *
 * Returns a discriminated result. The caller (route layer) is responsible
 * for the mismatch action (best-effort cancel + 502 to client + audit).
 *
 * @param {object} invoiceResponse - Facturapi createInvoice response.
 * @param {number} expectedTotalCents - Ticket total in cents.
 * @returns {{ ok: true } | { ok: false, expected: number, actual: number, deltaCents: number }}
 */
export function verifyStampedTotal(invoiceResponse, expectedTotalCents) {
  if (!invoiceResponse || invoiceResponse.total == null) {
    return {
      ok: false,
      expected: expectedTotalCents,
      actual: NaN,
      deltaCents: NaN,
      reason: 'response missing total',
    };
  }
  const actualCents = toCents(invoiceResponse.total);
  if (actualCents === expectedTotalCents) {
    return { ok: true };
  }
  return {
    ok: false,
    expected: expectedTotalCents,
    actual: actualCents,
    deltaCents: actualCents - expectedTotalCents,
    reason: 'total mismatch',
  };
}
