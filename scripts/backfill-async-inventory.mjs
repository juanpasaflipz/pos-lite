// Backfill inventory deductions for async-paid orders that silently skipped
// inventory deduction since launch, due to the Conekta + Getnet webhooks
// referencing a non-existent `recipe_ingredients` table.
//
// Safe to re-run: deductions are recorded in `inventory_backfill_log` and
// skipped on subsequent runs.
//
// Scope:
//   - OXXO + SPEI paid orders are ALWAYS affected (only path to paid was the
//     broken webhook). Backfilled by default.
//   - Getnet card/tap orders paid via sync handler already deducted; only the
//     async-confirm subset was affected, but those are hard to distinguish
//     after the fact. Opt-in via --include-getnet (risks double-deduction
//     on orders that were already deducted synchronously).
//
// Usage:
//   PROD_DATABASE_URL="..." node scripts/backfill-async-inventory.mjs
//   PROD_DATABASE_URL="..." node scripts/backfill-async-inventory.mjs --apply
//   PROD_DATABASE_URL="..." node scripts/backfill-async-inventory.mjs --apply --tenant=juanbertos
//   PROD_DATABASE_URL="..." node scripts/backfill-async-inventory.mjs --apply --since=2025-01-01
//   PROD_DATABASE_URL="..." node scripts/backfill-async-inventory.mjs --apply --include-getnet

import postgres from 'postgres';

const DB_URL = process.env.PROD_DATABASE_URL;
if (!DB_URL) {
  console.error('Set PROD_DATABASE_URL');
  process.exit(1);
}

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const INCLUDE_GETNET = args.includes('--include-getnet');
const tenantArg = args.find((a) => a.startsWith('--tenant='));
const sinceArg = args.find((a) => a.startsWith('--since='));
const TENANT = tenantArg ? tenantArg.split('=')[1] : null;
const SINCE = sinceArg ? sinceArg.split('=')[1] : null;

const methods = ['oxxo', 'spei'];
if (INCLUDE_GETNET) methods.push('getnet_card', 'getnet_tap');

console.log('Backfill async-paid inventory');
console.log('  mode          :', APPLY ? 'APPLY' : 'DRY RUN');
console.log('  payment_method:', methods.join(', '));
console.log('  tenant filter :', TENANT || '(all)');
console.log('  since         :', SINCE || '(launch)');
console.log('');

const sql = postgres(DB_URL, { ssl: 'require' });

await sql`
  CREATE TABLE IF NOT EXISTS inventory_backfill_log (
    order_id    INTEGER PRIMARY KEY,
    tenant_id   TEXT NOT NULL,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    items_count INTEGER NOT NULL,
    note        TEXT
  )
`;

const candidates = await sql`
  SELECT o.id, o.tenant_id, o.order_number, o.payment_method, o.paid_at, o.total
  FROM orders o
  LEFT JOIN inventory_backfill_log l ON l.order_id = o.id
  WHERE o.payment_status = 'paid'
    AND o.payment_method = ANY(${methods})
    AND l.order_id IS NULL
    ${TENANT ? sql`AND o.tenant_id = ${TENANT}` : sql``}
    ${SINCE ? sql`AND o.paid_at >= ${SINCE}` : sql``}
  ORDER BY o.paid_at ASC
`;

if (candidates.length === 0) {
  console.log('No candidate orders. Nothing to do.');
  await sql.end();
  process.exit(0);
}

console.log(`Found ${candidates.length} candidate order(s):\n`);

let applied = 0;
let skipped = 0;
let failed = 0;
const perTenant = new Map();

for (const o of candidates) {
  // Preview the per-item deduction this order would produce.
  const preview = await sql`
    SELECT mii.inventory_item_id,
           ii.name AS inventory_name,
           SUM(mii.quantity_used * oi.quantity) AS total_needed,
           ii.quantity AS current_quantity
    FROM order_items oi
    JOIN menu_item_ingredients mii ON mii.menu_item_id = oi.menu_item_id
    JOIN inventory_items ii ON ii.id = mii.inventory_item_id
    WHERE oi.order_id = ${o.id}
      AND ii.tenant_id = ${o.tenant_id}
    GROUP BY mii.inventory_item_id, ii.name, ii.quantity
  `;

  if (preview.length === 0) {
    console.log(`  order ${o.id} (${o.tenant_id} #${o.order_number}) — no recipe rows, skipping`);
    skipped += 1;
    if (APPLY) {
      await sql`
        INSERT INTO inventory_backfill_log (order_id, tenant_id, items_count, note)
        VALUES (${o.id}, ${o.tenant_id}, 0, 'no-recipe')
        ON CONFLICT (order_id) DO NOTHING
      `;
    }
    continue;
  }

  const tally = perTenant.get(o.tenant_id) || { orders: 0, items: 0 };
  tally.orders += 1;
  tally.items += preview.length;
  perTenant.set(o.tenant_id, tally);

  if (!APPLY) {
    console.log(`  order ${o.id} (${o.tenant_id} #${o.order_number}, ${o.payment_method}, paid ${o.paid_at?.toISOString?.() || o.paid_at}):`);
    for (const p of preview) {
      console.log(`      - ${p.inventory_name} (id ${p.inventory_item_id}): -${p.total_needed} from ${p.current_quantity}`);
    }
    continue;
  }

  // APPLY mode: one transaction per order. Log row inserted first; if the
  // UPDATE fails, the whole transaction rolls back, leaving no log entry.
  try {
    await sql.begin(async (trx) => {
      const ins = await trx`
        INSERT INTO inventory_backfill_log (order_id, tenant_id, items_count, note)
        VALUES (${o.id}, ${o.tenant_id}, ${preview.length}, ${INCLUDE_GETNET && o.payment_method.startsWith('getnet') ? 'getnet-optin' : 'oxxo-spei'})
        ON CONFLICT (order_id) DO NOTHING
        RETURNING order_id
      `;
      if (ins.length === 0) {
        // Concurrent run claimed it first — skip.
        return;
      }
      await trx`
        UPDATE inventory_items ii
        SET quantity = GREATEST(0, ii.quantity - deductions.total_needed)
        FROM (
          SELECT mii.inventory_item_id,
                 SUM(mii.quantity_used * oi.quantity) AS total_needed
          FROM order_items oi
          JOIN menu_item_ingredients mii ON mii.menu_item_id = oi.menu_item_id
          WHERE oi.order_id = ${o.id}
          GROUP BY mii.inventory_item_id
        ) deductions
        WHERE ii.id = deductions.inventory_item_id
          AND ii.tenant_id = ${o.tenant_id}
      `;
    });
    applied += 1;
    console.log(`  ✓ order ${o.id} (${o.tenant_id} #${o.order_number}) — deducted ${preview.length} item(s)`);
  } catch (err) {
    failed += 1;
    console.error(`  ✗ order ${o.id} (${o.tenant_id} #${o.order_number}) — ${err.message}`);
  }
}

console.log('');
console.log('Per-tenant summary:');
for (const [tenant, tally] of perTenant) {
  console.log(`  ${tenant}: ${tally.orders} order(s), ${tally.items} inventory line(s)`);
}
console.log('');
console.log(`Done. applied=${applied} skipped=${skipped} failed=${failed} total=${candidates.length}`);
if (!APPLY) {
  console.log('');
  console.log('Dry run only. Re-run with --apply to write changes.');
}

await sql.end();
