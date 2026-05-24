// Same as mp-debug.mjs but uses PROD_DATABASE_URL env var explicitly.
import postgres from 'postgres';

const DB_URL = process.env.PROD_DATABASE_URL;
if (!DB_URL) {
  console.error('Set PROD_DATABASE_URL (paste the Railway DATABASE_URL value)');
  process.exit(1);
}

const sql = postgres(DB_URL, { ssl: 'require' });

const rows = await sql`
  SELECT id, subdomain, plan, mp_user_id, mp_default_terminal_id,
         (mp_access_token IS NOT NULL) AS has_access_token,
         (mp_refresh_token IS NOT NULL) AS has_refresh_token
  FROM tenants
  WHERE id IN ('juanbertos', 'demo')
`;
console.log('--- juanbertos / demo MP state (PROD) ---');
console.table(rows);

const creds = await sql`
  SELECT tenant_id, service, key,
         CASE WHEN length(value) > 30 THEN left(value, 20) || '...' ELSE value END AS value_preview
  FROM tenant_credentials
  WHERE service = 'mercadopago'
  ORDER BY tenant_id, key
`;
console.log('\n--- tenant_credentials (mercadopago) — PROD ---');
console.table(creds);

await sql.end();
