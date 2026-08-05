-- =============================================================
-- POS Lite — Lean Postgres Schema (Neon)
-- Multi-tenant via tenant_id + Row-Level Security
-- Stripped: AI tables, banking, pricing experiments, financing
-- =============================================================

-- ==================== Platform Tables (no RLS) ====================

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  subdomain TEXT UNIQUE,
  plan TEXT DEFAULT 'free',
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  subscription_status TEXT DEFAULT 'active',
  subscription_cancelled_at TIMESTAMPTZ,
  owner_email TEXT NOT NULL,
  owner_password_hash TEXT NOT NULL,
  branding_json TEXT,
  active BOOLEAN DEFAULT true,
  reset_token TEXT,
  reset_token_expires TIMESTAMPTZ,
  mp_access_token TEXT,
  mp_refresh_token TEXT,
  mp_user_id TEXT,
  mp_token_expires_at TIMESTAMPTZ,
  mp_default_terminal_id TEXT,
  signup_promo_code TEXT DEFAULT NULL,
  trial_ends_at TIMESTAMPTZ,
  trial_reminder_sent_at TIMESTAMPTZ,
  trial_ended_notified_at TIMESTAMPTZ,
  timezone TEXT NOT NULL DEFAULT 'America/Mexico_City',
  kiosk_mode TEXT DEFAULT 'grid',
  inventory_mode TEXT NOT NULL DEFAULT 'ingredients'
    CHECK (inventory_mode IN ('ingredients', 'two_stage')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_owner_email ON tenants(owner_email);
CREATE INDEX IF NOT EXISTS idx_tenants_reset_token ON tenants(reset_token) WHERE reset_token IS NOT NULL;

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TIMESTAMPTZ DEFAULT NOW()
);

-- ==================== Tenant-Scoped Tables ====================

CREATE TABLE IF NOT EXISTS employees (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
  name TEXT NOT NULL,
  pin TEXT NOT NULL,
  role TEXT DEFAULT 'cashier',
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Time clock: payroll-grade shift tracking. One row per clock-in/out pair.
-- clock_out_at NULL = currently on shift. Rows open >12h are flagged in UI.
CREATE TABLE IF NOT EXISTS shifts (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  clock_in_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  clock_out_at TIMESTAMPTZ,
  notes TEXT,
  edited_by_employee_id INTEGER REFERENCES employees(id),
  edited_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shifts_tenant_employee ON shifts(tenant_id, employee_id, clock_in_at DESC);
CREATE INDEX IF NOT EXISTS idx_shifts_open ON shifts(tenant_id, clock_out_at) WHERE clock_out_at IS NULL;

CREATE TABLE IF NOT EXISTS cash_drawer_sessions (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
  shift_id INTEGER NOT NULL UNIQUE REFERENCES shifts(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  opening_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  opening_total NUMERIC(10,2) NOT NULL DEFAULT 0,
  closing_counts JSONB,
  closing_total NUMERIC(10,2),
  expected_cash_total NUMERIC(10,2),
  variance_total NUMERIC(10,2),
  variance_note TEXT,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cash_paid_outs (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
  shift_id INTEGER REFERENCES shifts(id) ON DELETE SET NULL,
  drawer_session_id INTEGER REFERENCES cash_drawer_sessions(id) ON DELETE SET NULL,
  by_employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  amount_out NUMERIC(10,2) NOT NULL CHECK (amount_out > 0),
  change_returned NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (change_returned >= 0),
  net_amount NUMERIC(10,2) GENERATED ALWAYS AS (amount_out - change_returned) STORED,
  payee TEXT,
  reason TEXT NOT NULL DEFAULT 'other',
  notes TEXT,
  receipt_image_url TEXT,
  no_receipt BOOLEAN NOT NULL DEFAULT false,
  source TEXT NOT NULL DEFAULT 'pos',
  voided_at TIMESTAMPTZ,
  voided_by_employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  void_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (change_returned <= amount_out)
);

CREATE TABLE IF NOT EXISTS menu_categories (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
  name TEXT NOT NULL,
  sort_order INTEGER,
  active BOOLEAN DEFAULT true,
  printer_target TEXT DEFAULT 'kitchen'
);

CREATE TABLE IF NOT EXISTS menu_items (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
  category_id INTEGER NOT NULL REFERENCES menu_categories(id),
  name TEXT NOT NULL,
  price NUMERIC(10,2) NOT NULL,
  description TEXT,
  image_url TEXT,
  sort_order INTEGER DEFAULT 0,
  active BOOLEAN DEFAULT true,
  prep_time_minutes INTEGER DEFAULT 5,
  is_example BOOLEAN DEFAULT false
);

CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
  order_number BIGINT NOT NULL,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  status TEXT DEFAULT 'pending',
  subtotal NUMERIC(10,2),
  tax NUMERIC(10,2),
  tip NUMERIC(10,2) DEFAULT 0,
  total NUMERIC(10,2),
  payment_intent_id TEXT,
  payment_status TEXT DEFAULT 'unpaid',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  offline_temp_id TEXT,
  payment_method TEXT DEFAULT NULL,
  source TEXT DEFAULT 'pos',
  delivery_order_id INTEGER DEFAULT NULL,
  refund_total NUMERIC(10,2) DEFAULT 0,
  loyalty_customer_id INTEGER DEFAULT NULL,
  cfdi_invoice_id INTEGER,
  invoice_token TEXT,
  paid_at TIMESTAMPTZ DEFAULT NULL,
  mp_order_id TEXT,
  ready_at TIMESTAMPTZ,
  estimated_ready_minutes INTEGER,
  discount_amount NUMERIC(10,2) DEFAULT 0,
  discount_type TEXT,
  discount_reason TEXT,
  discount_authorized_by INTEGER REFERENCES employees(id),
  customer_call_name TEXT,
  order_fulfillment_type TEXT DEFAULT 'to_go',
  manual_batch_id INTEGER DEFAULT NULL
);

CREATE TABLE IF NOT EXISTS order_items (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
  order_id INTEGER NOT NULL REFERENCES orders(id),
  menu_item_id INTEGER REFERENCES menu_items(id),
  item_name TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  unit_price NUMERIC(10,2) NOT NULL,
  notes TEXT,
  combo_instance_id TEXT DEFAULT NULL,
  virtual_brand_id INTEGER DEFAULT NULL,
  discount_amount NUMERIC(10,2) DEFAULT 0,
  discount_type TEXT,
  discount_reason TEXT,
  discount_authorized_by INTEGER REFERENCES employees(id),
  -- edit tracking (migration 0063): allows append / qty-change / soft-void
  -- on a sent order while keeping the KDS audit trail intact.
  added_at TIMESTAMPTZ,
  voided_at TIMESTAMPTZ,
  voided_by INTEGER REFERENCES employees(id),
  void_reason TEXT,
  qty_changed_at TIMESTAMPTZ,
  original_quantity INTEGER
);

-- Two layers live in this table, told apart by `kind` (migration 0103):
--   'raw'       walk-in / dry storage. Stocked by receipts. Never gates the menu.
--   'component' line inventory, counted in portions. Produced by prep runs;
--               menu availability derives from it.
-- quantity stays REAL deliberately — see the header comment in
-- migrations/0103_two_stage_inventory.js before changing it.
CREATE TABLE IF NOT EXISTS inventory_items (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
  name TEXT NOT NULL,
  quantity REAL NOT NULL,
  unit TEXT,
  low_stock_threshold REAL,
  category TEXT,
  cost_price NUMERIC(10,2) DEFAULT 0,
  last_counted_at TIMESTAMPTZ,
  kind TEXT NOT NULL DEFAULT 'raw' CHECK (kind IN ('raw', 'component')),
  low_threshold_portions NUMERIC(10,2),
  auto_86 BOOLEAN NOT NULL DEFAULT true,
  sold_out_manual BOOLEAN NOT NULL DEFAULT false,
  -- Perishable: the end-of-day count offers a one-tap discard instead of
  -- carrying it over (migration 0104).
  discard_on_close BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS menu_item_ingredients (
  tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
  menu_item_id INTEGER NOT NULL REFERENCES menu_items(id),
  inventory_item_id INTEGER NOT NULL REFERENCES inventory_items(id),
  quantity_used REAL NOT NULL,
  PRIMARY KEY(menu_item_id, inventory_item_id)
);

-- Modifiers
CREATE TABLE IF NOT EXISTS modifier_groups (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
  name TEXT NOT NULL,
  selection_type TEXT DEFAULT 'single',
  required BOOLEAN DEFAULT false,
  min_selections INTEGER DEFAULT 0,
  max_selections INTEGER DEFAULT 1,
  sort_order INTEGER DEFAULT 0,
  active BOOLEAN DEFAULT true
);

CREATE TABLE IF NOT EXISTS modifiers (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
  group_id INTEGER NOT NULL REFERENCES modifier_groups(id),
  name TEXT NOT NULL,
  price_adjustment NUMERIC(10,2) DEFAULT 0,
  sort_order INTEGER DEFAULT 0,
  active BOOLEAN DEFAULT true,
  image_url TEXT
);

CREATE TABLE IF NOT EXISTS menu_item_modifier_groups (
  tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
  menu_item_id INTEGER NOT NULL REFERENCES menu_items(id),
  modifier_group_id INTEGER NOT NULL REFERENCES modifier_groups(id),
  sort_order INTEGER DEFAULT 0,
  PRIMARY KEY(menu_item_id, modifier_group_id)
);

CREATE TABLE IF NOT EXISTS order_item_modifiers (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
  order_item_id INTEGER NOT NULL REFERENCES order_items(id),
  modifier_id INTEGER,
  modifier_name TEXT NOT NULL,
  price_adjustment NUMERIC(10,2) DEFAULT 0
);

-- Combos
CREATE TABLE IF NOT EXISTS combo_definitions (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
  name TEXT NOT NULL,
  description TEXT,
  combo_price NUMERIC(10,2) NOT NULL,
  active BOOLEAN DEFAULT true
);

CREATE TABLE IF NOT EXISTS combo_slots (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
  combo_id INTEGER NOT NULL REFERENCES combo_definitions(id),
  slot_label TEXT NOT NULL,
  category_id INTEGER REFERENCES menu_categories(id),
  specific_item_id INTEGER REFERENCES menu_items(id),
  sort_order INTEGER DEFAULT 0
);

-- Payments
CREATE TABLE IF NOT EXISTS order_payments (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
  order_id INTEGER NOT NULL REFERENCES orders(id),
  payment_method TEXT NOT NULL,
  amount NUMERIC(10,2) NOT NULL,
  tip NUMERIC(10,2) DEFAULT 0,
  payment_intent_id TEXT,
  status TEXT DEFAULT 'pending',
  processor_fee NUMERIC(10,2),
  processor_net NUMERIC(10,2),
  processor_response JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS order_payment_items (
  tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
  payment_id INTEGER NOT NULL REFERENCES order_payments(id),
  order_item_id INTEGER NOT NULL REFERENCES order_items(id),
  amount NUMERIC(10,2) NOT NULL,
  PRIMARY KEY(payment_id, order_item_id)
);

-- Printers
CREATE TABLE IF NOT EXISTS printers (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
  name TEXT NOT NULL,
  printer_type TEXT DEFAULT 'kitchen',
  address TEXT,
  active BOOLEAN DEFAULT true
);

CREATE TABLE IF NOT EXISTS category_printer_routes (
  tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
  category_id INTEGER NOT NULL REFERENCES menu_categories(id),
  printer_id INTEGER NOT NULL REFERENCES printers(id),
  PRIMARY KEY(category_id, printer_id)
);

-- Print jobs — queue consumed by the on-site print bridge (see /print-bridge)
CREATE TABLE IF NOT EXISTS print_jobs (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
  order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  printer_id INTEGER REFERENCES printers(id) ON DELETE SET NULL,
  job_type TEXT NOT NULL DEFAULT 'kitchen',
  source TEXT,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  claimed_by TEXT,
  claimed_at TIMESTAMPTZ,
  printed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_print_jobs_tenant_status ON print_jobs(tenant_id, status, id);

-- Delivery
CREATE TABLE IF NOT EXISTS delivery_platforms (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
  name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  webhook_secret TEXT,
  commission_percent REAL DEFAULT 0,
  active BOOLEAN DEFAULT true,
  default_markup_percent REAL DEFAULT 0,
  avg_delivery_time_min INTEGER DEFAULT 30,
  notes TEXT DEFAULT '',
  UNIQUE(tenant_id, name)
);

CREATE TABLE IF NOT EXISTS delivery_orders (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
  order_id INTEGER NOT NULL REFERENCES orders(id),
  platform_id INTEGER NOT NULL REFERENCES delivery_platforms(id),
  external_order_id TEXT,
  platform_status TEXT DEFAULT 'received',
  delivery_fee NUMERIC(10,2) DEFAULT 0,
  platform_commission NUMERIC(10,2) DEFAULT 0,
  customer_name TEXT,
  delivery_address TEXT,
  tracking_url TEXT,
  courier_name TEXT,
  courier_phone TEXT,
  courier_vehicle TEXT,
  raw_webhook_data TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Manual / imported sales entry (migration 0091). Header row for a batch of
-- orders that were recorded by hand or imported from a delivery platform's
-- settlement export, rather than rung up on the POS. Every order created this
-- way carries orders.manual_batch_id pointing here, so an entry can be
-- reversed as a unit. See server/routes/manual-sales.js.
CREATE TABLE IF NOT EXISTS manual_sales_batches (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
  channel TEXT NOT NULL,
  platform_id INTEGER REFERENCES delivery_platforms(id),
  entry_mode TEXT NOT NULL DEFAULT 'aggregate',
  business_date DATE NOT NULL,
  order_count INTEGER NOT NULL DEFAULT 1,
  gross_total NUMERIC(10,2) NOT NULL DEFAULT 0,
  commission_total NUMERIC(10,2) NOT NULL DEFAULT 0,
  net_total NUMERIC(10,2) NOT NULL DEFAULT 0,
  commission_percent REAL DEFAULT 0,
  source_filename TEXT,
  note TEXT,
  created_by INTEGER REFERENCES employees(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS delivery_markup_rules (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
  platform_id INTEGER NOT NULL REFERENCES delivery_platforms(id),
  menu_item_id INTEGER REFERENCES menu_items(id),
  category_id INTEGER REFERENCES menu_categories(id),
  markup_type TEXT NOT NULL DEFAULT 'percent',
  markup_value REAL NOT NULL DEFAULT 0,
  active BOOLEAN DEFAULT true,
  UNIQUE(tenant_id, platform_id, menu_item_id),
  UNIQUE(tenant_id, platform_id, category_id)
);

CREATE TABLE IF NOT EXISTS virtual_brands (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
  name TEXT NOT NULL,
  platform_id INTEGER REFERENCES delivery_platforms(id),
  description TEXT,
  logo_url TEXT,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  display_type TEXT DEFAULT 'delivery',
  primary_color TEXT,
  secondary_color TEXT,
  font_family TEXT,
  dark_bg TEXT,
  slug TEXT,
  show_in_pos BOOLEAN DEFAULT true,
  template_slug TEXT DEFAULT NULL,
  board_settings JSONB DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS virtual_brand_items (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
  virtual_brand_id INTEGER NOT NULL REFERENCES virtual_brands(id),
  menu_item_id INTEGER NOT NULL REFERENCES menu_items(id),
  custom_name TEXT,
  custom_price NUMERIC(10,2),
  active BOOLEAN DEFAULT true,
  show_image BOOLEAN DEFAULT true,
  UNIQUE(tenant_id, virtual_brand_id, menu_item_id)
);

CREATE TABLE IF NOT EXISTS display_assets (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
  kind TEXT NOT NULL,
  title TEXT,
  body TEXT,
  image_url TEXT,
  sort_order INTEGER DEFAULT 0,
  active BOOLEAN DEFAULT true,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Permissions
CREATE TABLE IF NOT EXISTS role_permissions (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
  role TEXT NOT NULL,
  permission TEXT NOT NULL,
  granted BOOLEAN DEFAULT true,
  UNIQUE(tenant_id, role, permission)
);

-- Refunds
CREATE TABLE IF NOT EXISTS refunds (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
  order_id INTEGER NOT NULL REFERENCES orders(id),
  stripe_refund_id TEXT,
  -- Conekta was dropped 2026-07-16; the column stays for historical rows.
  conekta_refund_id TEXT,
  getnet_refund_id TEXT,
  amount NUMERIC(10,2) NOT NULL,
  reason TEXT,
  refund_type TEXT DEFAULT 'full',
  refunded_by INTEGER REFERENCES employees(id),
  items_json TEXT,
  inventory_restored BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Inventory Counts
CREATE TABLE IF NOT EXISTS inventory_counts (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
  inventory_item_id INTEGER NOT NULL REFERENCES inventory_items(id),
  counted_quantity REAL NOT NULL,
  system_quantity REAL NOT NULL,
  variance REAL NOT NULL,
  variance_percent REAL,
  counted_by INTEGER REFERENCES employees(id),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS shrinkage_alerts (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
  inventory_item_id INTEGER NOT NULL REFERENCES inventory_items(id),
  alert_type TEXT NOT NULL,
  severity TEXT DEFAULT 'medium',
  message TEXT,
  variance_amount REAL,
  acknowledged BOOLEAN DEFAULT false,
  acknowledged_by INTEGER REFERENCES employees(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Vendors & Purchase Orders
CREATE TABLE IF NOT EXISTS vendors (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
  name TEXT NOT NULL,
  contact_name TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  notes TEXT,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS vendor_items (
  tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
  vendor_id INTEGER NOT NULL REFERENCES vendors(id),
  inventory_item_id INTEGER NOT NULL REFERENCES inventory_items(id),
  vendor_sku TEXT,
  unit_cost NUMERIC(10,2) DEFAULT 0,
  lead_time_days INTEGER DEFAULT 0,
  min_order_qty REAL DEFAULT 1,
  PRIMARY KEY(vendor_id, inventory_item_id)
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
  po_number TEXT NOT NULL,
  vendor_id INTEGER NOT NULL REFERENCES vendors(id),
  status TEXT DEFAULT 'draft',
  total_amount NUMERIC(10,2) DEFAULT 0,
  notes TEXT,
  created_by INTEGER REFERENCES employees(id),
  submitted_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tenant_id, po_number)
);

CREATE TABLE IF NOT EXISTS purchase_order_items (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
  po_id INTEGER NOT NULL REFERENCES purchase_orders(id),
  inventory_item_id INTEGER NOT NULL REFERENCES inventory_items(id),
  quantity_ordered REAL NOT NULL,
  unit_cost NUMERIC(10,2) DEFAULT 0,
  quantity_received REAL DEFAULT 0,
  line_total NUMERIC(10,2) DEFAULT 0
);

-- Two-stage inventory: prep runs + portion ledger (migration 0103).
-- Prep runs are the event that converts raw stock into sellable portions and,
-- because inputs snapshot their cost, they yield true cost-per-portion and
-- yield % without any extra bookkeeping.
CREATE TABLE IF NOT EXISTS prep_runs (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
  prepped_at TIMESTAMPTZ DEFAULT NOW(),
  employee_id INTEGER REFERENCES employees(id),
  notes TEXT
);

CREATE TABLE IF NOT EXISTS prep_run_inputs (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
  prep_run_id INTEGER NOT NULL REFERENCES prep_runs(id) ON DELETE CASCADE,
  inventory_item_id INTEGER NOT NULL REFERENCES inventory_items(id),
  quantity NUMERIC(12,4) NOT NULL CHECK (quantity > 0),
  cost_at_time NUMERIC(12,4)
);

CREATE TABLE IF NOT EXISTS prep_run_outputs (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
  prep_run_id INTEGER NOT NULL REFERENCES prep_runs(id) ON DELETE CASCADE,
  inventory_item_id INTEGER NOT NULL REFERENCES inventory_items(id),
  portions NUMERIC(10,2) NOT NULL CHECK (portions > 0)
);

-- Append-only. inventory_items.quantity is a cache over this table: the cache
-- clamps at 0, the ledger keeps the unclamped truth so overselling stays
-- visible as variance. ref_id carries no FK on purpose — orders are
-- hard-deletable and the record of what a sale consumed must outlive them.
-- app_user's UPDATE/TRUNCATE are REVOKEd in migration 0103 (the default ACL
-- grants them automatically, so a GRANT alone is a no-op). DELETE is retained
-- for the admin inventory reset.
CREATE TABLE IF NOT EXISTS portion_ledger (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
  inventory_item_id INTEGER NOT NULL REFERENCES inventory_items(id),
  delta NUMERIC(12,4) NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN (
    'purchase', 'prep_consume', 'prep_produce', 'sale',
    'refund_restore', 'void_restore', 'waste',
    'count_adjust', 'carryover_discard')),
  ref_type TEXT,
  ref_id INTEGER,
  employee_id INTEGER REFERENCES employees(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Financials
CREATE TABLE IF NOT EXISTS financial_targets (
  tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
  category TEXT NOT NULL,
  target_percent REAL NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ,
  PRIMARY KEY(tenant_id, category)
);

CREATE TABLE IF NOT EXISTS financial_actuals (
  tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
  category TEXT NOT NULL,
  period TEXT NOT NULL,
  amount NUMERIC(10,2) NOT NULL DEFAULT 0,
  auto_calculated BOOLEAN DEFAULT false,
  UNIQUE(tenant_id, category, period)
);

-- Loyalty
CREATE TABLE IF NOT EXISTS loyalty_customers (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
  phone TEXT NOT NULL,
  country_code TEXT NOT NULL DEFAULT 'MX',
  name TEXT NOT NULL,
  referral_code TEXT,
  referred_by INTEGER REFERENCES loyalty_customers(id),
  store_id INTEGER DEFAULT 1,
  stamps_earned INTEGER DEFAULT 0,
  orders_count INTEGER DEFAULT 0,
  total_spent NUMERIC(10,2) DEFAULT 0,
  last_visit TIMESTAMPTZ,
  sms_opt_in BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tenant_id, country_code, phone),
  UNIQUE(tenant_id, referral_code)
);

CREATE TABLE IF NOT EXISTS stamp_cards (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
  customer_id INTEGER NOT NULL REFERENCES loyalty_customers(id),
  stamps_earned INTEGER DEFAULT 0,
  stamps_required INTEGER DEFAULT 10,
  reward_description TEXT DEFAULT 'Free item of your choice',
  completed BOOLEAN DEFAULT false,
  redeemed BOOLEAN DEFAULT false,
  completed_at TIMESTAMPTZ,
  redeemed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS stamp_events (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
  stamp_card_id INTEGER NOT NULL REFERENCES stamp_cards(id),
  order_id INTEGER REFERENCES orders(id),
  stamps_added INTEGER NOT NULL,
  event_type TEXT DEFAULT 'purchase',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS referral_events (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
  referrer_id INTEGER NOT NULL REFERENCES loyalty_customers(id),
  referee_id INTEGER NOT NULL REFERENCES loyalty_customers(id),
  referrer_stamps_added INTEGER DEFAULT 0,
  referee_stamps_added INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS loyalty_messages (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
  customer_id INTEGER NOT NULL REFERENCES loyalty_customers(id),
  message_type TEXT NOT NULL,
  twilio_sid TEXT,
  status TEXT DEFAULT 'sent',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS loyalty_config (
  tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  description TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY(tenant_id, key)
);

-- Wallet Passes (Apple/Google Wallet display layer for loyalty)
CREATE TABLE IF NOT EXISTS wallet_passes (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
  customer_id INTEGER NOT NULL REFERENCES loyalty_customers(id),
  platform TEXT NOT NULL CHECK (platform IN ('apple', 'google')),
  serial_number TEXT NOT NULL UNIQUE,
  auth_token TEXT NOT NULL,
  enroll_token TEXT UNIQUE,
  revoked BOOLEAN DEFAULT false,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tenant_id, customer_id, platform)
);

CREATE TABLE IF NOT EXISTS wallet_registrations (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
  pass_id INTEGER NOT NULL REFERENCES wallet_passes(id) ON DELETE CASCADE,
  device_library_id TEXT NOT NULL,
  push_token TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(pass_id, device_library_id)
);

-- Order Templates
CREATE TABLE IF NOT EXISTS order_templates (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
  name TEXT NOT NULL,
  description TEXT,
  items_json TEXT NOT NULL,
  created_by INTEGER,
  active BOOLEAN DEFAULT true,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Waste Log
CREATE TABLE IF NOT EXISTS waste_log (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
  inventory_item_id INTEGER NOT NULL REFERENCES inventory_items(id),
  quantity REAL NOT NULL CHECK (quantity > 0),
  unit TEXT,
  reason TEXT NOT NULL CHECK (reason IN ('spoilage','prep_error','dropped','expired','other')),
  cost_at_time NUMERIC(10,2) DEFAULT 0,
  notes TEXT,
  logged_by INTEGER REFERENCES employees(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- CFDI Invoicing
CREATE TABLE IF NOT EXISTS cfdi_config (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL UNIQUE,
  facturapi_org_id TEXT,
  rfc TEXT,
  legal_name TEXT,
  tax_regime TEXT,
  postal_code TEXT,
  csd_uploaded BOOLEAN DEFAULT false,
  csd_valid_until TIMESTAMPTZ,
  default_uso_cfdi TEXT DEFAULT 'G03',
  invoice_series TEXT DEFAULT 'DK',
  invoice_link_expiry_hours INTEGER DEFAULT 72,
  active BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cfdi_invoices (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
  order_id INTEGER NOT NULL,
  facturapi_invoice_id TEXT NOT NULL UNIQUE,
  uuid_fiscal TEXT,
  series TEXT,
  folio TEXT,
  cfdi_type TEXT DEFAULT 'I',
  receptor_rfc TEXT NOT NULL,
  receptor_name TEXT NOT NULL,
  receptor_tax_regime TEXT,
  receptor_postal_code TEXT,
  receptor_uso_cfdi TEXT DEFAULT 'G03',
  subtotal NUMERIC(12,2),
  tax_total NUMERIC(12,2),
  total NUMERIC(12,2),
  forma_pago TEXT,
  metodo_pago TEXT DEFAULT 'PUE',
  xml_url TEXT,
  pdf_url TEXT,
  status TEXT DEFAULT 'valid',
  cancellation_reason TEXT,
  cancelled_at TIMESTAMPTZ,
  substitute_invoice_id INTEGER,
  requested_by TEXT DEFAULT 'staff',
  issued_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cfdi_invoice_tokens (
  id SERIAL PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL,
  order_id INTEGER NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used BOOLEAN DEFAULT false,
  used_at TIMESTAMPTZ,
  cfdi_invoice_id INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Receipt Tokens (public-link SMS receipts)
CREATE TABLE IF NOT EXISTS receipt_tokens (
  id SERIAL PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL,
  order_id INTEGER NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Tenant Credentials
CREATE TABLE IF NOT EXISTS tenant_credentials (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  service TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tenant_id, service, key)
);

-- Audit Log (no RLS)
CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  resource TEXT NOT NULL,
  resource_id TEXT,
  details JSONB,
  ip_address TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Expenses
CREATE TABLE IF NOT EXISTS expenses (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
  category TEXT NOT NULL,
  amount NUMERIC(10,2) NOT NULL,
  description TEXT,
  payee TEXT,
  receipt_url TEXT,
  expense_date DATE DEFAULT CURRENT_DATE,
  created_by INTEGER REFERENCES employees(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Kiosk device rows: created by /api/kiosk/bind when caller sends device_name.
-- kiosk_mode_override lets us flip ONE device to wizard while other devices on
-- the same tenant stay on their tenant.kiosk_mode default. See migration 0092.
CREATE TABLE IF NOT EXISTS kiosk_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
  name TEXT NOT NULL,
  bound_employee_id INTEGER,
  kiosk_mode_override TEXT,
  bound_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ,
  -- Build this device last reported (see POST /api/kiosk/heartbeat). Android
  -- APK kiosks are frozen between rebuilds, so this is how a stale tablet
  -- becomes visible without walking up to it.
  client_version TEXT,
  client_platform TEXT,
  revoked_at TIMESTAMPTZ,
  CONSTRAINT kiosk_devices_mode_override_valid
    CHECK (kiosk_mode_override IS NULL OR kiosk_mode_override IN ('grid', 'wizard'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_kiosk_devices_tenant_name_active
  ON kiosk_devices (tenant_id, name) WHERE revoked_at IS NULL;

-- Slug → menu_item_id map for the burrito-builder wizard. Decouples the
-- wizard's protein knobs from item names so a rename in Menu Management
-- doesn't break the flow. Populated by scripts/seed-builder-menu.mjs.
CREATE TABLE IF NOT EXISTS kiosk_builder_map (
  tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
  slug TEXT NOT NULL,
  menu_item_id INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  PRIMARY KEY (tenant_id, slug)
);

-- Curated sides / drinks for the wizard's "¿Deseas agregar algo?" step. An
-- allowlist rather than a category read: juanbertos keeps `Orden Papas` in
-- `otros` next to $299 fries entrées and a bookkeeping row, so a category
-- would pull entrées into an upsell strip. Rows are ordinary active menu
-- items and go through the normal cart path as their own lines.
CREATE TABLE IF NOT EXISTS kiosk_addon_map (
  tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
  section TEXT NOT NULL,
  menu_item_id INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, section, menu_item_id),
  CONSTRAINT kiosk_addon_map_section_valid CHECK (section IN ('side', 'drink'))
);

-- ==================== Indexes ====================

CREATE INDEX IF NOT EXISTS idx_employees_tenant ON employees(tenant_id);
CREATE INDEX IF NOT EXISTS idx_menu_categories_tenant ON menu_categories(tenant_id);
CREATE INDEX IF NOT EXISTS idx_menu_items_tenant ON menu_items(tenant_id);
CREATE INDEX IF NOT EXISTS idx_menu_items_category ON menu_items(tenant_id, category_id);
CREATE INDEX IF NOT EXISTS idx_menu_items_category_sort ON menu_items(tenant_id, category_id, sort_order, id);
CREATE INDEX IF NOT EXISTS idx_orders_tenant ON orders(tenant_id);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_orders_employee ON orders(tenant_id, employee_id);
CREATE INDEX IF NOT EXISTS idx_order_items_tenant ON order_items(tenant_id);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(tenant_id, order_id);
CREATE INDEX IF NOT EXISTS idx_inventory_items_tenant ON inventory_items(tenant_id);
CREATE INDEX IF NOT EXISTS idx_modifier_groups_tenant ON modifier_groups(tenant_id);
CREATE INDEX IF NOT EXISTS idx_modifiers_tenant ON modifiers(tenant_id);
CREATE INDEX IF NOT EXISTS idx_modifiers_group ON modifiers(tenant_id, group_id);
CREATE INDEX IF NOT EXISTS idx_order_item_modifiers_tenant ON order_item_modifiers(tenant_id);
CREATE INDEX IF NOT EXISTS idx_combo_definitions_tenant ON combo_definitions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_combo_slots_tenant ON combo_slots(tenant_id);
CREATE INDEX IF NOT EXISTS idx_order_payments_tenant ON order_payments(tenant_id);
CREATE INDEX IF NOT EXISTS idx_order_payments_order ON order_payments(tenant_id, order_id);
CREATE INDEX IF NOT EXISTS idx_cash_drawer_sessions_tenant ON cash_drawer_sessions(tenant_id, opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_cash_drawer_sessions_shift ON cash_drawer_sessions(tenant_id, shift_id);
CREATE INDEX IF NOT EXISTS idx_cash_paid_outs_tenant_created ON cash_paid_outs(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cash_paid_outs_shift ON cash_paid_outs(tenant_id, shift_id) WHERE voided_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_cash_paid_outs_drawer ON cash_paid_outs(tenant_id, drawer_session_id) WHERE voided_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_printers_tenant ON printers(tenant_id);
CREATE INDEX IF NOT EXISTS idx_delivery_platforms_tenant ON delivery_platforms(tenant_id);
CREATE INDEX IF NOT EXISTS idx_delivery_orders_tenant ON delivery_orders(tenant_id);
CREATE INDEX IF NOT EXISTS idx_delivery_markup_rules_tenant ON delivery_markup_rules(tenant_id);
CREATE INDEX IF NOT EXISTS idx_virtual_brands_tenant ON virtual_brands(tenant_id);
CREATE INDEX IF NOT EXISTS idx_virtual_brand_items_tenant ON virtual_brand_items(tenant_id);
CREATE INDEX IF NOT EXISTS idx_role_permissions_tenant ON role_permissions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_role_permissions_role ON role_permissions(tenant_id, role);
CREATE INDEX IF NOT EXISTS idx_refunds_tenant ON refunds(tenant_id);
CREATE INDEX IF NOT EXISTS idx_refunds_order ON refunds(tenant_id, order_id);
CREATE INDEX IF NOT EXISTS idx_inventory_counts_tenant ON inventory_counts(tenant_id);
CREATE INDEX IF NOT EXISTS idx_shrinkage_alerts_tenant ON shrinkage_alerts(tenant_id);
CREATE INDEX IF NOT EXISTS idx_vendors_tenant ON vendors(tenant_id);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_tenant ON purchase_orders(tenant_id);
CREATE INDEX IF NOT EXISTS idx_purchase_order_items_tenant ON purchase_order_items(tenant_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_customers_tenant ON loyalty_customers(tenant_id);
CREATE INDEX IF NOT EXISTS idx_stamp_cards_tenant ON stamp_cards(tenant_id);
CREATE INDEX IF NOT EXISTS idx_stamp_cards_customer ON stamp_cards(tenant_id, customer_id);
CREATE INDEX IF NOT EXISTS idx_stamp_events_tenant ON stamp_events(tenant_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_messages_tenant ON loyalty_messages(tenant_id);
CREATE INDEX IF NOT EXISTS idx_wallet_passes_tenant ON wallet_passes(tenant_id);
CREATE INDEX IF NOT EXISTS idx_wallet_passes_customer ON wallet_passes(tenant_id, customer_id);
CREATE INDEX IF NOT EXISTS idx_wallet_passes_enroll_token ON wallet_passes(enroll_token) WHERE enroll_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_wallet_registrations_tenant ON wallet_registrations(tenant_id);
CREATE INDEX IF NOT EXISTS idx_wallet_registrations_device ON wallet_registrations(device_library_id);
CREATE INDEX IF NOT EXISTS idx_order_templates_tenant ON order_templates(tenant_id);
CREATE INDEX IF NOT EXISTS idx_orders_payment_status ON orders(tenant_id, payment_status, paid_at);
CREATE INDEX IF NOT EXISTS idx_waste_log_tenant ON waste_log(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_waste_log_item ON waste_log(tenant_id, inventory_item_id);
CREATE INDEX IF NOT EXISTS idx_inventory_items_kind ON inventory_items(tenant_id, kind);
CREATE INDEX IF NOT EXISTS idx_menu_item_ingredients_inventory ON menu_item_ingredients(inventory_item_id);
CREATE INDEX IF NOT EXISTS idx_prep_runs_tenant ON prep_runs(tenant_id, prepped_at DESC);
CREATE INDEX IF NOT EXISTS idx_prep_run_inputs_run ON prep_run_inputs(prep_run_id);
CREATE INDEX IF NOT EXISTS idx_prep_run_outputs_run ON prep_run_outputs(prep_run_id);
CREATE INDEX IF NOT EXISTS idx_portion_ledger_item ON portion_ledger(tenant_id, inventory_item_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_portion_ledger_ref ON portion_ledger(tenant_id, ref_type, ref_id);
CREATE INDEX IF NOT EXISTS idx_cfdi_invoices_tenant_date ON cfdi_invoices(tenant_id, issued_at DESC);
CREATE INDEX IF NOT EXISTS idx_cfdi_invoices_tenant_order ON cfdi_invoices(tenant_id, order_id);
CREATE INDEX IF NOT EXISTS idx_cfdi_invoice_tokens_token ON cfdi_invoice_tokens(token);
CREATE INDEX IF NOT EXISTS idx_tenant_credentials_tenant ON tenant_credentials(tenant_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_tenant ON audit_log(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_resource ON audit_log(tenant_id, resource, resource_id);
CREATE INDEX IF NOT EXISTS idx_expenses_tenant ON expenses(tenant_id, expense_date DESC);
CREATE INDEX IF NOT EXISTS idx_display_assets_tenant ON display_assets(tenant_id, active, sort_order, id);

-- ==================== Row-Level Security ====================

DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOR tbl IN
    SELECT unnest(ARRAY[
      'employees', 'shifts', 'cash_drawer_sessions', 'cash_paid_outs', 'menu_categories', 'menu_items', 'orders', 'order_items',
      'inventory_items', 'menu_item_ingredients',
      'modifier_groups', 'modifiers', 'menu_item_modifier_groups', 'order_item_modifiers',
      'combo_definitions', 'combo_slots', 'order_payments', 'order_payment_items',
      'printers', 'category_printer_routes', 'print_jobs',
      'delivery_platforms', 'delivery_orders', 'delivery_markup_rules',
      'virtual_brands', 'virtual_brand_items',
      'display_assets',
      'role_permissions', 'refunds',
      'inventory_counts', 'shrinkage_alerts', 'vendors', 'vendor_items',
      'purchase_orders', 'purchase_order_items', 'financial_targets', 'financial_actuals',
      'loyalty_customers', 'stamp_cards', 'stamp_events', 'referral_events',
      'loyalty_messages', 'loyalty_config', 'wallet_passes', 'wallet_registrations',
      'order_templates',
      'waste_log', 'cfdi_config', 'cfdi_invoices', 'tenant_credentials', 'expenses',
      'kiosk_devices', 'kiosk_builder_map', 'kiosk_addon_map',
      'prep_runs', 'prep_run_inputs', 'prep_run_outputs', 'portion_ledger'
    ])
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', tbl);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (tenant_id = current_setting(''app.tenant_id'', true))
         WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true))',
      tbl
    );
  END LOOP;
END;
$$;

-- ===================== Demo / Lead Tables =====================

CREATE TABLE IF NOT EXISTS demo_tokens (
  token UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS leads (
  id SERIAL PRIMARY KEY,
  restaurant_name TEXT,
  name TEXT,
  email TEXT UNIQUE,
  phone TEXT,
  source TEXT DEFAULT 'unknown',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS stress_test_runs (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  config JSONB DEFAULT '{}',
  summary JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;

-- portion_ledger is append-only for the request role: the blanket GRANT above
-- (and this database's default ACL) hand app_user everything, so withholding
-- requires an explicit REVOKE. UPDATE is the meaningful one — a correction is a
-- new compensating row, never an edit to what a movement said. DELETE stays
-- granted because the admin inventory reset clears these rows inside the
-- request transaction. Migration 0103 repeats this for older databases.
REVOKE UPDATE, TRUNCATE ON portion_ledger FROM app_user;
