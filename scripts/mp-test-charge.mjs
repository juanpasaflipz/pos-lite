// Push a $1 test intent to the new terminal and watch what state MP reports.
// Cleans up by cancelling the intent after.
//
// Usage: PROD_DATABASE_URL=... node scripts/mp-test-charge.mjs

import postgres from 'postgres';

const DB_URL = process.env.PROD_DATABASE_URL;
if (!DB_URL) { console.error('Set PROD_DATABASE_URL'); process.exit(1); }

const sql = postgres(DB_URL, { ssl: 'require' });
const [t] = await sql`SELECT mp_access_token FROM tenants WHERE id='juanbertos'`;
const TOKEN = t.mp_access_token;
const DEVICE = 'NEWLAND_N950__N950NCCB05547243';

console.log('Creating $1 test intent on', DEVICE);
const create = await fetch(`https://api.mercadopago.com/point/integration-api/devices/${DEVICE}/payment-intents`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    amount: 500, // MP minimum = 500 cents ($5 MXN)
    additional_info: { external_reference: 'pdv-mode-test', print_on_terminal: true },
  }),
});
const created = await create.json();
console.log('Create HTTP', create.status, JSON.stringify(created).slice(0, 300));

if (!create.ok) { await sql.end(); process.exit(1); }
const INTENT = created.id;

const sleep = ms => new Promise(r => setTimeout(r, ms));
console.log('\nPolling intent state for 30s...');
let lastState = null;
for (let i = 0; i < 10; i++) {
  await sleep(3000);
  const s = await fetch(`https://api.mercadopago.com/point/integration-api/payment-intents/${INTENT}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const j = await s.json();
  if (j.state !== lastState) {
    console.log(`  t+${(i+1)*3}s: state=${j.state}`);
    lastState = j.state;
  }
  if (['FINISHED', 'CANCELED', 'ERROR'].includes(j.state)) break;
}

console.log('\nCleaning up — cancelling test intent');
const del = await fetch(`https://api.mercadopago.com/point/integration-api/devices/${DEVICE}/payment-intents/${INTENT}`, {
  method: 'DELETE',
  headers: { Authorization: `Bearer ${TOKEN}` },
});
console.log('Cancel HTTP', del.status, (await del.text()).slice(0, 150));

await sql.end();

console.log('\nVerdict:');
console.log('  OPEN throughout       → MP has NOT actually flipped the device (still standalone underneath)');
console.log('  OPEN → ON_TERMINAL    → device entered PDV, intent reached it. Test on POS now.');
console.log('  OPEN → ON_TERMINAL → PROCESSING/FINISHED → fully working, user processed the charge');
