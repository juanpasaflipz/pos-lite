/**
 * Demo Data Generator — creates realistic backdated historical data
 * for a tenant so that admin reports, AI analytics, delivery margins,
 * loyalty, and financial projections all show populated data.
 *
 * Tagged with source='demo_generator' on orders and demo_batch_id on
 * non-order tables for clean deletion.
 */

import crypto from 'crypto';
import { tenantContext } from '../db/index.js';
// AI modules removed in lean POS — stub the functions
const detectShrinkagePatterns = () => {};
const analyzeWastePatterns = () => {};

const TAX_RATE = 0.16;
const DEMO_SOURCE = 'demo_generator';

// Volume presets — hit $150k-200k MXN/month at ~$300-350 avg ticket
const VOLUME_MAP = { low: 150, medium: 500, high: 1000 };

// Mexican first/last names for loyalty customers
const FIRST_NAMES = [
  'María', 'José', 'Juan', 'Ana', 'Carlos', 'Laura', 'Miguel', 'Sofía',
  'Luis', 'Fernanda', 'Diego', 'Gabriela', 'Alejandro', 'Valentina',
  'Ricardo', 'Daniela', 'Fernando', 'Camila', 'Pedro', 'Isabella',
];
const LAST_NAMES = [
  'García', 'Hernández', 'López', 'Martínez', 'González', 'Rodríguez',
  'Pérez', 'Sánchez', 'Ramírez', 'Torres', 'Flores', 'Rivera',
  'Gómez', 'Díaz', 'Cruz', 'Morales', 'Reyes', 'Jiménez', 'Ruiz', 'Vargas',
];

// Financial line items (scaled for ~$175k/month revenue)
// Manual financial lines — seeded as % of monthly revenue with realistic variance
// (food_cost, stripe_fees, delivery_commissions are auto-calculated at report time, so skip them)
const FINANCIAL_LINES = [
  { category: 'labor', targetPercent: 25, varianceMin: -0.03, varianceMax: 0.05 },
  { category: 'rent', targetPercent: 10, varianceMin: -0.01, varianceMax: 0.01 },   // rent is fixed-ish
  { category: 'utilities', targetPercent: 4, varianceMin: -0.01, varianceMax: 0.02 },
  { category: 'supplies', targetPercent: 3, varianceMin: -0.01, varianceMax: 0.03 },
  { category: 'marketing', targetPercent: 2, varianceMin: -0.01, varianceMax: 0.04 },
];

// Financial targets (Budget vs Actual percentages)
const FINANCIAL_TARGETS = [
  { category: 'food_cost', target_percent: 30 },
  { category: 'labor', target_percent: 25 },
  { category: 'rent', target_percent: 10 },
  { category: 'utilities', target_percent: 4 },
  { category: 'supplies', target_percent: 3 },
  { category: 'marketing', target_percent: 2 },
];

// Waste reasons with distribution weights
const WASTE_REASONS = [
  { reason: 'spoilage', weight: 0.40 },
  { reason: 'prep_error', weight: 0.25 },
  { reason: 'expired', weight: 0.20 },
  { reason: 'dropped', weight: 0.10 },
  { reason: 'other', weight: 0.05 },
];

// Vendor templates
const VENDOR_TEMPLATES = [
  {
    name: 'Distribuidora Cárnica del Norte',
    contact: 'Roberto Mendoza',
    phone: '+5218112345678',
    keywords: ['carne', 'meat', 'pollo', 'chicken', 'res', 'cerdo', 'pork', 'bacon', 'wing', 'patty', 'beef', 'rib'],
  },
  {
    name: 'Frutas y Verduras La Central',
    contact: 'María Solís',
    phone: '+5218112345679',
    keywords: ['lechuga', 'lettuce', 'tomate', 'tomato', 'jalapeño', 'cebolla', 'onion', 'aguacate', 'avocado', 'pepino', 'pickle', 'coleslaw', 'produce', 'vegetal', 'fruta'],
  },
  {
    name: 'Abarrotes El Mayoreo',
    contact: 'Jorge Castillo',
    phone: '+5218112345680',
    keywords: ['pan', 'bun', 'bread', 'harina', 'flour', 'aceite', 'oil', 'salsa', 'sauce', 'queso', 'cheese', 'mayo', 'mustard', 'ketchup', 'bebida', 'drink', 'soda', 'fries', 'fry'],
  },
];

// Delivery platform markup percentages
const PLATFORM_MARKUPS = {
  uber_eats: 18,
  rappi: 15,
  didi_food: 12,
};

// Refund reasons
const REFUND_REASONS = [
  'Customer complaint',
  'Wrong order',
  'Quality issue',
  'Duplicate charge',
  'Late delivery',
];

// Monterrey addresses for delivery orders
const MONTERREY_ADDRESSES = [
  'Av. Constitución 500, Centro, 64000 Monterrey, N.L.',
  'Calzada del Valle 400, Del Valle, 66220 San Pedro Garza García, N.L.',
  'Av. Vasconcelos 300, Residencial San Agustín, 66260 San Pedro, N.L.',
  'Blvd. Antonio L. Rodríguez 2500, Santa María, 64650 Monterrey, N.L.',
  'Av. Lázaro Cárdenas 1000, Valle del Mirador, 64750 Monterrey, N.L.',
  'Av. Insurgentes 2500, Vista Hermosa, 64620 Monterrey, N.L.',
  'Calle Morelos 200, Barrio Antiguo, 64000 Monterrey, N.L.',
  'Av. Eugenio Garza Sada 2501, Tecnológico, 64849 Monterrey, N.L.',
  'Av. Alfonso Reyes 600, Contry, 64860 Monterrey, N.L.',
  'Av. Revolución 1500, Primavera, 64830 Monterrey, N.L.',
  'Calle Hidalgo 400, Centro, 64000 Monterrey, N.L.',
  'Av. Gonzalitos 500, Mitras Centro, 64460 Monterrey, N.L.',
];

// Category role keyword matching
const CATEGORY_ROLE_KEYWORDS = {
  primary: ['burger', 'chicken', 'pollo', 'wing', 'rib', 'sandwich', 'main', 'plato', 'principal', 'hamburguesa'],
  complement: ['side', 'acompañ', 'dessert', 'postre', 'appetizer', 'entrada', 'extra'],
  staple: ['drink', 'bebida', 'beverage', 'soda', 'agua', 'juice', 'jugo', 'refresco'],
};

// ─── Helpers ──────────────────────────────────────────────

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randFloat(min, max) {
  return Math.round((Math.random() * (max - min) + min) * 100) / 100;
}

/**
 * Generate a random timestamp within the date range, weighted
 * toward typical restaurant business hours.
 * Peaks: 12-14 (lunch), 19-21 (dinner)
 */
function randomTimestamp(dateRangeDays) {
  const now = new Date();
  // Include today (0) so "Hoy" reports have data; weight toward recent days
  const daysBack = randInt(0, dateRangeDays);
  const msBack = daysBack * 24 * 60 * 60 * 1000;
  const date = new Date(now.getTime() - msBack);

  // Weighted hour distribution
  const r = Math.random();
  let hour;
  if (daysBack === 0) {
    // Today: only generate hours up to current hour (no future timestamps)
    const maxHour = Math.max(now.getHours() - 1, 8);
    hour = randInt(8, maxHour);
  } else if (r < 0.05) hour = randInt(8, 10);        // 5% early morning
  else if (r < 0.15) hour = randInt(10, 11);          // 10% late morning
  else if (r < 0.45) hour = randInt(12, 14);          // 30% lunch peak
  else if (r < 0.55) hour = randInt(15, 17);          // 10% afternoon
  else if (r < 0.85) hour = randInt(19, 21);          // 30% dinner peak
  else hour = randInt(17, 18);                        // 15% early evening

  date.setHours(hour, randInt(0, 59), randInt(0, 59));
  return date;
}

function generatePhone() {
  const area = randInt(55, 99);
  const num = String(randInt(10000000, 99999999));
  return `+521${area}${num}`;
}

/** Pick from weighted items array [{ ..., weight }] */
function pickWeighted(items) {
  const r = Math.random();
  let cum = 0;
  for (const item of items) {
    cum += item.weight;
    if (r <= cum) return item;
  }
  return items[items.length - 1];
}

/** Shuffle array in-place (Fisher-Yates) */
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Match a vendor template index by inventory item name */
function matchVendor(itemName) {
  const lower = itemName.toLowerCase();
  for (let i = 0; i < VENDOR_TEMPLATES.length; i++) {
    if (VENDOR_TEMPLATES[i].keywords.some(kw => lower.includes(kw))) {
      return i;
    }
  }
  // Default to last vendor (dry goods/misc)
  return VENDOR_TEMPLATES.length - 1;
}

/** Determine category role from name */
function getCategoryRole(categoryName) {
  const lower = categoryName.toLowerCase();
  for (const [role, keywords] of Object.entries(CATEGORY_ROLE_KEYWORDS)) {
    if (keywords.some(kw => lower.includes(kw))) return role;
  }
  return 'complement';
}

// ─── Main Generator ──────────────────────────────────────

export async function generateDemoData(adminSql, {
  tenantId,
  batchId = crypto.randomUUID(),
  volume = 'medium',
  dateRangeDays = 30,
  includeDelivery = true,
  includeLoyalty = true,
  includeAi = true,
  includeFinancials = true,
}) {
  const orderCount = VOLUME_MAP[volume] || VOLUME_MAP.medium;

  // ─── Idempotent schema additions ──────────────────────────
  const schemaAdditions = [
    'ALTER TABLE loyalty_customers ADD COLUMN IF NOT EXISTS demo_batch_id UUID',
    'ALTER TABLE stamp_cards ADD COLUMN IF NOT EXISTS demo_batch_id UUID',
    'ALTER TABLE stamp_events ADD COLUMN IF NOT EXISTS demo_batch_id UUID',
    'ALTER TABLE referral_events ADD COLUMN IF NOT EXISTS demo_batch_id UUID',
    'ALTER TABLE orders ADD COLUMN IF NOT EXISTS demo_batch_id UUID',
    'ALTER TABLE financial_actuals ADD COLUMN IF NOT EXISTS demo_batch_id UUID',
    'ALTER TABLE waste_log ADD COLUMN IF NOT EXISTS demo_batch_id UUID',
    'ALTER TABLE delivery_orders ADD COLUMN IF NOT EXISTS demo_batch_id UUID',
    'ALTER TABLE refunds ADD COLUMN IF NOT EXISTS demo_batch_id UUID',
    'ALTER TABLE inventory_counts ADD COLUMN IF NOT EXISTS demo_batch_id UUID',
    'ALTER TABLE shrinkage_alerts ADD COLUMN IF NOT EXISTS demo_batch_id UUID',
    'ALTER TABLE delivery_markup_rules ADD COLUMN IF NOT EXISTS demo_batch_id UUID',
    'ALTER TABLE vendors ADD COLUMN IF NOT EXISTS demo_batch_id UUID',
    'ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS demo_batch_id UUID',
    'ALTER TABLE menu_item_ingredients ADD COLUMN IF NOT EXISTS demo_batch_id UUID',
    'ALTER TABLE pricing_guardrails ADD COLUMN IF NOT EXISTS demo_batch_id UUID',
    'ALTER TABLE pricing_rules ADD COLUMN IF NOT EXISTS demo_batch_id UUID',
    'ALTER TABLE pricing_experiments ADD COLUMN IF NOT EXISTS demo_batch_id UUID',
    'ALTER TABLE price_history ADD COLUMN IF NOT EXISTS demo_batch_id UUID',
    'ALTER TABLE virtual_brands ADD COLUMN IF NOT EXISTS demo_batch_id UUID',
    'ALTER TABLE virtual_brand_items ADD COLUMN IF NOT EXISTS demo_batch_id UUID',
    'ALTER TABLE delivery_recapture ADD COLUMN IF NOT EXISTS demo_batch_id UUID',
    'ALTER TABLE tenant_credentials ADD COLUMN IF NOT EXISTS demo_batch_id UUID',
    'ALTER TABLE ai_suggestion_events ADD COLUMN IF NOT EXISTS demo_batch_id UUID',
    'CREATE TABLE IF NOT EXISTS daily_order_counter (tenant_id TEXT NOT NULL, date_key DATE NOT NULL, last_seq INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (tenant_id, date_key))',
  ];
  for (const ddl of schemaAdditions) {
    try { await adminSql.unsafe(ddl); } catch { /* table may not exist in lean POS */ }
  }

  // ─── Fetch tenant data ──────────────────────────────────────
  const [menuItems, employees, modifiers, deliveryPlatforms, inventoryItems, menuItemIngredients, menuCategories] =
    await Promise.all([
      adminSql`SELECT id, name, price, category_id FROM menu_items WHERE tenant_id = ${tenantId} AND active = true`,
      adminSql`SELECT id, name FROM employees WHERE tenant_id = ${tenantId} AND active = true`,
      adminSql`
        SELECT m.id, m.name, m.price_adjustment, m.group_id
        FROM modifiers m JOIN modifier_groups mg ON mg.id = m.group_id
        WHERE mg.tenant_id = ${tenantId} AND mg.active = true AND m.active = true
      `,
      includeDelivery
        ? adminSql`SELECT id, name, commission_percent FROM delivery_platforms WHERE tenant_id = ${tenantId} AND active = true`
        : Promise.resolve([]),
      adminSql`SELECT id, name, quantity, unit, cost_price, category FROM inventory_items WHERE tenant_id = ${tenantId}`,
      adminSql`SELECT menu_item_id, inventory_item_id, quantity_used FROM menu_item_ingredients WHERE tenant_id = ${tenantId}`,
      adminSql`SELECT id, name FROM menu_categories WHERE tenant_id = ${tenantId}`,
    ]);

  if (menuItems.length === 0) throw new Error('No active menu items. Seed the tenant menu first.');
  if (employees.length === 0) throw new Error('No active employees. Seed the tenant first.');

  // Build ingredient lookup: menu_item_id → [{ inventory_item_id, quantity_used }]
  const ingredientMap = new Map();
  for (const ing of menuItemIngredients) {
    if (!ingredientMap.has(ing.menu_item_id)) ingredientMap.set(ing.menu_item_id, []);
    ingredientMap.get(ing.menu_item_id).push({
      inventory_item_id: ing.inventory_item_id,
      quantity_used: Number(ing.quantity_used),
    });
  }

  const summary = {
    menu_item_ingredients: 0,
    orders: 0, order_items: 0, order_item_modifiers: 0, order_payments: 0,
    delivery_orders: 0, delivery_markup_rules: 0,
    loyalty_customers: 0, stamp_cards: 0, stamp_events: 0, referral_events: 0,
    ai_hourly_snapshots: 0, ai_item_pairs: 0, ai_inventory_velocity: 0,
    ai_suggestion_cache: 0, ai_category_roles: 0,
    financial_actuals: 0, financial_targets: 0,
    waste_log: 0, inventory_counts: 0, shrinkage_alerts: 0,
    vendors: 0, purchase_orders: 0, purchase_order_items: 0,
    refunds: 0,
    virtual_brands: 0, virtual_brand_items: 0, delivery_recapture: 0,
    pricing_guardrails: 0, pricing_rules: 0, pricing_experiments: 0, price_history: 0,
    ai_suggestion_events: 0, tenant_credentials: 0,
  };

  // ─── 0. Seed Recipes (menu_item_ingredients) ──────────────
  // For items without ingredients, assign 3-6 inventory items targeting 28-35% food cost
  if (inventoryItems.length > 0) {
    // Group inventory items by rough type for smarter assignment
    const invByCategory = new Map();
    for (const inv of inventoryItems) {
      const cat = (inv.category || 'other').toLowerCase();
      if (!invByCategory.has(cat)) invByCategory.set(cat, []);
      invByCategory.get(cat).push(inv);
    }
    const allInvCategories = [...invByCategory.keys()];

    // Find menu items without recipes
    const itemsWithRecipes = new Set(menuItemIngredients.map(i => i.menu_item_id));

    for (const menuItem of menuItems) {
      if (itemsWithRecipes.has(menuItem.id)) continue; // skip items that already have recipes

      const price = Number(menuItem.price);
      if (price <= 0) continue;

      // Target COGS = 28-35% of price
      const targetCogs = price * randFloat(0.28, 0.35);
      const numIngredients = randInt(3, Math.min(6, inventoryItems.length));
      const costPerIngredient = targetCogs / numIngredients;

      // Pick diverse ingredients from different categories
      const usedIngredients = new Set();
      const shuffledInv = shuffle(inventoryItems);

      for (let n = 0; n < numIngredients && n < shuffledInv.length; n++) {
        const inv = shuffledInv[n];
        if (usedIngredients.has(inv.id)) continue;
        usedIngredients.add(inv.id);

        const costPrice = Number(inv.cost_price) || 10;
        // quantity_used = target cost per ingredient / cost_price
        const qtyUsed = Math.max(0.05, Math.round((costPerIngredient / costPrice) * 100) / 100);

        await adminSql.unsafe(`
          INSERT INTO menu_item_ingredients (tenant_id, menu_item_id, inventory_item_id, quantity_used, demo_batch_id)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (menu_item_id, inventory_item_id) DO NOTHING
        `, [tenantId, menuItem.id, inv.id, qtyUsed, batchId]);
        summary.menu_item_ingredients++;

        // Also add to ingredientMap for AI velocity computation later
        if (!ingredientMap.has(menuItem.id)) ingredientMap.set(menuItem.id, []);
        ingredientMap.get(menuItem.id).push({
          inventory_item_id: inv.id,
          quantity_used: qtyUsed,
        });
      }
    }
  }

  // ─── 1. Generate Orders ──────────────────────────────────

  const generatedOrders = []; // { id, total, created_at, items[], employee_id }
  const deliveryOrderIds = []; // { id, platform } for recapture linking

  for (let i = 0; i < orderCount; i++) {
    const created_at = randomTimestamp(dateRangeDays);
    const employee = pick(employees);
    const numItems = randInt(2, 4);
    const isDelivery = includeDelivery && deliveryPlatforms.length > 0 && Math.random() < 0.3;
    const platform = isDelivery ? pick(deliveryPlatforms) : null;

    let itemsTotal = 0;
    const orderItems = [];

    for (let j = 0; j < numItems; j++) {
      const item = pick(menuItems);
      const qty = randInt(1, 3);
      let modAdj = 0;
      const itemMods = [];

      // 30% chance of modifier
      if (modifiers.length > 0 && Math.random() < 0.3) {
        const mod = pick(modifiers);
        modAdj = Number(mod.price_adjustment) || 0;
        itemMods.push(mod);
      }

      const unitPrice = Number(item.price) + modAdj;
      itemsTotal += unitPrice * qty;
      orderItems.push({
        menu_item_id: item.id,
        item_name: item.name,
        category_id: item.category_id,
        quantity: qty,
        unit_price: unitPrice,
        modifiers: itemMods,
      });
    }

    const total = Math.round(itemsTotal * 100) / 100;
    const tax = Math.round((total - total / (1 + TAX_RATE)) * 100) / 100;
    const subtotal = Math.round((total - tax) * 100) / 100;

    // Payment method and tip
    const paymentMethod = Math.random() < 0.55 ? 'cash' : 'card';
    let tip = 0;
    if (paymentMethod === 'card') {
      const tipRoll = Math.random();
      if (tipRoll < 0.5) tip = 0;
      else if (tipRoll < 0.8) tip = Math.round(total * randFloat(0.10, 0.15) * 100) / 100;
      else tip = Math.round(total * randFloat(0.16, 0.20) * 100) / 100;
    }

    // Generate order number using same atomic pattern
    const dateStr = created_at.toISOString().split('T')[0];
    const datePrefix = parseInt(dateStr.replace(/-/g, '')) * 1000;

    const [counter] = await adminSql.unsafe(`
      INSERT INTO daily_order_counter (tenant_id, date_key, last_seq)
      VALUES ($1, $2::date, 1)
      ON CONFLICT (tenant_id, date_key) DO UPDATE SET last_seq = daily_order_counter.last_seq + 1
      RETURNING last_seq
    `, [tenantId, dateStr]);

    const orderNumber = datePrefix + counter.last_seq;

    // Insert order
    const [order] = await adminSql.unsafe(`
      INSERT INTO orders (tenant_id, order_number, employee_id, status, subtotal, tax, tip, total,
                          payment_status, payment_method, source, created_at, paid_at)
      VALUES ($1, $2, $3, 'completed', $4, $5, $6, $7, 'paid', $8, $9, $10, $10)
      RETURNING id
    `, [tenantId, orderNumber, employee.id, subtotal, tax, tip, total + tip, paymentMethod, DEMO_SOURCE, created_at.toISOString()]);

    const orderId = order.id;
    summary.orders++;

    // Insert order items
    for (const item of orderItems) {
      const [itemRow] = await adminSql.unsafe(`
        INSERT INTO order_items (tenant_id, order_id, menu_item_id, item_name, quantity, unit_price)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id
      `, [tenantId, orderId, item.menu_item_id, item.item_name, item.quantity, item.unit_price]);

      summary.order_items++;

      for (const mod of item.modifiers) {
        await adminSql.unsafe(`
          INSERT INTO order_item_modifiers (tenant_id, order_item_id, modifier_id, modifier_name, price_adjustment)
          VALUES ($1, $2, $3, $4, $5)
        `, [tenantId, itemRow.id, mod.id, mod.name, mod.price_adjustment]);
        summary.order_item_modifiers++;
      }
    }

    // Insert order payment
    await adminSql.unsafe(`
      INSERT INTO order_payments (tenant_id, order_id, payment_method, amount, status)
      VALUES ($1, $2, $3, $4, 'completed')
    `, [tenantId, orderId, paymentMethod, total + tip]);
    summary.order_payments++;

    // Insert delivery order if applicable
    if (isDelivery && platform) {
      const commission = Math.round(total * (Number(platform.commission_percent) / 100) * 100) / 100;
      const daysBack = (Date.now() - created_at.getTime()) / (24 * 60 * 60 * 1000);
      let deliveryStatus;
      if (daysBack <= 3) {
        const sr = Math.random();
        if (sr < 0.60) deliveryStatus = 'delivered';
        else if (sr < 0.80) deliveryStatus = 'ready_for_pickup';
        else if (sr < 0.95) deliveryStatus = 'confirmed';
        else deliveryStatus = 'received';
      } else {
        deliveryStatus = 'delivered';
      }
      const [delOrder] = await adminSql.unsafe(`
        INSERT INTO delivery_orders (tenant_id, order_id, platform_id, external_order_id,
                                     customer_name, delivery_address, platform_status, platform_commission, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING id
      `, [
        tenantId, orderId, platform.id,
        `DEL-${platform.name.toUpperCase()}-${randInt(10000, 99999)}`,
        `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`,
        pick(MONTERREY_ADDRESSES),
        deliveryStatus, commission, created_at.toISOString(),
      ]);
      summary.delivery_orders++;
      deliveryOrderIds.push({ id: delOrder.id, platform: platform.name });
    }

    generatedOrders.push({
      id: orderId,
      total: total + tip,
      created_at,
      items: orderItems,
      employee_id: employee.id,
    });
  }

  // ─── 2. Delivery Markup Rules ───────────────────────────

  if (includeDelivery && deliveryPlatforms.length > 0 && menuCategories.length > 0) {
    for (const platform of deliveryPlatforms) {
      const pKey = platform.name.toLowerCase().replace(/[\s-]/g, '_');
      const markup = PLATFORM_MARKUPS[pKey];
      if (!markup) continue;

      for (const cat of menuCategories) {
        await adminSql.unsafe(`
          INSERT INTO delivery_markup_rules (tenant_id, platform_id, category_id, markup_type, markup_value, active, demo_batch_id)
          VALUES ($1, $2, $3, 'percent', $4, true, $5)
          ON CONFLICT (tenant_id, platform_id, category_id) DO NOTHING
        `, [tenantId, platform.id, cat.id, markup, batchId]);
        summary.delivery_markup_rules++;
      }
    }
  }

  // ─── 3. Generate Loyalty Data ────────────────────────────

  if (includeLoyalty) {
    const customerCount = randInt(50, 100);
    const customers = [];

    for (let i = 0; i < customerCount; i++) {
      const firstName = pick(FIRST_NAMES);
      const lastName = pick(LAST_NAMES);
      // Backdate signup across 12 months for "Signups by Month" chart
      const signupDate = new Date();
      signupDate.setMonth(signupDate.getMonth() - randInt(0, 11));
      signupDate.setDate(randInt(1, 28));
      const [cust] = await adminSql.unsafe(`
        INSERT INTO loyalty_customers (tenant_id, name, phone, sms_opt_in, orders_count, total_spent, demo_batch_id, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING id
      `, [
        tenantId,
        `${firstName} ${lastName}`,
        generatePhone(),
        Math.random() < 0.7,
        randInt(1, 20),
        randFloat(200, 5000),
        batchId,
        signupDate.toISOString(),
      ]);
      customers.push(cust.id);
      summary.loyalty_customers++;
    }

    // Stamp cards: 1-2 per customer (subset of customers)
    const stampCustomers = customers.slice(0, Math.ceil(customers.length * 0.6));
    for (const custId of stampCustomers) {
      const cardsCount = randInt(1, 2);
      for (let c = 0; c < cardsCount; c++) {
        const stamps = randInt(1, 10);
        const isComplete = stamps >= 10;
        const isRedeemed = isComplete && Math.random() < 0.5;
        const [card] = await adminSql.unsafe(`
          INSERT INTO stamp_cards (tenant_id, customer_id, stamps_earned, completed, redeemed, demo_batch_id)
          VALUES ($1, $2, $3, $4, $5, $6)
          RETURNING id
        `, [tenantId, custId, Math.min(stamps, 10), isComplete, isRedeemed, batchId]);
        summary.stamp_cards++;

        // Stamp events for some orders
        const eventCount = Math.min(stamps, 5);
        for (let e = 0; e < eventCount; e++) {
          const order = pick(generatedOrders);
          await adminSql.unsafe(`
            INSERT INTO stamp_events (tenant_id, stamp_card_id, order_id, stamps_added, event_type, demo_batch_id, created_at)
            VALUES ($1, $2, $3, 1, 'purchase', $4, $5)
          `, [tenantId, card.id, order.id, batchId, order.created_at.toISOString()]);
          summary.stamp_events++;
        }
      }
    }

    // Referral events
    const refCount = randInt(5, 10);
    for (let i = 0; i < refCount; i++) {
      const referrer = pick(customers);
      const referred = pick(customers);
      if (referrer !== referred) {
        await adminSql.unsafe(`
          INSERT INTO referral_events (tenant_id, referrer_id, referee_id, demo_batch_id)
          VALUES ($1, $2, $3, $4)
        `, [tenantId, referrer, referred, batchId]);
        summary.referral_events++;
      }
    }
  }

  // ─── 4. Generate AI Analytics (may not exist in lean POS) ──

  try { if (includeAi) {
    // Aggregate orders by hour for ai_hourly_snapshots
    const hourlyMap = new Map();
    for (const order of generatedOrders) {
      const hourKey = order.created_at.toISOString().slice(0, 13); // YYYY-MM-DDTHH
      if (!hourlyMap.has(hourKey)) {
        hourlyMap.set(hourKey, { count: 0, revenue: 0, date: order.created_at });
      }
      const entry = hourlyMap.get(hourKey);
      entry.count++;
      entry.revenue += order.total;
    }

    for (const [, data] of hourlyMap) {
      const avgTicket = data.count > 0 ? Math.round((data.revenue / data.count) * 100) / 100 : 0;
      await adminSql.unsafe(`
        INSERT INTO ai_hourly_snapshots (tenant_id, snapshot_hour, order_count, revenue, avg_ticket, demo_batch_id)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [tenantId, data.date.toISOString(), data.count, Math.round(data.revenue * 100) / 100, avgTicket, batchId]);
      summary.ai_hourly_snapshots++;
    }

    // Item pair co-occurrence
    const pairMap = new Map();
    for (const order of generatedOrders) {
      const items = order.items.map(i => i.menu_item_id);
      for (let a = 0; a < items.length; a++) {
        for (let b = a + 1; b < items.length; b++) {
          const key = [items[a], items[b]].sort().join('-');
          pairMap.set(key, (pairMap.get(key) || 0) + 1);
        }
      }
    }

    for (const [key, count] of pairMap) {
      const [itemA, itemB] = key.split('-').map(Number);
      await adminSql.unsafe(`
        INSERT INTO ai_item_pairs (tenant_id, item_a_id, item_b_id, pair_count, demo_batch_id)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT DO NOTHING
      `, [tenantId, itemA, itemB, count, batchId]);
      summary.ai_item_pairs++;
    }

    // AI Inventory Velocity — compute from orders + menu_item_ingredients
    if (ingredientMap.size > 0) {
      // Aggregate: date → Map<inventory_item_id, { qty, orders }>
      const velocityMap = new Map();
      for (const order of generatedOrders) {
        const dateKey = order.created_at.toISOString().split('T')[0];
        if (!velocityMap.has(dateKey)) velocityMap.set(dateKey, new Map());
        const dayMap = velocityMap.get(dateKey);

        for (const item of order.items) {
          const ingredients = ingredientMap.get(item.menu_item_id);
          if (!ingredients) continue;
          for (const ing of ingredients) {
            const existing = dayMap.get(ing.inventory_item_id) || { qty: 0, orders: 0 };
            existing.qty += ing.quantity_used * item.quantity;
            existing.orders++;
            dayMap.set(ing.inventory_item_id, existing);
          }
        }
      }

      for (const [dateKey, dayMap] of velocityMap) {
        for (const [invItemId, data] of dayMap) {
          await adminSql.unsafe(`
            INSERT INTO ai_inventory_velocity (tenant_id, inventory_item_id, date, quantity_used, orders_count, demo_batch_id)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (tenant_id, inventory_item_id, date) DO UPDATE
              SET quantity_used = EXCLUDED.quantity_used, orders_count = EXCLUDED.orders_count
          `, [tenantId, invItemId, dateKey, Math.round(data.qty * 100) / 100, data.orders, batchId]);
          summary.ai_inventory_velocity++;
        }
      }
    }

    // AI Suggestion Cache — generate 10-15 realistic entries
    const menuItemMap = new Map(menuItems.map(m => [m.id, m]));

    // Upsell suggestions from top item pairs
    const topPairs = [...pairMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    for (const [key, count] of topPairs) {
      const [itemAId, itemBId] = key.split('-').map(Number);
      const itemA = menuItemMap.get(itemAId);
      const itemB = menuItemMap.get(itemBId);
      if (!itemA || !itemB) continue;

      await adminSql.unsafe(`
        INSERT INTO ai_suggestion_cache (tenant_id, suggestion_type, trigger_context, suggestion_data, priority, expires_at, demo_batch_id)
        VALUES ($1, 'upsell', $2, $3, $4, NOW() + INTERVAL '24 hours', $5)
      `, [
        tenantId,
        `upsell-${itemAId}-${itemBId}`,
        JSON.stringify({
          item_a_id: itemAId, item_a_name: itemA.name,
          item_b_id: itemBId, item_b_name: itemB.name,
          pair_count: count,
          confidence: Math.round((0.6 + Math.random() * 0.3) * 100) / 100,
          message: `Customers who order ${itemA.name} often add ${itemB.name}`,
        }),
        randInt(70, 90),
        batchId,
      ]);
      summary.ai_suggestion_cache++;
    }

    // Inventory push suggestions
    const pushItems = shuffle(menuItems).slice(0, randInt(3, 4));
    for (const item of pushItems) {
      await adminSql.unsafe(`
        INSERT INTO ai_suggestion_cache (tenant_id, suggestion_type, trigger_context, suggestion_data, priority, expires_at, demo_batch_id)
        VALUES ($1, 'inventory_push', $2, $3, $4, NOW() + INTERVAL '24 hours', $5)
      `, [
        tenantId,
        `push-${item.id}`,
        JSON.stringify({
          menu_item_id: item.id,
          name: item.name,
          price: Number(item.price),
          reason: 'Stock above optimal — promote as daily special',
        }),
        randInt(70, 85),
        batchId,
      ]);
      summary.ai_suggestion_cache++;
    }

    // Combo upgrade suggestions
    const comboItems = shuffle(menuItems).slice(0, randInt(2, 3));
    for (const item of comboItems) {
      await adminSql.unsafe(`
        INSERT INTO ai_suggestion_cache (tenant_id, suggestion_type, trigger_context, suggestion_data, priority, expires_at, demo_batch_id)
        VALUES ($1, 'combo_upgrade', $2, $3, $4, NOW() + INTERVAL '24 hours', $5)
      `, [
        tenantId,
        `combo-${item.id}`,
        JSON.stringify({
          trigger_item_id: item.id,
          trigger_item_name: item.name,
          savings_percent: randInt(10, 20),
          message: `Suggest combo upgrade when customer orders ${item.name} separately`,
        }),
        randInt(60, 80),
        batchId,
      ]);
      summary.ai_suggestion_cache++;
    }

    // Dynamic pricing suggestions
    const pricingCount = randInt(1, 2);
    for (let p = 0; p < pricingCount; p++) {
      const window = p === 0 ? '19:00-21:00' : '12:00-14:00';
      const label = p === 0 ? 'dinner' : 'lunch';
      await adminSql.unsafe(`
        INSERT INTO ai_suggestion_cache (tenant_id, suggestion_type, trigger_context, suggestion_data, priority, expires_at, demo_batch_id)
        VALUES ($1, 'dynamic_pricing', $2, $3, $4, NOW() + INTERVAL '24 hours', $5)
      `, [
        tenantId,
        `pricing-${label}`,
        JSON.stringify({
          time_window: window,
          demand_increase_percent: randInt(30, 50),
          suggested_action: `${label.charAt(0).toUpperCase() + label.slice(1)} peak shows ${randInt(30, 50)}% higher demand — consider surge pricing`,
        }),
        randInt(60, 75),
        batchId,
      ]);
      summary.ai_suggestion_cache++;
    }

    // AI Category Roles
    if (menuCategories.length > 0) {
      for (const cat of menuCategories) {
        const role = getCategoryRole(cat.name);
        await adminSql.unsafe(`
          INSERT INTO ai_category_roles (tenant_id, category_id, role)
          VALUES ($1, $2, $3)
          ON CONFLICT (tenant_id, category_id) DO UPDATE SET role = $3
        `, [tenantId, cat.id, role]);
        summary.ai_category_roles++;
      }
    }
  } } catch (aiErr) { console.warn('[DemoData] AI analytics skipped (tables may not exist):', aiErr.message); }

  // ─── 5. Generate Financial Data ──────────────────────────

  if (includeFinancials) {
    // Get monthly revenue from demo orders to derive realistic financial actuals
    const monthlyRevenue = await adminSql.unsafe(`
      SELECT to_char(created_at, 'YYYY-MM') as period, COALESCE(SUM(subtotal), 0) as revenue
      FROM orders
      WHERE tenant_id = $1 AND payment_status = 'paid'
      GROUP BY to_char(created_at, 'YYYY-MM')
    `, [tenantId]);

    const revenueByMonth = {};
    for (const row of monthlyRevenue) {
      revenueByMonth[row.period] = Number(row.revenue);
    }

    // Seed actuals for each month that has order revenue
    for (const [yearMonth, revenue] of Object.entries(revenueByMonth)) {
      for (const line of FINANCIAL_LINES) {
        // Actual = revenue * (target% + small variance)
        const effectivePercent = (line.targetPercent + randFloat(line.varianceMin * 100, line.varianceMax * 100)) / 100;
        const amount = Math.round(revenue * effectivePercent * 100) / 100;
        await adminSql.unsafe(`
          INSERT INTO financial_actuals (tenant_id, period, category, amount, demo_batch_id)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT DO NOTHING
        `, [tenantId, yearMonth, line.category, amount, batchId]);
        summary.financial_actuals++;
      }
    }

    // Financial targets — budget percentages
    for (const target of FINANCIAL_TARGETS) {
      await adminSql.unsafe(`
        INSERT INTO financial_targets (tenant_id, category, target_percent)
        VALUES ($1, $2, $3)
        ON CONFLICT (tenant_id, category) DO UPDATE SET target_percent = $3
      `, [tenantId, target.category, target.target_percent]);
      summary.financial_targets++;
    }
  }

  // ─── 6. Generate Waste Log ────────────────────────────────

  if (inventoryItems.length > 0) {
    const wasteCount = randInt(40, 60);
    for (let i = 0; i < wasteCount; i++) {
      const item = pick(inventoryItems);
      const { reason } = pickWeighted(WASTE_REASONS);
      const quantity = randFloat(0.5, 5);
      const costPrice = Number(item.cost_price) || 10;
      const costAtTime = Math.round(quantity * costPrice * 100) / 100;
      const timestamp = randomTimestamp(dateRangeDays);
      const employee = pick(employees);

      await adminSql.unsafe(`
        INSERT INTO waste_log (tenant_id, inventory_item_id, quantity, unit, reason, cost_at_time, logged_by, created_at, demo_batch_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `, [tenantId, item.id, quantity, item.unit || 'unit', reason, costAtTime, employee.id, timestamp.toISOString(), batchId]);
      summary.waste_log++;
    }
  }

  // ─── 7. Generate Inventory Counts & Shrinkage Alerts ──────

  if (inventoryItems.length > 0) {
    const sessionCount = randInt(2, 3);
    for (let s = 0; s < sessionCount; s++) {
      // Spread sessions across the month
      const sessionDaysBack = Math.round(((s + 1) / (sessionCount + 1)) * dateRangeDays);
      const sessionDate = new Date();
      sessionDate.setDate(sessionDate.getDate() - sessionDaysBack);
      sessionDate.setHours(randInt(9, 16), randInt(0, 59), 0);

      // Count 60-80% of inventory items
      const countPct = randFloat(0.6, 0.8);
      const itemsToCount = shuffle(inventoryItems).slice(0, Math.ceil(inventoryItems.length * countPct));

      // Pre-select items for significant variance
      const shrinkageIndices = new Set();
      const shrinkageCount = Math.min(randInt(2, 3), itemsToCount.length);
      while (shrinkageIndices.size < shrinkageCount) {
        shrinkageIndices.add(randInt(0, itemsToCount.length - 1));
      }
      const overCountIndex = randInt(0, itemsToCount.length - 1);

      for (let idx = 0; idx < itemsToCount.length; idx++) {
        const item = itemsToCount[idx];
        const sysQty = Number(item.quantity) || 10;

        let variancePct;
        if (shrinkageIndices.has(idx) && idx !== overCountIndex) {
          variancePct = randFloat(-15, -8); // significant shrinkage
        } else if (idx === overCountIndex && !shrinkageIndices.has(idx)) {
          variancePct = randFloat(3, 7); // over-count
        } else {
          variancePct = randFloat(-3, 3); // normal
        }

        const countedQty = Math.max(0, Math.round(sysQty * (1 + variancePct / 100) * 100) / 100);
        const variance = Math.round((countedQty - sysQty) * 100) / 100;
        const variancePercent = sysQty > 0 ? Math.round((variance / sysQty) * 10000) / 100 : 0;
        const employee = pick(employees);

        await adminSql.unsafe(`
          INSERT INTO inventory_counts (tenant_id, inventory_item_id, counted_quantity, system_quantity, variance, variance_percent, counted_by, created_at, demo_batch_id)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `, [tenantId, item.id, countedQty, sysQty, variance, variancePercent, employee.id, sessionDate.toISOString(), batchId]);
        summary.inventory_counts++;

        // Generate shrinkage alert for high-variance items
        if (Math.abs(variancePercent) > 7) {
          const severity = Math.abs(variancePercent) > 12 ? 'high' : 'medium';
          const direction = variance < 0 ? 'shrinkage' : 'surplus';
          await adminSql.unsafe(`
            INSERT INTO shrinkage_alerts (tenant_id, inventory_item_id, alert_type, severity, message, variance_amount, created_at, demo_batch_id)
            VALUES ($1, $2, 'variance', $3, $4, $5, $6, $7)
          `, [
            tenantId, item.id, severity,
            `Significant ${direction} detected: ${item.name} (${variancePercent > 0 ? '+' : ''}${variancePercent.toFixed(1)}%)`,
            variance, sessionDate.toISOString(), batchId,
          ]);
          summary.shrinkage_alerts++;
        }
      }
    }
  }

  // ─── 8. Generate Vendors & Purchase Orders ────────────────

  if (inventoryItems.length > 0) {
    // Create vendors and assign inventory items
    const vendorIds = [];
    const vendorItemsMap = new Map(); // vendorIndex → [inventory_items]

    // Assign each inventory item to a vendor
    for (const item of inventoryItems) {
      const vIdx = matchVendor(item.name);
      if (!vendorItemsMap.has(vIdx)) vendorItemsMap.set(vIdx, []);
      vendorItemsMap.get(vIdx).push(item);
    }

    // Create vendors
    for (let v = 0; v < VENDOR_TEMPLATES.length; v++) {
      const tpl = VENDOR_TEMPLATES[v];
      const items = vendorItemsMap.get(v) || [];
      if (items.length === 0) continue;

      const [vendor] = await adminSql.unsafe(`
        INSERT INTO vendors (tenant_id, name, contact_name, phone, active, demo_batch_id)
        VALUES ($1, $2, $3, $4, true, $5)
        RETURNING id
      `, [tenantId, tpl.name, tpl.contact, tpl.phone, batchId]);
      vendorIds.push({ id: vendor.id, items, templateIndex: v });
      summary.vendors++;

      // Link vendor_items
      for (const item of items) {
        const unitCost = Number(item.cost_price) || randFloat(10, 80);
        await adminSql.unsafe(`
          INSERT INTO vendor_items (tenant_id, vendor_id, inventory_item_id, unit_cost, lead_time_days, min_order_qty)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (vendor_id, inventory_item_id) DO NOTHING
        `, [tenantId, vendor.id, item.id, unitCost, randInt(1, 5), randInt(1, 10)]);
      }
    }

    // Create purchase orders
    if (vendorIds.length > 0) {
      const poConfigs = [
        { weeksAgo: 4, status: 'received', receivedPct: 1.0 },
        { weeksAgo: 3, status: 'received', receivedPct: 1.0 },
        { weeksAgo: 2, status: 'received', receivedPct: 1.0 },
        { weeksAgo: 2, status: 'received', receivedPct: 1.0 },
        { weeksAgo: 1, status: 'partial', receivedPct: 0.7 },
        { weeksAgo: 0, status: 'submitted', receivedPct: 0 },
        { weeksAgo: 0, status: 'draft', receivedPct: 0 },
      ];

      let poSeq = 1;
      for (const cfg of poConfigs) {
        const vendor = pick(vendorIds);
        if (vendor.items.length === 0) continue;

        const poDate = new Date();
        poDate.setDate(poDate.getDate() - cfg.weeksAgo * 7);
        poDate.setHours(randInt(9, 17), randInt(0, 59), 0);

        const dateStr = poDate.toISOString().split('T')[0].replace(/-/g, '');
        const poNumber = `PO-${dateStr}-${String(poSeq++).padStart(3, '0')}`;

        const submittedAt = cfg.status !== 'draft' ? poDate.toISOString() : null;
        const receivedAt = (cfg.status === 'received' || cfg.status === 'partial')
          ? new Date(poDate.getTime() + randInt(1, 3) * 24 * 60 * 60 * 1000).toISOString()
          : null;

        const [po] = await adminSql.unsafe(`
          INSERT INTO purchase_orders (tenant_id, po_number, vendor_id, status, total_amount, created_by, submitted_at, received_at, created_at, demo_batch_id)
          VALUES ($1, $2, $3, $4, 0, $5, $6, $7, $8, $9)
          RETURNING id
        `, [tenantId, poNumber, vendor.id, cfg.status, pick(employees).id, submittedAt, receivedAt, poDate.toISOString(), batchId]);
        summary.purchase_orders++;

        // Add 3-5 line items
        const lineCount = randInt(3, Math.min(5, vendor.items.length));
        const lineItems = shuffle(vendor.items).slice(0, lineCount);
        let poTotal = 0;

        for (const item of lineItems) {
          const qtyOrdered = randInt(5, 50);
          const unitCost = Number(item.cost_price) || randFloat(10, 80);
          const qtyReceived = cfg.receivedPct > 0
            ? Math.round(qtyOrdered * cfg.receivedPct * (cfg.status === 'partial' ? randFloat(0.5, 0.9) : 1))
            : 0;
          const lineTotal = Math.round(qtyOrdered * unitCost * 100) / 100;
          poTotal += lineTotal;

          await adminSql.unsafe(`
            INSERT INTO purchase_order_items (tenant_id, po_id, inventory_item_id, quantity_ordered, unit_cost, quantity_received, line_total)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
          `, [tenantId, po.id, item.id, qtyOrdered, unitCost, qtyReceived, lineTotal]);
          summary.purchase_order_items++;
        }

        // Update PO total
        await adminSql.unsafe(`UPDATE purchase_orders SET total_amount = $1 WHERE id = $2`, [poTotal, po.id]);
      }
    }
  }

  // ─── 9. Generate Refunds ──────────────────────────────────

  if (generatedOrders.length > 0) {
    const refundCount = randInt(3, 5);
    const refundOrders = shuffle(generatedOrders).slice(0, refundCount);

    for (let i = 0; i < refundOrders.length; i++) {
      const order = refundOrders[i];
      const isFull = i < 2; // first 1-2 are full refunds
      const refundType = isFull ? 'full' : 'partial';
      const amount = isFull
        ? order.total
        : Math.round(order.total * randFloat(0.30, 0.50) * 100) / 100;

      await adminSql.unsafe(`
        INSERT INTO refunds (tenant_id, order_id, amount, reason, refund_type, refunded_by, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [
        tenantId, order.id, amount,
        pick(REFUND_REASONS), refundType,
        pick(employees).id,
        order.created_at.toISOString(),
      ]);
      summary.refunds++;
    }
  }

  // ─── 10. Virtual Brands ─────────────────────────────────

  if (includeDelivery && deliveryPlatforms.length > 0 && menuItems.length >= 8) {
    const brandConfigs = [
      { name: 'Burger Express', color: '#DC2626', description: 'Fast premium burgers delivered fresh', markupPct: 10, slug: 'burger-express', keywords: ['burger', 'hamburguesa', 'fries', 'papas'] },
      { name: 'Wings & More', color: '#EA580C', description: 'Crispy chicken wings and sides', markupPct: 12, slug: 'wings-and-more', keywords: ['wing', 'chicken', 'pollo', 'alitas'] },
    ];

    for (const cfg of brandConfigs) {
      const platformForBrand = pick(deliveryPlatforms);
      const [brand] = await adminSql.unsafe(`
        INSERT INTO virtual_brands (tenant_id, name, platform_id, description, display_type, primary_color, slug, show_in_pos, active, demo_batch_id)
        VALUES ($1, $2, $3, $4, 'delivery', $5, $6, false, true, $7)
        RETURNING id
      `, [tenantId, cfg.name, platformForBrand.id, cfg.description, cfg.color, cfg.slug, batchId]);
      summary.virtual_brands++;

      // Find matching items by keyword, fallback to random selection
      let brandItems = menuItems.filter(m => cfg.keywords.some(kw => m.name.toLowerCase().includes(kw)));
      if (brandItems.length < 5) {
        brandItems = shuffle(menuItems).slice(0, randInt(6, 8));
      } else {
        brandItems = brandItems.slice(0, 8);
      }

      for (const item of brandItems) {
        const basePrice = Number(item.price);
        const markupPrice = Math.round(basePrice * (1 + cfg.markupPct / 100) * 100) / 100;
        await adminSql.unsafe(`
          INSERT INTO virtual_brand_items (tenant_id, virtual_brand_id, menu_item_id, custom_price, active, demo_batch_id)
          VALUES ($1, $2, $3, $4, true, $5)
          ON CONFLICT (tenant_id, virtual_brand_id, menu_item_id) DO NOTHING
        `, [tenantId, brand.id, item.id, markupPrice, batchId]);
        summary.virtual_brand_items++;
      }
    }
  }

  // ─── 11-19. Optional sections (may reference tables not in lean POS) ──
  try {

  // ─── 11. Delivery Recapture ─────────────────────────────

  if (includeDelivery && deliveryOrderIds.length > 0) {
    const recaptureCount = randInt(10, 15);
    for (let i = 0; i < recaptureCount && i < deliveryOrderIds.length; i++) {
      const del = deliveryOrderIds[i];
      const statusRoll = Math.random();
      let smsSentAt = null;
      let converted = false;

      if (statusRoll < 0.60) {
        // unsent — leave defaults
      } else if (statusRoll < 0.90) {
        smsSentAt = randomTimestamp(dateRangeDays).toISOString();
      } else {
        smsSentAt = randomTimestamp(dateRangeDays).toISOString();
        converted = true;
      }

      await adminSql.unsafe(`
        INSERT INTO delivery_recapture (tenant_id, customer_phone, customer_name, platform, last_delivery_order_id, sms_sent_at, converted, demo_batch_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `, [
        tenantId, generatePhone(), `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`,
        del.platform.toLowerCase().replace(/[\s-]/g, '_'),
        del.id, smsSentAt, converted, batchId,
      ]);
      summary.delivery_recapture++;
    }
  }

  // ─── 12. Dynamic Pricing — Guardrails ─────────────────────

  await adminSql.unsafe(`
    INSERT INTO pricing_guardrails (tenant_id, min_change_percent, max_change_percent, max_daily_changes, require_approval_above, protected_item_ids, cooldown_hours, demo_batch_id)
    VALUES ($1, -20, 15, 10, 10, '[]', 24, $2)
    ON CONFLICT (tenant_id) DO NOTHING
  `, [tenantId, batchId]);
  summary.pricing_guardrails++;

  // ─── 13. Dynamic Pricing — Rules ──────────────────────────

  const ruleIds = [];
  const cat1 = menuCategories[0];
  const cat2 = menuCategories.length > 1 ? menuCategories[1] : menuCategories[0];

  const pricingRuleDefs = [
    { name: 'Happy Hour', rule_type: 'happy_hour', conditions: { hours: '16-18', days: [1, 2, 3, 4, 5] }, adj: -15, applies_to: { scope: 'all' }, desc: 'Weekday happy hour 4-6pm' },
    { name: 'Martes de Tacos', rule_type: 'day_of_week', conditions: { days: [2], hours: '11-22' }, adj: -10, applies_to: { scope: 'categories', ids: [cat1?.id] }, desc: 'Tuesday taco discount all day' },
    { name: 'Peak Dinner', rule_type: 'demand_based', conditions: { demand_threshold: 1.5, direction: 'above' }, adj: 8, applies_to: { scope: 'all' }, desc: 'Dynamic surge during dinner peak' },
    { name: 'Weekend Brunch', rule_type: 'day_of_week', conditions: { days: [0, 6], hours: '10-13' }, adj: -5, applies_to: { scope: 'categories', ids: [cat2?.id] }, desc: 'Weekend brunch special' },
  ];

  for (const rule of pricingRuleDefs) {
    const [r] = await adminSql.unsafe(`
      INSERT INTO pricing_rules (tenant_id, name, rule_type, description, conditions, adjustment_type, adjustment_value, applies_to, active, auto_apply, priority, demo_batch_id)
      VALUES ($1, $2, $3, $4, $5, 'percent', $6, $7, true, true, $8, $9)
      RETURNING id
    `, [tenantId, rule.name, rule.rule_type, rule.desc, JSON.stringify(rule.conditions), rule.adj, JSON.stringify(rule.applies_to), ruleIds.length, batchId]);
    ruleIds.push(r.id);
    summary.pricing_rules++;
  }

  // ─── 14. Dynamic Pricing — Experiments ────────────────────

  if (menuItems.length >= 2) {
    const sortedItems = [...menuItems].sort((a, b) => Number(b.price) - Number(a.price));
    const expItem1 = sortedItems[0];
    const expItem2 = sortedItems[1];

    // Completed experiment (3 weeks ago → 1 week ago)
    const exp1Start = new Date(); exp1Start.setDate(exp1Start.getDate() - 21);
    const exp1End = new Date(); exp1End.setDate(exp1End.getDate() - 7);
    const basePrice1 = Number(expItem1.price);
    const variantB1 = Math.round(basePrice1 * 1.125 * 100) / 100;

    await adminSql.unsafe(`
      INSERT INTO pricing_experiments (tenant_id, name, description, menu_item_id, variant_a_price, variant_b_price, split_percent, status, start_date, end_date, results, demo_batch_id)
      VALUES ($1, $2, $3, $4, $5, $6, 50, 'completed', $7, $8, $9, $10)
    `, [
      tenantId, `Premium Price Test: ${expItem1.name}`, 'Test +12.5% price increase on top seller',
      expItem1.id, basePrice1, variantB1,
      exp1Start.toISOString(), exp1End.toISOString(),
      JSON.stringify({
        winner: 'b', confidence: 0.92,
        variant_a: { orders: 45, revenue: Math.round(45 * basePrice1 * 100) / 100 },
        variant_b: { orders: 42, revenue: Math.round(42 * variantB1 * 100) / 100 },
      }),
      batchId,
    ]);
    summary.pricing_experiments++;

    // Running experiment (5 days ago → ongoing)
    const exp2Start = new Date(); exp2Start.setDate(exp2Start.getDate() - 5);
    const basePrice2 = Number(expItem2.price);
    const variantB2 = Math.round(basePrice2 * 0.9 * 100) / 100;

    await adminSql.unsafe(`
      INSERT INTO pricing_experiments (tenant_id, name, description, menu_item_id, variant_a_price, variant_b_price, split_percent, status, start_date, end_date, results, demo_batch_id)
      VALUES ($1, $2, $3, $4, $5, $6, 50, 'running', $7, NULL, $8, $9)
    `, [
      tenantId, `Discount Test: ${expItem2.name}`, 'Test 10% discount to increase volume',
      expItem2.id, basePrice2, variantB2,
      exp2Start.toISOString(),
      JSON.stringify({
        variant_a: { orders: 18, revenue: Math.round(18 * basePrice2 * 100) / 100 },
        variant_b: { orders: 22, revenue: Math.round(22 * variantB2 * 100) / 100 },
      }),
      batchId,
    ]);
    summary.pricing_experiments++;
  }

  // ─── 15. Dynamic Pricing — Price History ──────────────────

  const priceSources = [
    { source: 'manual', weight: 0.30 },
    { source: 'ai_suggestion', weight: 0.25 },
    { source: 'scheduled_rule', weight: 0.20 },
    { source: 'ab_test', weight: 0.15 },
    { source: 'revert', weight: 0.10 },
  ];

  const priceReasons = [
    'Weekend promotion adjustment', 'AI-recommended price optimization',
    'Scheduled happy hour rule', 'A/B test result applied',
    'Reverted to original price', 'Manual menu update',
    'High-demand surge pricing', 'Low-demand discount',
    'Cost increase pass-through', 'Competitor price match',
  ];

  const historyCount = randInt(8, 12);
  for (let h = 0; h < historyCount; h++) {
    const item = pick(menuItems);
    const basePrice = Number(item.price);
    const changePct = randFloat(-15, 15);
    const newPrice = Math.round(basePrice * (1 + changePct / 100) * 100) / 100;
    const { source } = pickWeighted(priceSources);
    const daysAgo = randInt(0, 14);
    const histDate = new Date();
    histDate.setDate(histDate.getDate() - daysAgo);
    histDate.setHours(randInt(8, 20), randInt(0, 59), 0);

    const ruleId = source === 'scheduled_rule' && ruleIds.length > 0 ? pick(ruleIds) : null;

    await adminSql.unsafe(`
      INSERT INTO price_history (tenant_id, menu_item_id, old_price, new_price, change_percent, reason, source, pricing_rule_id, revenue_before_daily, revenue_after_daily, created_at, demo_batch_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    `, [
      tenantId, item.id, basePrice, newPrice, Math.round(changePct * 100) / 100,
      pick(priceReasons), source, ruleId,
      randFloat(800, 3000), randFloat(850, 3200),
      histDate.toISOString(), batchId,
    ]);
    summary.price_history++;
  }

  // ─── 16. AI Suggestion Events ─────────────────────────────

  {
    const eventCount = randInt(25, 35);
    const eventTypes = ['upsell', 'inventory_push', 'combo_upgrade', 'dynamic_pricing', 'waste_alert', 'cost_optimization', 'staff_scheduling', 'seasonal_menu'];
    const eventActions = [
      { action: 'accepted', weight: 0.65 },
      { action: 'dismissed', weight: 0.35 },
    ];

    for (let e = 0; e < eventCount; e++) {
      const suggType = pick(eventTypes);
      const { action } = pickWeighted(eventActions);
      const ts = randomTimestamp(dateRangeDays);
      const employee = pick(employees);
      const order = generatedOrders.length > 0 ? pick(generatedOrders) : null;

      await adminSql.unsafe(`
        INSERT INTO ai_suggestion_events (tenant_id, suggestion_type, suggestion_data, action, employee_id, order_id, created_at, demo_batch_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `, [
        tenantId, suggType,
        JSON.stringify({ type: suggType, message: `AI ${suggType.replace(/_/g, ' ')} suggestion`, confidence: randFloat(0.6, 0.95) }),
        action, employee.id, order?.id || null,
        ts.toISOString(), batchId,
      ]);
      summary.ai_suggestion_events++;
    }
  }

  // ─── 17. Waste Alert Suggestions in AI Cache ─────────────

  if (inventoryItems.length > 0) {
    const wasteAlertCount = randInt(5, 8);
    const wasteAlertItems = shuffle(inventoryItems).slice(0, wasteAlertCount);
    const wasteReasonsList = ['spoilage', 'prep_error', 'expired'];

    for (const item of wasteAlertItems) {
      const wastePct = randFloat(16, 35);
      const topReason = pick(wasteReasonsList);
      await adminSql.unsafe(`
        INSERT INTO ai_suggestion_cache (tenant_id, suggestion_type, trigger_context, suggestion_data, priority, expires_at, demo_batch_id)
        VALUES ($1, 'waste_alert', $2, $3, $4, NOW() + INTERVAL '48 hours', $5)
      `, [
        tenantId, `waste-${item.id}`,
        JSON.stringify({
          inventory_item_id: item.id,
          item_name: item.name,
          waste_rate_percent: wastePct,
          top_reason: topReason,
          message: `${item.name}: tasa de desperdicio ${wastePct.toFixed(1)}% — principal causa: ${topReason === 'spoilage' ? 'deterioro' : topReason === 'prep_error' ? 'error de preparación' : 'caducidad'}`,
          recommended_action: wastePct > 25
            ? 'Reducir pedido semanal y revisar almacenamiento'
            : 'Ajustar par levels y capacitar personal',
        }),
        wastePct > 25 ? randInt(85, 95) : randInt(70, 84),
        batchId,
      ]);
      summary.ai_suggestion_cache++;
    }
  }

  // ─── 18. Additional AI Examples ───────────────────────────

  {
    // Seasonal menu suggestions
    const seasonalItems = shuffle(menuItems).slice(0, randInt(2, 3));
    for (const item of seasonalItems) {
      await adminSql.unsafe(`
        INSERT INTO ai_suggestion_cache (tenant_id, suggestion_type, trigger_context, suggestion_data, priority, expires_at, demo_batch_id)
        VALUES ($1, 'seasonal_menu', $2, $3, $4, NOW() + INTERVAL '72 hours', $5)
      `, [
        tenantId, `seasonal-${item.id}`,
        JSON.stringify({
          menu_item_id: item.id,
          item_name: item.name,
          suggestion: `Promote ${item.name} as seasonal special — trending ingredient costs are down 12%`,
          expected_lift: `${randInt(8, 20)}% more orders`,
          confidence: randFloat(0.7, 0.9),
        }),
        randInt(65, 80),
        batchId,
      ]);
      summary.ai_suggestion_cache++;
    }

    // Cost optimization suggestions
    const costItems = shuffle(menuItems).slice(0, randInt(2, 4));
    for (const item of costItems) {
      const currentMargin = randFloat(25, 40);
      const suggestedMargin = currentMargin + randFloat(3, 8);
      await adminSql.unsafe(`
        INSERT INTO ai_suggestion_cache (tenant_id, suggestion_type, trigger_context, suggestion_data, priority, expires_at, demo_batch_id)
        VALUES ($1, 'cost_optimization', $2, $3, $4, NOW() + INTERVAL '48 hours', $5)
      `, [
        tenantId, `cost-opt-${item.id}`,
        JSON.stringify({
          menu_item_id: item.id,
          item_name: item.name,
          current_margin_percent: Math.round(currentMargin * 10) / 10,
          suggested_margin_percent: Math.round(suggestedMargin * 10) / 10,
          action: `Substitute supplier for ${item.name} to increase margin from ${currentMargin.toFixed(1)}% to ${suggestedMargin.toFixed(1)}%`,
          potential_monthly_savings: `$${randInt(500, 2000)} MXN`,
        }),
        randInt(70, 85),
        batchId,
      ]);
      summary.ai_suggestion_cache++;
    }

    // Staff scheduling suggestions
    const schedConfigs = [
      { label: 'weekday lunch', window: '12:00-14:00' },
      { label: 'Friday dinner', window: '19:00-22:00' },
      { label: 'Saturday peak', window: '13:00-21:00' },
    ];
    const schedCount = randInt(2, 3);
    for (let sh = 0; sh < schedCount; sh++) {
      const cfg = schedConfigs[sh];
      await adminSql.unsafe(`
        INSERT INTO ai_suggestion_cache (tenant_id, suggestion_type, trigger_context, suggestion_data, priority, expires_at, demo_batch_id)
        VALUES ($1, 'staff_scheduling', $2, $3, $4, NOW() + INTERVAL '24 hours', $5)
      `, [
        tenantId, `staff-${sh}`,
        JSON.stringify({
          time_window: cfg.window,
          label: cfg.label,
          current_staff: randInt(2, 4),
          recommended_staff: randInt(4, 6),
          avg_wait_increase: `${randFloat(3, 8).toFixed(1)} min`,
          message: `${cfg.label.charAt(0).toUpperCase() + cfg.label.slice(1)} shows ${randInt(25, 45)}% understaffing — add ${randInt(1, 2)} more staff`,
        }),
        randInt(60, 80),
        batchId,
      ]);
      summary.ai_suggestion_cache++;
    }

    // Revenue opportunity suggestion
    await adminSql.unsafe(`
      INSERT INTO ai_suggestion_cache (tenant_id, suggestion_type, trigger_context, suggestion_data, priority, expires_at, demo_batch_id)
      VALUES ($1, 'revenue_opportunity', $2, $3, $4, NOW() + INTERVAL '24 hours', $5)
    `, [
      tenantId, 'rev-delivery-gap',
      JSON.stringify({
        insight: 'Delivery orders average 23% higher ticket than POS orders',
        action: 'Increase delivery menu visibility and add combo deals for delivery platforms',
        potential_impact: `+$${randInt(5000, 15000)} MXN/month`,
        confidence: randFloat(0.75, 0.92),
      }),
      randInt(80, 95),
      batchId,
    ]);
    summary.ai_suggestion_cache++;

    // Peak hour optimization
    await adminSql.unsafe(`
      INSERT INTO ai_suggestion_cache (tenant_id, suggestion_type, trigger_context, suggestion_data, priority, expires_at, demo_batch_id)
      VALUES ($1, 'peak_optimization', $2, $3, $4, NOW() + INTERVAL '24 hours', $5)
    `, [
      tenantId, 'peak-lunch-opt',
      JSON.stringify({
        insight: 'Lunch rush (12-2pm) has 35% longer ticket times than dinner',
        action: 'Pre-prep high-demand items before 11:30am and add a dedicated expeditor',
        potential_impact: `${randInt(15, 25)}% faster service, +$${randInt(3000, 8000)} MXN/month`,
        confidence: randFloat(0.80, 0.95),
      }),
      randInt(75, 90),
      batchId,
    ]);
    summary.ai_suggestion_cache++;

    // Menu engineering suggestion
    const lowPerformer = pick(menuItems);
    await adminSql.unsafe(`
      INSERT INTO ai_suggestion_cache (tenant_id, suggestion_type, trigger_context, suggestion_data, priority, expires_at, demo_batch_id)
      VALUES ($1, 'menu_engineering', $2, $3, $4, NOW() + INTERVAL '48 hours', $5)
    `, [
      tenantId, `menu-eng-${lowPerformer.id}`,
      JSON.stringify({
        menu_item_id: lowPerformer.id,
        item_name: lowPerformer.name,
        category: 'puzzle',
        insight: `${lowPerformer.name} has high margin but low popularity`,
        action: 'Reposition on menu, add photo, or bundle with popular items',
        current_contribution: `${randFloat(1, 4).toFixed(1)}% of revenue`,
        potential_contribution: `${randFloat(5, 10).toFixed(1)}% of revenue`,
      }),
      randInt(70, 85),
      batchId,
    ]);
    summary.ai_suggestion_cache++;
  }

  // ─── 19. Integration Credentials ──────────────────────────

  {
    const integrationCreds = [
      { service: 'stripe', key: 'secret_key', value: 'sk_test_••••demo••••' },
      { service: 'stripe', key: 'publishable_key', value: 'pk_test_••••demo••••' },
      { service: 'stripe', key: 'webhook_secret', value: 'whsec_••••demo••••' },
      { service: 'twilio', key: 'account_sid', value: 'AC_demo_••••••••' },
      { service: 'twilio', key: 'auth_token', value: 'auth_••••demo••••' },
      { service: 'twilio', key: 'phone_number', value: '+15551234567' },
      { service: 'mercado_pago', key: 'client_id', value: 'mp_client_••••demo' },
      { service: 'mercado_pago', key: 'client_secret', value: 'mp_secret_••••demo' },
      { service: 'facturapi', key: 'api_key', value: 'fapi_••••demo••••' },
      { service: 'xai', key: 'api_key', value: 'xai_••••demo••••' },
      { service: 'uber_eats', key: 'client_id', value: 'ue_client_••••demo' },
      { service: 'uber_eats', key: 'client_secret', value: 'ue_secret_••••demo' },
      { service: 'uber_eats', key: 'store_id', value: 'ue_store_••••demo' },
      { service: 'uber_eats', key: 'webhook_secret', value: 'ue_whsec_••••demo' },
      { service: 'rappi', key: 'client_id', value: 'rappi_client_••••demo' },
      { service: 'rappi', key: 'client_secret', value: 'rappi_secret_••••demo' },
      { service: 'rappi', key: 'store_id', value: 'rappi_store_••••demo' },
      { service: 'didi_food', key: 'app_id', value: 'didi_app_••••demo' },
      { service: 'didi_food', key: 'app_secret', value: 'didi_secret_••••demo' },
      { service: 'didi_food', key: 'store_id', value: 'didi_store_••••demo' },
    ];

    for (const cred of integrationCreds) {
      await adminSql.unsafe(`
        INSERT INTO tenant_credentials (tenant_id, service, "key", value, demo_batch_id)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (tenant_id, service, "key") DO NOTHING
      `, [tenantId, cred.service, cred.key, cred.value, batchId]);
      summary.tenant_credentials++;
    }
  }

  // ─── 20. Adjust Inventory for Prep Forecast ───────────────

  if (inventoryItems.length > 0) {
    const lowStockCount = Math.ceil(inventoryItems.length * randFloat(0.20, 0.30));
    const lowStockItems = shuffle(inventoryItems).slice(0, lowStockCount);

    for (const item of lowStockItems) {
      const [inv] = await adminSql.unsafe(`
        SELECT low_stock_threshold FROM inventory_items WHERE id = $1 AND tenant_id = $2
      `, [item.id, tenantId]);
      if (inv && Number(inv.low_stock_threshold) > 0) {
        const newQty = Math.round(Number(inv.low_stock_threshold) * randFloat(0.30, 0.70) * 100) / 100;
        await adminSql.unsafe(`
          UPDATE inventory_items SET quantity = $1 WHERE id = $2 AND tenant_id = $3
        `, [newQty, item.id, tenantId]);
      }
    }
  }

  } catch (optionalErr) {
    console.warn('[DemoData] Optional sections (11-20) partially failed (non-fatal):', optionalErr.message);
  }

  // ─── 21. Auto-Trigger AI Pipeline ─────────────────────────
  // Run shrinkage detection and waste analysis with proper tenant RLS context

  try {
    const { tenantSql } = await import('../db/index.js');
    await tenantSql.begin(async (tx) => {
      await tx`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      await new Promise((resolve, reject) => {
        tenantContext.run({ conn: tx, tenantId }, async () => {
          try {
            await detectShrinkagePatterns();
            await analyzeWastePatterns();
            resolve();
          } catch (e) { reject(e); }
        });
      });
    });
    console.log('[DemoData] AI pipeline triggered successfully');
  } catch (err) {
    console.warn('[DemoData] AI pipeline trigger failed (non-fatal):', err.message);
  }

  return summary;
}
