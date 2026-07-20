// Format price in MXN (Mexican Pesos)
export function formatMXN(amount: number): string {
  return `$${Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} MXN`;
}

// Short format (for compact UI) — with thousand separators
export function formatPrice(amount: number): string {
  return `$${Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ── Shared MXN formatters ──────────────────────────────────────────────────
// Consolidates the ad-hoc `new Intl.NumberFormat('es-MX', ...)` instances that
// were redefined across ~20 screens/components. Output is byte-identical to the
// originals ($1,234.56), so nothing renders differently — there's just one
// definition now. NOTE: these differ from formatMXN above, which intentionally
// appends " MXN" for the printed-receipt/invoice context.

// $1,234.56 — the default on-screen money format.
export const mxn = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });
export const formatMoney = (v: number): string => mxn.format(Number(v) || 0);

// $1,235 — whole-peso, for compact dashboard tiles.
export const mxn0 = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });
export const formatMoney0 = (v: number): string => mxn0.format(Number(v) || 0);

// $1,234.56 from an integer number of cents (payroll/labor are stored in cents).
export const formatCents = (cents: number): string => mxn.format((Number(cents) || 0) / 100);

// 1,234 — plain grouped integer, no currency symbol (es-MX grouping).
export const intMX = new Intl.NumberFormat('es-MX');
export const formatInt = (v: number): string => intMX.format(Number(v) || 0);

// Tax rate: 16% IVA (Mexico)
export const TAX_RATE = 0.16;
export const TAX_LABEL = 'IVA (16%)';
