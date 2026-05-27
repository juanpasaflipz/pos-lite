import { Order } from '../types';

// Urgency tiers by order age, shared by the kitchen display and the cashier
// order board. Green 0–4 min, yellow 4–8 min, red + blink 8+ min.
export const URGENCY_WARNING_SECONDS = 4 * 60;
export const URGENCY_CRITICAL_SECONDS = 8 * 60;

// Para Aquí orders older than this threshold without payment are flagged as
// probable no-shows so the cashier can sweep them at close. KDS urgency
// (fresh/warning/critical) is unrelated and intentionally separate — this is
// a payment-cycle signal, not a cooking-cycle one.
export const NO_SHOW_THRESHOLD_SECONDS = 90 * 60;

export type TimeTier = 'fresh' | 'warning' | 'critical';

export function getTimeTier(elapsedSeconds: number): TimeTier {
  if (elapsedSeconds >= URGENCY_CRITICAL_SECONDS) return 'critical';
  if (elapsedSeconds >= URGENCY_WARNING_SECONDS) return 'warning';
  return 'fresh';
}

export function isPaid(order: Pick<Order, 'payment_status'>): boolean {
  return order.payment_status === 'paid' || order.payment_status === 'completed';
}

// True when a dine-in / kiosk order has aged past the no-show threshold and
// is still unpaid. Walk-up to-go orders aren't flagged — those are expected
// to pay up front and any "unpaid" status there is a different problem.
export function isProbableNoShow(
  order: Pick<Order, 'payment_status' | 'order_fulfillment_type' | 'source'>,
  elapsedSeconds: number,
): boolean {
  if (elapsedSeconds < NO_SHOW_THRESHOLD_SECONDS) return false;
  if (isPaid(order)) return false;
  // Eligible surfaces: dine-in POS orders, kiosk-placed orders.
  const isDineIn = order.order_fulfillment_type === 'for_here';
  const isKiosk = order.source === 'customer_kiosk';
  return isDineIn || isKiosk;
}
