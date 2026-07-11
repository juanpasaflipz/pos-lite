export const version = 79;
export const name = 'sentinel_incidents';

// Sentinel incident spine (docs/ai-sentinel-design.md §2.2).
//
// One row per detected operational incident. Deterministic SQL sensors
// (server/sentinel/sensors.js) upsert here on a 60s sweep; the unique
// (tenant_id, sensor, dedup_key) constraint is what makes re-detection a
// last_seen_at bump instead of a new incident — the anti-spam property the
// whole design leans on. When an incident leaves the active set (resolved /
// dismissed), its dedup_key is rewritten with a ':r<id>' / ':d<id>' suffix to
// free the slot, so a recurrence opens a NEW incident with fresh triage.
//
// RLS'd like every tenant table: the sweep writes via adminSql (bypasses
// RLS, cross-tenant); owner reads go through the normal tenant-scoped path.

export async function up(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS sentinel_incidents (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
      sensor TEXT NOT NULL,
      dedup_key TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'medium'
        CHECK (severity IN ('low','medium','high','critical')),
      status TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open','diagnosing','auto_fixed','waiting_approval','needs_human','resolved','dismissed')),
      subject_table TEXT,
      subject_id TEXT,
      evidence JSONB,
      diagnosis JSONB,
      actions JSONB NOT NULL DEFAULT '[]'::jsonb,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at TIMESTAMPTZ,
      UNIQUE(tenant_id, sensor, dedup_key)
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_sentinel_incidents_tenant_status
      ON sentinel_incidents(tenant_id, status, last_seen_at DESC)
  `;

  await sql`ALTER TABLE sentinel_incidents ENABLE ROW LEVEL SECURITY`;
  await sql`ALTER TABLE sentinel_incidents FORCE ROW LEVEL SECURITY`;
  await sql`DROP POLICY IF EXISTS tenant_isolation ON sentinel_incidents`;
  await sql`
    CREATE POLICY tenant_isolation ON sentinel_incidents
      USING (tenant_id = current_setting('app.tenant_id', true))
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true))
  `;

  // Base-schema GRANTs predate this table.
  await sql`GRANT SELECT, INSERT, UPDATE, DELETE ON sentinel_incidents TO app_user`;
  await sql`GRANT USAGE, SELECT ON SEQUENCE sentinel_incidents_id_seq TO app_user`;
}
