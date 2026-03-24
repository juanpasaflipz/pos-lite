// Format price in MXN (Mexican Pesos)
export function formatMXN(amount: number): string {
  return `$${Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} MXN`;
}

// Short format (for compact UI) — with thousand separators
export function formatPrice(amount: number): string {
  return `$${Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Tax rate: 16% IVA (Mexico)
export const TAX_RATE = 0.16;
export const TAX_LABEL = 'IVA (16%)';
