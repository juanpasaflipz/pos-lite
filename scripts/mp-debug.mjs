// Quick MP terminal debug — prints what pos-lite has saved vs. what MP reports.
// Usage:  node scripts/mp-debug.mjs
// Reads DATABASE_URL and MP_ACCESS_TOKEN from .env

import 'dotenv/config';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL, { ssl: 'require' });
const TOKEN = process.env.MP_ACCESS_TOKEN;

console.log('--- juanbertos full MP state ---');
const rows = await sql`
  SELECT id, subdomain, plan, mp_user_id, mp_default_terminal_id,
         (mp_access_token IS NOT NULL) AS has_access_token,
         (mp_refresh_token IS NOT NULL) AS has_refresh_token
  FROM tenants WHERE id = 'juanbertos'
`;
console.table(rows);

console.log('\n--- tenant_credentials rows for mercadopago (key/value model) ---');
const creds = await sql`
  SELECT tenant_id, service, key,
         CASE WHEN length(value) > 30 THEN left(value, 20) || '...' ELSE value END AS value_preview,
         updated_at
  FROM tenant_credentials
  WHERE service = 'mercadopago'
  ORDER BY tenant_id, key
`;
console.table(creds);

console.log('\n--- MP devices for the access token in .env ---');
const res = await fetch('https://api.mercadopago.com/point/integration-api/devices', {
  headers: { Authorization: `Bearer ${TOKEN}` },
});
const data = await res.json();
console.log(JSON.stringify(data, null, 2));

await sql.end();
