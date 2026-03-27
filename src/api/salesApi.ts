/**
 * Sales CRM API client.
 * All requests use sales rep JWT from sessionStorage for auth.
 */

const API_BASE = '/api/sales';

function getToken(): string {
  return sessionStorage.getItem('sales_token') || '';
}

async function salesRequest<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${getToken()}`,
      ...(options.headers || {}),
    },
  });

  if (!res.ok) {
    let msg = `API Error: ${res.status}`;
    try {
      const data = await res.json();
      msg = data.error || msg;
    } catch {}
    throw new Error(msg);
  }

  return res.json() as Promise<T>;
}

// ==================== Types ====================

export interface SalesRep {
  id: number;
  email: string;
  name: string;
  phone: string | null;
  role: 'rep' | 'manager';
  active: boolean;
  created_at: string;
}

export interface Lead {
  id: number;
  restaurant_name: string | null;
  name: string | null;
  email: string;
  phone: string | null;
  source: string | null;
  status: string;
  assigned_rep_id: number | null;
  rep_name: string | null;
  tenant_id: string | null;
  converted_at: string | null;
  notes: string | null;
  last_contacted_at: string | null;
  created_at: string;
}

export interface SalesActivity {
  id: number;
  rep_id: number;
  lead_id: number | null;
  tenant_id: string | null;
  activity_type: string;
  description: string | null;
  rep_name: string | null;
  created_at: string;
}

export interface DashboardData {
  leads: {
    new_leads: number;
    contacted: number;
    demo_scheduled: number;
    negotiating: number;
    converted: number;
    lost: number;
    total: number;
  };
  commissions: { earned: number; paid: number; total: number };
  active_clients: number;
  recent_leads: Lead[];
}

export interface CommissionPayout {
  id: number;
  rep_id: number;
  commission_id: number;
  tenant_id: string;
  tenant_name: string;
  period: string;
  mrr_amount: number;
  commission_amount: number;
  status: string;
  paid_at: string | null;
  created_at: string;
  rep_name?: string;
}

export interface SalesCommission {
  id: number;
  rep_id: number;
  tenant_id: string;
  tenant_name: string;
  commission_percent: number;
  duration_months: number;
  start_date: string;
  end_date: string | null;
  active: boolean;
}

export interface SalesClient {
  tenant_id: string;
  name: string;
  plan: string;
  active: boolean;
  created_at: string;
  commission_percent: number;
  start_date: string;
  end_date: string | null;
  orders_30d: number;
  rep_name?: string;
}

export interface ClientDetail {
  tenant: { id: string; name: string; plan: string; active: boolean; created_at: string };
  stats: {
    total_orders: number;
    total_revenue: number;
    orders_30d: number;
    revenue_30d: number;
    employees: number;
    menu_items: number;
    last_order_at: string | null;
  };
}

export interface LeaderboardEntry {
  id: number;
  name: string;
  conversions: number;
  clients: number;
  total_earned: number;
}

export interface OnboardPayload {
  restaurant_name: string;
  owner_name: string;
  owner_email: string;
  owner_phone?: string;
  subdomain: string;
  plan?: string;
  branding?: { primaryColor?: string };
  generate_demo_data?: boolean;
  financing_consent?: boolean;
}

export interface OnboardResult {
  ok: boolean;
  tenant_id: string;
  login_url: string;
  demo_token: string;
  pin: string;
  owner_password: string;
  employee_id: number;
}

// ==================== Auth ====================

export function login(email: string, password: string) {
  return salesRequest<{ token: string; rep: SalesRep }>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

export function getMe() {
  return salesRequest<{ rep: SalesRep }>('/auth/me');
}

// ==================== Dashboard ====================

export function getDashboard() {
  return salesRequest<DashboardData>('/dashboard');
}

export function getTeamDashboard() {
  return salesRequest<any[]>('/dashboard/team');
}

export function getLeaderboard() {
  return salesRequest<LeaderboardEntry[]>('/leaderboard');
}

// ==================== Leads ====================

export function getLeads(params?: { status?: string; limit?: number; offset?: number }) {
  const qs = new URLSearchParams();
  if (params?.status) qs.set('status', params.status);
  if (params?.limit) qs.set('limit', String(params.limit));
  if (params?.offset) qs.set('offset', String(params.offset));
  const s = qs.toString();
  return salesRequest<Lead[]>(`/leads${s ? `?${s}` : ''}`);
}

export function getLead(id: number) {
  return salesRequest<{ lead: Lead; activities: SalesActivity[] }>(`/leads/${id}`);
}

export function createLead(data: Partial<Lead>) {
  return salesRequest<Lead>('/leads', { method: 'POST', body: JSON.stringify(data) });
}

export function updateLead(id: number, data: Partial<Lead>) {
  return salesRequest<Lead>(`/leads/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
}

export function logActivity(leadId: number, data: { activity_type: string; description?: string }) {
  return salesRequest<SalesActivity>(`/leads/${leadId}/activity`, { method: 'POST', body: JSON.stringify(data) });
}

// ==================== Commissions ====================

export function getCommissions() {
  return salesRequest<CommissionPayout[]>('/commissions');
}

export function getCommissionSummary() {
  return salesRequest<{ summary: { pending: number; paid: number; total: number }; active_commissions: SalesCommission[] }>('/commissions/summary');
}

export function getAllCommissions() {
  return salesRequest<CommissionPayout[]>('/commissions/all');
}

export function markCommissionPaid(id: number) {
  return salesRequest<CommissionPayout>(`/commissions/${id}/pay`, { method: 'PATCH' });
}

// ==================== Clients ====================

export function getClients() {
  return salesRequest<SalesClient[]>('/clients');
}

export function getClientDetail(tenantId: string) {
  return salesRequest<ClientDetail>(`/clients/${tenantId}`);
}

// ==================== Reps (manager) ====================

export function getReps() {
  return salesRequest<SalesRep[]>('/reps');
}

export function createRep(data: { email: string; password: string; name: string; phone?: string; role?: string }) {
  return salesRequest<SalesRep>('/reps', { method: 'POST', body: JSON.stringify(data) });
}

export function updateRep(id: number, data: Partial<SalesRep>) {
  return salesRequest<SalesRep>(`/reps/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
}

export function resetRepPassword(id: number, password: string) {
  return salesRequest<{ ok: boolean; message: string }>(`/reps/${id}/reset-password`, {
    method: 'POST',
    body: JSON.stringify({ password }),
  });
}

// ==================== Onboarding ====================

export function checkAvailability(params: { subdomain?: string; email?: string }) {
  const qs = new URLSearchParams();
  if (params.subdomain) qs.set('subdomain', params.subdomain);
  if (params.email) qs.set('email', params.email);
  return salesRequest<{ subdomain_available: boolean; email_available: boolean }>(`/onboard/check-availability?${qs}`);
}

export function onboardClient(data: OnboardPayload) {
  return salesRequest<OnboardResult>('/onboard', { method: 'POST', body: JSON.stringify(data) });
}

// ==================== Demo ====================

export function getDemoAccess() {
  return salesRequest<{ ok: boolean; demo_url: string; expires_at: string; tenant_id: string }>('/demo/access');
}
