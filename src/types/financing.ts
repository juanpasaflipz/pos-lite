/* Financing Types — matches backend /api/financing/* response shapes */

export interface FinancialProfile {
  id: string;
  tenant_id: string;
  risk_score: number;
  eligibility_status: 'eligible' | 'pre_eligible' | 'ineligible' | 'new';
  monthly_avg_revenue: number;
  monthly_avg_orders: number;
  avg_daily_orders: number;
  card_payment_percent: number;
  refund_rate: number;
  revenue_trend: number;      // e.g. +12.5 or -3.2
  days_operating: number;
  days_required: number;
  revenue_required: number;
  last_calculated_at: string;
  created_at: string;
  updated_at: string;
}

export interface FinancingOffer {
  id: string;
  tenant_id: string;
  profile_id: string;
  offer_amount: number;
  holdback_percent: number;
  factor_rate: number;
  total_repayment: number;
  estimated_daily_holdback: number;
  estimated_duration_days: number;
  status: 'available' | 'viewed' | 'accepted' | 'declined' | 'expired' | 'withdrawn';
  decline_reason?: string;
  notes?: string;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

export interface ConsentStatus {
  has_consent: boolean;
  consent_types?: string[];
  consented_at?: string;
  consent_version?: string;
}

export interface FinancingOverview {
  total_consented: number;
  total_eligible: number;
  total_pre_eligible: number;
  total_ineligible: number;
  active_offers: number;
  total_capital_offered: number;
  total_capital_accepted: number;
  acceptance_rate: number;
  score_distribution: { bucket: string; count: number }[];
}

export interface FinancingEvent {
  id: string;
  tenant_id: string;
  event_type: string;
  details: Record<string, unknown>;
  created_at: string;
  tenant_name?: string;
}

export interface FinancingProfileWithTenant extends FinancialProfile {
  tenant_name: string;
  tenant_plan: string;
}
