// Dry verification: run the topo algorithm against the live FK graph
// without touching prod. Loads helper, mocks adminSql with read-only
// queries via the Neon connection string.

import 'dotenv/config';
import { adminSql } from '../server/db/index.js';
import { dryRunPurge, _resetOrderCache } from '../server/helpers/tenantPurge.js';

_resetOrderCache();

// Pick a tenant. Numero-3 / juanbertos / etc — list them first.
const tenants = await adminSql`SELECT id, name FROM tenants ORDER BY created_at`;
console.log('Tenants:');
for (const t of tenants) console.log('  -', t.id, '/', t.name);

// Pick the first tenant for dry-run probe.
const probe = process.env.PROBE_TENANT || tenants[0]?.id;
if (!probe) {
  console.log('No tenants — abort');
  process.exit(0);
}
console.log(`\nDry-running purge against tenant: ${probe}\n`);

const plan = await dryRunPurge(probe);
console.log('Table count:', plan.table_count);
console.log('Self refs:', JSON.stringify(plan.self_refs));
console.log('Total rows that would be deleted:', plan.total_rows);
console.log('\nFirst 10 in deletion order:');
for (const t of plan.deletion_order.slice(0, 10)) {
  console.log('  -', t, '(rows:', plan.row_counts[t], ')');
}
console.log('\nLast 10 in deletion order (parents):');
for (const t of plan.deletion_order.slice(-10)) {
  console.log('  -', t, '(rows:', plan.row_counts[t], ')');
}

// Sanity: every tenant table appears exactly once
const seen = new Set(plan.deletion_order);
if (seen.size !== plan.deletion_order.length) {
  console.log('FAIL: duplicate entries in deletion order');
  process.exit(1);
}
if (seen.size !== plan.table_count) {
  console.log('FAIL: deletion order length != table_count');
  process.exit(1);
}

// Sanity: tables with high rows should be near the start (children),
// parent reference tables near the end. Sanity peek at orders position.
const ordersIdx = plan.deletion_order.indexOf('orders');
const orderItemsIdx = plan.deletion_order.indexOf('order_items');
console.log(`\norder_items idx: ${orderItemsIdx}  orders idx: ${ordersIdx}`);
if (orderItemsIdx > ordersIdx) {
  console.log('FAIL: order_items must precede orders');
  process.exit(1);
}
const ordersBeforeEmployees = plan.deletion_order.indexOf('orders') < plan.deletion_order.indexOf('employees');
console.log(`orders before employees? ${ordersBeforeEmployees}`);

console.log('\nAll sanity checks passed.');
await adminSql.end();
