// Money math for CFDI invoicing.
//
// Rule of the module: never touch a floating-point representation for a
// monetary quantity. Convert to integer cents at the boundary, do all
// arithmetic in integers, convert back to a decimal string only for
// display/serialization.
//
// The load-bearing function here is splitTaxInclusive(). CFDI 4.0 requires
// that Subtotal + IVA = Total to the cent — if naive rounding of
// total/1.16 produces a 1-cent drift we adjust the *subtotal* by the
// remainder so that the invariant holds. See tests/genericInvoice.test.ts
// for the adversarial cases (esp. totals like $100.01, $288.37 that force
// the drift branch).

// Basis-point representation of tax rates keeps the "single source of
// truth" contract from the plan: no inline 0.16 anywhere in the codebase.
// 1600 bps = 16.00%. Denominator is always 10000.
export const IVA_RATE_BPS = 1600;
const BPS_DENOMINATOR = 10000;

/**
 * Convert a decimal money value (e.g. 288.37) to integer cents (28837).
 * Rejects non-finite numbers to prevent NaN cascades through the CFDI math.
 * @param {number|string} amount
 * @returns {number} cents
 */
export function toCents(amount) {
  const n = typeof amount === 'string' ? Number(amount) : amount;
  if (!Number.isFinite(n)) {
    throw new TypeError(`toCents: expected finite number, got ${amount}`);
  }
  // Math.round on n*100 is safe for values well below Number.MAX_SAFE_INTEGER/100.
  // Restaurant tickets sit in the 6-figure-cent range; no precision risk.
  return Math.round(n * 100);
}

/**
 * Convert integer cents back to a decimal number (2 decimals).
 * @param {number} cents
 * @returns {number}
 */
export function fromCents(cents) {
  if (!Number.isInteger(cents)) {
    throw new TypeError(`fromCents: expected integer cents, got ${cents}`);
  }
  return cents / 100;
}

/**
 * Split a tax-inclusive total into { subtotalCents, taxCents } given a
 * rate in basis points. The invariant subtotalCents + taxCents === totalCents
 * is guaranteed by reconciling any 1-cent rounding drift into the subtotal
 * (spec §"Requirements for the math" #2).
 *
 *   totalCents = 28837, rateBps = 1600
 *     subtotalCents = round(28837 * 10000 / 11600) = 24859
 *     taxCents      = 28837 - 24859               = 3978
 *
 * All arithmetic is integer. No floating-point rounding of the split itself
 * — only Math.round on the initial subtotal derivation, which produces an
 * integer immediately.
 *
 * @param {number} totalCents - Tax-inclusive total in cents.
 * @param {number} [rateBps=IVA_RATE_BPS] - Tax rate in basis points.
 * @returns {{ subtotalCents: number, taxCents: number, totalCents: number }}
 */
export function splitTaxInclusive(totalCents, rateBps = IVA_RATE_BPS) {
  if (!Number.isInteger(totalCents)) {
    throw new TypeError(`splitTaxInclusive: totalCents must be integer, got ${totalCents}`);
  }
  if (!Number.isInteger(rateBps) || rateBps < 0) {
    throw new TypeError(`splitTaxInclusive: rateBps must be non-negative integer, got ${rateBps}`);
  }
  // Denominator (BPS_DENOMINATOR + rateBps) is the "1 + rate" divisor,
  // scaled to keep everything in integers until Math.round.
  const denom = BPS_DENOMINATOR + rateBps;
  const subtotalCents = Math.round((totalCents * BPS_DENOMINATOR) / denom);
  const taxCents = totalCents - subtotalCents;
  return { subtotalCents, taxCents, totalCents };
}
