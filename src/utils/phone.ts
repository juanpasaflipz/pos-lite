export function formatPhone(phone: string | null | undefined): string {
  if (!phone) return '';
  const digits = String(phone).replace(/\D/g, '');

  let local = digits;
  if (digits.length === 12 && digits.startsWith('52')) local = digits.slice(2);
  else if (digits.length === 13 && digits.startsWith('521')) local = digits.slice(3);

  if (local.length === 10) {
    return `+52 ${local.slice(0, 2)} ${local.slice(2, 6)}-${local.slice(6)}`;
  }
  return String(phone);
}

export function normalizePhoneDigits(phone: string | null | undefined): string {
  if (!phone) return '';
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('52')) return digits.slice(2);
  if (digits.length === 13 && digits.startsWith('521')) return digits.slice(3);
  return digits.slice(-10);
}
