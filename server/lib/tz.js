/**
 * YYYY-MM-DD for the given date in the tenant's IANA timezone.
 *
 * Used by anything that keys off "today" in a way the merchant should see —
 * daily order-number counter (so #20260701001 means July 1 in Mexico City,
 * not in UTC), payroll period boundaries, report date buckets.
 *
 * Fallback to UTC if tz is falsy so we don't silently coerce a bad zone.
 */
export function tzDate(date, tz) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz || 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}
