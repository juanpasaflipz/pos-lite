// Pull today's MP payments for juanbertos and reconcile against pos-lite orders.
// Read-only — never mutates. Use to find orphan terminal charges (paid on MP,
// no link in pos-lite) and to confirm which DB-unpaid orders actually cleared.
//
// Usage: PROD_DATABASE_URL=... node scripts/mp-payments-today.mjs
//   --tenant=juanbertos     (default)
//   --date=YYYY-MM-DD       (default = today in America/Mexico_City)

import postgres from 'postgres';

const DB_URL = process.env.PROD_DATABASE_URL;
if (!DB_URL) { console.error('Set PROD_DATABASE_URL'); process.exit(1); }

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? true];
}));
const TENANT = args.tenant || 'juanbertos';

// Mexico City "today" → UTC window
const MX_OFFSET_MS = -6 * 60 * 60 * 1000; // CST, no DST in MX since 2022
const nowMx = new Date(Date.now() + MX_OFFSET_MS);
const targetDate = args.date || nowMx.toISOString().slice(0, 10);
const beginUtc = new Date(`${targetDate}T00:00:00-06:00`).toISOString();
const endUtc = new Date(`${targetDate}T23:59:59-06:00`).toISOString();
console.log(`Tenant: ${TENANT}`);
console.log(`Date  : ${targetDate} (CDMX) → ${beginUtc} .. ${endUtc} UTC\n`);

const sql = postgres(DB_URL, { ssl: 'require' });

const [tenant] = await sql`
  SELECT id, mp_access_token, mp_default_terminal_id, mp_token_expires_at
  FROM tenants WHERE id = ${TENANT}
`;
if (!tenant?.mp_access_token) {
  console.error(`No MP access token on ${TENANT}`); process.exit(1);
}
const TOKEN = tenant.mp_access_token;

// MP payments search by date_created window.
// Docs: GET /v1/payments/search?range=date_created&begin_date=...&end_date=...
const url = new URL('https://api.mercadopago.com/v1/payments/search');
url.searchParams.set('range', 'date_created');
url.searchParams.set('begin_date', beginUtc);
url.searchParams.set('end_date', endUtc);
url.searchParams.set('sort', 'date_created');
url.searchParams.set('criteria', 'asc');
url.searchParams.set('limit', '50');

const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
if (!res.ok) {
  console.error(`MP search failed: ${res.status} ${await res.text()}`);
  await sql.end(); process.exit(1);
}
const data = await res.json();
const results = data.results || [];
console.log(`MP reports ${results.length} payment(s) on ${targetDate}\n`);

// Print payments
const payments = results.map(p => ({
  mp_id: p.id,
  status: p.status,
  amount: Number(p.transaction_amount),
  external_ref: p.external_reference || null,
  date_created: p.date_created,
  pos_id: p.pos_id || null,
  source: p.point_of_interaction?.type || p.payment_type_id || null,
}));
console.table(payments);

// Pull pos-lite orders for the same day
const orders = await sql`
  SELECT id, order_number, total, payment_status, payment_method,
         mp_order_id, paid_at, created_at
  FROM orders
  WHERE tenant_id = ${TENANT}
    AND created_at >= ${beginUtc}
    AND created_at <= ${endUtc}
  ORDER BY created_at ASC
`;
console.log(`\npos-lite has ${orders.length} order(s) on ${targetDate}\n`);

// Reconcile by external_reference (format: "<tenant>-<order_id>")
// then by amount fallback for orphans.
const orphans = [];
const matched = [];
for (const p of results) {
  let order = null;
  if (p.external_reference) {
    const m = String(p.external_reference).match(/^([^-]+)-(\d+)$/);
    if (m) {
      const oid = Number(m[2]);
      order = orders.find(o => o.id === oid) || null;
    }
  }
  if (!order && p.status === 'approved') {
    // amount fallback: same total, unpaid order within ±30 min
    const amt = Number(p.transaction_amount);
    const pTime = new Date(p.date_created).getTime();
    order = orders.find(o =>
      Math.abs(Number(o.total) - amt) < 0.01 &&
      o.payment_status !== 'paid' &&
      Math.abs(new Date(o.created_at).getTime() - pTime) < 30 * 60 * 1000
    ) || null;
  }
  if (p.status !== 'approved') continue;
  if (order) {
    matched.push({
      mp_id: p.id,
      amount: Number(p.transaction_amount),
      order_id: order.id,
      order_number: order.order_number,
      order_paid: order.payment_status === 'paid',
      mp_order_id_set: order.mp_order_id != null,
    });
  } else {
    orphans.push({
      mp_id: p.id,
      amount: Number(p.transaction_amount),
      external_ref: p.external_reference,
      date: p.date_created,
    });
  }
}

console.log('\n=== Matched MP payments (approved) ===');
console.table(matched);

console.log('\n=== Orphan MP payments — paid on terminal, no link in pos-lite ===');
console.table(orphans);

const unpaidOrders = orders.filter(o => o.payment_status !== 'paid');
console.log('\n=== Unpaid orders in pos-lite (need decision) ===');
console.table(unpaidOrders.map(o => ({
  id: o.id, order_number: o.order_number, total: Number(o.total),
  payment_status: o.payment_status, has_mp_id: o.mp_order_id != null,
})));

await sql.end();
