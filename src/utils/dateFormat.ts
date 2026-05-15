import i18n from '../i18n';

export function getLocale(): string {
  return i18n.language?.startsWith('es') ? 'es-MX' : 'en-US';
}

export function formatTime(date: Date, timeZone?: string): string {
  return date.toLocaleTimeString(getLocale(), timeZone ? { timeZone } : undefined);
}

export function formatDate(date: Date, options?: Intl.DateTimeFormatOptions, timeZone?: string): string {
  return date.toLocaleDateString(getLocale(), timeZone ? { ...(options || {}), timeZone } : options);
}

export function formatDateTime(date: Date, timeZone?: string): string {
  return date.toLocaleString(getLocale(), timeZone ? { timeZone } : undefined);
}

/** YYYY-MM-DD for the current date in the given IANA timezone (or UTC if omitted). */
export function todayInTz(timeZone?: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZone || 'UTC',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}
