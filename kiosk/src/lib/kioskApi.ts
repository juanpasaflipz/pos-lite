const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) || '';

interface BindResponse {
  tenant_id: string;
  tenant_name: string;
  kiosk_token: string;
  device_id?: string;
}

export async function bindKiosk(pin: string, deviceName?: string): Promise<BindResponse> {
  const res = await fetch(`${API_BASE}/api/kiosk/bind`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(deviceName ? { pin, device_name: deviceName } : { pin }),
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

// Triggered when an authed kiosk fetch sees 401/403 — the kiosk token is
// invalid/expired/tenant-mismatched and the device must re-pair. Registered
// by KioskBindingProvider; routes to `unbind()` which kicks the UI back to
// /bind via the App.tsx route guard.
let authFailureHandler: (() => void) | null = null;

export function setKioskAuthFailureHandler(handler: (() => void) | null): void {
  authFailureHandler = handler;
}

// Triggered when the server answers 403 PLAN_UPGRADE_REQUIRED (kiosk is a Pro
// feature — repackaged 2026-07-23). This is NOT an auth failure: the token is
// valid and the binding must survive, so that upgrading (or trial → paid)
// brings the kiosk back without re-pairing the tablet. Registered by
// KioskBindingProvider; App.tsx swaps the UI for KioskUnavailableScreen.
let planLockHandler: (() => void) | null = null;

export function setKioskPlanLockHandler(handler: (() => void) | null): void {
  planLockHandler = handler;
}

async function authedFetch(
  auth: AuthHeaders,
  input: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = { ...authHeaders(auth), ...(init.headers || {}) };
  const res = await fetch(input, { ...init, headers });
  if (res.status === 403) {
    // Peek: plan lock (keep binding) vs real auth failure (unbind).
    try {
      const peek = await res.clone().json();
      if (peek?.error === 'PLAN_UPGRADE_REQUIRED') {
        planLockHandler?.();
        return res;
      }
    } catch { /* body not JSON — treat as auth failure below */ }
  }
  if ((res.status === 401 || res.status === 403) && authFailureHandler) {
    authFailureHandler();
  }
  return res;
}

/**
 * True when the kiosk feature is available for this tenant's current plan.
 * Probes a cheap gated endpoint; used by KioskUnavailableScreen's retry
 * loop so an upgrade mid-service brings the kiosk back automatically.
 */
export async function probeKioskPlan(auth: AuthHeaders): Promise<boolean> {
  try {
    const res = await authedFetch(auth, `${API_BASE}/api/kiosk/popular`);
    return res.ok;
  } catch {
    return false;
  }
}

export type KioskFulfillmentType = 'for_here' | 'to_go' | 'delivery';

export interface KioskMenuItem {
  id: number;
  name: string;
  name_en: string | null;
  price: number;
  description: string | null;
  description_en: string | null;
  image_url: string | null;
  category_id: number;
  active: boolean;
}

/**
 * Pick the display name/description for the current kiosk language. Falls back
 * to the Spanish source when the EN translation hasn't landed yet (fresh menu
 * item, translation retry pending, ANTHROPIC key temporarily missing, etc.) —
 * the customer never sees a blank tile.
 */
export function localizeMenuItem(
  item: KioskMenuItem,
  lang: string,
): { name: string; description: string | null } {
  const useEn = lang.startsWith('en');
  return {
    name: (useEn && item.name_en) ? item.name_en : item.name,
    description: useEn && item.description_en ? item.description_en : item.description,
  };
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
    authedFetch(auth, `${API_BASE}/api/menu/categories`),
    authedFetch(auth, `${API_BASE}/api/menu/items`),
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
  const res = await authedFetch(auth, `${API_BASE}/api/kiosk/modifier-map`);
  if (!res.ok) {
    throw new Error(`Modifiers fetch failed (${res.status})`);
  }
  const body = await res.json();
  return body.map || {};
}

// ==================== Wizard mode ====================

export type KioskMode = 'grid' | 'wizard';

export interface KioskConfig {
  mode: KioskMode;
  device_override: KioskMode | null;
  tenant_mode: KioskMode;
}

export async function fetchKioskConfig(auth: AuthHeaders): Promise<KioskConfig> {
  const res = await authedFetch(auth, `${API_BASE}/api/kiosk/config`);
  if (!res.ok) throw new Error(`Config fetch failed (${res.status})`);
  return res.json();
}

// Builder-menu payload — one row per builder item, groups[] carries the split
// { kind, slug } from the server so the wizard can key on kind === 'Estilo'
// etc. without parsing names client-side.
export interface BuilderModifier {
  id: number;
  name: string;
  price_adjustment: number;
}

export interface BuilderGroup {
  id: number;
  kind: string;               // 'Estilo' | 'Segunda proteína' | 'Quitar' | 'Extras' | '¿Con birria o cochinita?'
  slug: string | null;        // the base-item slug this group is scoped to; null on legacy groups
  name: string;               // internal "Estilo__asada"
  selection_type: 'single' | 'multiple';
  required: boolean;
  min_selections: number;
  max_selections: number;
  options: BuilderModifier[];
}

export interface BuilderItem {
  id: number;
  slug: string | null;        // 'asada' | 'pollo' | ... | 'birria' | 'cochinita' | 'rollbertos'
  name: string;
  name_en: string | null;
  description: string | null;
  description_en: string | null;
  price: number;
  groups: BuilderGroup[];
}

export async function fetchBuilderMenu(auth: AuthHeaders): Promise<{ items: BuilderItem[] }> {
  const res = await authedFetch(auth, `${API_BASE}/api/kiosk/builder-menu`);
  if (!res.ok) throw new Error(`Builder menu fetch failed (${res.status})`);
  return res.json();
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
  const res = await authedFetch(auth, `${API_BASE}/api/kiosk/orders/hold`, {
    method: 'POST',
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

// Kiosk pay-first flow: creates the order as status='draft_kiosk' (KDS blind).
// The kitchen ticket only fires after payment succeeds and the poller / cashier
// promotes the draft to 'active'. Endpoint name is legacy — the actual send-
// to-kitchen moment lives in markKioskOrderPaid() / claim.
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
  const res = await authedFetch(auth, `${API_BASE}/api/kiosk/orders/send-to-kitchen`, {
    method: 'POST',
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
  const res = await authedFetch(auth, `${API_BASE}/api/kiosk/delivery/quote`, {
    method: 'POST',
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
  const res = await authedFetch(auth, `${API_BASE}/api/kiosk/orders/send-to-delivery`, {
    method: 'POST',
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
  terminalId?: string | null,
): Promise<KioskTerminalChargeResponse> {
  const res = await authedFetch(auth, `${API_BASE}/api/kiosk/orders/${orderId}/mp-charge`, {
    method: 'POST',
    body: JSON.stringify({ terminal_id: terminalId || undefined }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Terminal charge failed (${res.status})`);
  }
  return res.json();
}

export interface KioskMpTerminal {
  id: string;
  external_pos_id: string | null;
  operating_mode: string;
}

export async function listKioskMpTerminals(auth: AuthHeaders): Promise<{
  terminals: KioskMpTerminal[];
  default_terminal_id: string | null;
}> {
  const res = await authedFetch(auth, `${API_BASE}/api/kiosk/mp/terminals`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Terminal list failed (${res.status})`);
  }
  return res.json();
}

// Polled after the terminal charge fires. Backend reconciles MP tip + records
// the payment row when status flips to 'paid'. For delivery orders, the
// courier is also dispatched on the tick that flips us to paid — `delivery`
// is non-null when the booking succeeded, and `delivery_error` carries the
// human message when it failed (payment still stands either way).
export interface KioskOrderStatusResponse {
  id: number;
  order_number: string | number;
  total: number;
  payment_status: string;
  invoice_token: string | null;
  delivery: {
    delivery_order_id: number;
    external_id: string;
    tracking_url: string | null;
    status: string;
    fee: number;
    dropoff_eta: string | null;
  } | null;
  delivery_error: string | null;
  just_paid: boolean;
}

export async function fetchKioskOrderStatus(
  auth: AuthHeaders,
  orderId: number,
): Promise<KioskOrderStatusResponse> {
  const res = await authedFetch(auth, `${API_BASE}/api/kiosk/orders/${orderId}/status`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Status fetch failed (${res.status})`);
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
    modifiers: KioskModifier[];
  }>;
}

export async function fetchActiveDraft(
  auth: AuthHeaders,
  customerToken: string,
): Promise<KioskActiveDraft | null> {
  const url = `${API_BASE}/api/kiosk/orders/active?customer_token=${encodeURIComponent(customerToken)}`;
  const res = await authedFetch(auth, url);
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
  const res = await authedFetch(auth, `${API_BASE}/api/kiosk/orders/${orderId}/resume`, {
    method: 'POST',
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
  const res = await authedFetch(auth, `${API_BASE}/api/kiosk/identify`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Identify failed (${res.status})`);
  }
  return res.json();
}

export async function fetchPopular(auth: AuthHeaders): Promise<SuggestionItem[]> {
  const res = await authedFetch(auth, `${API_BASE}/api/kiosk/popular`);
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

/* ==================== Wallet pass enrollment ==================== */

export interface WalletEnrollResult {
  available: boolean;
  /** true when a device already holds this customer's pass — skip the QR. */
  registered?: boolean;
  enroll_url?: string;
}

// Post-payment loyalty-join QR for an un-identified (or already-identified)
// customer. Returns a public URL that anyone with a phone can scan to enroll,
// have this order's stamps credited to them, and download a wallet pass —
// idempotent server-side so double-scans don't double-credit.
export async function fetchLoyaltyJoinUrl(
  auth: AuthHeaders,
  orderId: number,
): Promise<string | null> {
  try {
    const res = await authedFetch(
      auth,
      `${API_BASE}/api/kiosk/orders/${orderId}/loyalty-join-url`,
      { method: 'POST' },
    );
    if (!res.ok) return null;
    const body = await res.json();
    return body?.join_url || null;
  } catch {
    return null;
  }
}

// Apple Wallet QR for the identified customer, shown on the confirmation
// screen. Returns { available:false } when the platform has no pass cert
// configured — the kiosk simply hides the panel.
export async function fetchWalletEnroll(
  auth: AuthHeaders,
  customerToken: string,
): Promise<WalletEnrollResult> {
  const res = await authedFetch(auth, `${API_BASE}/api/kiosk/wallet-enroll`, {
    method: 'POST',
    body: JSON.stringify({ customer_token: customerToken }),
  });
  if (!res.ok) {
    // Best-effort UX: any failure just means "don't show the QR".
    return { available: false };
  }
  return res.json();
}

// Fire-and-forget telemetry — never throws, never blocks the order flow.
export function logSuggestionEvents(
  auth: AuthHeaders,
  customerToken: string | null,
  events: SuggestionEvent[],
): void {
  if (!events.length) return;
  authedFetch(auth, `${API_BASE}/api/kiosk/suggestion-event`, {
    method: 'POST',
    body: JSON.stringify({ customer_token: customerToken || undefined, events }),
  }).catch(() => {
    /* telemetry is best-effort */
  });
}
