export const version = 68;
export const name = 'inventory_aliases';

// Aliases for inventory items — captured during recipe import so that the
// next time someone pastes "tortilla burrera" or "queso cheddar" we can map
// it straight to the canonical row without prompting the owner again.
//
// Owner-confirmed only: we never auto-create aliases from a fuzzy guess.

export async function up(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS inventory_aliases (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
      inventory_item_id INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
      alias TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_id, alias)
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_inventory_aliases_item
      ON inventory_aliases(tenant_id, inventory_item_id)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_inventory_aliases_alias_lower
      ON inventory_aliases(tenant_id, LOWER(alias))
  `;

  await sql`ALTER TABLE inventory_aliases ENABLE ROW LEVEL SECURITY`;
  await sql`ALTER TABLE inventory_aliases FORCE ROW LEVEL SECURITY`;
  await sql`DROP POLICY IF EXISTS tenant_isolation ON inventory_aliases`;
  await sql`
    CREATE POLICY tenant_isolation ON inventory_aliases
      USING (tenant_id = current_setting('app.tenant_id', true))
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true))
  `;

  await sql`GRANT SELECT, INSERT, DELETE ON inventory_aliases TO app_user`;
  await sql`GRANT USAGE, SELECT ON SEQUENCE inventory_aliases_id_seq TO app_user`;
}
