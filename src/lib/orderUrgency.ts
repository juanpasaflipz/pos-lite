import { Order } from '../types';

// Urgency tiers by order age, shared by the kitchen display and the cashier
// order board. Green 0–4 min, yellow 4–8 min, red + blink 8+ min.
export const URGENCY_WARNING_SECONDS = 4 * 60;
export const URGENCY_CRITICAL_SECONDS = 8 * 60;

export type TimeTier = 'fresh' | 'warning' | 'critical';

export function getTimeTier(elapsedSeconds: number): TimeTier {
  if (elapsedSeconds >= URGENCY_CRITICAL_SECONDS) return 'critical';
  if (elapsedSeconds >= URGENCY_WARNING_SECONDS) return 'warning';
  return 'fresh';
}

export function isPaid(order: Pick<Order, 'payment_status'>): boolean {
  return order.payment_status === 'paid' || order.payment_status === 'completed';
}
