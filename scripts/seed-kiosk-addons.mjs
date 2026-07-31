#!/usr/bin/env node
// Seeds kiosk_addon_map — the curated Complementos (sides) and Bebidas (drinks)
// shown on the wizard's "¿Deseas agregar algo?" step (prototype v12, D5).
//
// Why curated instead of a category read: juanbertos has no sides category.
// `Orden Papas` sits in `otros` beside Carne Asada Fries ($299), La Gran
// Chimichanga ($320) and a $2,000 bookkeeping row, and `Brownie con crema`
// sits in `Postre / Sweets`. See migration 0096.
//
// Usage:
//   node scripts/seed-kiosk-addons.mjs --tenant juanbertos --dry-run
//   node scripts/seed-kiosk-addons.mjs --tenant juanbertos
//
// Idempotent: SELECT-then-INSERT-OR-UPDATE keyed on (tenant, section, item).
// Never deletes rows it didn't plan; prunes only rows for the same tenant that
// are no longer in the plan, so removing a line here removes it from the kiosk.

import 'dotenv/config';
import { adminSql } from '../server/db/index.js';

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const tenantIdx = argv.indexOf('--tenant');
const tenantArg = tenantIdx >= 0 ? argv[tenantIdx + 1] : null;
if (!tenantArg) {
  console.error('Missing --tenant. Usage: node scripts/seed-kiosk-addons.mjs --tenant <id-or-subdomain> [--dry-run]');
  process.exit(2);
}

// Resolved by exact menu-item name so the plan is readable and survives an id
// change. An item that is missing or inactive is reported, not silently
// skipped — a drink quietly dropping off the kiosk is exactly the failure we
// want to be loud.
const PLAN = [
  { section: 'side',  name: 'Orden Papas',       sort: 1 },
  { section: 'side',  name: 'Brownie con crema', sort: 2 },
  { section: 'drink', name: 'Refresco',          sort: 1 },
  { section: 'drink', name: 'Cerveza',           sort: 2 },
  { section: 'drink', name: 'CHELA 3X2',         sort: 3 },
  // Juan's call to add later — these exist but are active=false today, so the
  // wizard would not show them even if listed here:
  //   { section: 'drink', name: 'Michelada (tamarindo con clamato)', sort: 4 },
  //   { section: 'drink', name: 'Café',                              sort: 5 },
  //   { section: 'drink', name: 'Aguas Frescas (hechas en casa)',    sort: 6 },
];

async function resolveTenant(sql, arg) {
  const rows = await sql`
    SELECT id, subdomain, name FROM tenants WHERE id = ${arg} OR subdomain = ${arg}
  `;
  if (rows.length === 0) throw new Error(`No tenant matches "${arg}" by id or subdomain`);
  if (rows.length > 1) throw new Error(`Ambiguous tenant "${arg}" — ${rows.length} matches`);
  return rows[0];
}

async function run(sql) {
  const tenant = await resolveTenant(sql, tenantArg);
  console.log(`Tenant: ${tenant.name} (${tenant.id})${DRY_RUN ? '  [DRY RUN]' : ''}\n`);

  const planned = [];
  const problems = [];

  for (const spec of PLAN) {
    const rows = await sql`
      SELECT id, name, price, active FROM menu_items
      WHERE tenant_id = ${tenant.id} AND name = ${spec.name}
      ORDER BY active DESC, id
    `;
    if (rows.length === 0) {
      problems.push(`MISSING  ${spec.section.padEnd(5)} "${spec.name}" — no menu item with that exact name`);
      continue;
    }
    const live = rows.filter((r) => r.active);
    if (live.length === 0) {
      problems.push(`INACTIVE ${spec.section.padEnd(5)} "${spec.name}" (id ${rows[0].id}) — active=false, kiosk will not show it`);
      continue;
    }
    if (live.length > 1) {
      problems.push(`AMBIGUOUS ${spec.section.padEnd(5)} "${spec.name}" — ${live.length} active items share this name (${live.map((r) => r.id).join(', ')}); using ${live[0].id}`);
    }
    planned.push({ ...spec, id: Number(live[0].id), price: Number(live[0].price) });
  }

  for (const p of planned) {
    const existing = await sql`
      SELECT sort_order FROM kiosk_addon_map
      WHERE tenant_id = ${tenant.id} AND section = ${p.section} AND menu_item_id = ${p.id}
    `;
    if (existing.length) {
      const changed = Number(existing[0].sort_order) !== p.sort;
      if (changed && !DRY_RUN) {
        await sql`
          UPDATE kiosk_addon_map SET sort_order = ${p.sort}
          WHERE tenant_id = ${tenant.id} AND section = ${p.section} AND menu_item_id = ${p.id}
        `;
      }
      p.action = changed ? 'UPDATE' : 'NOOP';
    } else {
      if (!DRY_RUN) {
        await sql`
          INSERT INTO kiosk_addon_map (tenant_id, section, menu_item_id, sort_order)
          VALUES (${tenant.id}, ${p.section}, ${p.id}, ${p.sort})
        `;
      }
      p.action = 'INSERT';
    }
  }

  // Prune rows no longer in the plan so this file stays the single source of
  // truth for what the kiosk offers.
  const keep = planned.map((p) => `${p.section}:${p.id}`);
  const current = await sql`
    SELECT section, menu_item_id FROM kiosk_addon_map WHERE tenant_id = ${tenant.id}
  `;
  const stale = current.filter((r) => !keep.includes(`${r.section}:${Number(r.menu_item_id)}`));
  for (const s of stale) {
    if (!DRY_RUN) {
      await sql`
        DELETE FROM kiosk_addon_map
        WHERE tenant_id = ${tenant.id} AND section = ${s.section} AND menu_item_id = ${s.menu_item_id}
      `;
    }
  }

  console.log('ACTION   SECTION  ID     PRICE    NAME');
  for (const p of planned) {
    console.log(`${p.action.padEnd(8)} ${p.section.padEnd(8)} ${String(p.id).padEnd(6)} $${String(p.price).padEnd(7)} ${p.name}`);
  }
  for (const s of stale) console.log(`PRUNE    ${s.section.padEnd(8)} ${s.menu_item_id}`);

  if (problems.length) {
    console.log('\nProblems:');
    for (const p of problems) console.log(`  ${p}`);
  }
  console.log(`\n${planned.length} row(s) planned, ${stale.length} pruned, ${problems.length} problem(s).`);
}

try {
  if (DRY_RUN) await run(adminSql);
  else await adminSql.begin(run);
  await adminSql.end();
} catch (err) {
  console.error('\nFAILED:', err.message);
  await adminSql.end();
  process.exit(1);
}
