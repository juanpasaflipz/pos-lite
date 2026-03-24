/**
 * Super-Admin API client.
 * All requests use x-admin-secret from sessionStorage for auth.
 */

const API_BASE = '/admin';

function getSecret(): string {
  return sessionStorage.getItem('admin_secret') || '';
}

async function adminRequest<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'x-admin-secret': getSecret(),
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

// ==================== Analytics ====================

export interface OverviewData {
  total_tenants: number;
  active_tenants: number;
  plan_breakdown: { free: number; pro: number };
  mrr: number;
  total_orders: number;
  total_revenue: number;
}

export interface MonthlyData {
  month: string;
  count?: number;
  order_count?: number;
  revenue?: number;
}

export interface HealthData {
  uptime_seconds: number;
  node_version: string;
  platform: string;
  memory: { rss_mb: number; heap_used_mb: number; heap_total_mb: number };
  os: { total_mem_mb: number; free_mem_mb: number; cpus: number };
  postgres_version: string;
}

export interface ActivityData {
  most_active: TenantActivity[];
  least_active: TenantActivity[];
}

export interface TenantActivity {
  id: string;
  name: string;
  plan: string;
  order_count: number;
  revenue: number;
}

export interface TenantRecord {
  id: string;
  name: string;
  subdomain: string;
  owner_email: string;
  plan: string;
  active: boolean;
  subscription_status: string | null;
  created_at: string;
  order_count: number;
  employee_count: number;
  [key: string]: any;
}

export interface DeepDiveData {
  tenant: TenantRecord;
  stats: {
    total_orders: number;
    total_revenue: number;
    orders_30d: number;
    revenue_30d: number;
    employee_count: number;
    menu_item_count: number;
    category_count: number;
    customer_count: number;
    last_order_at: string | null;
  };
}

export function getOverview() {
  return adminRequest<OverviewData>('/analytics/overview');
}

export function getSignups(months = 12) {
  return adminRequest<MonthlyData[]>(`/analytics/signups?months=${months}`);
}

export function getRevenue(months = 12) {
  return adminRequest<MonthlyData[]>(`/analytics/revenue?months=${months}`);
}

export function getChurn(months = 12) {
  return adminRequest<MonthlyData[]>(`/analytics/churn?months=${months}`);
}

export function getHealth() {
  return adminRequest<HealthData>('/analytics/health');
}

export function getActivity() {
  return adminRequest<ActivityData>('/analytics/activity');
}

// ==================== Detailed Health / Monitoring ====================

export interface PoolMetrics {
  active: number;
  totalReserves: number;
  successes: number;
  failures: number;
  avgWaitMs: number;
  peakActive: number;
  max: number;
}

export interface ServiceStatus {
  status: 'ok' | 'degraded' | 'down' | 'unconfigured';
  latency_ms: number;
  message?: string;
}

export interface SchedulerJob {
  name: string;
  intervalMs: number;
  lastRun: string | null;
  lastError: string | null;
  runCount: number;
}

export interface RequestMetrics {
  totalRequests: number;
  totalErrors: number;
  errorRate: number;
  errorsByStatus: Record<string, number>;
  errorsByTenant: Record<string, number>;
  latencyBuckets: Record<string, number>;
  recentErrors: Array<{
    timestamp: string;
    method: string;
    path: string;
    status: number;
    tenant: string;
    message?: string;
  }>;
}

export interface DetailedHealthData {
  uptime_seconds: number;
  node_version: string;
  platform: string;
  memory: { rss_mb: number; heap_used_mb: number; heap_total_mb: number; external_mb: number };
  os: { total_mem_mb: number; free_mem_mb: number; cpus: number; load_avg: number[] };
  postgres_version: string;
  pools: { tenant: PoolMetrics; admin: PoolMetrics };
  requests: RequestMetrics;
  services: {
    postgres: ServiceStatus;
    stripe: ServiceStatus;
    twilio: ServiceStatus;
    grok: ServiceStatus;
    dns: Record<string, ServiceStatus>;
  };
  scheduler: { running: boolean; jobs: SchedulerJob[] };
}

export interface MetricsSnapshot {
  timestamp: string;
  pool: { tenant: Omit<PoolMetrics, 'max'>; admin: Omit<PoolMetrics, 'max'> };
  requests: { totalRequests: number; totalErrors: number; errorRate: number; latencyBuckets: Record<string, number> };
  memory: { heapUsedMb: number; heapTotalMb: number; rssMb: number };
}

export interface PlatformAlert {
  id: number;
  created_at: string;
  severity: 'warning' | 'critical';
  category: string;
  title: string;
  message: string;
  metadata: string;
  acknowledged: boolean;
  acknowledged_at: string | null;
}

export interface AlertRule {
  id: number;
  name: string;
  metric_type: string;
  metric_name: string;
  condition: string;
  threshold: number;
  severity: string;
  cooldown_minutes: number;
  webhook_url: string | null;
  enabled: boolean;
}

export function getDetailedHealth() {
  return adminRequest<DetailedHealthData>('/analytics/health/detailed');
}

export function getMetricsHistory(minutes = 60) {
  return adminRequest<MetricsSnapshot[]>(`/analytics/metrics/history?minutes=${minutes}`);
}

export function getAlerts(limit = 50) {
  return adminRequest<PlatformAlert[]>(`/analytics/alerts?limit=${limit}`);
}

export function getUnacknowledgedAlertCount() {
  return adminRequest<{ count: number }>('/analytics/alerts/unacknowledged/count');
}

export function acknowledgeAlert(id: number) {
  return adminRequest<PlatformAlert>(`/analytics/alerts/${id}/acknowledge`, { method: 'PATCH' });
}

export function getAlertRules() {
  return adminRequest<AlertRule[]>('/analytics/alerts/rules');
}

// ==================== Tenants ====================

export function getTenants(params?: { search?: string; plan?: string; status?: string; sort?: string; order?: string }) {
  const qs = new URLSearchParams();
  if (params?.search) qs.set('search', params.search);
  if (params?.plan) qs.set('plan', params.plan);
  if (params?.status) qs.set('status', params.status);
  if (params?.sort) qs.set('sort', params.sort);
  if (params?.order) qs.set('order', params.order);
  const s = qs.toString();
  return adminRequest<TenantRecord[]>(`/tenants${s ? `?${s}` : ''}`);
}

export function getTenantDeepDive(id: string) {
  return adminRequest<DeepDiveData>(`/tenants/${id}/deep-dive`);
}

export function patchTenant(id: string, data: Record<string, any>) {
  return adminRequest<TenantRecord>(`/tenants/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

// ==================== Tenant Management ====================

export interface CreateTenantPayload {
  id: string;
  name: string;
  owner_email: string;
  owner_password: string;
  subdomain?: string;
  plan?: string;
  branding_json?: { primaryColor?: string };
}

export interface CreateTenantResponse extends TenantRecord {
  pin: string;
}

export function createTenant(data: CreateTenantPayload) {
  return adminRequest<CreateTenantResponse>('/tenants', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function seedTenant(id: string) {
  return adminRequest<{ message: string }>(`/tenants/${id}/seed`, {
    method: 'POST',
  });
}

export function resetTenantPassword(id: string, new_password: string) {
  return adminRequest<{ message: string }>(`/tenants/${id}/reset-password`, {
    method: 'POST',
    body: JSON.stringify({ new_password }),
  });
}

export async function exportTenantData(id: string): Promise<Record<string, any>> {
  const res = await fetch(`${API_BASE}/tenants/${id}/export`, {
    headers: {
      'x-admin-secret': getSecret(),
    },
  });
  if (!res.ok) {
    let msg = `API Error: ${res.status}`;
    try { const data = await res.json(); msg = data.error || msg; } catch {}
    throw new Error(msg);
  }
  return res.json();
}

export function deleteTenant(id: string, confirm: string) {
  return adminRequest<{ message: string }>(`/tenants/${id}`, {
    method: 'DELETE',
    body: JSON.stringify({ confirm }),
  });
}

// ==================== Employee PIN Management ====================

export interface TenantEmployee {
  id: number;
  name: string;
  role: string;
  active: boolean;
  created_at: string;
}

export function getTenantEmployees(tenantId: string) {
  return adminRequest<TenantEmployee[]>(`/tenants/${tenantId}/employees`);
}

export function updateEmployeePin(tenantId: string, empId: number, pin: string) {
  return adminRequest<{ message: string }>(`/tenants/${tenantId}/employees/${empId}/pin`, {
    method: 'PATCH',
    body: JSON.stringify({ pin }),
  });
}

/**
 * Verify admin secret by making a lightweight request.
 * Returns true if valid, false otherwise.
 */
export async function verifySecret(): Promise<boolean> {
  try {
    await adminRequest('/analytics/health');
    return true;
  } catch {
    return false;
  }
}

// ==================== Demo Data / Stress Test ====================

export interface DemoDataConfig {
  tenant_id: string;
  volume?: 'low' | 'medium' | 'high';
  date_range_days?: number;
  include_delivery?: boolean;
  include_loyalty?: boolean;
  include_ai?: boolean;
  include_financials?: boolean;
}

export interface DemoDataSummary {
  orders: number;
  order_items: number;
  order_item_modifiers: number;
  order_payments: number;
  delivery_orders: number;
  loyalty_customers: number;
  stamp_cards: number;
  stamp_events: number;
  referral_events: number;
  ai_hourly_snapshots: number;
  ai_item_pairs: number;
  ai_inventory_velocity: number;
  financial_actuals: number;
}

export interface DemoRun {
  id: string;
  config: Record<string, any>;
  summary: DemoDataSummary | null;
  created_at: string;
}

export interface DemoStatus {
  hasDemo: boolean;
  runs: DemoRun[];
  counts: {
    orders: number;
    customers: number;
    delivery_orders: number;
    ai_snapshots: number;
    financial_actuals: number;
  };
}

export function generateDemoData(config: DemoDataConfig) {
  return adminRequest<{ run_id: string; summary: DemoDataSummary }>('/stress-test/generate', {
    method: 'POST',
    body: JSON.stringify(config),
  });
}

export function getDemoStatus(tenantId: string) {
  return adminRequest<DemoStatus>(`/stress-test/status/${tenantId}`);
}

export function deleteDemoData(tenantId: string) {
  return adminRequest<{ deleted: Record<string, number> }>(`/stress-test/${tenantId}`, {
    method: 'DELETE',
  });
}

// ==================== Financing ====================

import type {
  FinancingOverview,
  FinancingProfileWithTenant,
  FinancingOffer,
  FinancingEvent,
  FinancialProfile,
} from '../types/financing';

export function getFinancingOverview() {
  return adminRequest<FinancingOverview>('/financing/overview');
}

export function getFinancingProfiles(params?: { eligibility?: string; sort?: string; order?: string }) {
  const qs = new URLSearchParams();
  if (params?.eligibility) qs.set('eligibility', params.eligibility);
  if (params?.sort) qs.set('sort', params.sort);
  if (params?.order) qs.set('order', params.order);
  const s = qs.toString();
  return adminRequest<FinancingProfileWithTenant[]>(`/financing/profiles${s ? `?${s}` : ''}`);
}

export function getFinancingProfileAdmin(tenantId: string) {
  return adminRequest<FinancingProfileWithTenant>(`/financing/profiles/${tenantId}`);
}

export function recalculateFinancingProfile(tenantId: string) {
  return adminRequest<FinancialProfile>(`/financing/profiles/${tenantId}/recalculate`, {
    method: 'POST',
  });
}

export function getFinancingOffers(params?: { status?: string; sort?: string; order?: string }) {
  const qs = new URLSearchParams();
  if (params?.status) qs.set('status', params.status);
  if (params?.sort) qs.set('sort', params.sort);
  if (params?.order) qs.set('order', params.order);
  const s = qs.toString();
  return adminRequest<(FinancingOffer & { tenant_name?: string })[]>(`/financing/offers${s ? `?${s}` : ''}`);
}

export function updateFinancingOffer(offerId: string, updates: Partial<Pick<FinancingOffer, 'offer_amount' | 'holdback_percent' | 'factor_rate' | 'notes' | 'status'>>) {
  return adminRequest<FinancingOffer>(`/financing/offers/${offerId}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });
}

export function getFinancingEvents(params?: { tenant_id?: string; event_type?: string; limit?: number; offset?: number }) {
  const qs = new URLSearchParams();
  if (params?.tenant_id) qs.set('tenant_id', params.tenant_id);
  if (params?.event_type) qs.set('event_type', params.event_type);
  if (params?.limit) qs.set('limit', String(params.limit));
  if (params?.offset) qs.set('offset', String(params.offset));
  const s = qs.toString();
  return adminRequest<FinancingEvent[]>(`/financing/events${s ? `?${s}` : ''}`);
}

export function getFinancingActivity(params?: { event_type?: string; since?: string }) {
  const qs = new URLSearchParams();
  if (params?.event_type) qs.set('event_type', params.event_type);
  if (params?.since) qs.set('since', params.since);
  const s = qs.toString();
  return adminRequest<{ events: FinancingEvent[] }>(`/financing/activity${s ? `?${s}` : ''}`);
}

// ==================== Settlement ====================

export function getSettlementOverview() {
  return adminRequest<any>('/settlement/overview');
}

export function getSettlementBatches(params?: { limit?: number; offset?: number; status?: string }) {
  const qs = new URLSearchParams();
  if (params?.limit) qs.set('limit', String(params.limit));
  if (params?.offset) qs.set('offset', String(params.offset));
  if (params?.status) qs.set('status', params.status);
  const s = qs.toString();
  return adminRequest<any>(`/settlement/batches${s ? `?${s}` : ''}`);
}

export function getSettlementBatchDetail(id: number) {
  return adminRequest<any>(`/settlement/batches/${id}`);
}

export function getDisbursementQueue(params?: { status?: string; limit?: number }) {
  const qs = new URLSearchParams();
  if (params?.status) qs.set('status', params.status);
  if (params?.limit) qs.set('limit', String(params.limit));
  const s = qs.toString();
  return adminRequest<any>(`/settlement/disbursements${s ? `?${s}` : ''}`);
}

export function approveDisbursement(lineId: number, bankReference?: string) {
  return adminRequest<any>(`/settlement/disbursements/${lineId}/approve`, {
    method: 'POST',
    body: JSON.stringify({ bank_reference: bankReference }),
  });
}

export function holdDisbursement(lineId: number, reason?: string) {
  return adminRequest<any>(`/settlement/disbursements/${lineId}/hold`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

export function triggerDisbursements(date?: string) {
  return adminRequest<any>('/settlement/disbursements/process', {
    method: 'POST',
    body: JSON.stringify({ date }),
  });
}

export function getHoldingLedger(params?: { limit?: number; offset?: number; entry_type?: string; tenant_id?: string }) {
  const qs = new URLSearchParams();
  if (params?.limit) qs.set('limit', String(params.limit));
  if (params?.offset) qs.set('offset', String(params.offset));
  if (params?.entry_type) qs.set('entry_type', params.entry_type);
  if (params?.tenant_id) qs.set('tenant_id', params.tenant_id);
  const s = qs.toString();
  return adminRequest<any>(`/settlement/ledger${s ? `?${s}` : ''}`);
}

// ==================== MCA Admin ====================

export function getMCAPortfolio() {
  return adminRequest<any>('/settlement/mca/portfolio');
}

export function getMCAAdvanceDetail(id: number) {
  return adminRequest<any>(`/settlement/mca/advances/${id}`);
}

export function pauseAdvance(id: number, reason?: string) {
  return adminRequest<any>(`/settlement/mca/advances/${id}/pause`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

export function resumeAdvance(id: number) {
  return adminRequest<any>(`/settlement/mca/advances/${id}/resume`, {
    method: 'POST',
  });
}

export function adjustHoldback(id: number, holdbackPercent: number) {
  return adminRequest<any>(`/settlement/mca/advances/${id}/holdback`, {
    method: 'PATCH',
    body: JSON.stringify({ holdback_percent: holdbackPercent }),
  });
}

export function getCapitalPool() {
  return adminRequest<any>('/settlement/mca/capital');
}

export function updateCapitalPool(action: 'add' | 'withdraw', amount: number) {
  return adminRequest<any>('/settlement/mca/capital', {
    method: 'POST',
    body: JSON.stringify({ action, amount }),
  });
}
