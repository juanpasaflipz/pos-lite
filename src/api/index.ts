import {
  Employee,
  MenuCategory,
  MenuItem,
  Order,
  OrderItem,
  VirtualBrand,
  InventoryItem,
  PaymentIntent,
  PaymentStatus,
  SalesReport,
  TopItemsReport,
  ItemSalesReport,
  EmployeePerformanceReport,
  HourlyReport,
  CashCardBreakdown,
  COGSReport,
  CategoryMargins,
  ContributionMarginReport,
  LiveDashboardData,
  ModifierGroup,
  ComboDefinition,
  OrderPayment,
  Printer,
  DeliveryPlatform,
  DeliveryOrder,
  InventoryPushData,
  InventoryForecast,
  CategoryRole,
  PricingDashboard,
  PricingRule,
  PriceHistoryEntry,
  PricingGuardrails,
  PricingExperiment,
  GrokPricingSuggestion,
  Refund,
  ReconciliationRow,
  PaymentFeeSummary,
  RefundSummary,
  InventoryCount,
  ShrinkageAlert,
  VarianceReport,
  Vendor,
  PurchaseOrder,
  PrepForecast,
  InventoryInsights,
  FinancialProjection,
  LoyaltyCustomer,
  StampCard,
  StampResult,
  LoyaltyAnalytics,
  LoyaltyConfig,
  ReferralEvent,
  PaginatedResponse,
  OrderTemplate,
  WasteLogEntry,
  WasteReport,
  COGSSummary,
  CfdiConfig,
  CfdiInvoice,
  CfdiInvoiceToken,
  CfdiCatalogs,
  RecipeIngredient,
  RecipeSummaryItem,
  StressTestTemplate,
  StressTestConfig,
  StressTestProgress,
  StressTestResults,
  StressTestResidual,
  MenuTemplateOption,
  MenuImportStats,
  CSVImportPreview,
  AIMenuParseResult,
  MenuEngineeringReport,
  PayrollSnapshot,
  PayrollSettings,
  PayrollRateRow,
  PayrollPeriodsList,
  PayType,
  SettlementSummary,
  DisbursementRecord,
  SettlementStatement,
  MerchantBankAccount,
  MerchantAdvance,
  MCARepayment,
  Discount,
  DiscountType,
} from '../types';
import type { DisplayAsset, DisplayMenuSettings, MenuBoardDataResponse } from '../types/menu-board';
import { noteServerVersionHeaders } from '../lib/appUpdate';

// Employee ID for display/sync use - set after login
let currentEmployeeId: number | null = null;

export function setCurrentEmployeeId(id: number | null) {
  currentEmployeeId = id;
}

// Employee JWT for auth header - set after login
let currentEmployeeToken: string | null = null;

export function setCurrentEmployeeToken(token: string | null) {
  currentEmployeeToken = token;
}

export function getCurrentEmployeeToken(): string | null {
  return currentEmployeeToken;
}

// Paired-device JWT — used by wall-mounted KDS TVs. Persists across reloads
// in localStorage so the TV stays signed in across power cycles. When set,
// it's used as the Authorization header IFF no employee is logged in.
const DEVICE_TOKEN_KEY = 'kds_device_token';
let currentDeviceToken: string | null = (() => {
  try { return localStorage.getItem(DEVICE_TOKEN_KEY); } catch { return null; }
})();

export function setDeviceToken(token: string | null) {
  currentDeviceToken = token;
  try {
    if (token) localStorage.setItem(DEVICE_TOKEN_KEY, token);
    else localStorage.removeItem(DEVICE_TOKEN_KEY);
  } catch { /* localStorage unavailable */ }
}

export function getDeviceToken(): string | null {
  return currentDeviceToken;
}

function authHeader(): string | null {
  if (currentEmployeeToken) return `Bearer ${currentEmployeeToken}`;
  if (currentDeviceToken) return `Bearer ${currentDeviceToken}`;
  return null;
}

// Capacitor native: API calls must go to the remote server (local dist/ has no backend)
const isCapacitor = !!(window as any).Capacitor?.isNativePlatform?.();

function getCapacitorApiBase(): string {
  const tenantSlug = localStorage.getItem('tenant_id');
  if (tenantSlug) {
    return `https://${tenantSlug}.desktop.kitchen/api`;
  }
  return 'https://pos.desktop.kitchen/api';
}

const API_BASE_URL = import.meta.env.VITE_API_URL || (isCapacitor ? getCapacitorApiBase() : '/api');

// Try multiple LAN IPs when the primary fails
const FALLBACK_URLS = (import.meta.env.VITE_API_URL_FALLBACKS || '')
  .split(',')
  .filter(Boolean);

let activeBaseUrl = API_BASE_URL;
let fallbackResolved = false;

async function resolveBaseUrl(): Promise<string> {
  if (fallbackResolved || !FALLBACK_URLS.length) return activeBaseUrl;

  // Try the primary URL first
  try {
    await fetch(`${activeBaseUrl}/menu/categories`, { signal: AbortSignal.timeout(2000) });
    fallbackResolved = true;
    return activeBaseUrl;
  } catch {
    // Primary failed, try fallbacks
  }

  for (const url of FALLBACK_URLS) {
    try {
      await fetch(`${url}/menu/categories`, { signal: AbortSignal.timeout(2000) });
      activeBaseUrl = url;
      fallbackResolved = true;
      console.log(`[API] Using fallback server: ${url}`);
      return activeBaseUrl;
    } catch {
      // Try next
    }
  }

  // All failed, stick with primary (will show errors naturally)
  fallbackResolved = true;
  return activeBaseUrl;
}

/* ==================== Numeric Coercion ==================== */

// Neon Postgres returns NUMERIC(10,2) columns as strings to preserve precision.
// This causes NaN bugs when JS uses + (string concat) instead of addition.
// Coerce known numeric fields to numbers at the API boundary so all downstream
// code can safely do arithmetic without per-callsite Number() wrapping.
const NUMERIC_FIELDS = new Set([
  'price', 'unit_price', 'subtotal', 'tax', 'tip', 'total',
  'cost_price', 'price_adjustment', 'combo_price', 'amount',
  'delivery_fee', 'platform_commission', 'custom_price', 'price_amount',
  'unit_cost', 'total_amount', 'line_total', 'total_spent', 'refund_total',
  'quantity_used', 'quantity_received',
]);

function coerceNumerics(data: unknown): unknown {
  if (data === null || data === undefined) return data;
  if (Array.isArray(data)) return data.map(coerceNumerics);
  if (typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    for (const key in obj) {
      if (NUMERIC_FIELDS.has(key) && typeof obj[key] === 'string') {
        const n = Number(obj[key]);
        if (!Number.isNaN(n)) obj[key] = n;
      } else if (typeof obj[key] === 'object') {
        obj[key] = coerceNumerics(obj[key]);
      }
    }
    return obj;
  }
  return data;
}

/* ==================== Base API Client ==================== */

async function apiRequest<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const base = FALLBACK_URLS.length ? await resolveBaseUrl() : activeBaseUrl;
  const url = `${base}${endpoint}`;
  const defaultHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const auth = authHeader();
  if (auth) {
    defaultHeaders['Authorization'] = auth;
  }
  // Only send X-Tenant-ID header in development (localhost).
  // In production, tenant is resolved via subdomain — sending the header
  // without X-Admin-Secret triggers a 403.
  if (!isCapacitor && window.location.hostname === 'localhost') {
    const tenantId = localStorage.getItem('tenant_id');
    if (tenantId) {
      defaultHeaders['X-Tenant-ID'] = tenantId;
    }
  }

  const response = await fetch(url, {
    ...options,
    headers: {
      ...defaultHeaders,
      ...(options.headers || {}),
    },
  });

  // Every API response carries the server's build id — piggybacking on traffic
  // the app was already making is what makes new-deploy detection instant
  // without a polling hot path.
  noteServerVersionHeaders(response.headers);

  if (!response.ok) {
    let errorMessage = `API Error: ${response.status} ${response.statusText}`;
    let errorData: Record<string, unknown> = {};
    try {
      errorData = await response.json();
      errorMessage = (errorData.error as string) || (errorData.message as string) || errorMessage;
    } catch {
      // Use default error message if response is not JSON
    }
    const err = new Error(errorMessage) as Error & { status?: number; code?: string; planUpgradeRequired?: boolean; requiredPlan?: string; feature?: string; conflictWith?: string; approvalRequired?: boolean; permission?: string };
    err.status = response.status;
    // Machine-readable reason, when the route sends one. Callers branch on it to
    // offer the right recovery (e.g. `terminal_unpaired` raises the terminal
    // picker instead of dead-ending on an error string).
    if (typeof errorData.code === 'string') {
      err.code = errorData.code;
    }
    // The actor's role lacks the permission, but the route accepts a manager
    // approval — callers use this to raise the PIN pad and retry with a token
    // instead of dead-ending on the error string.
    if (response.status === 403 && errorData.code === 'approval_required') {
      err.approvalRequired = true;
      err.permission = errorData.permission as string;
    }
    // Uniqueness conflicts name the row they collided with so callers can build
    // a translated "X already has that" message instead of echoing the server's
    // English error string.
    if (typeof errorData.conflict_with === 'string') {
      err.conflictWith = errorData.conflict_with;
    }
    if (response.status === 403 && errorData.error === 'PLAN_UPGRADE_REQUIRED') {
      err.planUpgradeRequired = true;
      err.requiredPlan = errorData.requiredPlan as string;
      err.feature = errorData.feature as string;
    }
    throw err;
  }

  const data = await response.json();
  return coerceNumerics(data) as T;
}

/* ==================== Break-Even Calculator ==================== */

export interface BreakEvenPrefill {
  avg_ticket: number;
  orders_30d: number;
  open_days_30d: number;
  orders_per_open_day: number;
  variable_pct_default: number;
  labor_monthly: number;
  recurring: Array<{ label: string; category: string; monthly: number }>;
  recurring_total: number;
  expenses_30d: Array<{ category: string; total: number }>;
}

export async function getBreakEvenPrefill(): Promise<BreakEvenPrefill> {
  return apiRequest<BreakEvenPrefill>('/reports/breakeven');
}

/* ==================== Menu Templates & Import ==================== */

export async function getMenuTemplates(): Promise<MenuTemplateOption[]> {
  return apiRequest<MenuTemplateOption[]>('/menu/templates');
}

export async function applyMenuTemplate(templateId: string, mode: 'append' | 'replace' = 'append'): Promise<MenuImportStats> {
  return apiRequest<MenuImportStats>('/menu/import-template', {
    method: 'POST',
    body: JSON.stringify({ template_id: templateId, mode }),
  });
}

export async function applyMenuTemplateAsOwner(templateId: string, ownerToken: string, mode: 'append' | 'replace' = 'replace'): Promise<MenuImportStats> {
  const base = FALLBACK_URLS.length ? await resolveBaseUrl() : activeBaseUrl;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${ownerToken}`,
  };
  // Always send the tenant binding when known. The onboarding wizard runs on
  // the platform host (pos.desktop.kitchen) where subdomain resolution can't
  // identify the tenant — without this header the request falls through to
  // DEFAULT_TENANT_ID. The owner JWT authorizes the header server-side
  // (tenantMiddleware.hasValidTenantBoundToken).
  if (!isCapacitor) {
    const tenantId = localStorage.getItem('tenant_id');
    if (tenantId) headers['X-Tenant-ID'] = tenantId;
  }
  const response = await fetch(`${base}/menu/import-template`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ template_id: templateId, mode }),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to apply template');
  }
  return response.json();
}

export async function previewMenuCSV(file: File): Promise<CSVImportPreview> {
  const base = FALLBACK_URLS.length ? await resolveBaseUrl() : activeBaseUrl;
  const formData = new FormData();
  formData.append('file', file);
  const headers: Record<string, string> = {};
  if (currentEmployeeToken) headers['Authorization'] = `Bearer ${currentEmployeeToken}`;
  if (!isCapacitor && window.location.hostname === 'localhost') {
    const tenantId = localStorage.getItem('tenant_id');
    if (tenantId) headers['X-Tenant-ID'] = tenantId;
  }
  const response = await fetch(`${base}/menu/import?mode=preview`, {
    method: 'POST',
    headers,
    body: formData,
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to preview CSV');
  }
  return response.json();
}

export async function commitMenuCSV(file: File, columnMap?: Record<string, string>, importMode: 'append' | 'replace' = 'append'): Promise<MenuImportStats> {
  const base = FALLBACK_URLS.length ? await resolveBaseUrl() : activeBaseUrl;
  const formData = new FormData();
  formData.append('file', file);
  if (columnMap) formData.append('column_map', JSON.stringify(columnMap));
  formData.append('import_mode', importMode);
  const headers: Record<string, string> = {};
  if (currentEmployeeToken) headers['Authorization'] = `Bearer ${currentEmployeeToken}`;
  if (!isCapacitor && window.location.hostname === 'localhost') {
    const tenantId = localStorage.getItem('tenant_id');
    if (tenantId) headers['X-Tenant-ID'] = tenantId;
  }
  const response = await fetch(`${base}/menu/import?mode=commit`, {
    method: 'POST',
    headers,
    body: formData,
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to import CSV');
  }
  return response.json();
}

/* ==================== AI Menu Builder ==================== */

export async function parseMenuWithAI(text: string): Promise<AIMenuParseResult> {
  return apiRequest<AIMenuParseResult>('/menu/ai-parse', {
    method: 'POST',
    body: JSON.stringify({ text }),
  });
}

export async function parseMenuWithAIAsOwner(text: string, ownerToken: string): Promise<AIMenuParseResult> {
  const base = FALLBACK_URLS.length ? await resolveBaseUrl() : activeBaseUrl;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${ownerToken}`,
  };
  // Always send the tenant binding when known. The onboarding wizard runs on
  // the platform host (pos.desktop.kitchen) where subdomain resolution can't
  // identify the tenant — without this header the request falls through to
  // DEFAULT_TENANT_ID. The owner JWT authorizes the header server-side
  // (tenantMiddleware.hasValidTenantBoundToken).
  if (!isCapacitor) {
    const tenantId = localStorage.getItem('tenant_id');
    if (tenantId) headers['X-Tenant-ID'] = tenantId;
  }
  const response = await fetch(`${base}/menu/ai-parse`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ text }),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to parse menu');
  }
  return response.json();
}

export async function commitAIMenu(payload: AIMenuParseResult['data'], mode: 'append' | 'replace' = 'replace'): Promise<MenuImportStats> {
  return apiRequest<MenuImportStats>('/menu/ai-import', {
    method: 'POST',
    body: JSON.stringify({ payload, mode }),
  });
}

export async function commitAIMenuAsOwner(payload: AIMenuParseResult['data'], ownerToken: string, mode: 'append' | 'replace' = 'replace'): Promise<MenuImportStats> {
  const base = FALLBACK_URLS.length ? await resolveBaseUrl() : activeBaseUrl;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${ownerToken}`,
  };
  // Always send the tenant binding when known. The onboarding wizard runs on
  // the platform host (pos.desktop.kitchen) where subdomain resolution can't
  // identify the tenant — without this header the request falls through to
  // DEFAULT_TENANT_ID. The owner JWT authorizes the header server-side
  // (tenantMiddleware.hasValidTenantBoundToken).
  if (!isCapacitor) {
    const tenantId = localStorage.getItem('tenant_id');
    if (tenantId) headers['X-Tenant-ID'] = tenantId;
  }
  const response = await fetch(`${base}/menu/ai-import`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ payload, mode }),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to import menu');
  }
  return response.json();
}

/* ==================== Menu Endpoints ==================== */

export async function getCategories(activeOnly?: boolean): Promise<MenuCategory[]> {
  const endpoint = activeOnly ? '/menu/categories?active_only=1' : '/menu/categories';
  return apiRequest<MenuCategory[]>(endpoint);
}

export async function createCategory(data: { name: string; sort_order?: number }): Promise<MenuCategory> {
  return apiRequest<MenuCategory>('/menu/categories', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updateCategory(id: number, data: { name?: string; sort_order?: number }): Promise<any> {
  return apiRequest(`/menu/categories/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function toggleCategory(id: number): Promise<any> {
  return apiRequest(`/menu/categories/${id}/toggle`, { method: 'PUT' });
}

export async function deleteCategory(id: number): Promise<any> {
  return apiRequest(`/menu/categories/${id}`, { method: 'DELETE' });
}

export async function getMenuItems(categoryId?: string, includeInactive?: boolean): Promise<MenuItem[]> {
  const params = new URLSearchParams();
  if (categoryId) params.set('category_id', categoryId);
  if (includeInactive) params.set('include_inactive', '1');
  const qs = params.toString();
  const endpoint = qs ? `/menu/items?${qs}` : '/menu/items';
  return apiRequest<MenuItem[]>(endpoint);
}

export async function createMenuItem(data: {
  category_id: number;
  name: string;
  price: number;
  description?: string;
  image_url?: string;
  sort_order?: number;
  active?: boolean;
}): Promise<MenuItem> {
  return apiRequest<MenuItem>('/menu/items', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updateMenuItem(id: number, data: {
  category_id?: number;
  name?: string;
  price?: number;
  description?: string;
  image_url?: string;
  sort_order?: number;
  active?: boolean;
}): Promise<any> {
  return apiRequest(`/menu/items/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function toggleMenuItem(id: number): Promise<any> {
  return apiRequest(`/menu/items/${id}/toggle`, { method: 'PUT' });
}

export async function deleteMenuItem(id: number): Promise<any> {
  return apiRequest(`/menu/items/${id}`, { method: 'DELETE' });
}

export async function getPopularItems(limit: number = 8): Promise<MenuItem[]> {
  return apiRequest<MenuItem[]>(`/menu/items/popular?limit=${limit}`);
}

export async function getCategorySuggestedOrder(hour?: number): Promise<number[]> {
  const h = hour ?? new Date().getHours();
  return apiRequest<number[]>(`/menu/categories/suggested-order?hour=${h}`);
}

export async function getPosBrands(): Promise<VirtualBrand[]> {
  return apiRequest<VirtualBrand[]>('/menu/pos-brands');
}

/* ==================== Order Endpoints ==================== */

interface OrderFilters {
  status?: string;
  date?: string;
  payment_status?: string;
}

export async function getOrders(filters?: OrderFilters): Promise<Order[]> {
  const queryParams = new URLSearchParams();
  if (filters?.status) queryParams.append('status', filters.status);
  if (filters?.date) queryParams.append('date', filters.date);
  if (filters?.payment_status) queryParams.append('payment_status', filters.payment_status);

  const endpoint = `/orders${queryParams.toString() ? `?${queryParams}` : ''}`;
  return apiRequest<Order[]>(endpoint);
}

export async function getOrder(id: number): Promise<Order> {
  return apiRequest<Order>(`/orders/${id}`);
}

export async function lookupOrders(query: string): Promise<Order[]> {
  const q = query.trim();
  if (!q) return [];
  return apiRequest<Order[]>(`/orders/lookup?q=${encodeURIComponent(q)}`);
}

export async function getTodayOrderCount(): Promise<number> {
  const res = await apiRequest<{ count: number }>('/orders/today-count');
  return res.count ?? 0;
}

export interface KioskHeldOrder {
  id: number;
  order_number: string | number;
  total: number;
  created_at: string;
  loyalty_customer_id: number | null;
  customer_name: string | null;
  customer_phone: string | null;
  status: string;
  payment_status: string;
  kind: 'held' | 'stranded_terminal';
  items: Array<{
    menu_item_id: number;
    item_name: string;
    quantity: number;
    unit_price: number;
  }>;
}

export async function getKioskHeldOrders(): Promise<KioskHeldOrder[]> {
  return apiRequest<KioskHeldOrder[]>('/orders/kiosk-held');
}

export async function claimKioskOrder(id: number): Promise<{ id: number; status: string }> {
  return apiRequest(`/orders/${id}/claim`, { method: 'POST' });
}

interface DiscountPayload {
  type: 'percent' | 'amount' | 'comp';
  value: number;
  reason: string;
  /** Single-use approval bound to this discount; one per discounted line. */
  approval_id?: string;
}

interface CreateOrderData {
  employee_id: number;
  items: {
    menu_item_id: number;
    quantity: number;
    notes?: string;
    modifiers?: number[];
    combo_instance_id?: string | null;
    virtual_brand_id?: number | null;
    discount?: DiscountPayload | null;
  }[];
  discount?: DiscountPayload | null;
  order_fulfillment_type?: 'for_here' | 'to_go' | 'delivery';
  customer_call_name?: string;
  // Idempotency key. Server dedupes via the unique index on
  // (tenant_id, offline_temp_id) — a retry of the same submit returns
  // the existing order instead of creating a duplicate. Required on POS
  // surfaces; offline sync path already passes its own tempId.
  offline_temp_id?: string;
}

export async function createOrder(data: CreateOrderData): Promise<Order> {
  return apiRequest<Order>('/orders', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function syncOfflineOrder(
  data: CreateOrderData & { tip?: number; amount_received?: number },
): Promise<Order> {
  return apiRequest<Order>('/orders/sync', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

/**
 * Context for an `apply_discounts` approval — required for that permission and
 * ignored for every other. Binds the minted record to the exact discount the
 * manager is putting their PIN behind, so a 10%-off approval can't be replayed
 * as a comp.
 */
export interface DiscountApprovalContext {
  scope: 'cart' | 'line';
  discount_type: DiscountType;
  discount_value: number;
  base_amount?: number;
  item_label?: string;
}

export async function managerApprove(
  pin: string,
  permission: string,
  context?: DiscountApprovalContext
): Promise<{
  employee_id: number;
  employee_name: string;
  role: string;
  approval_token: string;
  approval_id?: string;
}> {
  return apiRequest('/employees/manager-approve', {
    method: 'POST',
    body: JSON.stringify({ pin, permission, context }),
  });
}

/**
 * Header carrying a one-shot manager approval. Routes declared with
 * `requireAuth(perm, { allowApproval: true })` accept it in place of the
 * actor's own role permission.
 */
export function approvalHeader(token?: string): Record<string, string> {
  return token ? { 'X-Approval-Token': token } : {};
}

export async function updateOrderStatus(
  id: number,
  status: string
): Promise<any> {
  return apiRequest(`/orders/${id}/status`, {
    method: 'PUT',
    body: JSON.stringify({ status }),
  });
}

export async function deleteOrder(
  id: number,
  approvalToken?: string
): Promise<{ success: boolean; deleted_id: number }> {
  return apiRequest(`/orders/${id}`, { method: 'DELETE', headers: approvalHeader(approvalToken) });
}

export type OrderEditTotals = {
  subtotal: number;
  tax: number;
  total: number;
  payment_status: string;
};

// The three order-edit mutations. Editing a *paid* order needs void_orders, so
// they take an optional approval token — pass them through useManagerApproval's
// run() and the PIN pad handles it.
export async function appendOrderItems(
  orderId: number,
  items: CreateOrderData['items'],
  approvalToken?: string
): Promise<OrderEditTotals & { success: true; order_id: number; inserted_item_ids: number[] }> {
  return apiRequest(`/orders/${orderId}/items`, {
    method: 'POST',
    body: JSON.stringify({ items }),
    headers: approvalHeader(approvalToken),
  });
}

export async function updateOrderItemQuantity(
  orderId: number,
  itemId: number,
  quantity: number,
  approvalToken?: string
): Promise<OrderEditTotals & { success: true; item_id: number; quantity: number }> {
  return apiRequest(`/orders/${orderId}/items/${itemId}`, {
    method: 'PATCH',
    body: JSON.stringify({ quantity }),
    headers: approvalHeader(approvalToken),
  });
}

export async function voidOrderItem(
  orderId: number,
  itemId: number,
  voidReason: string,
  approvalToken?: string
): Promise<OrderEditTotals & { success: true; item_id: number; voided: true }> {
  return apiRequest(`/orders/${orderId}/items/${itemId}`, {
    method: 'DELETE',
    body: JSON.stringify({ void_reason: voidReason }),
    headers: approvalHeader(approvalToken),
  });
}

export async function purgeUnpaidOrders(): Promise<{ success: boolean; deleted_count: number }> {
  return apiRequest('/orders/purge-unpaid', { method: 'POST' });
}

// Apply (or clear with discount=null) an order-level discount on an existing order.
// A 403 carrying code 'approval_required' means the operator lacks
// apply_discounts: mint an approval via managerApprove(pin, 'apply_discounts',
// context) and re-send with `approval_id` on the discount.
export async function applyOrderDiscount(
  orderId: number,
  discount: Discount | null
): Promise<OrderEditTotals & {
  success: true;
  order_id: number;
  discount: null | { type: DiscountType; value: number; reason: string; amount: number; authorized_by: number };
}> {
  return apiRequest(`/orders/${orderId}/discount`, {
    method: 'POST',
    body: JSON.stringify({
      discount: discount
        ? {
            type: discount.type,
            value: discount.value,
            reason: discount.reason,
            approval_id: discount.approval_id,
          }
        : null,
    }),
  });
}

export async function getKitchenOrders(opts?: { includeReady?: boolean; kds?: boolean }): Promise<Order[]> {
  const params = new URLSearchParams();
  if (opts?.includeReady) params.set('include_ready', '1');
  // kds=1 tells the server this is a REAL kitchen display, so it stamps
  // first_kds_seen_at. Cashier boards / live strips must omit it, or they
  // blind the sentinel's kds_blind sensor. See routes/orders.js.
  if (opts?.kds) params.set('kds', '1');
  const qs = params.toString();
  return apiRequest<Order[]>(`/orders/kitchen/active${qs ? `?${qs}` : ''}`);
}

export async function confirmOrderPayment(
  orderId: number,
  payment_method: 'cash' | 'card' | 'transfer',
  reference?: string
): Promise<{ success: boolean; order: Order }> {
  return apiRequest(`/orders/${orderId}/payment`, {
    method: 'PATCH',
    body: JSON.stringify({ payment_method, reference }),
  });
}

export async function sendSmsReceipt(
  orderId: number,
  phone: string,
  country_code: string = 'MX',
  opts: { enroll_loyalty?: boolean; customer_name?: string } = {},
): Promise<{
  success: boolean;
  token: string;
  url: string;
  message_sid: string;
  loyalty: null | { customer_id: number; stamps_earned: number; stamps_required: number; card_completed: boolean };
}> {
  return apiRequest(`/orders/${orderId}/sms-receipt`, {
    method: 'POST',
    body: JSON.stringify({ phone, country_code, ...opts }),
  });
}

export interface PublicReceiptResponse {
  tenant: { name: string; branding: Record<string, unknown> | null };
  order: {
    id: number;
    order_number: string | number;
    subtotal: number;
    tax: number;
    tip: number;
    total: number;
    payment_status: string;
    payment_method: string | null;
    created_at: string;
    paid_at: string | null;
    items: Array<{
      id: number;
      item_name: string;
      quantity: number;
      unit_price: number;
      notes: string | null;
    }>;
  };
}

export async function getPublicReceipt(token: string): Promise<PublicReceiptResponse> {
  const base = FALLBACK_URLS.length ? await resolveBaseUrl() : activeBaseUrl;
  const res = await fetch(`${base}/public/receipts/${encodeURIComponent(token)}`);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Failed to load receipt (${res.status})`);
  }
  return res.json();
}

/* ==================== Payment Endpoints ==================== */

interface CreatePaymentIntentData {
  order_id: number;
  tip?: number;
}

export async function createPaymentIntent(
  data: CreatePaymentIntentData
): Promise<any> {
  return apiRequest('/payments/create-intent', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

interface ConfirmPaymentData {
  order_id: number;
  payment_intent_id: string;
}

export async function confirmPayment(data: ConfirmPaymentData): Promise<any> {
  return apiRequest('/payments/confirm', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

interface RefundPaymentData {
  order_id: number;
  amount?: number;
  items?: Array<{ order_item_id: number; quantity: number }>;
  reason?: string;
}

export async function refundPayment(data: RefundPaymentData, approvalToken?: string): Promise<any> {
  return apiRequest('/payments/refund', {
    method: 'POST',
    body: JSON.stringify(data),
    headers: approvalHeader(approvalToken),
  });
}

interface CashTipAdjustResult {
  success: boolean;
  order_id: number;
  order_number: number;
  tip_total: number;
  tip_added: number;
}

export async function addCashTip(
  orderId: number,
  amount: number,
  note?: string
): Promise<CashTipAdjustResult> {
  return apiRequest<CashTipAdjustResult>('/payments/cash-tip-adjust', {
    method: 'POST',
    body: JSON.stringify({ order_id: orderId, amount, note }),
  });
}

export async function getOrderRefunds(orderId: number): Promise<Refund[]> {
  return apiRequest<Refund[]>(`/payments/refunds/${orderId}`);
}

export async function getAllRefunds(startDate?: string, endDate?: string): Promise<Refund[]> {
  const params = new URLSearchParams();
  if (startDate) params.append('start_date', startDate);
  if (endDate) params.append('end_date', endDate);
  const qs = params.toString();
  return apiRequest<Refund[]>(`/payments/refunds${qs ? `?${qs}` : ''}`);
}

export async function cashPayment(data: {
  order_id: number;
  tip?: number;
  amount_received?: number;
}): Promise<any> {
  return apiRequest('/payments/cash', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function getPaymentStatus(orderId: number): Promise<any> {
  return apiRequest(`/payments/${orderId}`);
}

/* ==================== Inventory Endpoints ==================== */

export async function getInventory(): Promise<InventoryItem[]> {
  return apiRequest<InventoryItem[]>('/inventory');
}

export async function getLowStock(): Promise<InventoryItem[]> {
  return apiRequest<InventoryItem[]>('/inventory/low-stock');
}

export async function updateInventory(
  id: number,
  data: Partial<Pick<
    InventoryItem,
    | 'name'
    | 'quantity'
    | 'unit'
    | 'low_stock_threshold'
    | 'category'
    | 'cost_price'
    | 'sku'
    | 'barcode'
    | 'expiry_date'
    | 'lot_number'
    | 'pack_size'
    | 'shelf_life_days'
    | 'storage_type'
  >>
): Promise<any> {
  return apiRequest(`/inventory/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function restockItem(id: number, quantity: number): Promise<any> {
  return apiRequest(`/inventory/${id}/restock`, {
    method: 'POST',
    body: JSON.stringify({ quantity }),
  });
}

export async function deductInventory(orderId: number): Promise<any> {
  return apiRequest('/inventory/deduct', {
    method: 'POST',
    body: JSON.stringify({ order_id: orderId }),
  });
}

export async function lookupInventoryItem(value: string): Promise<InventoryItem> {
  return apiRequest<InventoryItem>(`/inventory/lookup?barcode=${encodeURIComponent(value)}`);
}

export interface InventoryMatch {
  inventory_item_id: number;
  inventory_item_name: string;
  quantity: number;
  cost_price?: number;
  raw_description?: string;
}

export interface InventorySearchResult {
  id: number;
  name: string;
  quantity: number;
  unit: string;
  cost_price: number;
  category: string;
  pack_size?: number | null;
}

export async function searchInventory(query: string): Promise<InventorySearchResult[]> {
  return apiRequest<InventorySearchResult[]>(`/inventory/search?q=${encodeURIComponent(query)}`);
}

export async function scanRestock(data: {
  barcode: string;
  quantity: number;
  cost_price?: number;
}): Promise<{ item: InventoryItem; new_quantity: number }> {
  return apiRequest('/inventory/scan-restock', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function createInventoryItem(data: {
  name: string;
  unit?: string;
  quantity?: number;
  low_stock_threshold?: number;
  cost_price?: number;
  sku?: string;
  barcode?: string;
  expiry_date?: string;
  lot_number?: string;
  category?: string;
  pack_size?: number | null;
  shelf_life_days?: number | null;
  storage_type?: 'refrigerated' | 'frozen' | 'dry' | 'ambient' | null;
}): Promise<InventoryItem> {
  return apiRequest<InventoryItem>('/inventory', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export interface SuggestedItemAttrs {
  shelf_life_days: number;
  storage_type: 'refrigerated' | 'frozen' | 'dry' | 'ambient';
  category: string;
  confidence: 'high' | 'medium' | 'low';
  source: 'ai' | 'fallback';
}

export async function suggestInventoryAttrs(name: string, category?: string): Promise<SuggestedItemAttrs> {
  return apiRequest<SuggestedItemAttrs>('/inventory/suggest-attrs', {
    method: 'POST',
    body: JSON.stringify({ name, category: category || undefined }),
  });
}

export interface StaleStockItem {
  id: number;
  name: string;
  quantity: number;
  unit: string | null;
  category: string | null;
  shelf_life_days: number;
  storage_type: 'refrigerated' | 'frozen' | 'dry' | 'ambient' | null;
  last_restocked_at: string;
  cost_price: number;
  days_since_restock: number;
  stale_status: 'expired' | 'soon';
}

export async function getStaleStock(includeSoon = false): Promise<StaleStockItem[]> {
  return apiRequest<StaleStockItem[]>(`/inventory/stale${includeSoon ? '?include_soon=1' : ''}`);
}

export async function touchInventoryRestocked(id: number): Promise<{ success: boolean }> {
  return apiRequest<{ success: boolean }>(`/inventory/${id}/touch-restocked`, { method: 'POST' });
}

export interface DormantStockItem {
  id: number;
  name: string;
  quantity: number;
  unit: string | null;
  category: string | null;
  cost_price: number;
  last_restocked_at: string | null;
  last_activity_at: string | null;
  days_since_activity: number;
}

export async function getDormantStock(days = 30): Promise<DormantStockItem[]> {
  return apiRequest<DormantStockItem[]>(`/inventory/dormant?days=${days}`);
}

export async function getInventoryTouchedToday(): Promise<number[]> {
  return apiRequest<number[]>(`/inventory/touched-today`);
}

export interface InventoryAuditStatus {
  total: number;
  missing_shelf_life: number;
  missing_clock: number;
}

export async function getInventoryAuditStatus(): Promise<InventoryAuditStatus> {
  return apiRequest<InventoryAuditStatus>('/inventory/audit-status');
}

export interface BackfillAttrsResult {
  processed: number;
  ai_hits: number;
  fallbacks: number;
  restock_clock_set: number;
  remaining: number;
  items: Array<{
    id: number;
    name: string;
    shelf_life_days: number;
    storage_type: string;
    source: 'ai' | 'fallback';
    restock_clock_set: boolean;
  }>;
}

export async function backfillInventoryAttrs(limit = 25): Promise<BackfillAttrsResult> {
  return apiRequest<BackfillAttrsResult>('/inventory/backfill-attrs', {
    method: 'POST',
    body: JSON.stringify({ limit }),
  });
}

export async function markInventoryWasted(
  id: number,
  data?: { quantity?: number; reason?: 'spoilage' | 'prep_error' | 'dropped' | 'expired' | 'other'; notes?: string }
): Promise<{ success: boolean; new_quantity: number; wasted: number; cost_at_time: number }> {
  return apiRequest(`/inventory/${id}/mark-wasted`, {
    method: 'POST',
    body: JSON.stringify(data || {}),
  });
}

export async function deleteInventoryItem(id: number): Promise<{ id: number; deleted: true }> {
  return apiRequest<{ id: number; deleted: true }>(`/inventory/${id}`, {
    method: 'DELETE',
  });
}

export type InventoryResetMode = 'zero' | 'wipe';

export interface InventoryResetPreview {
  inventory_items: number;
  items_with_stock: number;
  history_rows: number;
  recipe_links: number;
  counts: Record<string, number>;
}

export interface InventoryResetResult {
  mode: InventoryResetMode;
  items_affected: number;
  deleted: Record<string, number>;
}

export async function getInventoryResetPreview(): Promise<InventoryResetPreview> {
  return apiRequest<InventoryResetPreview>('/inventory/reset/preview');
}

export async function resetInventory(
  mode: InventoryResetMode,
  confirm: string
): Promise<InventoryResetResult> {
  return apiRequest<InventoryResetResult>('/inventory/reset', {
    method: 'POST',
    body: JSON.stringify({ mode, confirm }),
  });
}

/* ==================== Waste Endpoints ==================== */

export async function logWaste(data: {
  inventory_item_id: number;
  quantity: number;
  reason: string;
  notes?: string;
}): Promise<WasteLogEntry> {
  return apiRequest<WasteLogEntry>('/waste', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function getWasteLog(params?: {
  start_date?: string;
  end_date?: string;
  item_id?: number;
}): Promise<WasteLogEntry[]> {
  const qs = new URLSearchParams();
  if (params?.start_date) qs.append('start_date', params.start_date);
  if (params?.end_date) qs.append('end_date', params.end_date);
  if (params?.item_id) qs.append('item_id', String(params.item_id));
  const s = qs.toString();
  return apiRequest<WasteLogEntry[]>(`/waste${s ? `?${s}` : ''}`);
}

export async function getWasteReport(params?: {
  start_date?: string;
  end_date?: string;
}): Promise<WasteReport> {
  const qs = new URLSearchParams();
  if (params?.start_date) qs.append('start_date', params.start_date);
  if (params?.end_date) qs.append('end_date', params.end_date);
  const s = qs.toString();
  return apiRequest<WasteReport>(`/waste/report${s ? `?${s}` : ''}`);
}

/* ==================== COGS Summary ==================== */

export async function getCOGSSummary(period?: string): Promise<COGSSummary> {
  const p = period || '30d';
  return apiRequest<COGSSummary>(`/reports/cogs-summary?period=${p}`);
}

/* ==================== Employee Endpoints ==================== */

export async function getEmployees(): Promise<Employee[]> {
  return apiRequest<Employee[]>('/employees');
}

interface CreateEmployeeData {
  name: string;
  pin: string;
  role: string;
  /** Optional WhatsApp/SMS ops number. Empty string clears it on update. */
  phone?: string;
}

export async function createEmployee(data: CreateEmployeeData): Promise<Employee> {
  return apiRequest<Employee>('/employees', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updateEmployee(
  id: number,
  data: { name?: string; pin?: string; role?: string; phone?: string }
): Promise<any> {
  return apiRequest(`/employees/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function loginEmployee(pin: string): Promise<Employee> {
  return apiRequest<Employee>('/employees/login', {
    method: 'POST',
    body: JSON.stringify({ pin }),
  });
}

/* ==================== Time Clock ==================== */

import type {
  ShiftStatusResponse,
  ClockInResponse,
  ClockOutResponse,
  ActiveShift,
  ShiftRow,
} from '../types';

export async function getShiftStatus(pin: string): Promise<ShiftStatusResponse> {
  return apiRequest<ShiftStatusResponse>('/shifts/status', {
    method: 'POST',
    body: JSON.stringify({ pin }),
  });
}

export async function clockIn(pin: string): Promise<ClockInResponse> {
  return apiRequest<ClockInResponse>('/shifts/clock-in', {
    method: 'POST',
    body: JSON.stringify({ pin }),
  });
}

export async function clockOut(pin: string): Promise<ClockOutResponse> {
  return apiRequest<ClockOutResponse>('/shifts/clock-out', {
    method: 'POST',
    body: JSON.stringify({ pin }),
  });
}

export async function getActiveShifts(): Promise<ActiveShift[]> {
  return apiRequest<ActiveShift[]>('/shifts/active');
}

export interface CashSummaryResponse {
  has_open_shift: boolean;
  shift_id?: number;
  opening_total?: number;
  cash_sales_total?: number;
  expected_cash_total?: number;
}

/** Live cash-drawer total for the authenticated employee's open shift. */
export async function getMyCashSummary(): Promise<CashSummaryResponse> {
  return apiRequest<CashSummaryResponse>('/shifts/me/cash-summary');
}

export async function adminClockInEmployee(employee_id: number): Promise<ClockInResponse> {
  return apiRequest<ClockInResponse>('/shifts/admin/clock-in', {
    method: 'POST',
    body: JSON.stringify({ employee_id }),
  });
}

export async function adminClockOutEmployee(employee_id: number): Promise<ClockOutResponse> {
  return apiRequest<ClockOutResponse>('/shifts/admin/clock-out', {
    method: 'POST',
    body: JSON.stringify({ employee_id }),
  });
}

/* ==================== Scheduled Shifts ==================== */

import type { ScheduledShiftRow } from '../types';

export async function getScheduledShifts(params: {
  from?: string;
  to?: string;
  employee_id?: number;
} = {}): Promise<ScheduledShiftRow[]> {
  const qs = new URLSearchParams();
  if (params.from) qs.set('from', params.from);
  if (params.to) qs.set('to', params.to);
  if (params.employee_id) qs.set('employee_id', String(params.employee_id));
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return apiRequest<ScheduledShiftRow[]>(`/shifts/scheduled${suffix}`);
}

export async function createScheduledShift(data: {
  employee_id: number;
  starts_at: string;
  ends_at: string;
  notes?: string;
}): Promise<ScheduledShiftRow> {
  return apiRequest<ScheduledShiftRow>('/shifts/scheduled', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updateScheduledShift(
  id: number,
  data: { starts_at?: string; ends_at?: string; notes?: string }
): Promise<ScheduledShiftRow> {
  return apiRequest<ScheduledShiftRow>(`/shifts/scheduled/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export async function deleteScheduledShift(id: number): Promise<{ success: boolean }> {
  return apiRequest<{ success: boolean }>(`/shifts/scheduled/${id}`, {
    method: 'DELETE',
  });
}

export async function getShifts(params: { from?: string; to?: string; employee_id?: number } = {}): Promise<ShiftRow[]> {
  const qs = new URLSearchParams();
  if (params.from) qs.set('from', params.from);
  if (params.to) qs.set('to', params.to);
  if (params.employee_id) qs.set('employee_id', String(params.employee_id));
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return apiRequest<ShiftRow[]>(`/shifts${suffix}`);
}

export async function updateShift(
  id: number,
  data: { clock_in_at?: string; clock_out_at?: string | null; notes?: string }
): Promise<ShiftRow> {
  return apiRequest<ShiftRow>(`/shifts/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export async function updateShiftCashDrawer(
  id: number,
  data: {
    opening_counts?: Record<string, number>;
    closing_counts?: Record<string, number>;
    variance_note?: string;
  }
): Promise<ShiftRow> {
  return apiRequest<ShiftRow>(`/shifts/${id}/cash-drawer`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export async function toggleEmployee(id: number): Promise<any> {
  return apiRequest(`/employees/${id}/toggle`, { method: 'PUT' });
}

/* ==================== Reports Endpoints ==================== */

/**
 * Optional explicit range for any report endpoint. When start_date and
 * end_date are both provided, the server uses them verbatim (YYYY-MM-DD,
 * inclusive). Otherwise it falls back to `period` anchored to
 * `week_start_dow` (defaults to Monday).
 */
export interface ReportRangeOpts {
  start_date?: string;
  end_date?: string;
  week_start_dow?: number;
}

function reportQS(period: string, opts: ReportRangeOpts = {}): string {
  const p = new URLSearchParams({ period });
  if (opts.start_date) p.set('start_date', opts.start_date);
  if (opts.end_date) p.set('end_date', opts.end_date);
  if (opts.week_start_dow !== undefined) p.set('week_start_dow', String(opts.week_start_dow));
  return p.toString();
}

export async function getSalesReport(period: string, opts: ReportRangeOpts = {}): Promise<SalesReport> {
  return apiRequest<SalesReport>(`/reports/sales?${reportQS(period, opts)}`);
}

export async function getTopItems(
  period: string,
  limit: number = 10
): Promise<TopItemsReport[]> {
  return apiRequest<TopItemsReport[]>(
    `/reports/top-items?period=${period}&limit=${limit}`
  );
}

export interface ItemSalesReportFilters {
  customerId?: number | 'all';
  hour?: number | 'all';
  minQuantity?: number;
  relatedItemId?: number | 'all';
}

export async function getItemSalesReport(
  period: string,
  filters: ItemSalesReportFilters = {},
  opts: ReportRangeOpts = {}
): Promise<ItemSalesReport> {
  const params = new URLSearchParams(reportQS(period, opts));
  if (filters.customerId && filters.customerId !== 'all') {
    params.set('customer_id', String(filters.customerId));
  }
  if (filters.hour !== undefined && filters.hour !== 'all') {
    params.set('hour', String(filters.hour));
  }
  if (filters.minQuantity && filters.minQuantity > 0) {
    params.set('min_quantity', String(filters.minQuantity));
  }
  if (filters.relatedItemId && filters.relatedItemId !== 'all') {
    params.set('related_item_id', String(filters.relatedItemId));
  }
  return apiRequest<ItemSalesReport>(`/reports/item-sales?${params.toString()}`);
}

export async function getEmployeePerformance(
  period: string,
  opts: ReportRangeOpts = {}
): Promise<EmployeePerformanceReport[]> {
  return apiRequest<EmployeePerformanceReport[]>(
    `/reports/employee-performance?${reportQS(period, opts)}`
  );
}

export async function getHourlyReport(): Promise<HourlyReport[]> {
  return apiRequest<HourlyReport[]>('/reports/hourly');
}

export async function getCashCardBreakdown(period: string, opts: ReportRangeOpts = {}): Promise<CashCardBreakdown> {
  return apiRequest<CashCardBreakdown>(`/reports/cash-card-breakdown?${reportQS(period, opts)}`);
}

export async function getCOGSReport(period: string, opts: ReportRangeOpts = {}): Promise<COGSReport> {
  return apiRequest<COGSReport>(`/reports/cogs?${reportQS(period, opts)}`);
}

export async function getCategoryMargins(period: string, opts: ReportRangeOpts = {}): Promise<CategoryMargins> {
  return apiRequest<CategoryMargins>(`/reports/category-margins?${reportQS(period, opts)}`);
}

export async function getContributionMargin(period: string, opts: ReportRangeOpts = {}): Promise<ContributionMarginReport> {
  return apiRequest<ContributionMarginReport>(`/reports/contribution-margin?${reportQS(period, opts)}`);
}

export async function getLiveDashboard(): Promise<LiveDashboardData> {
  return apiRequest<LiveDashboardData>('/reports/live');
}

export async function getDeliveryMargins(period: string, opts: ReportRangeOpts = {}): Promise<any> {
  return apiRequest(`/reports/delivery-margins?${reportQS(period, opts)}`);
}

export async function getChannelComparison(period: string, opts: ReportRangeOpts = {}): Promise<any> {
  return apiRequest(`/reports/channel-comparison?${reportQS(period, opts)}`);
}

/* ==================== Modifier Endpoints ==================== */

export async function getModifierGroups(): Promise<ModifierGroup[]> {
  return apiRequest<ModifierGroup[]>('/modifiers/groups');
}

export async function getModifierGroupsForItem(menuItemId: number): Promise<ModifierGroup[]> {
  return apiRequest<ModifierGroup[]>(`/modifiers/groups/item/${menuItemId}`);
}

export async function createModifierGroup(data: Partial<ModifierGroup>): Promise<ModifierGroup> {
  return apiRequest<ModifierGroup>('/modifiers/groups', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updateModifierGroup(id: number, data: Partial<ModifierGroup>): Promise<any> {
  return apiRequest(`/modifiers/groups/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function createModifier(data: { group_id: number; name: string; price_adjustment: number }): Promise<any> {
  return apiRequest('/modifiers', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updateModifier(id: number, data: Partial<{ name: string; price_adjustment: number; active: boolean }>): Promise<any> {
  return apiRequest(`/modifiers/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function deleteModifier(id: number): Promise<any> {
  return apiRequest(`/modifiers/${id}`, { method: 'DELETE' });
}

export async function deleteModifierGroup(id: number): Promise<any> {
  return apiRequest(`/modifiers/groups/${id}`, { method: 'DELETE' });
}

export async function assignModifierGroupToItem(menuItemId: number, groupId: number): Promise<any> {
  return apiRequest('/modifiers/assign', {
    method: 'POST',
    body: JSON.stringify({ menu_item_id: menuItemId, modifier_group_id: groupId }),
  });
}

export async function removeModifierGroupFromItem(menuItemId: number, groupId: number): Promise<any> {
  return apiRequest('/modifiers/unassign', {
    method: 'POST',
    body: JSON.stringify({ menu_item_id: menuItemId, modifier_group_id: groupId }),
  });
}

export async function getItemsWithModifiers(): Promise<{ itemIds: number[] }> {
  return apiRequest<{ itemIds: number[] }>('/modifiers/items-with-modifiers');
}

/* ==================== Recipe Endpoints ==================== */

export async function getRecipeSummary(): Promise<RecipeSummaryItem[]> {
  return apiRequest<RecipeSummaryItem[]>('/menu/recipes/summary');
}

export async function getItemRecipe(menuItemId: number): Promise<RecipeIngredient[]> {
  return apiRequest<RecipeIngredient[]>(`/menu/items/${menuItemId}/recipe`);
}

export async function updateItemRecipe(
  menuItemId: number,
  ingredients: { inventory_item_id: number; quantity_used: number }[]
): Promise<RecipeIngredient[]> {
  return apiRequest<RecipeIngredient[]>(`/menu/items/${menuItemId}/recipe`, {
    method: 'PUT',
    body: JSON.stringify({ ingredients }),
  });
}

/* ==================== Recipe Import Endpoints ==================== */

export interface RecipeParseLine {
  qty: number;
  unit: string;
  name: string;
  raw: string;
}

export interface RecipeMatchedLine extends RecipeParseLine {
  match: {
    inventory_item_id: number;
    name: string;
    unit: string;
    cost_price: number;
    stock: number;
    confidence: 'exact' | 'alias' | 'contains' | 'fuzzy' | 'none';
    quantity_used: number;
    unit_mismatch: boolean;
    line_cost: number | null;
  } | null;
  candidates: { inventory_item_id: number; name: string; unit: string; score: number }[];
  zombie_warning: { sibling_id: number; sibling_name: string } | null;
}

export interface RecipePreview {
  menu_item: { id: number; name: string; price: number };
  current: RecipeIngredient[];
  matched: RecipeMatchedLine[];
  summary: {
    proposed_total_cost: number;
    current_total_cost: number;
    unmatched_count: number;
    unit_mismatch_count: number;
    zombie_warning_count: number;
  };
}

export async function parseRecipeText(menuItemId: number, text: string): Promise<{ lines: RecipeParseLine[] }> {
  return apiRequest(`/menu/items/${menuItemId}/recipe/parse`, {
    method: 'POST',
    body: JSON.stringify({ text }),
  });
}

export async function previewRecipe(menuItemId: number, lines: RecipeParseLine[]): Promise<RecipePreview> {
  return apiRequest(`/menu/items/${menuItemId}/recipe/preview`, {
    method: 'POST',
    body: JSON.stringify({ lines }),
  });
}

export async function applyRecipe(
  menuItemId: number,
  ingredients: { inventory_item_id: number; quantity_used: number; alias?: string }[],
): Promise<RecipeIngredient[]> {
  return apiRequest(`/menu/items/${menuItemId}/recipe/apply`, {
    method: 'POST',
    body: JSON.stringify({ ingredients }),
  });
}

/* ==================== Combo Endpoints ==================== */

export async function getCombos(): Promise<ComboDefinition[]> {
  return apiRequest<ComboDefinition[]>('/combos');
}

export async function createCombo(data: Partial<ComboDefinition>): Promise<ComboDefinition> {
  return apiRequest<ComboDefinition>('/combos', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updateCombo(id: number, data: Partial<ComboDefinition>): Promise<any> {
  return apiRequest(`/combos/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function deleteCombo(id: number): Promise<any> {
  return apiRequest(`/combos/${id}`, { method: 'DELETE' });
}

/* ==================== Split Payment Endpoints ==================== */

export interface SplitRow {
  id: number;
  payment_method: 'card' | 'cash';
  amount: number;
  tip: number;
  status: 'pending' | 'pending_terminal' | 'paid' | 'failed';
  payment_intent_id?: string | null;
}

export async function splitStart(data: {
  order_id: number;
  splits: Array<{ payment_method: 'card' | 'cash'; amount: number; tip?: number }>;
}): Promise<{ success: boolean; order_id: number; splits: SplitRow[] }> {
  return apiRequest('/payments/split/start', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function splitChargeCard(
  order_payment_id: number,
  terminal_id?: string,
): Promise<{ success: boolean; order_payment_id: number; mp_order_id: string }> {
  return apiRequest('/payments/split/charge-card', {
    method: 'POST',
    body: JSON.stringify({ order_payment_id, terminal_id }),
  });
}

export async function splitCancelCard(order_payment_id: number): Promise<{ success: boolean }> {
  return apiRequest('/payments/split/cancel-card', {
    method: 'POST',
    body: JSON.stringify({ order_payment_id }),
  });
}

export async function splitRecordCash(
  order_payment_id: number,
  amount_received: number,
): Promise<{ success: boolean; change_due: number }> {
  return apiRequest('/payments/split/record-cash', {
    method: 'POST',
    body: JSON.stringify({ order_payment_id, amount_received }),
  });
}

export async function getSplitStatus(order_id: number): Promise<{ order_id: number; splits: SplitRow[] }> {
  return apiRequest(`/payments/split/${order_id}/status`);
}

export async function splitFinalize(order_id: number): Promise<{
  success: boolean;
  splits_count: number;
  tip: number;
  invoice_token: string | null;
}> {
  return apiRequest('/payments/split/finalize', {
    method: 'POST',
    body: JSON.stringify({ order_id }),
  });
}

/**
 * Tear a split flow back down to a normal single payment. Only legal while
 * nothing has been collected — the escape hatch for a terminal that won't take
 * the first leg, so the cashier never has to void and re-ring the check.
 */
export async function splitAbandon(order_id: number): Promise<{ success: boolean }> {
  return apiRequest('/payments/split/abandon', {
    method: 'POST',
    body: JSON.stringify({ order_id }),
  });
}

export async function getOrderSplits(orderId: number): Promise<OrderPayment[]> {
  return apiRequest<OrderPayment[]>(`/payments/split/${orderId}`);
}

/* ==================== Printer Endpoints ==================== */

export async function getPrinters(): Promise<Printer[]> {
  return apiRequest<Printer[]>('/printers');
}

export async function createPrinter(data: Partial<Printer>): Promise<Printer> {
  return apiRequest<Printer>('/printers', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updatePrinter(id: number, data: Partial<Printer>): Promise<any> {
  return apiRequest(`/printers/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function getCategoryPrinterRoutes(): Promise<any[]> {
  return apiRequest<any[]>('/printers/routes');
}

export async function updateCategoryPrinterRoute(categoryId: number, printerId: number | null): Promise<any> {
  return apiRequest('/printers/routes', {
    method: 'PUT',
    body: JSON.stringify({ category_id: categoryId, printer_id: printerId }),
  });
}

/* ==================== Print Bridge (on-site agent) ==================== */

export interface PrintBridgeStatus {
  configured: boolean;
  online: boolean;
  last_seen: string | null;
  queued: number;
  stuck_queued: number;
  printing: number;
  done_24h: number;
  errors_24h: number;
}

export async function getPrintBridgeStatus(): Promise<PrintBridgeStatus> {
  return apiRequest<PrintBridgeStatus>('/print-jobs/bridge-status');
}

export async function generatePrintAgentToken(): Promise<{ token: string }> {
  return apiRequest<{ token: string }>('/print-jobs/agent-token', { method: 'POST' });
}

/** One-time install code → copy-paste one-liner for the store's Mac. */
export async function createBridgeInstallCommand(): Promise<{ code: string; command: string; expires_at: string }> {
  return apiRequest<{ code: string; command: string; expires_at: string }>('/print-jobs/install-code', {
    method: 'POST',
  });
}

export async function sendTestPrint(printerId: number | null): Promise<{ job_id: number }> {
  return apiRequest<{ job_id: number }>('/print-jobs/test', {
    method: 'POST',
    body: JSON.stringify({ printer_id: printerId }),
  });
}

// Opt-in toggle: auto-print the customer ticket (loyalty QR + name + for-here/
// to-go) on the same kitchen printer whenever a counter order is paid.
export async function getCustomerTicketSetting(): Promise<{ enabled: boolean }> {
  return apiRequest<{ enabled: boolean }>('/print-jobs/customer-ticket-setting');
}

export async function updateCustomerTicketSetting(enabled: boolean): Promise<{ enabled: boolean }> {
  return apiRequest<{ enabled: boolean }>('/print-jobs/customer-ticket-setting', {
    method: 'PUT',
    body: JSON.stringify({ enabled }),
  });
}

// Tenant logo on the auto-printed customer ticket. Uploaded once as a normal
// image; the server converts it to the printer's 1-bit raster format at
// upload time and stores the packed bytes.
export async function getCustomerTicketLogo(): Promise<{ configured: boolean; height?: number | null }> {
  return apiRequest<{ configured: boolean; height?: number | null }>('/print-jobs/customer-ticket-logo');
}

export async function uploadCustomerTicketLogo(imageBase64: string): Promise<{ ok: boolean; width: number; height: number }> {
  return apiRequest<{ ok: boolean; width: number; height: number }>('/print-jobs/customer-ticket-logo', {
    method: 'PUT',
    body: JSON.stringify({ image: imageBase64 }),
  });
}

export async function deleteCustomerTicketLogo(): Promise<{ ok: boolean }> {
  return apiRequest<{ ok: boolean }>('/print-jobs/customer-ticket-logo', {
    method: 'DELETE',
  });
}

export interface PrinterPingResult {
  status: 'queued' | 'bridge_offline' | 'not_configured';
  job_id?: number;
  last_seen?: string | null;
}

/** Enqueue an end-to-end printer connectivity check (no paper output). */
export async function pingPrinter(printerId: number | null): Promise<PrinterPingResult> {
  return apiRequest<PrinterPingResult>('/print-jobs/ping', {
    method: 'POST',
    body: JSON.stringify({ printer_id: printerId }),
  });
}

export interface PrintJobStatus {
  id: number;
  job_type: string;
  status: 'queued' | 'printing' | 'done' | 'error';
  attempts: number;
  last_error: string | null;
  printed_at: string | null;
  created_at: string;
}

export async function getPrintJobStatus(jobId: number): Promise<PrintJobStatus> {
  return apiRequest<PrintJobStatus>(`/print-jobs/${jobId}/status`);
}

/* ==================== Delivery Endpoints ==================== */

export async function getDeliveryPlatforms(): Promise<DeliveryPlatform[]> {
  return apiRequest<DeliveryPlatform[]>('/delivery/platforms');
}

export async function updateDeliveryPlatform(id: number, data: Partial<DeliveryPlatform>): Promise<any> {
  return apiRequest(`/delivery/platforms/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function batchCreateDeliveryPlatforms(platforms: { name: string; display_name: string; commission_percent: number; default_markup_percent?: number }[]): Promise<{ success: boolean; platforms_created: number; platforms_updated: number }> {
  return apiRequest('/delivery/platforms/batch', {
    method: 'POST',
    body: JSON.stringify({ platforms }),
  });
}

export async function getDeliveryOrders(status?: string): Promise<DeliveryOrder[]> {
  const endpoint = status ? `/delivery/orders?status=${status}` : '/delivery/orders';
  return apiRequest<DeliveryOrder[]>(endpoint);
}

export async function getActiveDeliveryOrders(): Promise<DeliveryOrder[]> {
  return apiRequest<DeliveryOrder[]>('/delivery/orders/active');
}

export async function updateDeliveryOrderStatus(id: number, status: string): Promise<any> {
  return apiRequest(`/delivery/orders/${id}/status`, {
    method: 'PUT',
    body: JSON.stringify({ status }),
  });
}

/* ==================== Uber Direct (POS / employee surfaces) ==================== */

export interface UberDirectQuote {
  id: string;
  fee: number;
  currency?: string;
  currency_type?: string;
  duration?: number;
  dropoff_eta?: string;
  expires?: string;
}

export async function quoteUberDirect(body: {
  pickup_address?: string;
  pickup_phone_number?: string;
  dropoff_address: string;
  dropoff_phone_number: string;
  manifest_total_value?: number;
}): Promise<UberDirectQuote> {
  return apiRequest<UberDirectQuote>('/uber-direct/quote', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export interface UberDirectBooking {
  delivery_order_id: number;
  external_id: string;
  tracking_url: string | null;
  status: string;
  fee: number;
  dropoff_eta: string | null;
}

export async function bookUberDirect(body: {
  order_id: number;
  quote_id?: string;
  pickup_name?: string;
  pickup_address?: string;
  pickup_phone_number?: string;
  dropoff_name: string;
  dropoff_address: string;
  dropoff_phone_number: string;
  dropoff_notes?: string;
  manifest_items?: Array<{ name: string; quantity: number; price: number }>;
  manifest_total_value?: number;
  external_id?: string;
}): Promise<UberDirectBooking> {
  return apiRequest<UberDirectBooking>('/uber-direct/deliveries', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/* ==================== AI Endpoints ====================
 * Only functions with a live server counterpart in server/routes/ai.js.
 * The pre-extraction /ai surface (config, insights, analytics, pricing
 * suggestions, cart suggestions, feedback, ask/analyze) was pruned
 * 2026-07-20 — no callers, no backend. Rebuild server-first if needed. */

export async function getInventoryPushItems(): Promise<InventoryPushData> {
  return apiRequest<InventoryPushData>('/ai/suggestions/inventory-push');
}

export async function getInventoryForecast(): Promise<InventoryForecast[]> {
  return apiRequest<InventoryForecast[]>('/ai/inventory-forecast');
}

export async function getCategoryRoles(): Promise<CategoryRole[]> {
  return apiRequest<CategoryRole[]>('/ai/category-roles');
}

export async function updateCategoryRole(
  categoryId: number,
  role: string
): Promise<any> {
  return apiRequest(`/ai/category-roles/${categoryId}`, {
    method: 'PUT',
    body: JSON.stringify({ role }),
  });
}

/* ==================== Dynamic Pricing Endpoints ==================== */

export async function getPricingDashboard(): Promise<PricingDashboard> {
  return apiRequest<PricingDashboard>('/pricing/dashboard');
}

export async function getEnhancedPricingSuggestions(): Promise<{ heuristic: GrokPricingSuggestion[]; grok: GrokPricingSuggestion[] }> {
  return apiRequest('/pricing/suggestions');
}

export async function triggerPricingAnalysis(): Promise<{ suggestions: GrokPricingSuggestion[]; cached: boolean }> {
  return apiRequest('/pricing/analyze', { method: 'POST' });
}

export async function applyEnhancedPricingSuggestion(id: string, menuItemId: number, newPrice: number): Promise<any> {
  return apiRequest(`/pricing/suggestions/${id}/apply`, {
    method: 'POST',
    body: JSON.stringify({ menu_item_id: menuItemId, new_price: newPrice }),
  });
}

export async function dismissPricingSuggestion(id: string): Promise<any> {
  return apiRequest(`/pricing/suggestions/${id}/dismiss`, { method: 'POST' });
}

export async function getPricingRules(): Promise<PricingRule[]> {
  return apiRequest<PricingRule[]>('/pricing/rules');
}

export async function createPricingRule(data: Partial<PricingRule>): Promise<{ success: boolean; id: number }> {
  return apiRequest('/pricing/rules', { method: 'POST', body: JSON.stringify(data) });
}

export async function updatePricingRule(id: number, data: Partial<PricingRule>): Promise<any> {
  return apiRequest(`/pricing/rules/${id}`, { method: 'PUT', body: JSON.stringify(data) });
}

export async function deletePricingRule(id: number): Promise<any> {
  return apiRequest(`/pricing/rules/${id}`, { method: 'DELETE' });
}

export async function previewPricingRule(id: number): Promise<Array<{ menu_item_id: number; item_name: string; current_price: number; projected_price: number; change_percent: number }>> {
  return apiRequest(`/pricing/rules/${id}/preview`, { method: 'POST' });
}

export async function getPricingGuardrails(): Promise<PricingGuardrails> {
  return apiRequest<PricingGuardrails>('/pricing/guardrails');
}

export async function updatePricingGuardrails(data: Partial<PricingGuardrails>): Promise<any> {
  return apiRequest('/pricing/guardrails', { method: 'PUT', body: JSON.stringify(data) });
}

export async function getPriceHistory(params?: { item_id?: number; source?: string; from?: string; to?: string; page?: number; limit?: number }): Promise<{ data: PriceHistoryEntry[]; total: number; page: number; limit: number }> {
  const qs = new URLSearchParams();
  if (params?.item_id) qs.append('item_id', String(params.item_id));
  if (params?.source) qs.append('source', params.source);
  if (params?.from) qs.append('from', params.from);
  if (params?.to) qs.append('to', params.to);
  if (params?.page) qs.append('page', String(params.page));
  if (params?.limit) qs.append('limit', String(params.limit));
  const s = qs.toString();
  return apiRequest(`/pricing/history${s ? `?${s}` : ''}`);
}

export async function revertPriceChange(historyId: number): Promise<any> {
  return apiRequest(`/pricing/history/${historyId}/revert`, { method: 'POST' });
}

export async function getPricingImpact(itemId?: number): Promise<any[]> {
  const endpoint = itemId ? `/pricing/impact?item_id=${itemId}` : '/pricing/impact';
  return apiRequest(endpoint);
}

export async function getPricingExperiments(): Promise<PricingExperiment[]> {
  return apiRequest<PricingExperiment[]>('/pricing/experiments');
}

export async function createPricingExperiment(data: Partial<PricingExperiment>): Promise<{ success: boolean; id: number }> {
  return apiRequest('/pricing/experiments', { method: 'POST', body: JSON.stringify(data) });
}

export async function updatePricingExperiment(id: number, data: Partial<PricingExperiment> & { status?: string }): Promise<any> {
  return apiRequest(`/pricing/experiments/${id}`, { method: 'PUT', body: JSON.stringify(data) });
}

export async function applyExperimentWinner(id: number): Promise<any> {
  return apiRequest(`/pricing/experiments/${id}/apply-winner`, { method: 'POST' });
}

/* ==================== Reports - Reconciliation, Fees, Refunds ==================== */

export async function getReconciliation(startDate: string, endDate: string): Promise<{ rows: ReconciliationRow[]; summary: any }> {
  return apiRequest(`/reports/reconciliation?start_date=${startDate}&end_date=${endDate}`);
}

export async function getPaymentFees(period: string, opts: ReportRangeOpts = {}): Promise<PaymentFeeSummary> {
  return apiRequest<PaymentFeeSummary>(`/reports/payment-fees?${reportQS(period, opts)}`);
}

export async function getRefundSummary(startDate?: string, endDate?: string): Promise<RefundSummary> {
  const params = new URLSearchParams();
  if (startDate) params.append('start_date', startDate);
  if (endDate) params.append('end_date', endDate);
  const qs = params.toString();
  return apiRequest<RefundSummary>(`/reports/refund-summary${qs ? `?${qs}` : ''}`);
}

/* ==================== Reports - Financial Projection ==================== */

export async function getFinancialProjection(month: string): Promise<FinancialProjection> {
  return apiRequest<FinancialProjection>(`/reports/financial-projection?month=${month}`);
}

export async function updateFinancialTargets(targets: Array<{ category: string; target_percent: number }>): Promise<any> {
  return apiRequest('/reports/financial-targets', {
    method: 'PUT',
    body: JSON.stringify({ targets }),
  });
}

export async function getMenuEngineering(period: string, opts: ReportRangeOpts = {}): Promise<MenuEngineeringReport> {
  return apiRequest<MenuEngineeringReport>(`/reports/menu-engineering?${reportQS(period, opts)}`);
}

export async function updateFinancialActual(data: { period: string; category: string; amount: number }): Promise<any> {
  return apiRequest('/reports/financial-actuals', {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

/* ==================== Inventory - Counts, Variance, Alerts ==================== */

export async function recordInventoryCount(id: number, data: { counted_quantity: number; notes?: string }): Promise<InventoryCount> {
  return apiRequest<InventoryCount>(`/inventory/${id}/count`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function getInventoryCounts(params?: { item_id?: number; start_date?: string; end_date?: string }): Promise<InventoryCount[]> {
  const qs = new URLSearchParams();
  if (params?.item_id) qs.append('item_id', String(params.item_id));
  if (params?.start_date) qs.append('start_date', params.start_date);
  if (params?.end_date) qs.append('end_date', params.end_date);
  const s = qs.toString();
  return apiRequest<InventoryCount[]>(`/inventory/counts${s ? `?${s}` : ''}`);
}

export async function getVarianceReport(): Promise<VarianceReport[]> {
  return apiRequest<VarianceReport[]>('/inventory/variance-report');
}

export async function getShrinkageAlerts(acknowledged?: boolean): Promise<ShrinkageAlert[]> {
  const endpoint = acknowledged !== undefined
    ? `/inventory/shrinkage-alerts?acknowledged=${acknowledged ? '1' : '0'}`
    : '/inventory/shrinkage-alerts';
  return apiRequest<ShrinkageAlert[]>(endpoint);
}

export interface CostReviewCandidate {
  id: number;
  name: string;
  unit: string | null;
  stored_unit_cost: number;
  history_id: number;
  quantity_added: number;
  expense_amount: number | null;
  expense_date: string | null;
  vendor: string | null;
  proposed_unit_cost: number;
  detected_at: string;
}

export async function getCostReviewCandidates(): Promise<CostReviewCandidate[]> {
  const res = await apiRequest<{ candidates: CostReviewCandidate[] }>('/inventory/cost-review/candidates');
  return res.candidates || [];
}

export async function applyCostReviewCorrection(
  item_id: number,
  proposed_unit_cost: number
): Promise<{ success: boolean; item_id: number; prev_cost_price: number; new_cost_price: number }> {
  return apiRequest('/inventory/cost-review/apply', {
    method: 'POST',
    body: JSON.stringify({ item_id, proposed_unit_cost }),
  });
}

export async function acknowledgeShrinkageAlert(id: number): Promise<any> {
  return apiRequest(`/inventory/shrinkage-alerts/${id}/acknowledge`, { method: 'PUT' });
}

/* ==================== Vendors ==================== */

export async function getVendors(): Promise<Vendor[]> {
  return apiRequest<Vendor[]>('/purchase-orders/vendors');
}

export async function createVendor(data: Partial<Vendor>): Promise<Vendor> {
  return apiRequest<Vendor>('/purchase-orders/vendors', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updateVendor(id: number, data: Partial<Vendor>): Promise<any> {
  return apiRequest(`/purchase-orders/vendors/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

/* ==================== Purchase Orders ==================== */

export async function getPurchaseOrders(status?: string): Promise<PurchaseOrder[]> {
  const endpoint = status ? `/purchase-orders?status=${status}` : '/purchase-orders';
  return apiRequest<PurchaseOrder[]>(endpoint);
}

export async function getPurchaseOrder(id: number): Promise<PurchaseOrder> {
  return apiRequest<PurchaseOrder>(`/purchase-orders/${id}`);
}

export async function createPurchaseOrder(data: {
  vendor_id: number;
  items?: Array<{ inventory_item_id: number; quantity_ordered: number; unit_cost: number }>;
  notes?: string;
}): Promise<PurchaseOrder> {
  return apiRequest<PurchaseOrder>('/purchase-orders', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updatePurchaseOrder(id: number, data: {
  items?: Array<{ inventory_item_id: number; quantity_ordered: number; unit_cost: number }>;
  notes?: string;
}): Promise<any> {
  return apiRequest(`/purchase-orders/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function submitPurchaseOrder(id: number): Promise<any> {
  return apiRequest(`/purchase-orders/${id}/submit`, { method: 'POST' });
}

export async function receivePurchaseOrder(id: number, items: Array<{ po_item_id: number; quantity_received: number }>): Promise<any> {
  return apiRequest(`/purchase-orders/${id}/receive`, {
    method: 'POST',
    body: JSON.stringify({ items }),
  });
}

export async function cancelPurchaseOrder(id: number): Promise<any> {
  return apiRequest(`/purchase-orders/${id}/cancel`, { method: 'POST' });
}

/* ==================== Prep Forecast ==================== */

export async function getPrepForecast(date?: string): Promise<PrepForecast> {
  const endpoint = date ? `/ai/prep-forecast?date=${date}` : '/ai/prep-forecast';
  return apiRequest<PrepForecast>(endpoint);
}

export async function getInventoryInsights(): Promise<InventoryInsights> {
  return apiRequest<InventoryInsights>('/ai/inventory-insights');
}

/* ==================== Permissions ==================== */

export async function getAllPermissions(): Promise<Record<string, Record<string, boolean>>> {
  return apiRequest('/employees/permissions');
}

export async function updateRolePermissions(role: string, permissions: Record<string, boolean>): Promise<any> {
  return apiRequest(`/employees/permissions/${role}`, {
    method: 'PUT',
    body: JSON.stringify({ permissions }),
  });
}

/* ==================== Loyalty / CRM Endpoints ==================== */

export async function lookupLoyaltyCustomer(phone: string, countryCode?: string): Promise<LoyaltyCustomer> {
  const qs = countryCode ? `?country_code=${encodeURIComponent(countryCode)}` : '';
  return apiRequest<LoyaltyCustomer>(`/loyalty/customers/phone/${encodeURIComponent(phone)}${qs}`);
}

// Mints a signed loyalty-join link for a just-closed (or past) order, for the
// "scan to join" QR printed at the bottom of the counter receipt (ReceiptModal).
export async function getLoyaltyJoinToken(orderId: number): Promise<{ token: string }> {
  return apiRequest<{ token: string }>(`/loyalty/orders/${orderId}/join-token`);
}

// Resolve a scanned wallet-pass QR ("dk-loyalty:<serial>") to its customer —
// the register-scan path. Accepts the raw scan payload or the bare serial.
export async function lookupLoyaltyCustomerByPass(scan: string): Promise<LoyaltyCustomer> {
  return apiRequest<LoyaltyCustomer>(`/loyalty/customers/by-pass/${encodeURIComponent(scan)}`);
}

// Name-based search for the POS lookup modal — cashier types a name, backend
// returns up to 10 matches (prefix-ranked over contains). Each carries its
// active stamp card so the modal can render the same card UI as phone lookup.
export async function searchLoyaltyCustomersByName(name: string): Promise<LoyaltyCustomer[]> {
  const body = await apiRequest<{ customers: LoyaltyCustomer[] }>(
    `/loyalty/customers/search?name=${encodeURIComponent(name)}`
  );
  return body.customers || [];
}

export async function createLoyaltyCustomer(data: {
  phone: string;
  name: string;
  referral_code_used?: string;
  sms_opt_in?: boolean;
  country_code?: string;
}): Promise<LoyaltyCustomer & { created: boolean }> {
  return apiRequest('/loyalty/customers', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function getLoyaltyCustomers(params?: {
  search?: string;
  page?: number;
  limit?: number;
}): Promise<PaginatedResponse<LoyaltyCustomer>> {
  const qs = new URLSearchParams();
  if (params?.search) qs.append('search', params.search);
  if (params?.page) qs.append('page', String(params.page));
  if (params?.limit) qs.append('limit', String(params.limit));
  const s = qs.toString();
  return apiRequest(`/loyalty/customers${s ? `?${s}` : ''}`);
}

export async function getLoyaltyCustomer(id: number): Promise<LoyaltyCustomer & { cards: any[]; recentEvents: any[] }> {
  return apiRequest(`/loyalty/customers/${id}`);
}

export async function updateLoyaltyCustomer(
  id: number,
  data: {
    name?: string;
    phone?: string;
    country_code?: string;
    sms_opt_in?: boolean;
    orders_count?: number;
    total_spent?: number;
    stamps_earned?: number;
  },
): Promise<LoyaltyCustomer> {
  return apiRequest(`/loyalty/customers/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function addStampsForOrder(
  customerId: number,
  orderId: number,
  options: { suppressStampEarnedSms?: boolean } = {},
): Promise<StampResult> {
  return apiRequest<StampResult>(`/loyalty/customers/${customerId}/stamps`, {
    method: 'POST',
    body: JSON.stringify({
      order_id: orderId,
      suppress_stamp_earned_sms: options.suppressStampEarnedSms || false,
    }),
  });
}

export async function addManualStamps(customerId: number, count: number): Promise<{ stampCard: any; customer: LoyaltyCustomer }> {
  return apiRequest(`/loyalty/customers/${customerId}/stamps/manual`, {
    method: 'POST',
    body: JSON.stringify({ count }),
  });
}

export async function redeemLoyaltyReward(customerId: number): Promise<any> {
  return apiRequest(`/loyalty/customers/${customerId}/redeem`, { method: 'POST' });
}

export async function getLoyaltyAnalytics(): Promise<LoyaltyAnalytics> {
  return apiRequest<LoyaltyAnalytics>('/loyalty/analytics');
}

export async function getLoyaltyReferrals(): Promise<{
  leaderboard: any[];
  recentReferrals: ReferralEvent[];
  totalReferrals: number;
}> {
  return apiRequest('/loyalty/referrals');
}

export async function getLoyaltyConfig(): Promise<LoyaltyConfig> {
  return apiRequest<LoyaltyConfig>('/loyalty/config');
}

export async function updateLoyaltyConfig(key: string, value: string): Promise<LoyaltyConfig> {
  return apiRequest<LoyaltyConfig>('/loyalty/config', {
    method: 'PUT',
    body: JSON.stringify({ key, value }),
  });
}

/* ==================== Wallet Pass Endpoints ==================== */

export interface WalletStatus {
  apple: boolean;
  google: boolean;
}

export interface WalletEnrollResult {
  created: boolean;
  serial_number: string;
  enroll_url: string;
}

export async function getWalletStatus(): Promise<WalletStatus> {
  return apiRequest<WalletStatus>('/wallet/status');
}

export async function enrollWalletPass(customerId: number): Promise<WalletEnrollResult> {
  return apiRequest<WalletEnrollResult>('/wallet/enroll', {
    method: 'POST',
    body: JSON.stringify({ customer_id: customerId }),
  });
}

/* ==================== Order Template Endpoints ==================== */

export async function getOrderTemplates(): Promise<OrderTemplate[]> {
  return apiRequest<OrderTemplate[]>('/order-templates');
}

export async function createOrderTemplate(data: {
  name: string;
  description?: string;
  items: Array<{ menu_item_id: number; quantity: number }>;
}): Promise<OrderTemplate> {
  return apiRequest<OrderTemplate>('/order-templates', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

/* ==================== Delivery Intelligence Endpoints ==================== */

export async function getDeliveryAnalytics(start?: string, end?: string): Promise<any> {
  const qs = new URLSearchParams();
  if (start) qs.append('start', start);
  if (end) qs.append('end', end);
  const s = qs.toString();
  return apiRequest(`/delivery-intel/analytics${s ? `?${s}` : ''}`);
}

export async function getMarkupRules(): Promise<any[]> {
  return apiRequest('/delivery-intel/markup-rules');
}

export async function createMarkupRule(data: {
  platform_id: number;
  menu_item_id?: number;
  category_id?: number;
  markup_type?: string;
  markup_value: number;
}): Promise<{ id: number }> {
  return apiRequest('/delivery-intel/markup-rules', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updateMarkupRule(id: number, data: {
  markup_type?: string;
  markup_value?: number;
  active?: boolean;
}): Promise<any> {
  return apiRequest(`/delivery-intel/markup-rules/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function deleteMarkupRule(id: number): Promise<any> {
  return apiRequest(`/delivery-intel/markup-rules/${id}`, { method: 'DELETE' });
}

export async function getMarkupPreview(platformId: number): Promise<any[]> {
  return apiRequest(`/delivery-intel/markup-preview/${platformId}`);
}

export async function getVirtualBrands(): Promise<any[]> {
  return apiRequest('/delivery-intel/virtual-brands');
}

export async function createVirtualBrand(data: {
  name: string;
  platform_id?: number | null;
  description?: string;
  logo_url?: string;
  display_type?: string;
  primary_color?: string;
  secondary_color?: string;
  font_family?: string;
  dark_bg?: string;
  slug?: string;
  show_in_pos?: boolean;
}): Promise<{ id: number }> {
  return apiRequest('/delivery-intel/virtual-brands', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updateVirtualBrand(id: number, data: any): Promise<any> {
  return apiRequest(`/delivery-intel/virtual-brands/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function getVirtualBrandItems(brandId: number): Promise<any[]> {
  return apiRequest(`/delivery-intel/virtual-brands/${brandId}/items`);
}

export async function setVirtualBrandItems(brandId: number, items: Array<{
  menu_item_id: number;
  custom_name?: string;
  custom_price?: number;
  show_image?: boolean;
}>): Promise<any> {
  return apiRequest(`/delivery-intel/virtual-brands/${brandId}/items`, {
    method: 'POST',
    body: JSON.stringify({ items }),
  });
}

export async function removeVirtualBrandItem(brandId: number, menuItemId: number): Promise<any> {
  return apiRequest(`/delivery-intel/virtual-brands/${brandId}/items/${menuItemId}`, { method: 'DELETE' });
}

export async function deleteVirtualBrand(brandId: number): Promise<any> {
  return apiRequest(`/delivery-intel/virtual-brands/${brandId}`, { method: 'DELETE' });
}

export async function getRecaptureCandidates(days?: number): Promise<any[]> {
  const qs = days ? `?days=${days}` : '';
  return apiRequest(`/delivery-intel/recapture/candidates${qs}`);
}

export async function sendRecaptureSMS(data: {
  phone: string;
  customer_name: string;
  platform: string;
  delivery_order_id?: number;
  message?: string;
}): Promise<any> {
  return apiRequest('/delivery-intel/recapture/send', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function markRecaptureConverted(id: number): Promise<any> {
  return apiRequest(`/delivery-intel/recapture/${id}/convert`, { method: 'POST' });
}

/* ==================== Menu Board Endpoints ==================== */

export async function getMenuBoardData(): Promise<MenuBoardDataResponse> {
  return apiRequest<MenuBoardDataResponse>('/menu-board/data');
}

export async function getDisplayMenuSettings(): Promise<DisplayMenuSettings> {
  return apiRequest<DisplayMenuSettings>('/branding/display-menu');
}

export async function updateDisplayMenuSettings(data: Partial<DisplayMenuSettings>): Promise<DisplayMenuSettings> {
  return apiRequest<DisplayMenuSettings>('/branding/display-menu', {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function getDisplayAssets(): Promise<DisplayAsset[]> {
  return apiRequest<DisplayAsset[]>('/display-assets');
}

export async function createDisplayAsset(data: Partial<DisplayAsset>): Promise<DisplayAsset> {
  return apiRequest<DisplayAsset>('/display-assets', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updateDisplayAsset(id: number, data: Partial<DisplayAsset>): Promise<DisplayAsset> {
  return apiRequest<DisplayAsset>(`/display-assets/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function deleteDisplayAsset(id: number): Promise<{ success: boolean }> {
  return apiRequest<{ success: boolean }>(`/display-assets/${id}`, {
    method: 'DELETE',
  });
}

/* ==================== Onboarding ==================== */

export interface OnboardingStatus {
  has_menu_items: boolean;
  has_extra_staff: boolean;
  has_branding: boolean;
  has_delivery: boolean;
  has_payment: boolean;
  has_printer: boolean;
  real_order_count: number;
}

export async function getOnboardingStatus(): Promise<OnboardingStatus> {
  return apiRequest<OnboardingStatus>('/onboarding/status');
}

/* ==================== Billing Endpoints (Owner JWT Auth) ==================== */

function ownerHeaders(): Record<string, string> {
  const token = localStorage.getItem('owner_token') || currentEmployeeToken;
  const isDev = window.location.hostname === 'localhost';
  const tenantId = !isCapacitor && isDev ? localStorage.getItem('tenant_id') : null;
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(tenantId ? { 'X-Tenant-ID': tenantId } : {}),
  };
}

export async function getBillingStatus(): Promise<{
  plan: string;
  subscription_status: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
}> {
  const base = FALLBACK_URLS.length ? await resolveBaseUrl() : activeBaseUrl;
  const res = await fetch(`${base}/billing`, { headers: ownerHeaders() });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed to fetch billing status');
  return res.json();
}

export async function createCheckoutSession(plan: 'pro', promo_code?: string): Promise<{ url: string }> {
  const base = FALLBACK_URLS.length ? await resolveBaseUrl() : activeBaseUrl;
  const body: Record<string, string> = { plan };
  if (promo_code) body.promo_code = promo_code;
  const res = await fetch(`${base}/billing/checkout`, {
    method: 'POST',
    headers: ownerHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed to create checkout session');
  return res.json();
}

export async function validatePromoCode(code: string): Promise<{
  valid: boolean;
  code?: string;
  discount_description?: string;
  message?: string;
}> {
  const base = FALLBACK_URLS.length ? await resolveBaseUrl() : activeBaseUrl;
  const res = await fetch(`${base}/billing/promo/validate?code=${encodeURIComponent(code.trim().toUpperCase())}`);
  return res.json();
}

export async function createPortalSession(): Promise<{ url: string }> {
  const base = FALLBACK_URLS.length ? await resolveBaseUrl() : activeBaseUrl;
  const res = await fetch(`${base}/billing/portal`, {
    method: 'POST',
    headers: ownerHeaders(),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed to create portal session');
  return res.json();
}

/* ==================== Financing Endpoints (Owner JWT Auth) ==================== */

import type {
  ConsentStatus,
  FinancialProfile,
  FinancingOffer,
} from '../types/financing';

export async function postFinancingConsent(consent_types: string[]): Promise<{ success: boolean }> {
  const base = FALLBACK_URLS.length ? await resolveBaseUrl() : activeBaseUrl;
  const res = await fetch(`${base}/financing/consent`, {
    method: 'POST',
    headers: ownerHeaders(),
    body: JSON.stringify({ consent_types }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed to submit consent');
  return res.json();
}

export async function getFinancingConsent(): Promise<ConsentStatus> {
  const base = FALLBACK_URLS.length ? await resolveBaseUrl() : activeBaseUrl;
  const res = await fetch(`${base}/financing/consent`, { headers: ownerHeaders() });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed to fetch consent');
  return res.json();
}

export async function deleteFinancingConsent(): Promise<{ success: boolean }> {
  const base = FALLBACK_URLS.length ? await resolveBaseUrl() : activeBaseUrl;
  const res = await fetch(`${base}/financing/consent`, {
    method: 'DELETE',
    headers: ownerHeaders(),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed to revoke consent');
  return res.json();
}

export async function getFinancingProfile(): Promise<FinancialProfile | null> {
  const base = FALLBACK_URLS.length ? await resolveBaseUrl() : activeBaseUrl;
  const res = await fetch(`${base}/financing/profile`, { headers: ownerHeaders() });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed to fetch profile');
  return res.json();
}

export async function getFinancingOffers(): Promise<FinancingOffer[]> {
  const base = FALLBACK_URLS.length ? await resolveBaseUrl() : activeBaseUrl;
  const res = await fetch(`${base}/financing/offers`, { headers: ownerHeaders() });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed to fetch offers');
  return res.json();
}

export async function viewFinancingOffer(offerId: string): Promise<FinancingOffer> {
  const base = FALLBACK_URLS.length ? await resolveBaseUrl() : activeBaseUrl;
  const res = await fetch(`${base}/financing/offers/${offerId}/view`, {
    method: 'POST',
    headers: ownerHeaders(),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed to view offer');
  return res.json();
}

export async function acceptFinancingOffer(offerId: string): Promise<FinancingOffer> {
  const base = FALLBACK_URLS.length ? await resolveBaseUrl() : activeBaseUrl;
  const res = await fetch(`${base}/financing/offers/${offerId}/accept`, {
    method: 'POST',
    headers: ownerHeaders(),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed to accept offer');
  return res.json();
}

export async function declineFinancingOffer(offerId: string, reason?: string): Promise<FinancingOffer> {
  const base = FALLBACK_URLS.length ? await resolveBaseUrl() : activeBaseUrl;
  const res = await fetch(`${base}/financing/offers/${offerId}/decline`, {
    method: 'POST',
    headers: ownerHeaders(),
    body: JSON.stringify({ reason }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed to decline offer');
  return res.json();
}

export async function getFinancingConsentTerms(locale: string = 'en'): Promise<{ version: string; consent: any }> {
  const base = FALLBACK_URLS.length ? await resolveBaseUrl() : activeBaseUrl;
  const res = await fetch(`${base}/financing/consent/terms?locale=${locale}`, { headers: ownerHeaders() });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed to fetch terms');
  return res.json();
}

export async function exportFinancingData(): Promise<any> {
  const base = FALLBACK_URLS.length ? await resolveBaseUrl() : activeBaseUrl;
  const res = await fetch(`${base}/financing/export`, { headers: ownerHeaders() });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed to export data');
  return res.json();
}

/* ==================== Account Endpoints (Owner JWT Auth) ==================== */

export async function getAccount(): Promise<any> {
  const base = FALLBACK_URLS.length ? await resolveBaseUrl() : activeBaseUrl;
  const res = await fetch(`${base}/account`, { headers: ownerHeaders() });
  if (!res.ok) {
    const msg = (await res.json().catch(() => ({}))).error || 'Failed to fetch account';
    const err: any = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

export async function updateAccount(data: { name?: string; email?: string }): Promise<{ name: string; email: string }> {
  const base = FALLBACK_URLS.length ? await resolveBaseUrl() : activeBaseUrl;
  const res = await fetch(`${base}/account`, {
    method: 'PUT',
    headers: ownerHeaders(),
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed to update account');
  return res.json();
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  const base = FALLBACK_URLS.length ? await resolveBaseUrl() : activeBaseUrl;
  const res = await fetch(`${base}/account/password`, {
    method: 'PUT',
    headers: ownerHeaders(),
    body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed to change password');
}

/* ==================== CFDI / Electronic Invoicing Endpoints ==================== */

export async function getCfdiCatalogs(): Promise<CfdiCatalogs> {
  return apiRequest<CfdiCatalogs>('/cfdi/catalogs');
}

export async function getCfdiConfig(): Promise<{ config: CfdiConfig | null; facturapi_configured: boolean }> {
  return apiRequest('/cfdi/config');
}

export async function updateCfdiConfig(data: {
  rfc: string;
  legal_name: string;
  tax_regime: string;
  postal_code: string;
  default_uso_cfdi?: string;
  invoice_series?: string;
  invoice_link_expiry_hours?: number;
}): Promise<{ config: CfdiConfig }> {
  return apiRequest('/cfdi/config', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function uploadCSD(formData: FormData): Promise<{ config: CfdiConfig; message: string }> {
  const base = FALLBACK_URLS.length ? await resolveBaseUrl() : activeBaseUrl;
  const headers: Record<string, string> = {};
  if (currentEmployeeToken) {
    headers['Authorization'] = `Bearer ${currentEmployeeToken}`;
  }
  if (!isCapacitor && window.location.hostname === 'localhost') {
    const tenantId = localStorage.getItem('tenant_id');
    if (tenantId) {
      headers['X-Tenant-ID'] = tenantId;
    }
  }
  // Note: no Content-Type header — browser sets multipart boundary automatically
  const res = await fetch(`${base}/cfdi/config/csd`, {
    method: 'POST',
    headers,
    body: formData,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to upload CSD');
  }
  return res.json();
}

export async function testCfdiConnection(): Promise<{ success: boolean; expires_at?: string; error?: string }> {
  return apiRequest('/cfdi/config/test', { method: 'POST' });
}

export async function issueCfdiInvoice(data: {
  order_id: number;
  receptor?: { rfc: string; name: string; tax_regime: string; postal_code: string; uso_cfdi?: string };
  publico_general?: boolean;
  email?: string;
}, approvalToken?: string): Promise<CfdiInvoice> {
  return apiRequest<CfdiInvoice>('/cfdi/invoices', {
    method: 'POST',
    body: JSON.stringify(data),
    headers: approvalHeader(approvalToken),
  });
}

export async function resendCfdiInvoiceEmail(invoiceId: number, email: string): Promise<CfdiInvoice> {
  return apiRequest<CfdiInvoice>(`/cfdi/invoices/${invoiceId}/resend-email`, {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
}

export async function getCfdiInvoices(params?: {
  page?: number;
  limit?: number;
  search?: string;
  status?: string;
}): Promise<{ invoices: CfdiInvoice[]; total: number; page: number; limit: number }> {
  const qs = new URLSearchParams();
  if (params?.page) qs.append('page', String(params.page));
  if (params?.limit) qs.append('limit', String(params.limit));
  if (params?.search) qs.append('search', params.search);
  if (params?.status) qs.append('status', params.status);
  const s = qs.toString();
  return apiRequest(`/cfdi/invoices${s ? `?${s}` : ''}`);
}

export async function getCfdiInvoice(id: number): Promise<CfdiInvoice> {
  return apiRequest<CfdiInvoice>(`/cfdi/invoices/${id}`);
}

export async function cancelCfdiInvoice(id: number, data: {
  motive: string;
  substitute_uuid?: string;
}): Promise<CfdiInvoice> {
  return apiRequest<CfdiInvoice>(`/cfdi/invoices/${id}/cancel`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function getInvoiceToken(orderId: number): Promise<CfdiInvoiceToken> {
  return apiRequest<CfdiInvoiceToken>(`/cfdi/orders/${orderId}/token`);
}

/* ==================== Password Reset Endpoints (no auth) ==================== */

export async function ownerLogin(email: string, password: string): Promise<{ token: string; tenant: { id: string; subdomain: string; name: string } }> {
  const base = isCapacitor ? 'https://pos.desktop.kitchen/api' : (FALLBACK_URLS.length ? await resolveBaseUrl() : activeBaseUrl);
  const res = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Login failed');
  return data;
}

export async function requestPasswordReset(email: string): Promise<{ message: string }> {
  const base = FALLBACK_URLS.length ? await resolveBaseUrl() : activeBaseUrl;
  const res = await fetch(`${base}/auth/forgot-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Request failed');
  }
  return res.json();
}

export async function resetPassword(token: string, newPassword: string): Promise<{ message: string }> {
  const base = FALLBACK_URLS.length ? await resolveBaseUrl() : activeBaseUrl;
  const res = await fetch(`${base}/auth/reset-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, new_password: newPassword }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Reset failed');
  }
  return res.json();
}

/* ==================== CFDI Public Endpoints (no auth) ==================== */

export async function getCfdiPublicOrder(token: string): Promise<{
  order_number: string;
  date: string;
  items: Array<{ item_name: string; quantity: number; unit_price: number }>;
  subtotal: number;
  tax: number;
  total: number;
  tenant_name: string;
  tenant_logo: string | null;
  tenant_color: string;
  emisor_postal_code: string;
}> {
  const base = FALLBACK_URLS.length ? await resolveBaseUrl() : activeBaseUrl;
  const res = await fetch(`${base}/cfdi-public/${token}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to load order');
  }
  return res.json();
}

export async function issueCfdiPublicInvoice(token: string, data: {
  rfc: string;
  name: string;
  tax_regime: string;
  postal_code: string;
  uso_cfdi?: string;
}): Promise<{ uuid_fiscal: string; pdf_url: string; xml_url: string; invoice_id: number }> {
  const base = FALLBACK_URLS.length ? await resolveBaseUrl() : activeBaseUrl;
  const res = await fetch(`${base}/cfdi-public/${token}/issue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to issue invoice');
  }
  return res.json();
}

/* ==================== Loyalty Join (post-order QR, no auth) ==================== */

export interface LoyaltyJoinInfo {
  tenant_name: string;
  order_number: string;
  order_total: number;
  already_linked: boolean;
}

export async function verifyLoyaltyJoin(token: string): Promise<LoyaltyJoinInfo> {
  const base = FALLBACK_URLS.length ? await resolveBaseUrl() : activeBaseUrl;
  const res = await fetch(`${base}/loyalty-join/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'No se pudo verificar el enlace');
  }
  return res.json();
}

export interface LoyaltyJoinEnrollResult {
  first_name: string;
  stamps_earned: number;
  stamps_required: number;
  card_completed: boolean;
  wallet_url: string | null;
}

export async function enrollLoyaltyJoin(
  token: string,
  phone: string,
  smsOptIn: boolean,
): Promise<LoyaltyJoinEnrollResult> {
  const base = FALLBACK_URLS.length ? await resolveBaseUrl() : activeBaseUrl;
  const res = await fetch(`${base}/loyalty-join/enroll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, phone, country_code: 'MX', sms_opt_in: smsOptIn }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'No pudimos registrarte');
  }
  return res.json();
}

/* ==================== Mercado Pago Point Endpoints ==================== */

export async function getMpConnectUrl(): Promise<{ auth_url: string }> {
  return apiRequest('/payments/mp/connect');
}

export async function getMpStatus(): Promise<{
  connected: boolean;
  mp_user_id: string | null;
  mp_default_terminal_id: string | null;
  mp_default_kiosk_terminal_id: string | null;
}> {
  return apiRequest('/payments/mp/status');
}

export async function getMpTerminals(): Promise<{ terminals: Array<{ id: string; external_pos_id: string; operating_mode: string }> }> {
  return apiRequest('/payments/mp/terminals');
}

export async function getMpDevices(): Promise<{ devices: Array<{ id: string; external_pos_id: string; operating_mode: string }> }> {
  return apiRequest('/payments/mp/devices');
}

export async function setMpDeviceOperatingMode(
  device_id: string,
  operating_mode: 'PDV' | 'STANDALONE' = 'PDV'
): Promise<{ success: boolean; operating_mode: string }> {
  return apiRequest('/payments/mp/devices/operating-mode', {
    method: 'POST',
    body: JSON.stringify({ device_id, operating_mode }),
  });
}

export async function setMpDefaultTerminal(terminal_id: string): Promise<{ success: boolean }> {
  return apiRequest('/payments/mp/terminals/default', {
    method: 'POST',
    body: JSON.stringify({ terminal_id }),
  });
}

export async function setMpDefaultKioskTerminal(terminal_id: string | null): Promise<{ success: boolean }> {
  return apiRequest('/payments/mp/terminals/kiosk-default', {
    method: 'POST',
    body: JSON.stringify({ terminal_id }),
  });
}

export async function mpCharge(order_id: number, terminal_id?: string, tip: number = 0): Promise<{ success: boolean; mp_order_id: string; payment_intent_id: string; terminal_id: string }> {
  return apiRequest('/payments/mp/charge', {
    method: 'POST',
    body: JSON.stringify({ order_id, terminal_id, tip }),
  });
}

export async function mpCancelCharge(order_id: number, terminal_id?: string): Promise<{ success: boolean }> {
  return apiRequest('/payments/mp/cancel', {
    method: 'POST',
    body: JSON.stringify({ order_id, terminal_id }),
  });
}

/* ==================== Cobrar Juntas (Pay Together) ==================== */

export interface PayTogetherShare {
  order_id: number;
  subtotal: number;
  tax: number;
  total: number;
  tip_share: number;
  charge_share: number;
}

export interface PayTogetherResponse {
  payment_group_id: number;
  status: 'paid' | 'pending_terminal';
  payment_method: 'cash' | 'mp_terminal';
  total: number;
  change_due?: number;
  mp_order_id?: string;
  mp_terminal_id?: string;
  orders: PayTogetherShare[];
}

export async function payTogether(input: {
  order_ids: number[];
  payment_method: 'cash' | 'mp_terminal';
  tip?: number;
  mp_terminal_id?: string;
  cash_received?: number;
}): Promise<PayTogetherResponse> {
  return apiRequest('/payments/pay-together', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function cancelPayTogether(payment_group_id: number): Promise<{ success: boolean; cancelled: boolean; paid?: boolean }> {
  return apiRequest(`/payments/pay-together/${payment_group_id}/cancel`, {
    method: 'POST',
  });
}

export async function getPaymentGroupStatus(payment_group_id: number): Promise<{
  payment_group_id: number;
  status: 'pending' | 'paid' | 'failed' | 'cancelled';
  payment_method: 'cash' | 'mp_terminal';
  total: number;
  tip: number;
}> {
  return apiRequest(`/payment-groups/${payment_group_id}/status`);
}

export interface PaymentGroupDetail {
  group: {
    id: number;
    subtotal: number;
    tax: number;
    tip: number;
    total: number;
    payment_method: string;
    status: string;
    created_at: string;
    paid_at: string | null;
  };
  orders: Array<{
    id: number;
    order_number: number;
    customer_call_name: string | null;
    subtotal: number;
    tax: number;
    tip: number;
    total: number;
    status: string;
    payment_status: string;
    order_fulfillment_type: string | null;
    items: Array<{ order_id: number; item_name: string; quantity: number; unit_price: number; notes: string | null }>;
  }>;
}

export async function getPaymentGroup(payment_group_id: number): Promise<PaymentGroupDetail> {
  return apiRequest(`/payment-groups/${payment_group_id}`);
}

/* ==================== Clip PinPad Terminal ==================== */

export async function getClipStatus(): Promise<{ configured: boolean; default_terminal_id: string | null }> {
  return apiRequest('/payments/clip/status');
}

export async function clipCharge(order_id: number, terminal_id?: string): Promise<{ success: boolean; clip_payment_id: string }> {
  return apiRequest('/payments/clip/charge', {
    method: 'POST',
    body: JSON.stringify({ order_id, terminal_id }),
  });
}

export async function clipCancelCharge(order_id: number): Promise<{ success: boolean }> {
  return apiRequest('/payments/clip/cancel', {
    method: 'POST',
    body: JSON.stringify({ order_id }),
  });
}

/* ==================== Getnet Payments ==================== */

export async function getGetnetStatus(): Promise<{
  configured: boolean;
  enabled: boolean;
  tapOnPhoneEnabled: boolean;
  environment: string;
}> {
  return apiRequest('/getnet/status');
}

export async function setupGetnet(data: {
  merchant_id: string;
  terminal_id?: string;
  environment?: string;
  tap_on_phone_enabled?: boolean;
}): Promise<{ success: boolean; message: string }> {
  return ownerApiRequest('/getnet/setup', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function disableGetnet(): Promise<{ success: boolean }> {
  return ownerApiRequest('/getnet/setup', { method: 'DELETE' });
}

export async function getnetTokenize(data: {
  card_number: string;
  expiration_month: string;
  expiration_year: string;
  security_code: string;
  holder_name?: string;
}): Promise<{ number_token: string; brand?: string; last_four: string }> {
  return apiRequest('/getnet/tokenize', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function getnetCharge(data: {
  order_id: number;
  card_token: string;
  tip?: number;
}): Promise<{
  success: boolean;
  payment_status: string;
  getnet_payment_id: string;
  authorization_code?: string;
  card_brand?: string;
  card_last_four?: string;
  invoice_token?: string;
}> {
  return apiRequest('/getnet/charge', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function getnetTapCharge(data: {
  order_id: number;
  getnet_payment_id: string;
  authorization_code?: string;
  card_brand?: string;
  card_last_four?: string;
  tip?: number;
}): Promise<{ success: boolean; payment_status: string; getnet_payment_id: string }> {
  return apiRequest('/getnet/tap-charge', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function getGetnetTransactions(params?: {
  start_date?: string;
  end_date?: string;
  limit?: number;
}): Promise<any[]> {
  const qs = new URLSearchParams();
  if (params?.start_date) qs.set('start_date', params.start_date);
  if (params?.end_date) qs.set('end_date', params.end_date);
  if (params?.limit) qs.set('limit', String(params.limit));
  return apiRequest(`/getnet/transactions?${qs}`);
}

export async function getGetnetFees(startDate?: string, endDate?: string): Promise<{
  summary: Array<{
    processor: string;
    transactions: number;
    gross: number;
    processorFees: number;
    platformFees: number;
    net: number;
  }>;
}> {
  const qs = new URLSearchParams();
  if (startDate) qs.set('start_date', startDate);
  if (endDate) qs.set('end_date', endDate);
  return apiRequest(`/getnet/fees?${qs}`);
}

export async function getGetnetSavings(days?: number): Promise<{
  periodDays: number;
  totalVolume: number;
  totalTransactions: number;
  currentFees: number;
  proFees: number;
  monthlySavings: number;
}> {
  const qs = days ? `?days=${days}` : '';
  return apiRequest(`/getnet/savings${qs}`);
}

/* ==================== Credentials / Integrations ==================== */

export interface ServiceField {
  key: string;
  label: string;
  secret: boolean;
}

export interface ServiceSchema {
  label: string;
  fields: ServiceField[];
}

export async function getCredentialsSchema(): Promise<Record<string, ServiceSchema>> {
  return apiRequest('/credentials/schema');
}

export async function getCredentials(): Promise<Record<string, Record<string, string>>> {
  return ownerApiRequest('/credentials');
}

export async function saveCredentials(service: string, values: Record<string, string>): Promise<{ success: boolean }> {
  return ownerApiRequest(`/credentials/${service}`, {
    method: 'PUT',
    body: JSON.stringify(values),
  });
}

/* ==================== WhatsApp ops ==================== */

export interface WhatsAppEligibleEmployee {
  id: number;
  name: string;
  role: string;
  phone_masked: string;
}

export interface WhatsAppStatus {
  connected: boolean;
  /** 'tenant' = this restaurant's own number, 'platform' = Desktop Kitchen's, 'none' = not connected. */
  source: 'tenant' | 'platform' | 'none';
  display_phone_number: string | null;
  eligible: WhatsAppEligibleEmployee[];
  eligible_count: number;
  missing_phone_count: number;
}

export async function getWhatsAppStatus(): Promise<WhatsAppStatus> {
  return apiRequest<WhatsAppStatus>('/whatsapp/status');
}

/* ==================== Stress Test ==================== */

export async function getStressTestTemplates(): Promise<StressTestTemplate[]> {
  return apiRequest<StressTestTemplate[]>('/stress-test/templates');
}

export async function runStressTest(
  config: StressTestConfig,
  onProgress: (event: StressTestProgress) => void,
  onComplete: (results: StressTestResults) => void,
  onError: (error: string) => void,
): Promise<void> {
  const base = FALLBACK_URLS.length ? await resolveBaseUrl() : activeBaseUrl;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (currentEmployeeToken) headers['Authorization'] = `Bearer ${currentEmployeeToken}`;
  if (!isCapacitor && window.location.hostname === 'localhost') { const tenantId = localStorage.getItem('tenant_id'); if (tenantId) headers['X-Tenant-ID'] = tenantId; }

  const response = await fetch(`${base}/stress-test/run`, {
    method: 'POST',
    headers,
    body: JSON.stringify(config),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || `API Error: ${response.status}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response stream');

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    let currentEvent = '';
    for (const line of lines) {
      if (line.startsWith('event: ')) {
        currentEvent = line.slice(7).trim();
      } else if (line.startsWith('data: ')) {
        try {
          const data = JSON.parse(line.slice(6));
          if (currentEvent === 'progress') {
            onProgress(data as StressTestProgress);
          } else if (currentEvent === 'complete') {
            onComplete(data as StressTestResults);
          } else if (currentEvent === 'error') {
            onError(data.message || 'Unknown error');
          }
        } catch {
          // Skip malformed JSON
        }
        currentEvent = '';
      }
    }
  }
}

export async function getStressTestResidual(): Promise<StressTestResidual> {
  return apiRequest<StressTestResidual>('/stress-test/residual');
}

export async function cleanupStressTestData(): Promise<{ deleted: number }> {
  return apiRequest<{ deleted: number }>('/stress-test/cleanup', { method: 'DELETE' });
}

/* ==================== Chaos Agent Endpoints (Admin Secret) ==================== */

export interface ChaosAgentProgress {
  phase: string;
  message: string;
  percent: number;
}

export interface ChaosAgentTenantResult {
  tenantId: string;
  ordersCreated: number;
  errors: number;
  avgLatencyMs: number;
}

export interface ChaosAgentBreach {
  type: string;
  severity?: string;
  tenantId?: string;
  orderId?: number;
  expectedTenant?: string;
  actualTenant?: string;
  leakedCount?: number;
  expected?: number;
  actual?: number;
  message: string;
}

export interface ChaosAgentAnomaly {
  pid: number;
  staleTenanId: string;
  message: string;
}

export interface ChaosAgentResults {
  verdict: 'PASS' | 'WARN' | 'FAIL';
  durationMs: number;
  tenantsProvisioned: number;
  ordersPerTenant: number;
  tenantResults: ChaosAgentTenantResult[];
  totalOrdersCreated: number;
  totalErrors: number;
  isolationBreaches: ChaosAgentBreach[];
  connectionAnomalies: ChaosAgentAnomaly[];
  latency: { avg: number; p50: number; p95: number; max: number };
}

export async function getFeatureFlags(): Promise<{ stressTest: boolean }> {
  const base = FALLBACK_URLS.length ? await resolveBaseUrl() : activeBaseUrl;
  const res = await fetch(`${base}/api/features`);
  if (!res.ok) return { stressTest: false };
  return res.json();
}

export async function getChaosStatus(): Promise<{ running: boolean }> {
  const base = FALLBACK_URLS.length ? await resolveBaseUrl() : activeBaseUrl;
  const adminSecret = sessionStorage.getItem('admin_secret') || '';
  const res = await fetch(`${base}/chaos/status`, {
    headers: { 'X-Admin-Secret': adminSecret },
  });
  if (!res.ok) throw new Error('Failed to check chaos status');
  return res.json();
}

export async function runChaosAgent(
  ordersPerTenant: number,
  onProgress: (event: ChaosAgentProgress) => void,
  onComplete: (results: ChaosAgentResults) => void,
  onError: (error: string) => void,
): Promise<void> {
  const base = FALLBACK_URLS.length ? await resolveBaseUrl() : activeBaseUrl;
  const adminSecret = sessionStorage.getItem('admin_secret') || '';

  const response = await fetch(`${base}/chaos/run`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Admin-Secret': adminSecret,
    },
    body: JSON.stringify({ ordersPerTenant }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || `API Error: ${response.status}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response stream');

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    let currentEvent = '';
    for (const line of lines) {
      if (line.startsWith('event: ')) {
        currentEvent = line.slice(7).trim();
      } else if (line.startsWith('data: ')) {
        try {
          const data = JSON.parse(line.slice(6));
          if (currentEvent === 'progress') {
            onProgress(data as ChaosAgentProgress);
          } else if (currentEvent === 'complete') {
            onComplete(data as ChaosAgentResults);
          } else if (currentEvent === 'error') {
            onError(data.message || 'Unknown error');
          }
        } catch {
          // Skip malformed JSON
        }
        currentEvent = '';
      }
    }
  }
}

/* ==================== Banking Endpoints (Owner JWT Auth) ==================== */

export interface BankConnection {
  id: string;
  provider: string;
  external_link_id: string;
  institution_name: string | null;
  institution_logo_url: string | null;
  country_code: string;
  status: 'active' | 'disconnected' | 'error' | 'pending';
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
  account_count: number;
}

export interface BankAccount {
  id: string;
  connection_id: string;
  external_account_id: string;
  name: string;
  type: 'checking' | 'savings' | 'credit_card' | 'loan' | 'investment' | 'other' | null;
  currency: string;
  balance_current: number | null;
  balance_available: number | null;
  last_four: string | null;
  is_primary: boolean;
  synced_at: string | null;
  provider: string;
  institution_name: string | null;
  institution_logo_url: string | null;
}

export interface BankTransaction {
  id: string;
  account_id: string;
  external_transaction_id: string;
  amount: number;
  currency: string;
  description: string | null;
  merchant_name: string | null;
  category: string | null;
  subcategory: string | null;
  transaction_date: string;
  transaction_type: 'INFLOW' | 'OUTFLOW' | 'TRANSFER' | null;
  status: 'posted' | 'pending';
  account_name: string;
  last_four: string | null;
}

export interface BankingSummary {
  totalBalance: number;
  totalCreditAvailable: number;
  lastSyncedAt: string | null;
  accountsByType: Record<string, number>;
  recentTransactions: BankTransaction[];
}

async function ownerApiRequest<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const base = FALLBACK_URLS.length ? await resolveBaseUrl() : activeBaseUrl;
  const res = await fetch(`${base}${endpoint}`, {
    ...options,
    headers: { ...ownerHeaders(), ...(options.headers || {}) },
  });
  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}));
    const err = new Error(errorData.error || `API Error: ${res.status}`) as Error & { planUpgradeRequired?: boolean; requiredPlan?: string; feature?: string };
    if (res.status === 403 && errorData.error === 'PLAN_UPGRADE_REQUIRED') {
      err.planUpgradeRequired = true;
      err.requiredPlan = errorData.requiredPlan;
      err.feature = errorData.feature;
    }
    throw err;
  }
  const data = await res.json();
  return coerceNumerics(data) as T;
}

export async function getBankingWidgetToken(): Promise<{ token: string; provider: string; widgetJsUrl: string }> {
  return ownerApiRequest('/banking/widget-token', { method: 'POST' });
}

export async function exchangeBankToken(publicToken: string, metadata?: { institutionName?: string; institutionLogoUrl?: string; countryCode?: string }): Promise<{ connectionId: string; institutionName: string; accountCount: number }> {
  return ownerApiRequest('/banking/exchange-token', {
    method: 'POST',
    body: JSON.stringify({ publicToken, metadata }),
  });
}

export async function getBankConnections(): Promise<BankConnection[]> {
  return ownerApiRequest<BankConnection[]>('/banking/connections');
}

export async function deleteBankConnection(connectionId: string): Promise<{ success: boolean }> {
  return ownerApiRequest(`/banking/connections/${connectionId}`, { method: 'DELETE' });
}

export async function getBankAccounts(connectionId?: string): Promise<BankAccount[]> {
  const qs = connectionId ? `?connectionId=${connectionId}` : '';
  return ownerApiRequest<BankAccount[]>(`/banking/accounts${qs}`);
}

export async function getBankTransactions(params: {
  accountId?: string;
  startDate?: string;
  endDate?: string;
  limit?: number;
  offset?: number;
}): Promise<{ transactions: BankTransaction[]; totalCount: number }> {
  const base = FALLBACK_URLS.length ? await resolveBaseUrl() : activeBaseUrl;
  const qs = new URLSearchParams();
  if (params.accountId) qs.append('accountId', params.accountId);
  if (params.startDate) qs.append('startDate', params.startDate);
  if (params.endDate) qs.append('endDate', params.endDate);
  if (params.limit) qs.append('limit', String(params.limit));
  if (params.offset) qs.append('offset', String(params.offset));

  const res = await fetch(`${base}/banking/transactions?${qs}`, {
    headers: ownerHeaders(),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `API Error: ${res.status}`);
  }
  const totalCount = Number(res.headers.get('X-Total-Count')) || 0;
  const transactions = coerceNumerics(await res.json()) as BankTransaction[];
  return { transactions, totalCount };
}

export async function syncBankConnection(connectionId?: string): Promise<{ synced: number; errors: Array<{ connectionId: string; institution: string; error: string }> }> {
  return ownerApiRequest('/banking/sync', {
    method: 'POST',
    body: JSON.stringify(connectionId ? { connectionId } : {}),
  });
}

export async function getBankingSummary(): Promise<BankingSummary> {
  return ownerApiRequest<BankingSummary>('/banking/summary');
}

export interface ReconciliationItem {
  platformId: number;
  platformName: string;
  displayName: string;
  orderCount: number;
  grossRevenue: number;
  commission: number;
  expectedPayout: number;
  depositAmount: number | null;
  difference: number | null;
  status: 'matched' | 'partial' | 'missing';
  matchedTransactionId: string | null;
  matchedDescription: string | null;
  matchedDate: string | null;
}

export interface ReconciliationResult {
  items: ReconciliationItem[];
  summary: {
    totalExpected: number;
    totalConfirmed: number;
    totalPartial: number;
    totalUnconfirmed: number;
    matchedCount: number;
    partialCount: number;
    missingCount: number;
  };
}

export async function getBankReconciliation(startDate?: string, endDate?: string): Promise<ReconciliationResult> {
  const qs = new URLSearchParams();
  if (startDate) qs.append('startDate', startDate);
  if (endDate) qs.append('endDate', endDate);
  return ownerApiRequest<ReconciliationResult>(`/banking/reconciliation?${qs}`);
}

export async function getBankConfirmedTotal(startDate?: string, endDate?: string): Promise<{ confirmedTotal: number; period: { start: string; end: string } }> {
  const qs = new URLSearchParams();
  if (startDate) qs.append('startDate', startDate);
  if (endDate) qs.append('endDate', endDate);
  return ownerApiRequest(`/banking/confirmed-total?${qs}`);
}

export interface BankSyncAlert {
  connectionId: string;
  institutionName: string;
  status: string;
  consecutiveFailures: number;
}

export async function getBankSyncHealth(): Promise<{ alerts: BankSyncAlert[] }> {
  return ownerApiRequest('/banking/sync-health');
}

export async function deleteCredentials(service: string): Promise<{ success: boolean }> {
  return ownerApiRequest(`/credentials/${service}`, { method: 'DELETE' });
}

/* ==================== Demo Data Endpoints ==================== */

export interface DemoDataStatus {
  allowed: boolean;
  reason?: string;
  hasDemo?: boolean;
  counts?: {
    orders: number;
    customers: number;
    delivery_orders: number;
    ai_snapshots: number;
    financial_actuals: number;
  };
}

export async function getDemoDataStatus(): Promise<DemoDataStatus> {
  return apiRequest<DemoDataStatus>('/demo-data/status');
}

export async function generateDemoData(): Promise<{ run_id: string; summary: Record<string, number> }> {
  return apiRequest('/demo-data/generate', { method: 'POST' });
}

export async function clearDemoData(): Promise<{ deleted: Record<string, number> }> {
  return apiRequest('/demo-data', { method: 'DELETE' });
}

// ==================== Settlement ====================

export async function getSettlementSummary(): Promise<SettlementSummary> {
  return apiRequest('/settlement/summary', { headers: ownerHeaders() });
}

export async function getSettlementHistory(params?: { limit?: number; offset?: number }): Promise<{ history: DisbursementRecord[]; total: number }> {
  const qs = new URLSearchParams();
  if (params?.limit) qs.set('limit', String(params.limit));
  if (params?.offset) qs.set('offset', String(params.offset));
  const s = qs.toString();
  return apiRequest(`/settlement/history${s ? `?${s}` : ''}`, { headers: ownerHeaders() });
}

export async function getSettlementStatement(month: string): Promise<SettlementStatement> {
  return apiRequest(`/settlement/statement/${month}`, { headers: ownerHeaders() });
}

export async function downloadSettlementStatement(month: string): Promise<Blob> {
  const base = activeBaseUrl;
  const res = await fetch(`${base}/settlement/statement/${month}/download`, {
    headers: { ...ownerHeaders() },
  });
  if (!res.ok) throw new Error('Failed to download statement');
  return res.blob();
}

// ==================== Merchant Banking ====================

export async function getMerchantBankAccounts(): Promise<MerchantBankAccount[]> {
  return apiRequest('/merchant-banking/accounts', { headers: ownerHeaders() });
}

export async function addMerchantBankAccount(data: { clabe: string; beneficiary_name: string; alias?: string }): Promise<MerchantBankAccount> {
  return apiRequest('/merchant-banking/accounts', {
    method: 'POST',
    headers: ownerHeaders(),
    body: JSON.stringify(data),
  });
}

export async function setPrimaryMerchantBankAccount(id: number): Promise<MerchantBankAccount> {
  return apiRequest(`/merchant-banking/accounts/${id}/primary`, {
    method: 'PUT',
    headers: ownerHeaders(),
  });
}

export async function deleteMerchantBankAccount(id: number): Promise<{ deleted: boolean }> {
  return apiRequest(`/merchant-banking/accounts/${id}`, {
    method: 'DELETE',
    headers: ownerHeaders(),
  });
}

// ==================== Advance ====================

export async function getActiveAdvance(): Promise<MerchantAdvance | null> {
  return apiRequest('/financing/advance', { headers: ownerHeaders() });
}

export async function getAdvanceRepayments(params?: { limit?: number }): Promise<{ repayments: MCARepayment[]; total: number }> {
  const qs = params?.limit ? `?limit=${params.limit}` : '';
  return apiRequest(`/financing/advance/repayments${qs}`, { headers: ownerHeaders() });
}

// ==================== Expenses ====================

export interface Expense {
  id: number;
  tenant_id: string;
  category: string;
  vendor: string | null;
  vendor_id?: number | null;
  description: string | null;
  amount: number;
  tax_amount: number;
  receipt_image_url: string | null;
  receipt_data: Record<string, unknown> | null;
  expense_date: string;
  payment_method: string | null;
  payee: string | null;
  notes: string | null;
  created_by: number | null;
  created_by_name?: string | null;
  created_at: string;
  updated_at: string;
}

export interface ExpenseSupplier {
  id: number;
  name: string;
  contact_name?: string;
  phone?: string;
  email?: string;
  address?: string;
  notes?: string;
  active: boolean;
  created_at: string;
}

export interface ParsedReceiptItem {
  description: string;
  amount: number;
  quantity?: number | null;
  unit?: string | null;
  pack_size?: number | null;
  unit_price?: number | null;
}

export interface ReceiptScanResult {
  image_url: string;
  parsed: {
    vendor?: string | null;
    date?: string | null;
    items?: ParsedReceiptItem[];
    subtotal?: number | null;
    tax?: number | null;
    total?: number | null;
    payment_method?: string | null;
    category?: string | null;
  } | null;
  vendor_match?: {
    id: number;
    name: string;
    score: number;
    contact_name?: string | null;
    phone?: string | null;
  } | null;
  message: string;
}

export async function getExpenses(params?: { from?: string; to?: string }): Promise<Expense[]> {
  const qs = new URLSearchParams();
  if (params?.from) qs.set('from', params.from);
  if (params?.to) qs.set('to', params.to);
  const query = qs.toString() ? `?${qs}` : '';
  return apiRequest(`/expenses${query}`);
}

export async function getExpenseSuppliers(): Promise<ExpenseSupplier[]> {
  return apiRequest<ExpenseSupplier[]>('/expenses/suppliers');
}

export async function searchExpenseSuppliers(q: string, limit = 10): Promise<ExpenseSupplier[]> {
  const qs = new URLSearchParams();
  if (q) qs.set('q', q);
  qs.set('limit', String(limit));
  return apiRequest<ExpenseSupplier[]>(`/expenses/suppliers/search?${qs}`);
}

export async function matchExpenseSupplier(name: string, threshold = 0.5): Promise<{ match: (ExpenseSupplier & { score: number; exact: boolean }) | null }> {
  return apiRequest('/expenses/suppliers/match', {
    method: 'POST',
    body: JSON.stringify({ name, threshold }),
  });
}

export async function createExpenseSupplier(data: Partial<ExpenseSupplier>): Promise<ExpenseSupplier> {
  return apiRequest<ExpenseSupplier>('/expenses/suppliers', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export interface ExpensePayee {
  name: string;
  source: 'expense_history' | 'employee';
  score?: number;
}

export async function searchExpensePayees(q: string, limit = 10): Promise<ExpensePayee[]> {
  const qs = new URLSearchParams();
  qs.set('q', q);
  qs.set('limit', String(limit));
  return apiRequest<ExpensePayee[]>(`/expenses/payees/search?${qs}`);
}

export async function matchExpensePayee(name: string, threshold = 0.5): Promise<{ match: (ExpensePayee & { score: number; exact: boolean }) | null }> {
  return apiRequest('/expenses/payees/match', {
    method: 'POST',
    body: JSON.stringify({ name, threshold }),
  });
}

export interface OverpayAlert {
  inventory_item_id: number;
  inventory_item_name: string | null;
  unit_cost: number;
  median_cost: number;
  deviation_pct: number;
  history_count: number;
}

export interface VarianceAlert {
  rule_id: number;
  rule_label: string;
  expected_amount: number;
  variance_threshold_pct: number;
  actual_amount: number;
  deviation_pct: number;
  flagged: boolean;
}

export interface RecurringExpense {
  id: number;
  label: string;
  category: string;
  vendor_id: number | null;
  vendor_name?: string | null;
  payee: string | null;
  expected_amount: number;
  variance_threshold_pct: number;
  frequency: 'weekly' | 'biweekly' | 'monthly' | 'bimonthly' | 'quarterly' | 'annual';
  last_charged_date: string | null;
  next_expected_date: string | null;
  active: boolean;
  notes: string | null;
}

export type CreateExpenseResponse = Expense & {
  overpay_alerts?: OverpayAlert[];
  variance_alert?: VarianceAlert | null;
};

export async function getRecurringExpenses(activeOnly = false): Promise<RecurringExpense[]> {
  return apiRequest<RecurringExpense[]>(`/recurring-expenses${activeOnly ? '?active_only=1' : ''}`);
}

export async function createRecurringExpense(data: Partial<RecurringExpense>): Promise<RecurringExpense> {
  return apiRequest<RecurringExpense>('/recurring-expenses', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updateRecurringExpense(id: number, data: Partial<RecurringExpense>): Promise<RecurringExpense> {
  return apiRequest<RecurringExpense>(`/recurring-expenses/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function deleteRecurringExpense(id: number): Promise<{ success: boolean }> {
  return apiRequest<{ success: boolean }>(`/recurring-expenses/${id}`, { method: 'DELETE' });
}

export async function createExpense(data: Partial<Expense> & { inventory_matches?: InventoryMatch[] }): Promise<CreateExpenseResponse> {
  return apiRequest('/expenses', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updateExpense(id: number, data: Partial<Expense>): Promise<Expense> {
  return apiRequest(`/expenses/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function deleteExpense(id: number): Promise<{ success: boolean }> {
  return apiRequest(`/expenses/${id}`, { method: 'DELETE' });
}

export interface UnlinkedExpense {
  id: number;
  category: string;
  vendor: string | null;
  vendor_id: number | null;
  description: string | null;
  amount: number;
  expense_date: string;
  payment_method: string | null;
  notes: string | null;
  receipt_data: any;
  created_at: string;
  parsed_items: Array<{ description: string; quantity: number; unit_price: number }>;
}

export async function getUnlinkedExpenses(days = 30): Promise<UnlinkedExpense[]> {
  return apiRequest<UnlinkedExpense[]>(`/expenses/unlinked?days=${days}`);
}

export async function linkExpenseToInventory(
  expenseId: number,
  inventory_matches: InventoryMatch[]
): Promise<{ success: boolean; linked_count: number; overpay_alerts: any[] }> {
  return apiRequest(`/expenses/${expenseId}/link-inventory`, {
    method: 'POST',
    body: JSON.stringify({ inventory_matches }),
  });
}

export interface MenuImageUploadResult {
  uuid: string;
  image_url: string;
  variants: { thumb: string; card: string; hero: string };
  width: number | null;
  height: number | null;
  storage: 'r2' | 'disk';
}

// Upload a menu item photo. Server resizes to webp variants and returns their
// public URLs; `image_url` (the card variant) is what gets saved on the item.
export async function uploadMenuImage(file: File): Promise<MenuImageUploadResult> {
  const formData = new FormData();
  formData.append('image', file);
  const base = FALLBACK_URLS.length ? await resolveBaseUrl() : activeBaseUrl;
  const headers: Record<string, string> = {};
  if (currentEmployeeToken) headers['Authorization'] = `Bearer ${currentEmployeeToken}`;
  if (!isCapacitor && window.location.hostname === 'localhost') {
    const tenantId = localStorage.getItem('tenant_id');
    if (tenantId) headers['X-Tenant-ID'] = tenantId;
  }
  const response = await fetch(`${base}/uploads/menu-image`, {
    method: 'POST',
    headers,
    body: formData,
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error((err as Record<string, string>).error || 'Failed to upload image');
  }
  return response.json();
}

// Delete all variants of a previously uploaded menu photo. Tenant-scoped server-side.
export async function deleteMenuImage(tenantId: string, uuid: string): Promise<void> {
  await apiRequest(
    `/uploads/${encodeURIComponent(tenantId)}/menu/${encodeURIComponent(uuid)}`,
    { method: 'DELETE' },
  );
}

// Pull the {tenantId, uuid} out of a stored menu-image URL so we can clean up
// the old variants when a photo is replaced/removed. Matches both backends:
//   disk: /uploads/<tenant>/menu/<uuid>/card.webp
//   R2:   https://img.desktop.kitchen/<tenant>/menu/<uuid>/card.webp
// Returns null for externally-pasted URLs (nothing of ours to delete).
export function extractMenuPhotoRef(url: string | null | undefined): { tenantId: string; uuid: string } | null {
  if (!url) return null;
  const m = url.match(/\/([^/]+)\/menu\/([a-f0-9-]{16,})\//i);
  return m ? { tenantId: m[1], uuid: m[2] } : null;
}

export async function uploadReceipt(file: File): Promise<{ image_url: string }> {
  const formData = new FormData();
  formData.append('receipt', file);
  const base = FALLBACK_URLS.length ? await resolveBaseUrl() : activeBaseUrl;
  const headers: Record<string, string> = {};
  if (currentEmployeeToken) {
    headers['Authorization'] = `Bearer ${currentEmployeeToken}`;
  }
  if (!isCapacitor && window.location.hostname === 'localhost') {
    const tenantId = localStorage.getItem('tenant_id');
    if (tenantId) headers['X-Tenant-ID'] = tenantId;
  }
  const response = await fetch(`${base}/expenses/upload-receipt`, {
    method: 'POST',
    headers,
    body: formData,
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error((err as Record<string, string>).error || 'Failed to upload receipt');
  }
  return response.json();
}

export async function scanReceipt(file: File): Promise<ReceiptScanResult> {
  const formData = new FormData();
  formData.append('receipt', file);
  const base = FALLBACK_URLS.length ? await resolveBaseUrl() : activeBaseUrl;
  const headers: Record<string, string> = {};
  if (currentEmployeeToken) {
    headers['Authorization'] = `Bearer ${currentEmployeeToken}`;
  }
  if (!isCapacitor && window.location.hostname === 'localhost') {
    const tenantId = localStorage.getItem('tenant_id');
    if (tenantId) headers['X-Tenant-ID'] = tenantId;
  }
  const response = await fetch(`${base}/expenses/scan-receipt`, {
    method: 'POST',
    headers,
    body: formData,
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error((err as Record<string, string>).error || 'Failed to scan receipt');
  }
  return response.json();
}

export async function exportExpenses(params?: { from?: string; to?: string }): Promise<Blob> {
  const qs = new URLSearchParams();
  if (params?.from) qs.set('from', params.from);
  if (params?.to) qs.set('to', params.to);
  const query = qs.toString() ? `?${qs}` : '';
  const base = FALLBACK_URLS.length ? await resolveBaseUrl() : activeBaseUrl;
  const headers: Record<string, string> = {};
  if (currentEmployeeToken) {
    headers['Authorization'] = `Bearer ${currentEmployeeToken}`;
  }
  if (!isCapacitor && window.location.hostname === 'localhost') {
    const tenantId = localStorage.getItem('tenant_id');
    if (tenantId) headers['X-Tenant-ID'] = tenantId;
  }
  const response = await fetch(`${base}/expenses/export${query}`, { headers });
  if (!response.ok) throw new Error('Failed to export expenses');
  return response.blob();
}

/* ==================== Payroll Endpoints ==================== */

export async function getPayrollLive(): Promise<PayrollSnapshot> {
  return apiRequest<PayrollSnapshot>('/payroll/live');
}

export async function getPayrollPeriod(from: string, to: string): Promise<PayrollSnapshot> {
  return apiRequest<PayrollSnapshot>(`/payroll/period?from=${from}&to=${to}`);
}

export interface PayrollForecast {
  from: string;
  to: string;
  employees: Array<{
    employee_id: number;
    employee_name: string;
    employee_role: string;
    pay_type: string;
    hourly_rate_cents: number;
    weekly_salary_cents: number;
    hours_scheduled: number;
    cost_cents: number;
  }>;
  totals: { hours_scheduled: number; cost_cents: number };
}

export async function getPayrollForecast(params: { from?: string; to?: string } = {}): Promise<PayrollForecast> {
  const qs = new URLSearchParams();
  if (params.from) qs.set('from', params.from);
  if (params.to) qs.set('to', params.to);
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return apiRequest<PayrollForecast>(`/payroll/forecast${suffix}`);
}

export async function getPayrollSettings(): Promise<PayrollSettings> {
  return apiRequest<PayrollSettings>('/payroll/settings');
}

export async function updatePayrollSettings(patch: Partial<PayrollSettings>): Promise<PayrollSettings> {
  return apiRequest<PayrollSettings>('/payroll/settings', {
    method: 'PUT',
    body: JSON.stringify(patch),
  });
}

export async function getPayrollRates(): Promise<PayrollRateRow[]> {
  return apiRequest<PayrollRateRow[]>('/payroll/employees/rates');
}

export async function updateEmployeePayRate(
  employeeId: number,
  body: { pay_type: PayType; hourly_rate_cents?: number; weekly_salary_cents?: number; note?: string }
): Promise<PayrollRateRow> {
  return apiRequest<PayrollRateRow>(`/payroll/employees/${employeeId}/rate`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export async function listPayrollPeriods(): Promise<PayrollPeriodsList> {
  return apiRequest<PayrollPeriodsList>('/payroll/periods');
}

export async function closePayrollPeriod(period_start: string, period_end: string): Promise<PayrollSnapshot & { period_id: number }> {
  return apiRequest<PayrollSnapshot & { period_id: number }>('/payroll/periods/close', {
    method: 'POST',
    body: JSON.stringify({ period_start, period_end }),
  });
}

export async function exportPayrollPeriodCsv(periodId: number): Promise<Blob> {
  const base = FALLBACK_URLS.length ? await resolveBaseUrl() : activeBaseUrl;
  const headers: Record<string, string> = {};
  if (currentEmployeeToken) {
    headers['Authorization'] = `Bearer ${currentEmployeeToken}`;
  }
  if (!isCapacitor && window.location.hostname === 'localhost') {
    const tenantId = localStorage.getItem('tenant_id');
    if (tenantId) headers['X-Tenant-ID'] = tenantId;
  }
  const response = await fetch(`${base}/payroll/periods/${periodId}/export.csv`, { headers });
  if (!response.ok) throw new Error('Failed to export payroll period');
  return response.blob();
}

/* ==================== Paired Devices (KDS, etc.) ==================== */

export interface PairInitResponse {
  device_id: string;
  pairing_code: string;
  expires_at: string;
}

export type PairPollResponse =
  | { status: 'pending' }
  | { status: 'expired' }
  | { status: 'revoked' }
  | {
      status: 'claimed';
      token: string;
      device_id: string;
      device_label: string | null;
      device_type: 'kds' | 'bar' | 'expo';
      tenant_name: string;
    };

export interface PairedDevice {
  id: string;
  device_label: string | null;
  device_type: 'kds' | 'bar' | 'expo';
  claimed_at: string | null;
  last_seen_at: string | null;
  last_seen_ip: string | null;
  revoked_at: string | null;
  created_at: string;
  claimed_by_name: string | null;
}

export async function pairDeviceInit(deviceType: 'kds' | 'bar' | 'expo' = 'kds'): Promise<PairInitResponse> {
  return apiRequest<PairInitResponse>('/devices/pair/init', {
    method: 'POST',
    body: JSON.stringify({ device_type: deviceType }),
  });
}

export async function pairDevicePoll(deviceId: string): Promise<PairPollResponse> {
  return apiRequest<PairPollResponse>('/devices/pair/poll', {
    method: 'POST',
    body: JSON.stringify({ device_id: deviceId }),
  });
}

export async function pairDeviceClaim(pairingCode: string, deviceLabel?: string): Promise<{ ok: true; device_id: string }> {
  return apiRequest<{ ok: true; device_id: string }>('/devices/pair/claim', {
    method: 'POST',
    body: JSON.stringify({ pairing_code: pairingCode, device_label: deviceLabel }),
  });
}

export async function listPairedDevices(): Promise<PairedDevice[]> {
  return apiRequest<PairedDevice[]>('/devices');
}

export async function renamePairedDevice(id: string, deviceLabel: string): Promise<{ ok: true }> {
  return apiRequest<{ ok: true }>(`/devices/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ device_label: deviceLabel }),
  });
}

export async function revokePairedDevice(id: string): Promise<{ ok: true }> {
  return apiRequest<{ ok: true }>(`/devices/${id}`, { method: 'DELETE' });
}

export interface KioskDeviceStatus {
  id: string;
  name: string;
  bound_at: string;
  last_seen_at: string | null;
  /** Build the device last reported. Null until it heartbeats once. */
  client_version: string | null;
  client_platform: 'web' | 'android' | null;
  kiosk_mode_override: string | null;
}

export async function listKioskDevices(): Promise<{
  devices: KioskDeviceStatus[];
  current_version: string;
}> {
  return apiRequest<{ devices: KioskDeviceStatus[]; current_version: string }>('/devices/kiosks');
}

// ==================== Manual & imported sales ====================
// Delivery-app revenue that never touches the POS. See
// server/routes/manual-sales.js for the three entry modes.

export interface ManualSalesChannel {
  id: number | null;
  name: string;
  display_name: string;
  commission_percent: number;
  active: boolean;
}

export interface ManualSalesBatch {
  id: number;
  channel: string;
  platform_id: number | null;
  platform_display_name: string | null;
  entry_mode: 'aggregate' | 'itemized' | 'import' | 'products';
  business_date: string;
  order_count: number;
  gross_total: number;
  commission_total: number;
  net_total: number;
  commission_percent: number;
  source_filename: string | null;
  note: string | null;
  created_by_name: string | null;
  created_at: string;
  live_order_count: number;
  /** 'products' batches create no orders — these are what they did instead. */
  product_units: number;
  product_cogs: number;
}

export interface ManualSalesImportRow {
  external_order_id: string | null;
  business_date: string;
  /** 1 for a per-order file; the day's order count for a daily-summary file. */
  order_count: number;
  gross: number;
  commission: number | null;
  net: number | null;
}

export interface ManualSalesImportPreview {
  headers: string[];
  mapping: Record<string, string | null>;
  /** Sheet names in the workbook (empty for CSV) and which one was read. */
  sheets: string[];
  sheet: string | null;
  /** true when the file is one row per DAY, so rows fan out into many orders. */
  is_daily: boolean;
  /** One row per day but no order count — importing as-is skews avg ticket. */
  looks_daily_without_counts: boolean;
  total_orders: number;
  row_count: number;
  importable_count: number;
  skipped: { row: number; reason: string }[];
  skipped_count: number;
  duplicate_count: number;
  totals: { gross: number; commission: number };
  date_range: { from: string; to: string } | null;
  sample: ManualSalesImportRow[];
  rows: ManualSalesImportRow[];
  warnings: string[];
}

export async function getManualSalesChannels(): Promise<{ platforms: ManualSalesChannel[] }> {
  return apiRequest('/manual-sales/channels');
}

export async function getManualSalesBatches(limit = 50): Promise<{ batches: ManualSalesBatch[] }> {
  return apiRequest(`/manual-sales/batches?limit=${limit}`);
}

export async function createAggregateManualSale(payload: {
  channel: string;
  business_date: string;
  order_count: number;
  gross_total: number;
  note?: string;
}): Promise<{
  success: boolean; batch_id: number; orders_created: number;
  gross_total: number; commission_total: number; net_total: number;
}> {
  return apiRequest('/manual-sales/aggregate', { method: 'POST', body: JSON.stringify(payload) });
}

export async function createItemizedManualSale(payload: {
  channel: string;
  business_date: string;
  items: { menu_item_id?: number | null; item_name?: string; quantity: number; unit_price?: number; notes?: string }[];
  note?: string;
  customer_name?: string;
  external_order_id?: string;
  deduct_inventory?: boolean;
}): Promise<{
  success: boolean; batch_id: number; order_id: number; items: number;
  gross_total: number; commission_total: number; net_total: number; inventory_deducted: boolean;
}> {
  return apiRequest('/manual-sales/itemized', { method: 'POST', body: JSON.stringify(payload) });
}

/** Shared multipart POST for the two manual-sales file previews. */
async function postManualSalesFile<T>(
  path: string,
  file: File,
  fields: Record<string, string | undefined>
): Promise<T> {
  const base = FALLBACK_URLS.length ? await resolveBaseUrl() : activeBaseUrl;
  const formData = new FormData();
  formData.append('file', file);
  for (const [key, value] of Object.entries(fields)) {
    if (value) formData.append(key, value);
  }
  const headers: Record<string, string> = {};
  const auth = authHeader();
  if (auth) headers['Authorization'] = auth;
  if (!isCapacitor && window.location.hostname === 'localhost') {
    const tenantId = localStorage.getItem('tenant_id');
    if (tenantId) headers['X-Tenant-ID'] = tenantId;
  }
  const response = await fetch(`${base}${path}`, { method: 'POST', headers, body: formData });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to read that file');
  }
  return response.json();
}

export async function previewManualSalesImport(
  file: File,
  opts: { business_date?: string; mapping?: Record<string, string | null>; sheet?: string } = {}
): Promise<ManualSalesImportPreview> {
  return postManualSalesFile('/manual-sales/import/preview', file, {
    business_date: opts.business_date,
    mapping: opts.mapping ? JSON.stringify(opts.mapping) : undefined,
    sheet: opts.sheet,
  });
}

export async function commitManualSalesImport(payload: {
  channel: string;
  rows: ManualSalesImportRow[];
  source_filename?: string;
  note?: string;
}): Promise<{
  success: boolean; batch_id: number | null; orders_created: number;
  skipped_duplicates: number; gross_total?: number; commission_total?: number;
  net_total?: number; date_range?: { from: string; to: string }; message?: string;
}> {
  return apiRequest('/manual-sales/import/commit', { method: 'POST', body: JSON.stringify(payload) });
}

export async function deleteManualSalesBatch(id: number): Promise<{
  success: boolean; batch_id: number; orders_deleted: number; product_lines_reversed: number;
}> {
  return apiRequest(`/manual-sales/batches/${id}`, { method: 'DELETE' });
}

// ==================== Product-level delivery import ====================
// A per-product daily report (DiDi's "Reporte diario de productos") feeds
// inventory and COGS. It creates NO orders — the settlement import already
// booked that revenue. See migration 0095.

export interface ProductImportDay {
  business_date: string;
  gross: number;
  /** null when the price is unknown, so units could not be worked out. */
  quantity: number | null;
  /** false when gross ÷ price did not land on a whole number. */
  exact: boolean;
  quantity_source: 'column' | 'derived' | 'none';
  already_imported: boolean;
}

export interface ProductImportItem {
  platform_item_name: string;
  norm_name: string;
  menu_item_id: number | null;
  menu_item_name: string | null;
  pos_price: number | null;
  platform_price: number | null;
  /** How the platform price was arrived at. 'single' is the weakest — one
   *  day's total cannot pin a unit price, so it needs a human. */
  price_basis: 'saved' | 'pos_anchor' | 'divisor' | 'single' | 'none';
  match_confidence: 'saved' | 'exact' | 'contains' | 'fuzzy' | 'none';
  candidates: { menu_item_id: number; name: string; price: number; score: number }[];
  ignored: boolean;
  days: ProductImportDay[];
  total_quantity: number;
  total_gross: number;
  /** Recipe cost per unit; null when the menu item has no recipe. */
  unit_cost: number | null;
}

export interface ProductImportPreview {
  headers: string[];
  mapping: Record<string, string | null>;
  sheets: string[];
  sheet: string | null;
  platform: { id: number; name: string; display_name: string };
  items: ProductImportItem[];
  row_count: number;
  product_count: number;
  unresolved_count: number;
  already_imported_dates: string[];
  skipped_count: number;
  date_range: { from: string; to: string } | null;
  warnings: string[];
}

export async function previewProductImport(
  file: File,
  opts: { channel: string; business_date?: string; mapping?: Record<string, string | null>; sheet?: string }
): Promise<ProductImportPreview> {
  return postManualSalesFile('/manual-sales/products/preview', file, {
    channel: opts.channel,
    business_date: opts.business_date,
    mapping: opts.mapping ? JSON.stringify(opts.mapping) : undefined,
    sheet: opts.sheet,
  });
}

export async function commitProductImport(payload: {
  channel: string;
  items: ProductImportItem[];
  source_filename?: string;
  note?: string;
  deduct_inventory?: boolean;
}): Promise<{
  success: boolean; batch_id: number; lines: number; units: number;
  gross_total: number; cogs_total: number;
  skipped_unresolved: number; skipped_already_imported: number;
  inventory_deducted: boolean; date_range: { from: string; to: string };
}> {
  return apiRequest('/manual-sales/products/commit', { method: 'POST', body: JSON.stringify(payload) });
}

export interface PlatformItemMapping {
  id: number;
  platform_item_name: string;
  menu_item_id: number | null;
  menu_item_name: string | null;
  platform_price: number | null;
  pos_price: number | null;
  ignored: boolean;
}

export async function getPlatformItemMap(channel: string): Promise<{ mappings: PlatformItemMapping[] }> {
  return apiRequest(`/manual-sales/product-map?channel=${encodeURIComponent(channel)}`);
}

export async function deletePlatformItemMapping(id: number): Promise<{ success: boolean; id: number }> {
  return apiRequest(`/manual-sales/product-map/${id}`, { method: 'DELETE' });
}

export interface ProductSalesRow {
  menu_item_id: number | null;
  platform_item_name: string;
  menu_item_name: string | null;
  platform_display_name: string | null;
  units: number;
  gross: number;
  cogs: number;
}

export async function getProductSales(opts: { from?: string; to?: string } = {}): Promise<{ rows: ProductSalesRow[] }> {
  const q = new URLSearchParams();
  if (opts.from) q.set('from', opts.from);
  if (opts.to) q.set('to', opts.to);
  const qs = q.toString();
  return apiRequest(`/manual-sales/product-sales${qs ? `?${qs}` : ''}`);
}
