// One-off audit: which tenants have a Twilio SMS sender that can't send SMS?
// Read-only. Bypasses RLS by turning off row_security for the session
// (works because DATABASE_URL connects as the table owner with BYPASSRLS).

import 'dotenv/config';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL, { ssl: 'require', max: 1 });
const PLATFORM_SID = process.env.TWILIO_ACCOUNT_SID;
const PLATFORM_PHONE = process.env.TWILIO_PHONE_NUMBER;

function mask(v) {
  if (!v) return '(null)';
  const s = String(v);
  if (s.length <= 8) return s;
  return `${s.slice(0, 6)}…${s.slice(-4)} (len=${s.length})`;
}

try {
  await sql`SET row_security = off`;

  const misconfigured = await sql`
    SELECT tc.tenant_id,
           t.name       AS tenant_name,
           t.subdomain,
           tc.value     AS misconfigured_phone_number,
           tc.updated_at
    FROM tenant_credentials tc
    JOIN tenants t ON t.id = tc.tenant_id
    WHERE tc.service = 'twilio'
      AND tc.key     = 'phone_number'
      AND (tc.value LIKE 'whatsapp:%' OR tc.value = '+14155238886')
    ORDER BY tc.updated_at DESC
  `;

  console.log(`\n=== Misconfigured phone_number rows: ${misconfigured.length} ===\n`);
  for (const row of misconfigured) console.log(row);

  const landscape = await sql`
    SELECT tc.tenant_id,
           t.name AS tenant_name,
           tc.key,
           tc.value,
           tc.updated_at
    FROM tenant_credentials tc
    JOIN tenants t ON t.id = tc.tenant_id
    WHERE tc.service = 'twilio'
    ORDER BY t.name, tc.key
  `;

  console.log(`\n=== Twilio credential rows: ${landscape.length} ===\n`);
  console.log(`PLATFORM_SID   = ${mask(PLATFORM_SID)}`);
  console.log(`PLATFORM_PHONE = ${PLATFORM_PHONE}\n`);

  for (const row of landscape) {
    const val = row.key === 'phone_number' ? row.value : mask(row.value);
    const matchesPlatform = (row.key === 'account_sid' && row.value === PLATFORM_SID) ? '  ← matches PLATFORM_SID' : '';
    console.log(`  ${row.tenant_name} / ${row.key} = ${val}${matchesPlatform}`);
  }
} finally {
  await sql.end({ timeout: 5 });
}
