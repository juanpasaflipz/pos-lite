/**
 * Corporate (organization) dashboard API client.
 * Auth: org JWT in sessionStorage — separate from employee/owner tokens.
 */

const API_BASE = '/api/org';
const TOKEN_KEY = 'org_token';

export function getOrgToken(): string {
  return sessionStorage.getItem(TOKEN_KEY) || '';
}

export function setOrgToken(token: string): void {
  sessionStorage.setItem(TOKEN_KEY, token);
}

export function clearOrgToken(): void {
  sessionStorage.removeItem(TOKEN_KEY);
}

async function orgRequest<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getOrgToken()}`,
      ...(options.headers || {}),
    },
  });

  if (!res.ok) {
    let msg = `API Error: ${res.status}`;
    try {
      const data = await res.json();
      msg = data.error || msg;
    } catch { /* keep default */ }
    throw new Error(msg);
  }

  return res.json() as Promise<T>;
}

// ==================== Types ====================

export interface OrgInfo {
  id: string;
  name: string;
}

export interface OrgOverview {
  store_count: number;
  today_revenue: number;
  today_orders: number;
  yesterday_revenue: number;
  week_revenue: number;
  month_revenue: number;
  month_orders: number;
  avg_ticket_30d: number;
}

export interface OrgStore {
  id: string;
  name: string;
  subdomain: string;
  today_revenue: number;
  today_orders: number;
  week_revenue: number;
  month_revenue: number;
  month_orders: number;
  avg_ticket: number;
  last_sale_at: string | null;
}

export interface OrgDayPoint {
  day: string;
  orders: number;
  revenue: number;
}

export interface OrgTopItem {
  item_name: string;
  units: number;
  revenue: number;
}

// ==================== Calls ====================

export async function orgLogin(email: string, password: string): Promise<OrgInfo> {
  const res = await fetch(`${API_BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    let msg = 'Login failed';
    try {
      const data = await res.json();
      msg = data.error || msg;
    } catch { /* keep default */ }
    throw new Error(msg);
  }
  const data = await res.json();
  setOrgToken(data.token);
  return data.org as OrgInfo;
}

export async function orgMe(): Promise<{ org: OrgInfo; store_count: number }> {
  return orgRequest('/me');
}

export const getOrgOverview = () => orgRequest<OrgOverview>('/overview');
export const getOrgStores = () => orgRequest<OrgStore[]>('/stores');
export const getOrgTimeseries = (days = 30) => orgRequest<OrgDayPoint[]>(`/timeseries?days=${days}`);
export const getOrgTopItems = (limit = 10) => orgRequest<OrgTopItem[]>(`/top-items?limit=${limit}`);
