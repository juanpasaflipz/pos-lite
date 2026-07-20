// Shared MXN money formatter for the kiosk app.
//
// The kiosk is a separate Vite app and can't import from the main `src/` tree,
// so it keeps its own copy. Output matches the POS ($1,234.56) — this replaces
// the `const money = new Intl.NumberFormat('es-MX', ...)` line that used to be
// redefined in every kiosk screen/component.

// $1,234.56 — the default on-screen money format.
export const mxn = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });
export const formatMoney = (v: number): string => mxn.format(Number(v) || 0);
