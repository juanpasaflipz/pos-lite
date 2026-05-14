// Display formatter. `phone` is the 10-digit local number we store; pair it
// with the customer's `country_code` to render the correct international prefix.
// Legacy callers without a country code default to MX so existing rows keep
// rendering the way they always have.
export function formatPhone(phone: string | null | undefined, countryCode: string = 'MX'): string {
  if (!phone) return '';
  const digits = String(phone).replace(/\D/g, '');
  const cc = (countryCode || 'MX').toUpperCase();

  let local = digits;
  if (cc === 'US' || cc === 'CA') {
    if (digits.length === 11 && digits.startsWith('1')) local = digits.slice(1);
    else local = digits.slice(-10);
    if (local.length === 10) {
      return `+1 (${local.slice(0, 3)}) ${local.slice(3, 6)}-${local.slice(6)}`;
    }
    return String(phone);
  }

  // MX
  if (digits.length === 12 && digits.startsWith('52')) local = digits.slice(2);
  else if (digits.length === 13 && digits.startsWith('521')) local = digits.slice(3);

  if (local.length === 10) {
    return `+52 ${local.slice(0, 2)} ${local.slice(2, 6)}-${local.slice(6)}`;
  }
  return String(phone);
}

export function normalizePhoneDigits(phone: string | null | undefined, countryCode: string = 'MX'): string {
  if (!phone) return '';
  const digits = String(phone).replace(/\D/g, '');
  const cc = (countryCode || 'MX').toUpperCase();
  if (cc === 'US' || cc === 'CA') {
    if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
    return digits.slice(-10);
  }
  if (digits.length === 12 && digits.startsWith('52')) return digits.slice(2);
  if (digits.length === 13 && digits.startsWith('521')) return digits.slice(3);
  return digits.slice(-10);
}
