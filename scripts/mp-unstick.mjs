// Find stuck MP payment intents on juanbertos, cancel them on the OLD device,
// and clear the order so a fresh charge can be initiated.
//
// Usage:
//   PROD_DATABASE_URL="..." node scripts/mp-unstick.mjs

import postgres from 'postgres';

const DB_URL = process.env.PROD_DATABASE_URL;
if (!DB_URL) { console.error('Set PROD_DATABASE_URL'); process.exit(1); }

const sql = postgres(DB_URL, { ssl: 'require' });

const [tenant] = await sql`
  SELECT id, mp_access_token, mp_refresh_token, mp_default_terminal_id
  FROM tenants WHERE id = 'juanbertos'
`;
if (!tenant?.mp_access_token) { console.error('No MP token on juanbertos'); process.exit(1); }

const TOKEN = tenant.mp_access_token;
const NEW_DEVICE = 'NEWLAND_N950__N950NCCB05547243';
const OLD_DEVICE = 'NEWLAND_N950__N950NCCB05551867';

console.log('Tenant default terminal:', tenant.mp_default_terminal_id);

const stuckOrders = await sql`
  SELECT id, order_number, mp_order_id, payment_status, total
  FROM orders
  WHERE tenant_id = 'juanbertos'
    AND payment_status = 'pending_terminal'
    AND mp_order_id IS NOT NULL
  ORDER BY id DESC
  LIMIT 20
`;

console.log(`\nFound ${stuckOrders.length} order(s) in pending_terminal state:\n`);
console.table(stuckOrders);

for (const o of stuckOrders) {
  for (const device of [NEW_DEVICE, OLD_DEVICE]) {
    const url = `https://api.mercadopago.com/point/integration-api/devices/${device}/payment-intents/${o.mp_order_id}`;
    const r = await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${TOKEN}` } });
    const body = await r.text();
    console.log(`order ${o.id} → DELETE on ${device}: HTTP ${r.status} ${body.slice(0,200)}`);
    if (r.ok) break;
  }
  await sql`
    UPDATE orders
       SET mp_order_id = NULL, payment_status = 'pending'
     WHERE id = ${o.id}
  `;
  console.log(`  ✓ cleared order ${o.id} locally`);
}

await sql.end();
