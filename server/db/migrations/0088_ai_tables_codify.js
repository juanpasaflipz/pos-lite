export const version = 88;
export const name = 'ai_tables_codify';

// Codify the nine ai_* tables that exist in production but were never in
// pg-schema.sql or any migration — they predate the repo extraction ("AI
// data pipeline removed in pos-lite") and survived only as live DB state.
// demoDataGenerator, demo-data.js, admin.js and (indirectly) the kiosk
// suggestion engine write/purge them, so a fresh database built from this
// repo (Neon test branch resets, disaster recovery, self-host) breaks demo
// provisioning with undefined_table. Everything below is IF NOT EXISTS /
// idempotent — a no-op against prod, constitutive on fresh DBs.
//
// DDL is a faithful transcription of prod introspection 2026-07-20
// (information_schema + pg_indexes + pg_policies + table_privileges).
export async function up(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS ai_config (
      tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      description TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (tenant_id, key)
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS ai_daily_suggestions (
      tenant_id TEXT NOT NULL,
      date DATE NOT NULL DEFAULT CURRENT_DATE,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (tenant_id, date)
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS ai_category_roles (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
      category_id INTEGER NOT NULL REFERENCES menu_categories(id),
      role TEXT NOT NULL,
      UNIQUE (tenant_id, category_id)
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS ai_hourly_snapshots (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
      snapshot_hour TEXT NOT NULL,
      order_count INTEGER DEFAULT 0,
      revenue REAL DEFAULT 0,
      avg_ticket REAL DEFAULT 0,
      day_of_week INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      demo_batch_id UUID
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS ai_item_pairs (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
      item_a_id INTEGER NOT NULL REFERENCES menu_items(id),
      item_b_id INTEGER NOT NULL REFERENCES menu_items(id),
      pair_count INTEGER DEFAULT 1,
      last_seen TIMESTAMPTZ DEFAULT NOW(),
      demo_batch_id UUID,
      UNIQUE (tenant_id, item_a_id, item_b_id)
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS ai_inventory_velocity (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
      inventory_item_id INTEGER NOT NULL REFERENCES inventory_items(id),
      date DATE NOT NULL,
      quantity_used REAL DEFAULT 0,
      orders_count INTEGER DEFAULT 0,
      demo_batch_id UUID,
      UNIQUE (tenant_id, inventory_item_id, date)
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS ai_restock_log (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
      inventory_item_id INTEGER NOT NULL REFERENCES inventory_items(id),
      quantity_before REAL,
      quantity_added REAL,
      quantity_after REAL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS ai_suggestion_cache (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
      suggestion_type TEXT NOT NULL,
      trigger_context TEXT,
      suggestion_data TEXT NOT NULL,
      priority INTEGER DEFAULT 50,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      demo_batch_id UUID
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS ai_suggestion_events (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
      suggestion_type TEXT NOT NULL,
      suggestion_data TEXT,
      action TEXT NOT NULL,
      employee_id INTEGER REFERENCES employees(id),
      order_id INTEGER REFERENCES orders(id),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      demo_batch_id UUID
    )
  `;

  // Secondary indexes (prod parity)
  await sql`CREATE INDEX IF NOT EXISTS idx_ai_hourly_snapshots_tenant ON ai_hourly_snapshots (tenant_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_ai_hourly_snapshots_demo ON ai_hourly_snapshots (demo_batch_id) WHERE demo_batch_id IS NOT NULL`;
  await sql`CREATE INDEX IF NOT EXISTS idx_ai_inventory_velocity_tenant ON ai_inventory_velocity (tenant_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_ai_inventory_velocity_demo ON ai_inventory_velocity (demo_batch_id) WHERE demo_batch_id IS NOT NULL`;
  await sql`CREATE INDEX IF NOT EXISTS idx_ai_item_pairs_tenant ON ai_item_pairs (tenant_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_ai_item_pairs_demo ON ai_item_pairs (demo_batch_id) WHERE demo_batch_id IS NOT NULL`;
  await sql`CREATE INDEX IF NOT EXISTS idx_ai_suggestion_cache_tenant ON ai_suggestion_cache (tenant_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_ai_suggestion_cache_demo ON ai_suggestion_cache (demo_batch_id) WHERE demo_batch_id IS NOT NULL`;
  await sql`CREATE INDEX IF NOT EXISTS idx_ai_suggestion_cache_expires ON ai_suggestion_cache (tenant_id, expires_at)`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_suggestion_cache_upsert ON ai_suggestion_cache (tenant_id, suggestion_type, trigger_context)`;

  // RLS + tenant-isolation policies + app_user grants (prod parity).
  // DO block per table so re-runs against prod (policy already exists)
  // stay idempotent without pg 15-only IF NOT EXISTS on CREATE POLICY.
  for (const table of [
    'ai_config', 'ai_daily_suggestions', 'ai_category_roles',
    'ai_hourly_snapshots', 'ai_item_pairs', 'ai_inventory_velocity',
    'ai_restock_log', 'ai_suggestion_cache', 'ai_suggestion_events',
  ]) {
    await sql.unsafe(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    await sql.unsafe(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_policies
          WHERE tablename = '${table}' AND policyname IN ('tenant_isolation', '${table}_tenant')
        ) THEN
          CREATE POLICY tenant_isolation ON ${table}
            USING (tenant_id = current_setting('app.tenant_id', true))
            WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
        END IF;
      END $$;
    `);
    await sql.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO app_user`);
  }

  // SERIAL sequences need explicit grants for app_user inserts under RLS.
  for (const seq of [
    'ai_category_roles_id_seq', 'ai_hourly_snapshots_id_seq',
    'ai_item_pairs_id_seq', 'ai_inventory_velocity_id_seq',
    'ai_restock_log_id_seq', 'ai_suggestion_cache_id_seq',
    'ai_suggestion_events_id_seq',
  ]) {
    await sql.unsafe(`GRANT USAGE, SELECT ON SEQUENCE ${seq} TO app_user`);
  }
}
