export const version = 59;
export const name = 'voice_intents';

export async function up(sql) {
  // Employees need a phone number so we can resolve an inbound WhatsApp sender
  // back to a specific employee inside a specific tenant. Stored E.164.
  await sql`ALTER TABLE employees ADD COLUMN IF NOT EXISTS phone TEXT`;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_employees_tenant_phone
      ON employees(tenant_id, phone) WHERE phone IS NOT NULL
  `;
  // Cross-tenant lookup index — used by the Twilio webhook (admin pool) to map
  // a sender phone to the (tenant, employee) pair before entering RLS scope.
  await sql`
    CREATE INDEX IF NOT EXISTS idx_employees_phone
      ON employees(phone) WHERE phone IS NOT NULL
  `;

  // Each inbound WhatsApp voice/text from staff lands here as a draft.
  // Status flow: pending_confirm → confirmed | cancelled | expired | failed | unrecognized
  // The same row records what we actually wrote (executed_resource_*) once the
  // user replies SI and we successfully called the target write path.
  await sql`
    CREATE TABLE IF NOT EXISTS voice_intents (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      source TEXT NOT NULL DEFAULT 'whatsapp',
      twilio_message_sid TEXT UNIQUE,
      from_phone TEXT,
      to_phone TEXT,
      raw_body TEXT,
      media_url TEXT,
      media_content_type TEXT,
      transcript TEXT,
      parsed_json JSONB,
      draft_action TEXT,
      draft_summary TEXT,
      status TEXT NOT NULL DEFAULT 'pending_confirm',
      executed_resource_type TEXT,
      executed_resource_id INTEGER,
      failure_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      confirmed_at TIMESTAMPTZ
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_voice_intents_tenant_emp_status_created
      ON voice_intents(tenant_id, employee_id, status, created_at DESC)
  `;

  await sql`ALTER TABLE voice_intents ENABLE ROW LEVEL SECURITY`;
  await sql`ALTER TABLE voice_intents FORCE ROW LEVEL SECURITY`;
  await sql`DROP POLICY IF EXISTS tenant_isolation ON voice_intents`;
  await sql`
    CREATE POLICY tenant_isolation ON voice_intents
      USING (tenant_id = current_setting('app.tenant_id', true))
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true))
  `;
  await sql`GRANT SELECT, INSERT, UPDATE, DELETE ON voice_intents TO app_user`;
  await sql`GRANT USAGE, SELECT ON SEQUENCE voice_intents_id_seq TO app_user`;
}
