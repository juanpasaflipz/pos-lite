#!/usr/bin/env node
/**
 * Seed a demo organization: "Helados y Donas SA de CV" — 100 stores in the
 * Guadalajara metro area with ~35 days of realistic ice-cream/donut sales.
 *
 * Built for the corporate-dashboard demo (routes/org.js + /#/org screen).
 *
 * Usage:
 *   node scripts/seed-helados-demo.js            # seed (refuses if org exists)
 *   node scripts/seed-helados-demo.js --purge    # remove org + all its stores
 *
 * Env knobs:
 *   SEED_STORES=100         number of stores (default 100)
 *   SEED_DAYS=35            days of history (default 35)
 *   SEED_ORG_PASSWORD=...   corporate login password (default printed at end)
 *
 * Notes:
 * - Run against the target DB via DATABASE_URL (same as the server). Seeding
 *   ~150k orders takes a while on Neon (10–25 min); progress is logged.
 * - Everything is isolated in tenants 'hyd-001'…'hyd-NNN' + org
 *   'helados-y-donas'; --purge removes it all via the prod-safe purgeTenant.
 */

import 'dotenv/config';
import bcrypt from 'bcrypt';
import { adminSql, shutdown } from '../server/db/index.js';
import { createTenant } from '../server/tenants.js';
import { purgeTenant } from '../server/helpers/tenantPurge.js';

const ORG_ID = 'helados-y-donas';
const ORG_NAME = 'Helados y Donas SA de CV';
const ORG_EMAIL = 'corporativo@heladosydonas.mx';
const ORG_PASSWORD = process.env.SEED_ORG_PASSWORD || 'HeladosDonas2026!';

const STORES = Math.min(parseInt(process.env.SEED_STORES) || 100, 200);
const DAYS = Math.min(parseInt(process.env.SEED_DAYS) || 35, 90);
const TZ_OFFSET_HOURS = 6; // America/Mexico_City (UTC-6)

// ==================== Store catalog ====================

const GDL_LOCATIONS = [
  'Centro Histórico', 'Chapultepec', 'Providencia', 'Andares', 'Punto Sao Paulo',
  'Plaza del Sol', 'Gran Plaza', 'Plaza México', 'La Gran Vía', 'Minerva',
  'Zapopan Centro', 'Plaza Patria', 'Plaza Universidad', 'Ciudad Granja', 'Valle Real',
  'Tlaquepaque Centro', 'Plaza Forum', 'Tonalá Centro', 'Loma Dorada', 'Santa Tere',
  'Americana', 'Lafayette', 'Moderna', 'Oblatos', 'Tetlán',
  'Huentitán', 'Independencia', 'Medrano', 'Olímpica', 'Del Fresno',
  'Jardines del Bosque', 'Chapalita', 'Las Águilas', 'Cruz del Sur', 'Lomas de Polanco',
  'El Sauz', 'Miravalle', 'Toluquilla', 'Santa María Tequepexpan', 'López Mateos Sur',
  'Palomar', 'Bugambilias', 'Concepción del Valle', 'San Agustín', 'Santa Anita',
  'Tesistán', 'Arcos de Zapopan', 'Constitución', 'Atemajac', 'Zoquipan',
];

function storeName(i) {
  const loc = GDL_LOCATIONS[i % GDL_LOCATIONS.length];
  const round = Math.floor(i / GDL_LOCATIONS.length);
  return round === 0 ? `Helados y Donas ${loc}` : `Helados y Donas ${loc} ${round + 1}`;
}

// tier: flagship (mall anchors, high volume) / standard / kiosco (street stands)
function storeTier(i) {
  if (i % 10 === 0) return { key: 'flagship', volume: 1.5 };
  if (i % 3 === 0) return { key: 'kiosco', volume: 0.55 };
  return { key: 'standard', volume: 1.0 };
}

// ==================== Menu ====================

const MENU = [
  { cat: 'Helados', items: [
    { name: 'Cono Sencillo', price: 35, w: 20 },
    { name: 'Cono Doble', price: 55, w: 14 },
    { name: 'Copa Sundae', price: 65, w: 8 },
    { name: 'Banana Split', price: 85, w: 4 },
    { name: 'Litro para Llevar', price: 120, w: 3 },
  ]},
  { cat: 'Paletas', items: [
    { name: 'Paleta de Agua', price: 25, w: 12 },
    { name: 'Paleta de Crema', price: 32, w: 10 },
    { name: 'Paleta Cubierta de Chocolate', price: 40, w: 6 },
  ]},
  { cat: 'Donas', items: [
    { name: 'Dona Glaseada', price: 22, w: 16 },
    { name: 'Dona de Chocolate', price: 25, w: 12 },
    { name: 'Caja 6 Donas', price: 120, w: 3 },
  ]},
  { cat: 'Bebidas', items: [
    { name: 'Malteada de Fresa', price: 60, w: 6 },
    { name: 'Café Americano', price: 30, w: 8 },
    { name: 'Frappé de Vainilla', price: 55, w: 5 },
  ]},
  { cat: 'Combos', items: [
    { name: 'Combo Dona + Café', price: 45, w: 7 },
    { name: 'Combo Familiar', price: 199, w: 2 },
  ]},
];

const FLAT_MENU = MENU.flatMap((c) => c.items);
const TOTAL_WEIGHT = FLAT_MENU.reduce((s, m) => s + m.w, 0);

function pickItem(rng) {
  let r = rng() * TOTAL_WEIGHT;
  for (const item of FLAT_MENU) {
    r -= item.w;
    if (r <= 0) return item;
  }
  return FLAT_MENU[0];
}

// Deterministic PRNG so re-seeds produce comparable curves (mulberry32).
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Sun..Sat — ice cream peaks on weekends
const WEEKDAY_FACTOR = [1.3, 0.75, 0.8, 0.85, 0.95, 1.15, 1.45];
const BASE_ORDERS_PER_DAY = 46;

// ==================== Seeding ====================

async function ensureNotSeeded() {
  const [org] = await adminSql`SELECT id FROM organizations WHERE id = ${ORG_ID}`;
  if (org) {
    console.error(`Organization '${ORG_ID}' already exists. Run with --purge first to re-seed.`);
    process.exit(1);
  }
}

async function createOrg() {
  const hash = await bcrypt.hash(ORG_PASSWORD, 12);
  await adminSql`
    INSERT INTO organizations (id, name, admin_email, admin_password_hash)
    VALUES (${ORG_ID}, ${ORG_NAME}, ${ORG_EMAIL}, ${hash})
  `;
  console.log(`[Org] Created '${ORG_NAME}' (${ORG_ID})`);
}

async function createStore(i, sharedOwnerHash) {
  const n = String(i + 1).padStart(3, '0');
  const id = `hyd-${n}`;
  const tier = storeTier(i);

  await createTenant({
    id,
    name: storeName(i),
    subdomain: id,
    owner_email: `${id}@heladosydonas.mx`,
    owner_password_hash: sharedOwnerHash,
    plan: 'pro',
  });
  await adminSql`UPDATE tenants SET org_id = ${ORG_ID} WHERE id = ${id}`;

  // One counter employee per store (orders.employee_id is NOT NULL)
  const [emp] = await adminSql`
    INSERT INTO employees (tenant_id, name, pin, role)
    VALUES (${id}, 'Mostrador', ${String(2000 + i)}, 'cashier')
    RETURNING id
  `;

  // Menu (not strictly needed for the dashboard, but makes per-store POS
  // demos work if you open one live during the pitch)
  const itemIds = {};
  for (const cat of MENU) {
    const [c] = await adminSql`
      INSERT INTO menu_categories (tenant_id, name, sort_order)
      VALUES (${id}, ${cat.cat}, 0)
      RETURNING id
    `;
    for (const item of cat.items) {
      const [mi] = await adminSql`
        INSERT INTO menu_items (tenant_id, category_id, name, price)
        VALUES (${id}, ${c.id}, ${item.name}, ${item.price})
        RETURNING id
      `;
      itemIds[item.name] = mi.id;
    }
  }

  return { id, tier, employeeId: emp.id, itemIds };
}

function buildOrdersForStore(store, storeIndex) {
  const rng = mulberry32(1234 + storeIndex * 7919);
  const orders = [];
  const now = Date.now();

  for (let d = DAYS - 1; d >= 0; d--) {
    const dayStartUtc = new Date(now - d * 86400_000);
    // Local midnight (approx, fixed UTC-6 — fine for demo data)
    dayStartUtc.setUTCHours(TZ_OFFSET_HOURS, 0, 0, 0);
    const weekday = new Date(dayStartUtc.getTime() - TZ_OFFSET_HOURS * 3600_000).getUTCDay();

    const target = Math.round(
      BASE_ORDERS_PER_DAY * store.tier.volume * WEEKDAY_FACTOR[weekday] * (0.85 + rng() * 0.3),
    );

    for (let k = 0; k < target; k++) {
      // Sales window 11:00–21:30 local, weighted toward the 16:00–20:00 peak
      const peak = rng() < 0.6;
      const hour = peak ? 16 + rng() * 4 : 11 + rng() * 10.5;
      const createdAt = new Date(dayStartUtc.getTime() + hour * 3600_000);
      if (createdAt.getTime() > now) continue; // don't seed the future today

      const itemCount = 1 + Math.floor(rng() * rng() * 4); // skew toward 1–2
      const items = [];
      let subtotal = 0;
      for (let j = 0; j < itemCount; j++) {
        const menuItem = pickItem(rng);
        const qty = rng() < 0.15 ? 2 : 1;
        items.push({ menuItem, qty });
        subtotal += menuItem.price * qty;
      }

      const isCard = rng() < 0.45;
      const tip = isCard && rng() < 0.25 ? Math.round(subtotal * 0.1) : 0;

      orders.push({
        order_number: (DAYS - d) * 1000 + k + 1,
        employee_id: store.employeeId,
        status: 'completed',
        subtotal,
        tax: 0,
        tip,
        total: subtotal + tip,
        payment_status: 'paid',
        payment_method: isCard ? 'card' : 'cash',
        source: store.tier.key === 'kiosco' ? 'pos' : (rng() < 0.3 ? 'kiosk' : 'pos'),
        created_at: createdAt,
        paid_at: createdAt,
        completed_at: new Date(createdAt.getTime() + 5 * 60_000),
        items,
      });
    }
  }
  return orders;
}

async function insertOrders(store, orders) {
  const CHUNK = 500;
  for (let i = 0; i < orders.length; i += CHUNK) {
    const chunk = orders.slice(i, i + CHUNK);
    const orderRows = chunk.map((o) => ({
      tenant_id: store.id,
      order_number: o.order_number,
      employee_id: o.employee_id,
      status: o.status,
      subtotal: o.subtotal,
      tax: o.tax,
      tip: o.tip,
      total: o.total,
      payment_status: o.payment_status,
      payment_method: o.payment_method,
      source: o.source,
      created_at: o.created_at,
      paid_at: o.paid_at,
      completed_at: o.completed_at,
    }));

    // postgres.js returns RETURNING rows in insertion order — safe to zip.
    const inserted = await adminSql`
      INSERT INTO orders ${adminSql(
        orderRows,
        'tenant_id', 'order_number', 'employee_id', 'status', 'subtotal', 'tax',
        'tip', 'total', 'payment_status', 'payment_method', 'source',
        'created_at', 'paid_at', 'completed_at',
      )}
      RETURNING id
    `;

    const itemRows = [];
    chunk.forEach((o, idx) => {
      for (const { menuItem, qty } of o.items) {
        itemRows.push({
          tenant_id: store.id,
          order_id: inserted[idx].id,
          menu_item_id: store.itemIds[menuItem.name] ?? null,
          item_name: menuItem.name,
          quantity: qty,
          unit_price: menuItem.price,
        });
      }
    });

    if (itemRows.length > 0) {
      await adminSql`
        INSERT INTO order_items ${adminSql(
          itemRows,
          'tenant_id', 'order_id', 'menu_item_id', 'item_name', 'quantity', 'unit_price',
        )}
      `;
    }
  }
}

async function seed() {
  await ensureNotSeeded();
  await createOrg();

  const sharedOwnerHash = await bcrypt.hash(`store-${ORG_ID}-demo`, 10);
  let totalOrders = 0;
  const t0 = Date.now();

  for (let i = 0; i < STORES; i++) {
    const store = await createStore(i, sharedOwnerHash);
    const orders = buildOrdersForStore(store, i);
    await insertOrders(store, orders);
    totalOrders += orders.length;

    if ((i + 1) % 10 === 0 || i === STORES - 1) {
      const mins = ((Date.now() - t0) / 60000).toFixed(1);
      console.log(`[Seed] ${i + 1}/${STORES} stores · ${totalOrders.toLocaleString()} orders · ${mins} min`);
    }
  }

  console.log('\n================ DEMO READY ================');
  console.log(`Org:       ${ORG_NAME}`);
  console.log(`Stores:    ${STORES} · Orders: ${totalOrders.toLocaleString()} (${DAYS} days)`);
  console.log(`Dashboard: https://pos.desktop.kitchen/#/org`);
  console.log(`Login:     ${ORG_EMAIL}`);
  console.log(`Password:  ${ORG_PASSWORD}`);
  console.log('============================================\n');
}

async function purge() {
  const tenants = await adminSql`SELECT id FROM tenants WHERE org_id = ${ORG_ID} ORDER BY id`;
  console.log(`[Purge] Removing ${tenants.length} stores of org '${ORG_ID}'...`);
  for (let i = 0; i < tenants.length; i++) {
    await purgeTenant(tenants[i].id);
    await adminSql`DELETE FROM tenants WHERE id = ${tenants[i].id}`;
    if ((i + 1) % 10 === 0 || i === tenants.length - 1) {
      console.log(`[Purge] ${i + 1}/${tenants.length}`);
    }
  }
  await adminSql`DELETE FROM organizations WHERE id = ${ORG_ID}`;
  console.log('[Purge] Done.');
}

(async () => {
  try {
    if (process.argv.includes('--purge')) {
      await purge();
    } else {
      await seed();
    }
  } catch (err) {
    console.error('Seed failed:', err);
    process.exitCode = 1;
  } finally {
    await shutdown();
  }
})();
