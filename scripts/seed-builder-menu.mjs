#!/usr/bin/env node
// Phase 1 seed for the kiosk burrito-builder — see design/kiosk-builder-menu-spec.md
// and the 2026-07-27 HANDOFF entry. Creates a hidden category, 10 items,
// 29 modifier groups, 136 options for a single tenant (juanbertos). All rows
// active=false so nothing is visible to live customers until Phase 2 ships.
//
// Usage:
//   node scripts/seed-builder-menu.mjs --tenant juanbertos --dry-run
//   node scripts/seed-builder-menu.mjs --tenant juanbertos
//
// Idempotent: SELECT-then-INSERT-OR-UPDATE keyed on stable name tuples. Never
// deletes. Real run wraps the whole thing in adminSql.begin() so partial state
// cannot leak. The spec anticipated that modifier_groups are shared (not
// per-item) — we materialize per-item copies with internal `__<slug>` suffixes.

import 'dotenv/config';
import { adminSql } from '../server/db/index.js';

// ---------- CLI ----------
const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const tenantIdx = argv.indexOf('--tenant');
const tenantArg = tenantIdx >= 0 ? argv[tenantIdx + 1] : null;
if (!tenantArg) {
  console.error('Missing --tenant. Usage: node scripts/seed-builder-menu.mjs --tenant <id-or-subdomain> [--dry-run]');
  process.exit(2);
}

// ---------- Spec data ----------
const CATEGORY = { name: 'Arma tu burrito', sort_order: 999 };

const PROTEINS = [
  { slug: 'asada',      name: 'Burrito Carne Asada',  name_en: 'Carne Asada Burrito',      price: 250, friesAdj: 49, friesConfirmed: true  },
  { slug: 'pollo',      name: 'Burrito Pollo Asado',  name_en: 'Grilled Chicken Burrito',  price: 219, friesAdj: 49, friesConfirmed: false },
  { slug: 'porkbelly',  name: 'Burrito Porkbelly',    name_en: 'Pork Belly Burrito',       price: 230, friesAdj: 69, friesConfirmed: true  },
  { slug: 'huevo',      name: 'Burrito Huevo',        name_en: 'Egg Burrito',              price: 180, friesAdj: 49, friesConfirmed: false },
  { slug: 'portobello', name: 'Burrito Portobello',   name_en: 'Portobello Burrito',       price: 170, friesAdj: 49, friesConfirmed: false },
  { slug: 'camaron',    name: 'Burrito Camarón',      name_en: 'Shrimp Burrito',           price: 240, friesAdj: 49, friesConfirmed: false },
  { slug: 'pescado',    name: 'Burrito Pescado',      name_en: 'Baja Fish Burrito',        price: 265, friesAdj: 49, friesConfirmed: false },
];

const PROTEIN_LABELS = {
  asada:      { es: 'Carne Asada', en: 'Carne Asada' },
  pollo:      { es: 'Pollo Asado', en: 'Grilled Chicken' },
  porkbelly:  { es: 'Porkbelly',   en: 'Pork Belly' },
  huevo:      { es: 'Huevo',       en: 'Egg' },
  portobello: { es: 'Portobello',  en: 'Portobello' },
  camaron:    { es: 'Camarón',     en: 'Shrimp' },
  pescado:    { es: 'Pescado',     en: 'Baja Fish' },
  chorizo:    { es: 'Chorizo',     en: 'Chorizo' },
};

// SECOND_MATRIX[base][add] = [adj, confirmed]. Only two cells are confirmed
// anchors — asada+camaron=340 and huevo+chorizo=210 — everything else is the
// +$90 fallback (max(pA,pB)+90 - base) and gets a ⚠️ in the placeholder summary.
const SECOND_MATRIX = {
  asada:      { pollo:[90,false],  porkbelly:[90,false],  huevo:[90,false],  portobello:[90,false],  camaron:[90,true],   pescado:[105,false] },
  pollo:      { asada:[121,false], porkbelly:[101,false], huevo:[90,false],  portobello:[90,false],  camaron:[111,false], pescado:[136,false] },
  porkbelly:  { asada:[110,false], pollo:[90,false],      huevo:[90,false],  portobello:[90,false],  camaron:[100,false], pescado:[125,false] },
  huevo:      { asada:[160,false], pollo:[129,false],     porkbelly:[140,false], portobello:[90,false], camaron:[150,false], pescado:[175,false], chorizo:[30,true] },
  portobello: { asada:[170,false], pollo:[139,false],     porkbelly:[150,false], huevo:[100,false],   camaron:[160,false], pescado:[185,false] },
  camaron:    { asada:[100,false], pollo:[90,false],      porkbelly:[90,false],  huevo:[90,false],   portobello:[90,false], pescado:[115,false] },
  pescado:    { asada:[90,false],  pollo:[90,false],      porkbelly:[90,false],  huevo:[90,false],   portobello:[90,false], camaron:[90,false]  },
};

const QUITAR = [
  'Sin papas a la francesa', 'Sin arroz', 'Sin frijoles', 'Sin queso',
  'Sin guacamole', 'Sin pico de gallo', 'Sin crema',
];

const EXTRAS = [
  { name: 'Guacamole extra', adj: 35, confirmed: false },
  { name: 'Queso extra',     adj: 25, confirmed: false },
  { name: 'Cebollita asada', adj: 20, confirmed: false },
];

const FIXED_ITEMS = [
  { key: 'birria',     name: 'Burrito de Birria',                        name_en: 'Birria Burrito',                      price: 99  },
  { key: 'cochinita',  name: 'Burrito de Cochinita Pibil',               name_en: 'Cochinita Pibil Burrito',             price: 99  },
  { key: 'rollbertos', name: 'Rollbertos — Taquitos dorados de queso',   name_en: 'Rollbertos — Rolled cheese taquitos', price: 139 },
];

// ---------- Plan builders ----------

// Groups (name/required/min/max/type) attached to each of the 7 builder items.
function builderGroupsFor(p, index) {
  return [
    { key: 'estilo',     name: `Estilo__${p.slug}`,            selection_type: 'single',   required: true,  min: 1, max: 1, sort: 1 },
    { key: 'segunda',    name: `Segunda proteína__${p.slug}`,  selection_type: 'single',   required: false, min: 0, max: 1, sort: 2 },
    { key: 'quitar',     name: `Quitar__${p.slug}`,            selection_type: 'multiple', required: false, min: 0, max: QUITAR.length, sort: 3 },
    { key: 'extras',     name: `Extras__${p.slug}`,            selection_type: 'multiple', required: false, min: 0, max: EXTRAS.length,  sort: 4 },
  ];
}

function estiloOptions(p) {
  return [
    { name: 'California', price_adjustment: 0,           sort: 1, confirmed: true },
    { name: 'Mission',    price_adjustment: 0,           sort: 2, confirmed: true },
    { name: 'Fries',      price_adjustment: p.friesAdj,  sort: 3, confirmed: p.friesConfirmed },
  ];
}

function segundaOptions(baseSlug) {
  const row = SECOND_MATRIX[baseSlug] || {};
  const order = ['asada','pollo','porkbelly','huevo','portobello','camaron','pescado','chorizo'];
  const opts = [];
  let sort = 0;
  for (const s of order) {
    const cell = row[s];
    if (!cell) continue;
    sort += 1;
    opts.push({
      name: PROTEIN_LABELS[s].es,
      price_adjustment: cell[0],
      sort,
      confirmed: cell[1],
    });
  }
  return opts;
}

function quitarOptions() {
  return QUITAR.map((n, i) => ({ name: n, price_adjustment: 0, sort: i + 1, confirmed: true }));
}

function extrasOptions() {
  return EXTRAS.map((e, i) => ({ name: e.name, price_adjustment: e.adj, sort: i + 1, confirmed: e.confirmed }));
}

// ---------- DB helpers (SELECT-then-INSERT-OR-UPDATE) ----------

async function resolveTenant(sql, arg) {
  const rows = await sql`
    SELECT id, subdomain, name
    FROM tenants
    WHERE id = ${arg} OR subdomain = ${arg}
  `;
  if (rows.length === 0) throw new Error(`No tenant matches "${arg}" by id or subdomain`);
  if (rows.length > 1) throw new Error(`Ambiguous tenant "${arg}" — ${rows.length} matches`);
  return rows[0];
}

async function upsertCategory(sql, tenantId, spec, apply) {
  const existing = await sql`
    SELECT id, sort_order, active FROM menu_categories
    WHERE tenant_id = ${tenantId} AND name = ${spec.name}
  `;
  if (existing.length) {
    const row = existing[0];
    const changed = Number(row.sort_order) !== spec.sort_order || row.active !== false;
    if (apply && changed) {
      await sql`
        UPDATE menu_categories
        SET sort_order = ${spec.sort_order}, active = false
        WHERE id = ${row.id}
      `;
    }
    return { id: row.id, action: changed ? 'UPDATE' : 'NOOP' };
  }
  if (!apply) return { id: null, action: 'INSERT' };
  const [row] = await sql`
    INSERT INTO menu_categories (tenant_id, name, sort_order, active)
    VALUES (${tenantId}, ${spec.name}, ${spec.sort_order}, false)
    RETURNING id
  `;
  return { id: row.id, action: 'INSERT' };
}

async function upsertItem(sql, tenantId, categoryId, spec, apply) {
  const existing = await sql`
    SELECT id, price, name_en, sort_order, active FROM menu_items
    WHERE tenant_id = ${tenantId} AND category_id = ${categoryId} AND name = ${spec.name}
  `;
  if (existing.length) {
    const row = existing[0];
    const changed =
      Number(row.price) !== spec.price ||
      row.name_en !== spec.name_en ||
      Number(row.sort_order) !== spec.sort_order ||
      row.active !== false;
    if (apply && changed) {
      await sql`
        UPDATE menu_items
        SET price = ${spec.price}, name_en = ${spec.name_en},
            sort_order = ${spec.sort_order}, active = false
        WHERE id = ${row.id}
      `;
    }
    return { id: row.id, action: changed ? 'UPDATE' : 'NOOP' };
  }
  if (!apply) return { id: null, action: 'INSERT' };
  const [row] = await sql`
    INSERT INTO menu_items (tenant_id, category_id, name, name_en, price, sort_order, active)
    VALUES (${tenantId}, ${categoryId}, ${spec.name}, ${spec.name_en}, ${spec.price}, ${spec.sort_order}, false)
    RETURNING id
  `;
  return { id: row.id, action: 'INSERT' };
}

async function upsertGroup(sql, tenantId, spec, apply) {
  const existing = await sql`
    SELECT id, selection_type, required, min_selections, max_selections, sort_order, active
    FROM modifier_groups
    WHERE tenant_id = ${tenantId} AND name = ${spec.name}
  `;
  if (existing.length) {
    const row = existing[0];
    const changed =
      row.selection_type !== spec.selection_type ||
      row.required !== spec.required ||
      Number(row.min_selections) !== spec.min ||
      Number(row.max_selections) !== spec.max ||
      Number(row.sort_order) !== spec.sort ||
      row.active !== true;
    if (apply && changed) {
      await sql`
        UPDATE modifier_groups
        SET selection_type = ${spec.selection_type}, required = ${spec.required},
            min_selections = ${spec.min}, max_selections = ${spec.max},
            sort_order = ${spec.sort}, active = true
        WHERE id = ${row.id}
      `;
    }
    return { id: row.id, action: changed ? 'UPDATE' : 'NOOP' };
  }
  if (!apply) return { id: null, action: 'INSERT' };
  const [row] = await sql`
    INSERT INTO modifier_groups
      (tenant_id, name, selection_type, required, min_selections, max_selections, sort_order, active)
    VALUES
      (${tenantId}, ${spec.name}, ${spec.selection_type}, ${spec.required},
       ${spec.min}, ${spec.max}, ${spec.sort}, true)
    RETURNING id
  `;
  return { id: row.id, action: 'INSERT' };
}

async function upsertOption(sql, tenantId, groupId, opt, apply) {
  const existing = await sql`
    SELECT id, price_adjustment, sort_order, active FROM modifiers
    WHERE tenant_id = ${tenantId} AND group_id = ${groupId} AND name = ${opt.name}
  `;
  if (existing.length) {
    const row = existing[0];
    const changed =
      Number(row.price_adjustment) !== opt.price_adjustment ||
      Number(row.sort_order) !== opt.sort ||
      row.active !== true;
    if (apply && changed) {
      await sql`
        UPDATE modifiers
        SET price_adjustment = ${opt.price_adjustment}, sort_order = ${opt.sort}, active = true
        WHERE id = ${row.id}
      `;
    }
    return { id: row.id, action: changed ? 'UPDATE' : 'NOOP' };
  }
  if (!apply) return { id: null, action: 'INSERT' };
  const [row] = await sql`
    INSERT INTO modifiers (tenant_id, group_id, name, price_adjustment, sort_order, active)
    VALUES (${tenantId}, ${groupId}, ${opt.name}, ${opt.price_adjustment}, ${opt.sort}, true)
    RETURNING id
  `;
  return { id: row.id, action: 'INSERT' };
}

async function upsertLink(sql, tenantId, itemId, groupId, sort, apply) {
  if (!itemId || !groupId) return { action: 'INSERT' };
  const existing = await sql`
    SELECT sort_order FROM menu_item_modifier_groups
    WHERE menu_item_id = ${itemId} AND modifier_group_id = ${groupId}
  `;
  if (existing.length) {
    const changed = Number(existing[0].sort_order) !== sort;
    if (apply && changed) {
      await sql`
        UPDATE menu_item_modifier_groups SET sort_order = ${sort}
        WHERE menu_item_id = ${itemId} AND modifier_group_id = ${groupId}
      `;
    }
    return { action: changed ? 'UPDATE' : 'NOOP' };
  }
  if (!apply) return { action: 'INSERT' };
  await sql`
    INSERT INTO menu_item_modifier_groups (tenant_id, menu_item_id, modifier_group_id, sort_order)
    VALUES (${tenantId}, ${itemId}, ${groupId}, ${sort})
  `;
  return { action: 'INSERT' };
}

// ---------- Formatting helpers ----------

function fmtHostFromUrl(url) {
  try { return new URL(url).host.split('@').pop(); } catch { return '(unparseable)'; }
}
function row(...cells) { return cells.join(' | '); }
function warn(x) { return x ? '⚠️ ' : '   '; }

// ---------- Main ----------

async function main() {
  const dbHost = fmtHostFromUrl(process.env.DATABASE_URL || '');
  console.log(`\n=== builder-menu seed (${DRY_RUN ? 'DRY-RUN' : 'REAL'}) ===`);
  console.log(`Target DB host : ${dbHost}`);
  console.log(`Tenant arg     : ${tenantArg}`);

  const tenant = await resolveTenant(adminSql, tenantArg);
  console.log(`Resolved tenant: id=${tenant.id} subdomain=${tenant.subdomain || '(none)'} name="${tenant.name}"\n`);

  const placeholders = [];
  const itemPlan = [];
  const groupPlan = [];
  const optionPlan = [];
  const linkPlan = [];

  // Execute either directly against adminSql (dry-run only reads) or inside a
  // single transaction for the real run. We build up the plan tables inside so
  // that IDs come from the same handle as writes.
  const runner = async (sql) => {
    // Category
    const cat = await upsertCategory(sql, tenant.id, CATEGORY, !DRY_RUN);
    console.log(`Category "${CATEGORY.name}" — ${cat.action} (id=${cat.id ?? 'pending'})\n`);

    // 7 builder items + their 4 groups each + all options + links
    for (let i = 0; i < PROTEINS.length; i++) {
      const p = PROTEINS[i];
      const item = await upsertItem(sql, tenant.id, cat.id, {
        name: p.name, name_en: p.name_en, price: p.price, sort_order: i + 1,
      }, !DRY_RUN);
      itemPlan.push({ name: p.name, price: p.price, action: item.action, id: item.id });

      const groups = builderGroupsFor(p, i);
      for (const g of groups) {
        const grp = await upsertGroup(sql, tenant.id, g, !DRY_RUN);
        groupPlan.push({ name: g.name, required: g.required, min: g.min, max: g.max, type: g.selection_type, action: grp.action, id: grp.id });

        let opts = [];
        if (g.key === 'estilo')  opts = estiloOptions(p);
        if (g.key === 'segunda') opts = segundaOptions(p.slug);
        if (g.key === 'quitar')  opts = quitarOptions();
        if (g.key === 'extras')  opts = extrasOptions();

        for (const o of opts) {
          const opt = await upsertOption(sql, tenant.id, grp.id, o, !DRY_RUN);
          optionPlan.push({ group: g.name, name: o.name, adj: o.price_adjustment, confirmed: o.confirmed, action: opt.action });
          if (!o.confirmed) {
            placeholders.push({ where: `${p.slug} / ${g.key} / ${o.name}`, adj: o.price_adjustment });
          }
        }

        const link = await upsertLink(sql, tenant.id, item.id, grp.id, g.sort, !DRY_RUN);
        linkPlan.push({ item: p.name, group: g.name, sort: g.sort, action: link.action });
      }
    }

    // Fixed items (Birria, Cochinita, Rollbertos)
    for (let i = 0; i < FIXED_ITEMS.length; i++) {
      const f = FIXED_ITEMS[i];
      const item = await upsertItem(sql, tenant.id, cat.id, {
        name: f.name, name_en: f.name_en, price: f.price, sort_order: PROTEINS.length + i + 1,
      }, !DRY_RUN);
      itemPlan.push({ name: f.name, price: f.price, action: item.action, id: item.id });

      if (f.key === 'rollbertos') {
        const gspec = {
          key: 'rollbertos_choice',
          name: '¿Con birria o cochinita?__rollbertos',
          selection_type: 'single', required: true, min: 1, max: 1, sort: 1,
        };
        const grp = await upsertGroup(sql, tenant.id, gspec, !DRY_RUN);
        groupPlan.push({ name: gspec.name, required: true, min: 1, max: 1, type: 'single', action: grp.action, id: grp.id });

        const opts = [
          { name: 'Con birria',    price_adjustment: 0, sort: 1, confirmed: true },
          { name: 'Con cochinita', price_adjustment: 0, sort: 2, confirmed: true },
        ];
        for (const o of opts) {
          const opt = await upsertOption(sql, tenant.id, grp.id, o, !DRY_RUN);
          optionPlan.push({ group: gspec.name, name: o.name, adj: 0, confirmed: true, action: opt.action });
        }
        const link = await upsertLink(sql, tenant.id, item.id, grp.id, gspec.sort, !DRY_RUN);
        linkPlan.push({ item: f.name, group: gspec.name, sort: gspec.sort, action: link.action });
      }
    }

    // Visibility check (real run only — IDs from dry-run are all null)
    if (!DRY_RUN) {
      const ids = itemPlan.map(x => x.id).filter(Boolean);
      const leaked = await sql`
        SELECT id, name FROM menu_items
        WHERE tenant_id = ${tenant.id} AND active = true AND id = ANY(${ids})
      `;
      if (leaked.length) {
        throw new Error(`SAFETY ABORT: ${leaked.length} seeded item(s) came back active=true: ${JSON.stringify(leaked)}`);
      }
    }
  };

  if (DRY_RUN) {
    await runner(adminSql);
  } else {
    await adminSql.begin(runner);
  }

  // ---------- Report ----------
  const summarize = (plan) => {
    const acc = { INSERT: 0, UPDATE: 0, NOOP: 0 };
    for (const r of plan) acc[r.action] = (acc[r.action] || 0) + 1;
    return acc;
  };

  console.log('---- ITEMS (10) ----');
  console.log(row('action'.padEnd(8), 'price'.padStart(6), 'name'));
  for (const r of itemPlan) console.log(row(r.action.padEnd(8), String(r.price).padStart(6), r.name));
  const iS = summarize(itemPlan);
  console.log(`  = ${iS.INSERT} INSERT · ${iS.UPDATE} UPDATE · ${iS.NOOP} NOOP\n`);

  console.log(`---- GROUPS (${groupPlan.length}) ----`);
  console.log(row('action'.padEnd(8), 'req'.padEnd(4), 'min'.padStart(3), 'max'.padStart(3), 'type'.padEnd(9), 'name'));
  for (const r of groupPlan) {
    console.log(row(r.action.padEnd(8), (r.required ? 'yes' : 'no').padEnd(4),
      String(r.min).padStart(3), String(r.max).padStart(3), r.type.padEnd(9), r.name));
  }
  const gS = summarize(groupPlan);
  console.log(`  = ${gS.INSERT} INSERT · ${gS.UPDATE} UPDATE · ${gS.NOOP} NOOP\n`);

  console.log(`---- OPTIONS (${optionPlan.length}) ----`);
  console.log(row('action'.padEnd(8), 'adj'.padStart(6), '⚠', 'group / name'));
  for (const r of optionPlan) {
    console.log(row(r.action.padEnd(8), String(r.adj).padStart(6), warn(!r.confirmed), `${r.group} / ${r.name}`));
  }
  const oS = summarize(optionPlan);
  console.log(`  = ${oS.INSERT} INSERT · ${oS.UPDATE} UPDATE · ${oS.NOOP} NOOP\n`);

  console.log(`---- LINKS (${linkPlan.length}) ----`);
  const lS = summarize(linkPlan);
  console.log(`  = ${lS.INSERT} INSERT · ${lS.UPDATE} UPDATE · ${lS.NOOP} NOOP\n`);

  // Placeholder summary
  console.log(`---- ⚠️ PLACEHOLDER PRICES (${placeholders.length}) — Juan must confirm ----`);
  console.log('These prices were not set by Juan and follow the +$90 fallback rule (Segunda)');
  console.log('or the $49 fries default. Update in Menu Management or re-run this seed with');
  console.log('corrected values in scripts/seed-builder-menu.mjs.\n');
  for (const p of placeholders) {
    console.log(`  ⚠️  ${String(p.adj).padStart(5)}   ${p.where}`);
  }
  console.log('');

  // Acceptance-check totals — computed from the plan's own numbers, not hard-coded.
  console.log('---- ACCEPTANCE CHECKS (computed from seed data) ----');
  const priceOf = (slug) => PROTEINS.find(p => p.slug === slug).price;
  const friesOf = (slug) => PROTEINS.find(p => p.slug === slug).friesAdj;
  const secondOf = (base, add) => (SECOND_MATRIX[base][add] || [null])[0];
  const check = (label, actual, expected) => {
    const ok = actual === expected ? '✓' : '✗';
    console.log(`  ${ok} ${label.padEnd(38)} actual=${actual}  expected=${expected}`);
    return actual === expected;
  };
  let allOk = true;
  allOk = check('Asada + Fries',           priceOf('asada') + friesOf('asada'),                     299) && allOk;
  allOk = check('Asada + Camarón (any style)', priceOf('asada') + secondOf('asada','camaron'),      340) && allOk;
  allOk = check('Huevo + Chorizo',         priceOf('huevo') + secondOf('huevo','chorizo'),          210) && allOk;
  allOk = check('Pescado + Asada',         priceOf('pescado') + secondOf('pescado','asada'),        355) && allOk;
  allOk = check('Rollbertos',              FIXED_ITEMS.find(f=>f.key==='rollbertos').price,         139) && allOk;
  if (!allOk) console.warn('  ✗ one or more acceptance checks failed — seed data is inconsistent with the spec');
  console.log('');

  console.log(DRY_RUN
    ? '=== DRY-RUN complete. No writes performed. Re-run without --dry-run to apply. ==='
    : '=== Seed complete. All writes committed. ===');

  await adminSql.end({ timeout: 5 });
}

main().catch(async (err) => {
  console.error('\nSEED FAILED:', err.message);
  console.error(err.stack);
  try { await adminSql.end({ timeout: 5 }); } catch {}
  process.exit(1);
});
