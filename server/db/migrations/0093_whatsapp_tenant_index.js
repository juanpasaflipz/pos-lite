export const version = 93;
export const name = 'whatsapp_tenant_index';

// Per-tenant WhatsApp numbers.
//
// Credentials themselves reuse tenant_credentials (service='whatsapp', keys
// access_token / phone_number_id / waba_id / display_phone_number) — no new
// table. What's missing is the REVERSE direction: an inbound Meta Cloud API
// webhook arrives with value.metadata.phone_number_id and we have to find the
// tenant that owns that number before we know which credentials to use. That
// lookup runs on every inbound message, so it gets its own partial index.
//
// tenant_credentials has no RLS (it's read via adminSql from platform-level
// code paths), so there's no policy or grant to add here.
export async function up(sql) {
  await sql`
    CREATE INDEX IF NOT EXISTS idx_tenant_credentials_wa_phone_id
    ON tenant_credentials (value)
    WHERE service = 'whatsapp' AND key = 'phone_number_id'
  `;
}
