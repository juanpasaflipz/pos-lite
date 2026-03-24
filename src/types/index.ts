/* Employee Types */
export interface Employee {
  id: number;
  name: string;
  pin?: string;
  role: 'cashier' | 'kitchen' | 'bar' | 'manager' | 'admin';
  active: boolean;
  created_at: string;
  permissions?: string[];
  token?: string;
}

export interface RolePermission {
  role: string;
  permission: string;
  granted: boolean;
}

/* Menu Types */
export interface MenuCategory {
  id: number;
  name: string;
  sort_order: number;
  active: boolean;
}

export interface MenuItem {
  id: number;
  category_id: number;
  name: string;
  price: number;
  description?: string;
  image_url?: string;
  active: boolean;
  prep_time_minutes?: number;
  is_example?: boolean;
}

/* Virtual Brand Types */
export interface VirtualBrand {
  id: number;
  name: string;
  slug: string;
  primary_color: string;
  secondary_color?: string;
  items: VirtualBrandItem[];
}

export interface VirtualBrandItem {
  menu_item_id: number;
  custom_name: string | null;
  custom_price: number | null;
  category_id: number;
}

/* Order Types */
export interface OrderItem {
  id?: number;
  order_id?: number;
  menu_item_id: number;
  item_name: string;
  quantity: number;
  unit_price: number;
  notes?: string;
  combo_instance_id?: string | null;
  modifiers?: OrderItemModifier[];
  virtual_brand_id?: number | null;
  brand_name?: string;
  brand_color?: string;
}

export interface CartItem extends OrderItem {
  cart_id: string;
  menuItem?: MenuItem;
  selectedModifierIds?: number[];
  selectedModifierNames?: string[];
  virtual_brand_id?: number | null;
}

export interface Order {
  id: number;
  order_number: string;
  employee_id: number;
  employee_name?: string;
  status: 'pending' | 'confirmed' | 'preparing' | 'ready' | 'completed' | 'cancelled';
  subtotal: number;
  tax: number;
  tip: number;
  total: number;
  payment_intent_id?: string;
  payment_status: 'unpaid' | 'processing' | 'paid' | 'completed' | 'failed' | 'refunded' | 'pending_oxxo' | 'pending_spei' | 'expired';
  payment_method?: 'card' | 'cash' | 'split' | 'transfer' | 'oxxo' | 'spei' | 'getnet_card' | 'getnet_tap' | null;
  source?: 'pos' | 'uber_eats' | 'rappi' | 'didi_food' | 'qr_order';
  table_number?: string | null;
  invoice_token?: string;
  cfdi_invoice_id?: number;
  paid_at?: string;
  created_at: string;
  completed_at?: string;
  ready_at?: string;
  estimated_ready_minutes?: number;
  estimated_ready_range?: { low: number; high: number };
  conekta_order_id?: string;
  oxxo_reference?: string;
  oxxo_barcode_url?: string;
  spei_clabe?: string;
  async_payment_expires_at?: string;
  getnet_payment_id?: string;
  getnet_authorization_code?: string;
  items?: OrderItem[];
}

/* Getnet Types */
export interface GetnetStatus {
  configured: boolean;
  enabled: boolean;
  tapOnPhoneEnabled: boolean;
  environment: string;
}

export interface GetnetChargeResult {
  success: boolean;
  payment_status: string;
  getnet_payment_id: string;
  authorization_code?: string;
  card_brand?: string;
  card_last_four?: string;
  invoice_token?: string;
}

export interface GetnetTokenResult {
  number_token: string;
  brand?: string;
  last_four: string;
}

export interface GetnetTransaction {
  id: number;
  order_id: number;
  order_number?: string;
  getnet_payment_id: string;
  amount_centavos: number;
  status: string;
  authorization_code?: string;
  card_brand?: string;
  card_last_four?: string;
  is_tap_on_phone: boolean;
  created_at: string;
}

export interface GetnetFeeSummary {
  processor: string;
  transactions: number;
  gross: number;
  processorFees: number;
  platformFees: number;
  net: number;
}

export interface GetnetSavings {
  periodDays: number;
  totalVolume: number;
  totalTransactions: number;
  currentFees: number;
  proFees: number;
  monthlySavings: number;
}

/* Inventory Types */
export interface InventoryItem {
  id: number;
  name: string;
  quantity: number;
  unit: string;
  low_stock_threshold: number;
  category: string;
  cost_price?: number;
  sku?: string;
  barcode?: string;
  expiry_date?: string;
  lot_number?: string;
}

/* Recipe Types */
export interface RecipeIngredient {
  inventory_item_id: number;
  quantity_used: number;
  ingredient_name: string;
  unit: string;
  cost_price: number;
}

export interface RecipeSummaryItem {
  id: number;
  name: string;
  price: number;
  category_id: number;
  category_name: string;
  active: boolean;
  ingredient_count: number;
  cost_per_unit: number;
}

/* Waste Types */
export interface WasteLogEntry {
  id: number;
  inventory_item_id: number;
  item_name: string;
  quantity: number;
  unit: string;
  reason: 'spoilage' | 'prep_error' | 'dropped' | 'expired' | 'other';
  cost_at_time: number;
  notes?: string;
  logged_by_name?: string;
  created_at: string;
}

export interface WasteReport {
  summary: {
    total_waste_cost: number;
    total_entries: number;
    by_reason: Record<string, { count: number; cost: number }>;
  };
  by_item: Array<{
    inventory_item_id: number;
    name: string;
    unit: string;
    total_quantity: number;
    total_cost: number;
    entry_count: number;
    top_reason: string;
    waste_rate?: number;
  }>;
  daily_trend: Array<{ date: string; total_cost: number; entry_count: number }>;
}

export interface COGSSummary {
  period: string;
  start_date: string;
  revenue: number;
  cogs: number;
  waste_cost: number;
  total_food_cost: number;
  food_cost_percent: number;
  gross_profit: number;
  gross_margin_percent: number;
}

export interface ScanSession {
  item: InventoryItem;
  quantity: number;
  scanned_at: string;
}

/* Payment Types */
export interface PaymentIntent {
  client_secret: string;
  payment_intent_id: string;
  amount: number;
}

export interface PaymentStatus {
  status: 'unpaid' | 'processing' | 'completed' | 'failed' | 'refunded';
  payment_intent_id?: string;
  amount?: number;
}

/* Report Types */
export interface SalesReport {
  period: string;
  total_revenue: number;
  order_count: number;
  avg_ticket: number;
  tip_total: number;
  data?: any[];
}

export interface TopItemsReport {
  item_name: string;
  quantity_sold: number;
  revenue: number;
}

export interface EmployeePerformanceReport {
  employee_id: number;
  employee_name: string;
  orders_processed: number;
  total_sales: number;
  avg_ticket: number;
  tips_received: number;
}

export interface HourlyReport {
  hour: number;
  orders: number;
  revenue: number;
  avg_ticket: number;
}

/* AI Suggestion Types */
export interface AISuggestion {
  type: string;
  priority: number;
  data: {
    rule: string;
    suggested_item_id: number;
    suggested_item_name: string;
    suggested_item_price: number;
    savings?: number;
    message: string;
  };
}

export interface InventoryPushItem {
  menu_item_id: number;
  name: string;
  price: number;
  category_id: number;
  category_name: string;
  reason: string;
  ingredient_name?: string;
}

export interface InventoryPushData {
  pushItems: InventoryPushItem[];
  avoidItems: InventoryPushItem[];
  lowIngredients?: Array<{
    id: number;
    name: string;
    quantity: number;
    unit: string;
    low_stock_threshold: number;
  }>;
  soldOutItemIds?: number[];
  lowStockItemIds?: number[];
}

export interface AIConfig {
  [key: string]: {
    value: string;
    description: string | null;
    updated_at: string | null;
  };
}

export interface AISuggestionFeedback {
  suggestion_type: string;
  suggestion_data?: any;
  action: 'accepted' | 'dismissed';
  employee_id?: number;
  order_id?: number;
}

export interface AIInsights {
  inventory: {
    pushItems: number;
    avoidItems: number;
    lowIngredients: number;
  };
  suggestions: {
    totalEvents: number;
    accepted: number;
    acceptanceRate: number;
  };
  topItemPairs: Array<{
    item_a_id: number;
    item_b_id: number;
    pair_count: number;
    item_a_name: string;
    item_b_name: string;
  }>;
  recentSnapshots: Array<{
    snapshot_hour: string;
    order_count: number;
    revenue: number;
    avg_ticket: number;
  }>;
  grokStats: {
    enabled: boolean;
    apiKeySet: boolean;
    callsThisHour: number;
    maxCallsPerHour: number;
    model: string;
  };
  aiStatus: {
    initialized: boolean;
    scheduler: {
      running: boolean;
      jobs: Array<{
        name: string;
        intervalMs: number;
        lastRun: string | null;
        runCount: number;
      }>;
    };
  };
}

export interface AIAnalytics {
  period: string;
  byType: Array<{ suggestion_type: string; action: string; count: number }>;
  dailyTrend: Array<{ date: string; action: string; count: number }>;
  aiRevenue: { itemsSold: number; revenue: number };
}

export interface PricingSuggestion {
  id: string;
  type: 'markup' | 'discount';
  menu_item_id: number;
  item_name: string;
  current_price: number;
  suggested_price: number;
  change_percent: number;
  reason: string;
  requires_approval: boolean;
}

export interface InventoryForecast {
  inventory_item_id: number;
  name: string;
  current_quantity: number;
  unit: string;
  category: string;
  avg_daily_usage: number;
  days_until_stockout: number | null;
  days_until_low: number | null;
  suggested_reorder_qty: number | null;
  risk_level: 'critical' | 'high' | 'medium' | 'low' | 'unknown';
  data_days: number;
  message?: string;
}

export interface CategoryRole {
  id: number;
  category_id: number;
  role: string;
  category_name: string;
}

/* Dynamic Pricing Types */
export interface PricingRule {
  id: number;
  name: string;
  rule_type: 'happy_hour' | 'day_of_week' | 'seasonal' | 'demand_based' | 'custom';
  description?: string;
  conditions: Record<string, any>;
  adjustment_type: 'percent' | 'fixed';
  adjustment_value: number;
  applies_to: { scope: 'all' | 'categories' | 'items'; ids?: number[] };
  priority: number;
  max_stack: boolean;
  active: boolean;
  auto_apply: boolean;
  created_by?: number;
  created_by_name?: string;
  created_at: string;
  updated_at: string;
}

export interface PriceHistoryEntry {
  id: number;
  menu_item_id: number;
  item_name?: string;
  old_price: number;
  new_price: number;
  change_percent: number;
  reason?: string;
  source: 'manual' | 'ai_suggestion' | 'scheduled_rule' | 'ab_test' | 'delivery_sync' | 'revert';
  pricing_rule_id?: number;
  experiment_id?: number;
  created_by?: number;
  created_by_name?: string;
  reverted_at?: string;
  reverted_by?: number;
  revenue_before_daily?: number;
  revenue_after_daily?: number;
  created_at: string;
}

export interface PricingExperiment {
  id: number;
  name: string;
  description?: string;
  menu_item_id: number;
  item_name?: string;
  variant_a_price: number;
  variant_b_price: number;
  split_percent: number;
  status: 'draft' | 'running' | 'paused' | 'completed' | 'cancelled';
  start_date?: string;
  end_date?: string;
  results: {
    variant_a?: { orders: number; revenue: number; avg_quantity: number };
    variant_b?: { orders: number; revenue: number; avg_quantity: number };
    winner?: 'a' | 'b' | null;
    confidence?: number;
  };
  created_at: string;
}

export interface PricingGuardrails {
  id: number;
  min_change_percent: number;
  max_change_percent: number;
  max_daily_changes: number;
  require_approval_above: number;
  protected_item_ids: number[];
  notification_email?: string;
  cooldown_hours: number;
  today_changes?: number;
}

export interface GrokPricingSuggestion {
  id: string;
  type: 'markup' | 'discount';
  menu_item_id: number;
  item_name: string;
  current_price: number;
  suggested_price: number;
  change_percent: number;
  confidence: number;
  reasoning?: string;
  reason?: string;
  projected_weekly_revenue_change: number;
  elasticity_estimate?: number;
  source: 'heuristic' | 'grok';
  requires_approval: boolean;
}

export interface PricingDashboard {
  activeRulesCount: number;
  recentChanges: PriceHistoryEntry[];
  totalRevenueImpact: number;
  runningExperiments: number;
  pendingSuggestions: number;
  chartData: Array<{ date: string; revenue: number; changes: number }>;
}

export interface DynamicPricingLimits {
  aiSuggestions: boolean;
  scheduledRules: boolean;
  priceHistory: boolean;
  guardrails: boolean;
  abTesting: boolean;
  deliveryIntegration: boolean;
}

/* Inventory Insights Types */
export interface InventoryInsightsKPIs {
  itemsAtRisk: number;
  criticalCount: number;
  highCount: number;
  prepActionsNeeded: number;
  wasteTrendPercent: number;
  acceptanceRate: number;
}

export interface VelocityDayData {
  date: string;
  quantity_used: number;
  orders_count: number;
}

export interface VelocityChartItem {
  inventory_item_id: number;
  name: string;
  total_used: number;
  daily: VelocityDayData[];
}

export interface WasteAlertData {
  inventory_item_id?: number;
  item_name?: string;
  waste_rate?: number;
  total_waste_cost?: number;
  top_reason?: string;
  message?: string;
  data?: Record<string, unknown>;
  type?: string;
}

export interface WasteDailyTrend {
  date: string;
  total_cost: number;
  entry_count: number;
}

export interface InventoryInsights {
  kpis: InventoryInsightsKPIs;
  forecasts: InventoryForecast[];
  prepForecast: PrepForecast;
  velocityChart: VelocityChartItem[];
  wasteAlerts: WasteAlertData[];
  pushItems: InventoryPushItem[];
  avoidItems: InventoryPushItem[];
  wasteDailyTrend: WasteDailyTrend[];
}

/* Financial Report Types */
export interface CashCardBreakdown {
  period: string;
  total_orders: number;
  total_revenue: number;
  breakdown: Array<{
    payment_method: string;
    count: number;
    total: number;
    tips: number;
    percentage: number;
    revenue_percentage: number;
  }>;
}

export interface COGSReport {
  period: string;
  items: Array<{
    menu_item_id: number;
    item_name: string;
    quantity_sold: number;
    revenue: number;
    cogs: number;
    margin: number;
    margin_percent: number;
  }>;
  totals: {
    total_revenue: number;
    total_cogs: number;
    total_margin: number;
    overall_margin_percent: number;
  };
}

export interface CategoryMargins {
  period: string;
  categories: Array<{
    category_id: number;
    category_name: string;
    quantity_sold: number;
    revenue: number;
    cogs: number;
    margin: number;
    margin_percent: number;
  }>;
}

export interface ContributionMarginReport {
  period: string;
  data: Array<{
    date: string;
    revenue: number;
    cogs: number;
    contribution_margin: number;
    margin_percent: number;
    orders: number;
  }>;
}

export interface LiveDashboardData {
  date: string;
  kpis: {
    order_count: number;
    revenue: number;
    avg_ticket: number;
    tips: number;
    cash_orders: number;
    card_orders: number;
    cash_revenue: number;
    card_revenue: number;
  };
  hourly: Array<{ hour: number; orders: number; revenue: number }>;
  sources: Array<{ source: string; count: number; revenue: number }>;
  topItems: Array<{ item_name: string; qty: number }>;
}

/* Modifier Types */
export interface ModifierGroup {
  id: number;
  name: string;
  selection_type: 'single' | 'multi';
  required: boolean;
  min_selections: number;
  max_selections: number;
  sort_order: number;
  active: boolean;
  modifiers?: Modifier[];
}

export interface Modifier {
  id: number;
  group_id: number;
  name: string;
  price_adjustment: number;
  sort_order: number;
  active: boolean;
}

export interface OrderItemModifier {
  id: number;
  order_item_id: number;
  modifier_id: number;
  modifier_name: string;
  price_adjustment: number;
}

/* Combo Types */
export interface ComboDefinition {
  id: number;
  name: string;
  description: string;
  combo_price: number;
  active: boolean;
  slots?: ComboSlot[];
}

export interface ComboSlot {
  id: number;
  combo_id: number;
  slot_label: string;
  category_id: number | null;
  specific_item_id: number | null;
  sort_order: number;
}

/* Split Payment Types */
export interface OrderPayment {
  id: number;
  order_id: number;
  payment_method: 'card' | 'cash';
  amount: number;
  tip: number;
  payment_intent_id?: string;
  status: string;
}

/* Printer Types */
export interface Printer {
  id: number;
  name: string;
  printer_type: string;
  address: string;
  active: boolean;
}

/* Delivery Types */
export interface DeliveryPlatform {
  id: number;
  name: string;
  display_name: string;
  commission_percent: number;
  active: boolean;
}

export interface DeliveryOrder {
  id: number;
  order_id: number;
  platform_id: number;
  external_order_id: string;
  platform_status: string;
  delivery_fee: number;
  platform_commission: number;
  customer_name: string;
  delivery_address: string;
  created_at?: string;
  platform_name?: string;
  order_number?: string;
  total?: number;
  order_status?: string;
}

/* Refund Types */
export interface Refund {
  id: number;
  order_id: number;
  stripe_refund_id?: string;
  amount: number;
  reason: string;
  refund_type: 'full' | 'partial_items' | 'partial_amount';
  refunded_by?: number;
  refunded_by_name?: string;
  items_json?: string;
  inventory_restored: boolean;
  created_at: string;
}

export interface ReconciliationRow {
  order_id: number;
  order_number: string;
  order_total: number;
  stripe_amount: number;
  stripe_fee: number;
  net_amount: number;
  matched: boolean;
  payment_intent_id: string;
}

export interface PaymentFeeSummary {
  period: string;
  total_revenue: number;
  total_fees: number;
  net_revenue: number;
  fee_percent: number;
  daily: Array<{
    date: string;
    revenue: number;
    fees: number;
    net: number;
    order_count: number;
  }>;
}

export interface RefundSummary {
  total_refunds: number;
  total_refunded_amount: number;
  by_reason: Array<{ reason: string; count: number; amount: number }>;
  by_employee: Array<{ employee_name: string; count: number; amount: number }>;
  daily: Array<{ date: string; count: number; amount: number }>;
}

/* Advanced Inventory Types */
export interface InventoryCount {
  id: number;
  inventory_item_id: number;
  item_name?: string;
  unit?: string;
  counted_quantity: number;
  system_quantity: number;
  variance: number;
  variance_percent: number;
  counted_by?: number;
  counted_by_name?: string;
  notes?: string;
  created_at: string;
}

export interface ShrinkageAlert {
  id: number;
  inventory_item_id: number;
  item_name?: string;
  unit?: string;
  alert_type: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  message: string;
  variance_amount: number;
  acknowledged: boolean;
  acknowledged_by?: number;
  created_at: string;
}

export interface VarianceReport {
  inventory_item_id: number;
  name: string;
  unit: string;
  category: string;
  count_sessions: number;
  avg_variance: number;
  avg_variance_percent: number;
  total_variance: number;
  last_counted: string;
}

export interface Vendor {
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

export interface PurchaseOrder {
  id: number;
  po_number: string;
  vendor_id: number;
  vendor_name?: string;
  status: 'draft' | 'submitted' | 'partial' | 'received' | 'cancelled';
  total_amount: number;
  notes?: string;
  created_by?: number;
  created_by_name?: string;
  submitted_at?: string;
  received_at?: string;
  created_at: string;
  items?: PurchaseOrderItem[];
}

export interface PurchaseOrderItem {
  id: number;
  po_id: number;
  inventory_item_id: number;
  item_name?: string;
  unit?: string;
  quantity_ordered: number;
  unit_cost: number;
  quantity_received: number;
  line_total: number;
}

export interface PrepForecast {
  target_date: string;
  day_of_week: string;
  estimated_orders: number;
  items: Array<{
    inventory_item_id: number;
    item_name: string;
    unit: string;
    expected_quantity_needed: number;
    current_stock: number;
    deficit: number;
    prep_action: 'restock_needed' | 'prep_extra' | 'sufficient';
    velocity_estimate: number;
    menu_items_using: Array<{
      menu_item_name: string;
      avg_sold: number;
      ingredient_per_item: number;
    }>;
  }>;
}

/* Financial Projection Types */
export interface FinancialTargetRow {
  category: string;
  label: string;
  auto_calculated: boolean;
  target_percent: number;
  target_amount: number;
  actual_amount: number;
  diff_amount: number;
  diff_percent: number;
}

export interface FinancialProjection {
  month: string;
  revenue: number;
  rows: FinancialTargetRow[];
  net_profit: number;
  target_net_profit: number;
}

/* Loyalty / CRM Types */
export interface LoyaltyCustomer {
  id: number;
  phone: string;
  name: string;
  referral_code: string;
  referred_by: number | null;
  store_id: number;
  stamps_earned: number;
  orders_count: number;
  total_spent: number;
  last_visit: string | null;
  sms_opt_in: number;
  created_at: string;
  activeCard?: StampCard;
}

export interface StampCard {
  id: number;
  customer_id: number;
  stamps_earned: number;
  stamps_required: number;
  reward_description: string;
  completed: number;
  redeemed: number;
  completed_at: string | null;
  redeemed_at: string | null;
  created_at: string;
}

export interface StampEvent {
  id: number;
  stamp_card_id: number;
  order_id: number | null;
  stamps_added: number;
  event_type: 'purchase' | 'referral_bonus' | 'manual';
  created_at: string;
  stamps_required?: number;
}

export interface ReferralEvent {
  id: number;
  referrer_id: number;
  referee_id: number;
  referrer_stamps_added: number;
  referee_stamps_added: number;
  referrer_name?: string;
  referee_name?: string;
  created_at: string;
}

export interface LoyaltyAnalytics {
  totalMembers: number;
  newThisMonth: number;
  activeCards: number;
  completedCards: number;
  redeemedCards: number;
  redemptionRate: number;
  topCustomers: LoyaltyCustomer[];
  signupsByMonth: Array<{ month: string; count: number }>;
}

export interface LoyaltyConfig {
  [key: string]: {
    value: string;
    description: string | null;
    updated_at: string | null;
  };
}

export interface StampResult {
  stampCard: StampCard;
  cardCompleted: boolean;
  customer: LoyaltyCustomer;
}

/* Order Template Types */
export interface OrderTemplate {
  id: number;
  name: string;
  description?: string;
  items: Array<{ menu_item_id: number; quantity: number }>;
  items_json?: string;
  created_by?: number;
  active: boolean;
  sort_order: number;
  created_at: string;
}

/* Waste Types (already above, but ensure WasteReport is present) */

/* CFDI / Electronic Invoicing Types */
export interface CfdiConfig {
  id: number;
  facturapi_org_id: string | null;
  rfc: string | null;
  legal_name: string | null;
  tax_regime: string | null;
  postal_code: string | null;
  csd_uploaded: boolean;
  csd_valid_until: string | null;
  default_uso_cfdi: string;
  invoice_series: string;
  invoice_link_expiry_hours: number;
  active: boolean;
}

export interface CfdiInvoice {
  id: number;
  order_id: number;
  facturapi_invoice_id: string;
  uuid_fiscal: string;
  series: string;
  folio: string;
  receptor_rfc: string;
  receptor_name: string;
  receptor_uso_cfdi: string;
  subtotal: number;
  tax_total: number;
  total: number;
  forma_pago: string;
  status: 'valid' | 'cancelled' | 'cancellation_pending';
  cancellation_reason: string | null;
  requested_by: 'staff' | 'customer';
  issued_at: string;
  xml_url: string;
  pdf_url: string;
  order_number?: string;
}

export interface CfdiInvoiceToken {
  token: string;
  url: string;
  expires_at: string;
}

export interface CfdiReceptor {
  rfc: string;
  name: string;
  tax_regime: string;
  postal_code: string;
  uso_cfdi: string;
}

export interface SatCatalogItem {
  code: string;
  name: string;
}

export interface CfdiCatalogs {
  taxRegimes: SatCatalogItem[];
  usoCfdi: SatCatalogItem[];
  formaPago: SatCatalogItem[];
  cancellationMotives: SatCatalogItem[];
}

/* Stress Test Types */
export type StressTestTemplateId = 'slow_day' | 'lunch_rush' | 'friday_night' | 'delivery_blitz' | 'breaking_point';

export interface StressTestParam {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
  unit?: string;
}

export interface StressTestTemplate {
  id: StressTestTemplateId;
  name: string;
  description: string;
  icon: string;
  params: StressTestParam[];
}

export interface StressTestConfig {
  templateId: StressTestTemplateId;
  params: Record<string, number>;
}

export interface StressTestProgress {
  phase: string;
  message: string;
  percent: number;
  ordersCreated?: number;
  ordersProcessed?: number;
  errorsCount?: number;
  currentLatencyMs?: number;
}

export interface StressTestLatencyStats {
  avg: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  min: number;
}

export interface StressTestBatchResult {
  batchSize: number;
  avgLatencyMs: number;
  errorRate: number;
}

export interface StressTestResults {
  templateId: StressTestTemplateId;
  templateName: string;
  durationMs: number;
  totalOrders: number;
  posOrders: number;
  deliveryOrders: number;
  ordersCompleted: number;
  ordersFailed: number;
  errorRate: number;
  orderCreationLatency: StressTestLatencyStats;
  kitchenTransitionLatency: StressTestLatencyStats;
  throughputPerMinute: number;
  peakKitchenQueue: number;
  breakingPointBatches?: StressTestBatchResult[];
  recommendations: string[];
}

export interface StressTestResidual {
  orderCount: number;
  totalRevenue: number;
  oldest: string | null;
  newest: string | null;
}

/* Menu Import Types */
export interface MenuTemplateOption {
  id: string;
  name: string;
  description: string;
  icon: string;
  item_count: number;
  category_count: number;
}

export interface MenuImportStats {
  categoriesCreated: number;
  itemsCreated: number;
  inventoryCreated: number;
  recipesCreated: number;
  modifierGroupsCreated: number;
  combosCreated: number;
  skipped: string[];
  warnings: string[];
}

export interface CSVImportPreview {
  detected_columns: string[];
  column_mapping: Record<string, string>;
  detected_categories: string[];
  valid_rows: Array<Record<string, unknown>>;
  invalid_rows: Array<{ row: number; data: Record<string, unknown>; reason: string }>;
  total: number;
  valid_count: number;
  invalid_count: number;
}

/* AI Menu Builder Types */
export interface AIMenuParseResult {
  success: boolean;
  data?: {
    categories: Array<{ name: string; sort_order: number }>;
    items: Array<{ name: string; category: string; price: number; description?: string; prep_time_minutes?: number }>;
    inventory?: Array<{ name: string; unit: string; quantity: number; low_stock_threshold: number; category: string; cost_price: number }>;
    recipes?: Array<{ item_name: string; ingredient_name: string; quantity_used: number }>;
    modifier_groups?: Array<{ name: string; selection_type: string; required: boolean; min_selections: number; max_selections: number; modifiers: Array<{ name: string; price_adjustment: number }>; assign_to_categories: string[] }>;
  };
  error?: string;
  fallback?: boolean;
}

/* AI Assistant Types */
export interface AIAssistantResponse {
  success: boolean;
  answer: string;
  error?: string;
}

/* Menu Engineering Types */
export interface MenuEngineeringItem {
  menu_item_id: number;
  item_name: string;
  category_name: string;
  price: number;
  cogs_per_unit: number;
  contribution_margin: number;
  total_contribution: number;
  quantity_sold: number;
  revenue: number;
  popularity_index: number;
  classification: 'star' | 'workhorse' | 'puzzle' | 'dog';
}

export interface MenuEngineeringReport {
  period: string;
  startDate: string;
  items: MenuEngineeringItem[];
  summary: {
    total_items: number;
    stars: number;
    workhorses: number;
    puzzles: number;
    dogs: number;
    avg_contribution_margin: number;
    avg_popularity_index: number;
    popularity_threshold: number;
    margin_threshold: number;
    total_revenue: number;
    total_contribution: number;
  };
  recommendations: Array<{
    type: 'star' | 'workhorse' | 'puzzle' | 'dog';
    items: string[];
    action: string;
    detail: string;
  }>;
}

/* Settlement Types */
export interface SettlementSummary {
  pending_amount: number;
  pending_count: number;
  month_fees: {
    platform: number;
    processor: number;
    holdback: number;
  };
  last_disbursement: { disbursed_at: string; net_disbursement: number } | null;
  next_disbursement: { settlement_date: string; net_disbursement: number } | null;
}

export interface DisbursementRecord {
  id: number;
  settlement_date: string;
  gross_amount: number;
  processor_fee: number;
  platform_fee: number;
  mca_holdback: number;
  net_disbursement: number;
  disbursement_status: string;
  disbursed_at: string | null;
  disbursement_reference: string | null;
}

export interface SettlementStatement {
  month: string;
  lines: DisbursementRecord[];
  totals: {
    gross: number;
    processor_fee: number;
    platform_fee: number;
    holdback: number;
    net: number;
    transactions: number;
  };
}

export interface MerchantBankAccount {
  id: number;
  clabe: string;
  bank_name: string;
  bank_code: string;
  beneficiary_name: string;
  alias: string | null;
  is_primary: boolean;
  verified: boolean;
  verified_at: string | null;
  created_at: string;
}

export interface MerchantAdvance {
  id: number;
  tenant_id: string;
  offer_id: number;
  advance_amount: number;
  factor_rate: number;
  total_repayment: number;
  holdback_percent: number;
  total_repaid: number;
  remaining_balance: number;
  status: string;
  disbursement_reference: string | null;
  disbursed_at: string | null;
  completed_at: string | null;
  estimated_completion_date: string | null;
  risk_status: string;
  risk_flags: Array<{ type: string; detail: string }>;
  created_at: string;
  tenant_name?: string;
}

export interface MCARepayment {
  id: number;
  advance_id: number;
  settlement_date: string;
  holdback_percent: number;
  holdback_amount: number;
  cumulative_repaid: number;
  remaining_after: number;
  created_at: string;
}

export interface SettlementBatch {
  id: number;
  batch_reference: string;
  settlement_date: string;
  total_gross: number;
  total_fees: number;
  total_net: number;
  transaction_count: number;
  status: string;
  processed_at: string | null;
  created_at: string;
}

export interface SettlementLine {
  id: number;
  batch_id: number;
  tenant_id: string;
  tenant_name?: string;
  settlement_date: string;
  gross_amount: number;
  processor_fee: number;
  platform_fee: number;
  mca_holdback: number;
  net_disbursement: number;
  transaction_count: number;
  disbursement_status: string;
  disbursement_reference: string | null;
  disbursed_at: string | null;
  hold_reason: string | null;
  bank_name?: string;
  clabe?: string;
}

export interface HoldingLedgerEntry {
  id: number;
  entry_type: string;
  tenant_id: string | null;
  tenant_name?: string;
  reference_type: string | null;
  reference_id: number | null;
  debit: number;
  credit: number;
  balance_after: number;
  description: string | null;
  created_at: string;
}

export interface CapitalPool {
  total_capital: number;
  deployed: number;
  available: number;
  total_returned: number;
  updated_at: string;
}

export interface SettlementOverview {
  holding_balance: number;
  pending_disbursement: number;
  pending_count: number;
  month_platform_fees: number;
  month_processor_fees: number;
  mca: {
    active_advances: number;
    total_outstanding: number;
    total_repaid: number;
  };
  capital_pool: CapitalPool | null;
}

/* API Response Types */
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}
