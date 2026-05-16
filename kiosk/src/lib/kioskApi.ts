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
): Promise<KioskOrderResponse> {
  const res = await fetch(`${API_BASE}/api/kiosk/orders`, {
    method: 'POST',
    headers: authHeaders(auth),
    body: JSON.stringify({ items, payment_choice: paymentChoice }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Order failed (${res.status})`);
  }
  return res.json();
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
