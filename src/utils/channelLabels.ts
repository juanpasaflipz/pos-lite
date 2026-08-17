import type { TFunction } from 'i18next';

/** Every value orders.source can carry (src/types/index.ts Order.source). */
export const CHANNEL_SLUGS = [
  'pos',
  'uber_eats',
  'uber_direct',
  'rappi',
  'didi_food',
  'customer_kiosk',
  'qr_order',
] as const;

/**
 * Display label for an orders.source channel slug, via the reports namespace
 * (`sales.channels.*`). Unknown slugs fall back to the raw value so a new
 * channel degrades to its slug instead of disappearing.
 */
export function channelLabel(t: TFunction, slug: string | null | undefined): string {
  const key = slug || 'pos';
  return t(`sales.channels.${key}`, { defaultValue: key });
}
