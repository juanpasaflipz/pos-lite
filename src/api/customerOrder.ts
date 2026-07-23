/**
 * Customer Order API client.
 * Public endpoints — no auth required. Used by the QR code ordering screen.
 */

const isCapacitor = !!(window as any).Capacitor?.isNativePlatform?.();

function getApiBase(): string {
  if (isCapacitor) {
    const tenantSlug = localStorage.getItem('tenant_id');
    if (tenantSlug) return `https://${tenantSlug}.desktop.kitchen/api/customer-order`;
    return 'https://pos.desktop.kitchen/api/customer-order';
  }
  return '/api/customer-order';
}

const API_BASE = getApiBase();

export interface CustomerOrderSettings {
  requirePayment: boolean;
  /** False when the tenant's plan doesn't include QR table ordering
   *  (free plan keeps the QR menu as view-only). Absent on old servers → true. */
  orderingEnabled?: boolean;
}

export interface CustomerOrderItem {
  menu_item_id: number;
  quantity: number;
  notes?: string;
  modifiers?: number[];
}

export interface CustomerOrderResult {
  order_id: number;
  order_number: number;
  order_secret: string;
  estimated_ready_minutes: number;
  estimated_ready_range: { low: number; high: number };
}

export interface CustomerOrderStatus {
  order_id: number;
  order_number: number;
  status: string;
  table_number: string | null;
  estimated_ready_minutes: number | null;
  created_at: string;
  ready_at: string | null;
  total: number;
}

export async function getCustomerOrderSettings(): Promise<CustomerOrderSettings> {
  const res = await fetch(`${API_BASE}/settings`);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Failed to fetch settings: ${res.status}`);
  }
  return res.json();
}

export async function placeCustomerOrder(
  items: CustomerOrderItem[],
  table_number?: string
): Promise<CustomerOrderResult> {
  const res = await fetch(API_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items, table_number }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Failed to place order: ${res.status}`);
  }
  return res.json();
}

export async function getCustomerOrderStatus(orderId: number, secret: string): Promise<CustomerOrderStatus> {
  const res = await fetch(`${API_BASE}/${orderId}/status?secret=${encodeURIComponent(secret)}`);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Failed to fetch status: ${res.status}`);
  }
  return res.json();
}

export async function createCustomerPaymentIntent(orderId: number, secret: string): Promise<{ clientSecret: string }> {
  const res = await fetch(`${API_BASE}/${orderId}/payment-intent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Failed to create payment: ${res.status}`);
  }
  return res.json();
}

export async function confirmCustomerPayment(orderId: number, secret: string): Promise<{ success: boolean }> {
  const res = await fetch(`${API_BASE}/${orderId}/confirm-payment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Failed to confirm payment: ${res.status}`);
  }
  return res.json();
}
