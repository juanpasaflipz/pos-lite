// Receptor (customer) validation for CFDI 4.0.
//
// Consolidated here so the staff route (routes/cfdi.js) and the customer
// QR-token route (routes/cfdi-public.js) share the same rules — previously
// both routes duplicated the RFC regex and required-field checks, which
// drifted independently.

// SAT RFC format:
//   Persona moral: 3 letters + 6 digits (yymmdd) + 3-char homoclave = 12
//   Persona física: 4 letters + 6 digits (yymmdd) + 3-char homoclave = 13
// The homoclave's last char is a mod-11 check digit that is validated by
// SAT itself at stamping time — we only enforce shape here.
export const RFC_REGEX = /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/;

// Special SAT RFCs for público en general (XAXX) and foreign customers
// (XEXX). Bypass the regex + name-uppercase rules.
export const SPECIAL_RFCS = new Set(['XAXX010101000', 'XEXX010101000']);

const ZIP_REGEX = /^\d{5}$/;

/**
 * Normalize + validate a receptor payload from the client. Returns either
 * `{ ok: true, receptor }` with normalized fields, or `{ ok: false, error }`
 * with a message safe to surface to the customer/merchant UI.
 *
 * The caller decides what to do with the error (400 for staff, redisplay
 * form for the public QR path).
 *
 * @param {object} raw - Untrusted body { rfc, name, tax_regime, postal_code, uso_cfdi? }
 * @param {object} [opts]
 * @param {string} [opts.defaultUsoCfdi='G03'] - Fallback when the client didn't send one.
 * @returns {{ ok: true, receptor: object } | { ok: false, error: string }}
 */
export function validateReceptor(raw, opts = {}) {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'Receptor data is required' };
  }
  const { rfc, name, tax_regime, postal_code, uso_cfdi } = raw;
  if (!rfc || !name || !tax_regime || !postal_code) {
    return { ok: false, error: 'RFC, name, tax regime, and postal code are required' };
  }

  const cleanRfc = String(rfc).toUpperCase().trim();
  if (!SPECIAL_RFCS.has(cleanRfc) && !RFC_REGEX.test(cleanRfc)) {
    return { ok: false, error: 'Invalid RFC format' };
  }

  const cleanZip = String(postal_code).trim();
  if (!ZIP_REGEX.test(cleanZip)) {
    return { ok: false, error: 'Postal code must be 5 digits' };
  }

  const cleanName = String(name).toUpperCase().trim();
  if (cleanName.length === 0) {
    return { ok: false, error: 'Receptor name is required' };
  }

  const cleanRegime = String(tax_regime).trim();

  return {
    ok: true,
    receptor: {
      rfc: cleanRfc,
      name: cleanName,
      tax_regime: cleanRegime,
      postal_code: cleanZip,
      uso_cfdi: (uso_cfdi && String(uso_cfdi).trim()) || opts.defaultUsoCfdi || 'G03',
    },
  };
}

/**
 * Optional email normalization (invoice delivery). Returns '' if empty,
 * throws-shaped result if malformed.
 * @param {unknown} email
 * @returns {{ ok: true, email: string } | { ok: false, error: string }}
 */
export function normalizeEmail(email) {
  if (email == null || email === '') return { ok: true, email: '' };
  if (typeof email !== 'string') return { ok: false, error: 'Invalid email format' };
  const trimmed = email.trim().toLowerCase();
  if (!trimmed) return { ok: true, email: '' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    return { ok: false, error: 'Invalid email format' };
  }
  return { ok: true, email: trimmed };
}
