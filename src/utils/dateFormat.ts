import i18n from '../i18n';

export function getLocale(): string {
  return i18n.language?.startsWith('es') ? 'es-MX' : 'en-US';
}

export function formatTime(date: Date): string {
  return date.toLocaleTimeString(getLocale());
}

export function formatDate(date: Date, options?: Intl.DateTimeFormatOptions): string {
  return date.toLocaleDateString(getLocale(), options);
}

export function formatDateTime(date: Date): string {
  return date.toLocaleString(getLocale());
}
