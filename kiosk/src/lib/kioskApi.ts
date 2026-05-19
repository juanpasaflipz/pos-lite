const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) || '';

interface BindResponse {
  tenant_id: string;
  tenant_name: string;
  kiosk_token: string;
}

export async function bindKiosk(pin: string): Promise<BindResponse> {
  const res = await fetch(`${API_BASE}/api/kiosk/bind`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Bind failed (${res.status})`);
  }
  return res.json();
}

export interface AdminTenant {
  id: string;
  name: string;
  subdomain: string | null;
}

export async function listTenantsWithAdminSecret(adminSecret: string): Promise<AdminTenant[]> {
  const res = await fetch(`${API_BASE}/api/kiosk/admin/tenants`, {
    headers: { 'X-Admin-Secret': adminSecret },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Tenant list failed (${res.status})`);
  }
  return res.json();
}

export async function bindKioskWithAdminSecret(
  adminSecret: string,
  tenantId: string,
): Promise<BindResponse> {
  const res = await fetch(`${API_BASE}/api/kiosk/admin/bind`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Admin-Secret': adminSecret,
    },
    body: JSON.stringify({ tenant_id: tenantId }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Admin bind failed (${res.status})`);
  }
  return res.json();
}

interface AuthHeaders {
  tenantId: string;
  kioskToken: string;
}

function authHeaders({ tenantId, kioskToken }: AuthHeaders): HeadersInit {
  return {
    'Content-Type': 'application/json',
    'X-Tenant-ID': tenantId,
    Authorization: `Bearer ${kioskToken}`,
  };
}

export type KioskPaymentChoice = 'counter_cash' | 'terminal_card';

export interface KioskMenuItem {
  id: number;
  name: string;
  price: number;
  description: string | null;
  image_url: string | null;
  category_id: number;
  active: boolean;
}

export interface KioskMenuCategory {
  id: number;
  name: string;
  sort_order: number;
}

export async function fetchMenu(auth: AuthHeaders): Promise<{
  categories: KioskMenuCategory[];
  items: KioskMenuItem[];
}> {
  const [catsRes, itemsRes] = await Promise.all([
    fetch(`${API_BASE}/api/menu/categories`, { headers: authHeaders(auth) }),
    fetch(`${API_BASE}/api/menu/items`, { headers: authHeaders(auth) }),
  ]);
  if (!catsRes.ok) throw new Error(`Categories ${catsRes.status}`);
  if (!itemsRes.ok) throw new Error(`Items ${itemsRes.status}`);
  return {
    categories: await catsRes.json(),
    items: await itemsRes.json(),
  };
}

export interface CreateKioskOrderLine {
  menu_item_id: number;
  quantity: number;
}

export interface KioskOrderResponse {
  id: number;
  order_number: string | number;
  subtotal: number;
  tax: number;
  total: number;
  payment_status: string;
  status: string;
}

export async function createKioskOrder(
  auth: AuthHeaders,
  items: CreateKioskOrderLine[],
  paymentChoice: KioskPaymentChoice,
  customerToken?: string | null,
): Promise<KioskOrderResponse> {
  const res = await fetch(`${API_BASE}/api/kiosk/orders`, {
    method: 'POST',
    headers: authHeaders(auth),
    body: JSON.stringify({
      items,
      payment_choice: paymentChoice,
      customer_token: customerToken || undefined,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Order failed (${res.status})`);
  }
  return res.json();
}

export interface KioskHoldResponse {
  id: number;
  order_number: string | number;
  total: number;
  status: string;
  items: CreateKioskOrderLine[];
}

export async function holdKioskOrder(
  auth: AuthHeaders,
  items: CreateKioskOrderLine[],
  customerToken: string,
): Promise<KioskHoldResponse> {
  const res = await fetch(`${API_BASE}/api/kiosk/orders/hold`, {
    method: 'POST',
    headers: authHeaders(auth),
    body: JSON.stringify({ items, customer_token: customerToken }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Hold failed (${res.status})`);
  }
  return res.json();
}

export interface KioskActiveDraft {
  id: number;
  order_number: string | number;
  total: number;
  created_at: string;
  items: Array<{
    menu_item_id: number;
    item_name: string;
    quantity: number;
    unit_price: number;
  }>;
}

export async function fetchActiveDraft(
  auth: AuthHeaders,
  customerToken: string,
): Promise<KioskActiveDraft | null> {
  const url = `${API_BASE}/api/kiosk/orders/active?customer_token=${encodeURIComponent(customerToken)}`;
  const res = await fetch(url, { headers: authHeaders(auth) });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Active fetch failed (${res.status})`);
  }
  const body = await res.json();
  return body.active || null;
}

export async function resumeDraft(
  auth: AuthHeaders,
  orderId: number,
  customerToken: string,
): Promise<KioskActiveDraft['items']> {
  const res = await fetch(`${API_BASE}/api/kiosk/orders/${orderId}/resume`, {
    method: 'POST',
    headers: authHeaders(auth),
    body: JSON.stringify({ customer_token: customerToken }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Resume failed (${res.status})`);
  }
  const body = await res.json();
  return body.items;
}

export async function sendKioskOrderToTerminal(
  auth: AuthHeaders,
  orderId: number,
): Promise<{ success: boolean; mp_order_id: string; payment_status: string }> {
  const res = await fetch(`${API_BASE}/api/kiosk/orders/${orderId}/mp-charge`, {
    method: 'POST',
    headers: authHeaders(auth),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Terminal failed (${res.status})`);
  }
  return res.json();
}

export async function fetchKioskOrderStatus(
  auth: AuthHeaders,
  orderId: number,
): Promise<{
  id: number;
  order_number: string | number;
  total: number;
  payment_status: string;
  invoice_token: string | null;
}> {
  const res = await fetch(`${API_BASE}/api/kiosk/orders/${orderId}/status`, {
    headers: authHeaders(auth),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Status failed (${res.status})`);
  }
  return res.json();
}

/* ==================== Customer identification & suggestions ==================== */

export type SuggestionLane = 'for_you' | 'house' | 'popular' | 'usual';

export interface SuggestionItem {
  menu_item_id: number;
  name: string;
  price: number;
  image_url: string | null;
  category: string;
  reason?: string;
  lane: SuggestionLane;
  source?: string;
}

export interface RepeatOrderLine {
  menu_item_id: number;
  name: string;
  price: number;
  image_url: string | null;
  quantity: number;
}

export interface RepeatOrderSuggestion {
  order_id: number;
  reason: string;
  total: number;
  items: RepeatOrderLine[];
}

export interface KioskSuggestions {
  usual: RepeatOrderSuggestion | null;
  for_you: SuggestionItem[];
  house: SuggestionItem | null;
  popular: SuggestionItem[];
}

export interface StampStatus {
  earned: number;
  required: number;
  completed: boolean;
  reward_description: string;
}

export interface IdentifyResult {
  found: boolean;
  is_new?: boolean;
  customer?: { id: number; name: string; first_name: string };
  customer_token?: string;
  stamp?: StampStatus | null;
  ai_powered?: boolean;
  visit_count?: number;
  suggestions?: KioskSuggestions;
}

export interface IdentifyBody {
  phone: string;
  country_code?: string;
  name?: string;
  sms_opt_in?: boolean;
}

export async function identifyCustomer(
  auth: AuthHeaders,
  body: IdentifyBody,
): Promise<IdentifyResult> {
  const res = await fetch(`${API_BASE}/api/kiosk/identify`, {
    method: 'POST',
    headers: authHeaders(auth),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Identify failed (${res.status})`);
  }
  return res.json();
}

export async function fetchPopular(auth: AuthHeaders): Promise<SuggestionItem[]> {
  const res = await fetch(`${API_BASE}/api/kiosk/popular`, {
    headers: authHeaders(auth),
  });
  if (!res.ok) throw new Error(`Popular ${res.status}`);
  const data = await res.json();
  return data.popular || [];
}

export interface SuggestionEvent {
  menu_item_id?: number | null;
  lane: SuggestionLane;
  source?: string;
  event_type: 'tapped' | 'ordered';
  reason?: string;
}

// Fire-and-forget telemetry — never throws, never blocks the order flow.
export function logSuggestionEvents(
  auth: AuthHeaders,
  customerToken: string | null,
  events: SuggestionEvent[],
): void {
  if (!events.length) return;
  fetch(`${API_BASE}/api/kiosk/suggestion-event`, {
    method: 'POST',
    headers: authHeaders(auth),
    body: JSON.stringify({ customer_token: customerToken || undefined, events }),
  }).catch(() => {
    /* telemetry is best-effort */
  });
}
