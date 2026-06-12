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

export type KioskFulfillmentType = 'for_here' | 'to_go' | 'delivery';

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
  modifier_ids?: number[];
}

export interface KioskModifier {
  id: number;
  name: string;
  price_adjustment: number;
}

export interface KioskModifierGroup {
  id: number;
  name: string;
  selection_type: 'single' | 'multiple';
  required: boolean;
  min_selections: number;
  max_selections: number;
  modifiers: KioskModifier[];
}

export type KioskModifierMap = Record<number, KioskModifierGroup[]>;

export async function fetchModifierMap(auth: AuthHeaders): Promise<KioskModifierMap> {
  const res = await fetch(`${API_BASE}/api/kiosk/modifier-map`, { headers: authHeaders(auth) });
  if (!res.ok) {
    throw new Error(`Modifiers fetch failed (${res.status})`);
  }
  const body = await res.json();
  return body.map || {};
}

export interface KioskHoldResponse {
  id: number;
  order_number: string | number;
  total: number;
  status: string;
  items: CreateKioskOrderLine[];
}

export interface HoldKioskOrderOpts {
  customerToken?: string | null;
  customerCallName?: string | null;
  fulfillmentType?: KioskFulfillmentType | null;
}

export async function holdKioskOrder(
  auth: AuthHeaders,
  items: CreateKioskOrderLine[],
  opts: HoldKioskOrderOpts = {},
): Promise<KioskHoldResponse> {
  const res = await fetch(`${API_BASE}/api/kiosk/orders/hold`, {
    method: 'POST',
    headers: authHeaders(auth),
    body: JSON.stringify({
      items,
      customer_token: opts.customerToken || undefined,
      customer_call_name: opts.customerCallName || undefined,
      fulfillment_type: opts.fulfillmentType || undefined,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Hold failed (${res.status})`);
  }
  return res.json();
}

// Dine-in pre-pay: fires the order to the kitchen with payment_status='unpaid'.
// The customer eats first, then comes back via Pagar mi cuenta to pay.
export interface KioskSendToKitchenResponse {
  id: number;
  order_number: string | number;
  subtotal: number;
  tax: number;
  total: number;
  status: string;
  payment_status: string;
  customer_call_name: string | null;
  order_fulfillment_type: KioskFulfillmentType;
}

export async function sendKioskOrderToKitchen(
  auth: AuthHeaders,
  items: CreateKioskOrderLine[],
  opts: HoldKioskOrderOpts = {},
): Promise<KioskSendToKitchenResponse> {
  const res = await fetch(`${API_BASE}/api/kiosk/orders/send-to-kitchen`, {
    method: 'POST',
    headers: authHeaders(auth),
    body: JSON.stringify({
      items,
      customer_token: opts.customerToken || undefined,
      customer_call_name: opts.customerCallName || undefined,
      fulfillment_type: opts.fulfillmentType || 'for_here',
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Send to kitchen failed (${res.status})`);
  }
  return res.json();
}

/* ==================== Uber Direct (delivery) ==================== */

export interface KioskDeliveryQuote {
  quote_id: string;
  fee: number;
  currency: string;
  duration_min: number;
  dropoff_eta: string | null;
  expires: string | null;
}

export async function quoteKioskDelivery(
  auth: AuthHeaders,
  body: { dropoff_address: string; dropoff_phone_number: string; manifest_total_value?: number },
): Promise<KioskDeliveryQuote> {
  const res = await fetch(`${API_BASE}/api/kiosk/delivery/quote`, {
    method: 'POST',
    headers: authHeaders(auth),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Quote failed (${res.status})`);
  }
  return res.json();
}

export interface KioskDeliveryResponse extends KioskSendToKitchenResponse {
  delivery: {
    delivery_order_id: number;
    external_id: string;
    tracking_url: string | null;
    status: string;
    fee: number;
    dropoff_eta: string | null;
  } | null;
  delivery_error: string | null;
}

export async function sendKioskDeliveryOrder(
  auth: AuthHeaders,
  items: CreateKioskOrderLine[],
  opts: {
    customerToken?: string | null;
    customerCallName?: string | null;
    dropoffAddress: string;
    dropoffPhoneNumber: string;
    dropoffName?: string | null;
    dropoffNotes?: string | null;
    quoteId?: string | null;
  },
): Promise<KioskDeliveryResponse> {
  const res = await fetch(`${API_BASE}/api/kiosk/orders/send-to-delivery`, {
    method: 'POST',
    headers: authHeaders(auth),
    body: JSON.stringify({
      items,
      customer_token: opts.customerToken || undefined,
      customer_call_name: opts.customerCallName || undefined,
      dropoff_address: opts.dropoffAddress,
      dropoff_phone_number: opts.dropoffPhoneNumber,
      dropoff_name: opts.dropoffName || undefined,
      dropoff_notes: opts.dropoffNotes || undefined,
      quote_id: opts.quoteId || undefined,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Delivery order failed (${res.status})`);
  }
  return res.json();
}

// Find open dine-in unpaid orders by name OR by loyalty session token.
// Used by Welcome banner ("Hola Juan, tienes una cuenta abierta"),
// Pagar mi cuenta lookup, and Agregar a mi orden lookup.
export interface KioskOpenOrder {
  id: number;
  order_number: string | number;
  subtotal: number;
  tax: number;
  total: number;
  status: string;
  payment_status: string;
  customer_call_name: string | null;
  order_fulfillment_type: KioskFulfillmentType;
  created_at: string;
  items: Array<{
    order_item_id: number;
    menu_item_id: number;
    item_name: string;
    quantity: number;
    unit_price: number;
    modifiers: KioskModifier[];
  }>;
}

// Pagar mi cuenta — charges an existing dine-in order via MP terminal.
export interface KioskTerminalChargeResponse {
  success: true;
  mp_order_id: string;
  payment_status: string;
}

export async function chargeExistingKioskOrderOnTerminal(
  auth: AuthHeaders,
  orderId: number,
): Promise<KioskTerminalChargeResponse> {
  const res = await fetch(`${API_BASE}/api/kiosk/orders/${orderId}/mp-charge`, {
    method: 'POST',
    headers: authHeaders(auth),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Terminal charge failed (${res.status})`);
  }
  return res.json();
}

// Polled by Pagar mi cuenta after the terminal charge fires. Backend reconciles
// MP tip + records the payment row when status flips to 'paid'.
export interface KioskOrderStatusResponse {
  id: number;
  order_number: string | number;
  total: number;
  payment_status: string;
  invoice_token: string | null;
}

export async function fetchKioskOrderStatus(
  auth: AuthHeaders,
  orderId: number,
): Promise<KioskOrderStatusResponse> {
  const res = await fetch(`${API_BASE}/api/kiosk/orders/${orderId}/status`, {
    headers: authHeaders(auth),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Status fetch failed (${res.status})`);
  }
  return res.json();
}

// Customer-initiated "Agregar a mi orden": appends items to an open dine-in
// order. Backend requires the customer match the order's loyalty profile or
// (case-insensitive) call name — the ownership boundary.
export interface KioskAppendItemsResponse {
  success: true;
  order_id: number;
  inserted_item_ids: number[];
  subtotal: number;
  tax: number;
  total: number;
}

export async function appendItemsToKioskOrder(
  auth: AuthHeaders,
  orderId: number,
  items: CreateKioskOrderLine[],
  identity: { customerToken?: string | null; customerCallName?: string | null },
): Promise<KioskAppendItemsResponse> {
  const res = await fetch(`${API_BASE}/api/kiosk/orders/${orderId}/append-items`, {
    method: 'POST',
    headers: authHeaders(auth),
    body: JSON.stringify({
      items,
      customer_token: identity.customerToken || undefined,
      customer_call_name: identity.customerCallName || undefined,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Append failed (${res.status})`);
  }
  return res.json();
}

export async function fetchOpenOrders(
  auth: AuthHeaders,
  by: { name?: string; customerToken?: string; mode?: 'pay' | 'agregar' },
): Promise<KioskOpenOrder[]> {
  const params = new URLSearchParams();
  if (by.name) params.set('name', by.name);
  if (by.customerToken) params.set('customer_token', by.customerToken);
  if (by.mode) params.set('mode', by.mode);
  const res = await fetch(`${API_BASE}/api/kiosk/orders/open?${params.toString()}`, {
    headers: authHeaders(auth),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Open orders fetch failed (${res.status})`);
  }
  const body = await res.json();
  return body.orders || [];
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
    modifiers: KioskModifier[];
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
  modifiers?: KioskModifier[];
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
