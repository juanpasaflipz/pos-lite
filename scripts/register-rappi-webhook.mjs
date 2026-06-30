// Register a Rappi webhook for a tenant and persist the returned secret.
//
// Usage:
//   PROD_DATABASE_URL=... node scripts/register-rappi-webhook.mjs <subdomain> [event]
//
// Example:
//   PROD_DATABASE_URL=$(railway variables --json | jq -r .DATABASE_URL) \
//     node scripts/register-rappi-webhook.mjs juanbertos NEW_ORDER
//
// Prereq: tenant must already have rappi.client_id, rappi.client_secret,
// rappi.store_id in tenant_credentials (via the Integrations screen).

import postgres from 'postgres';

const RAPPI_API = 'https://api.rappi.com.mx';
const AUTH_PATH = '/restaurants/auth/v1/token/login/integrations';
const WEBHOOK_PATH = '/api/v2/restaurants-integrations-public-api/webhook';

const [subdomain, event = 'NEW_ORDER'] = process.argv.slice(2);
if (!subdomain) {
  console.error('Usage: node scripts/register-rappi-webhook.mjs <subdomain> [event]');
  process.exit(1);
}

const DB_URL = process.env.PROD_DATABASE_URL;
if (!DB_URL) {
  console.error('Set PROD_DATABASE_URL');
  process.exit(1);
}

const sql = postgres(DB_URL, { ssl: 'require' });

const [tenant] = await sql`
  SELECT id FROM tenants WHERE subdomain = ${subdomain} AND active = true
`;
if (!tenant) {
  console.error(`No active tenant with subdomain "${subdomain}"`);
  await sql.end();
  process.exit(1);
}

const creds = Object.fromEntries(
  (await sql`
    SELECT key, value FROM tenant_credentials
    WHERE tenant_id = ${tenant.id} AND service = 'rappi'
  `).map(r => [r.key, r.value])
);

for (const k of ['client_id', 'client_secret', 'store_id']) {
  if (!creds[k]) {
    console.error(`Missing rappi.${k} for tenant ${tenant.id} — add it in the Integrations screen first.`);
    await sql.end();
    process.exit(1);
  }
}

const url = `https://${subdomain}.desktop.kitchen/api/delivery/webhook/rappi`;

console.log(`Tenant:    ${tenant.id}`);
console.log(`Store:     ${creds.store_id}`);
console.log(`Event:     ${event}`);
console.log(`Webhook:   ${url}`);
console.log('');

console.log('[1/3] OAuth token...');
const tokenRes = await fetch(`${RAPPI_API}${AUTH_PATH}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ client_id: creds.client_id, client_secret: creds.client_secret }),
});
if (!tokenRes.ok) {
  console.error(`OAuth failed (${tokenRes.status}):`, await tokenRes.text());
  await sql.end();
  process.exit(1);
}
const { access_token } = await tokenRes.json();
console.log('       ok');

console.log('[2/3] Register webhook...');
const regRes = await fetch(`${RAPPI_API}${WEBHOOK_PATH}`, {
  method: 'POST',
  headers: {
    'x-authorization': `Bearer ${access_token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ event, url, stores: [creds.store_id] }),
});
const regBody = await regRes.text();
if (!regRes.ok) {
  console.error(`Register failed (${regRes.status}):`, regBody);
  console.error('');
  console.error('If the webhook already exists for this event, reset the secret with:');
  console.error(`  PUT ${RAPPI_API}${WEBHOOK_PATH}/${event}/reset-secret`);
  await sql.end();
  process.exit(1);
}
const reg = JSON.parse(regBody);
const secret = reg.secret;
if (!secret) {
  console.error('Rappi response missing "secret" field:', regBody);
  await sql.end();
  process.exit(1);
}
console.log('       ok');

console.log('[3/3] Persist webhook_secret to tenant_credentials...');
await sql`
  INSERT INTO tenant_credentials (tenant_id, service, key, value, updated_at)
  VALUES (${tenant.id}, 'rappi', 'webhook_secret', ${secret}, NOW())
  ON CONFLICT (tenant_id, service, key)
  DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
`;
console.log('       ok');

console.log('');
console.log('Done. Rappi will now POST events to:');
console.log(`  ${url}`);
console.log('PING heartbeat should arrive within ~3 min — watch Railway logs.');

await sql.end();
