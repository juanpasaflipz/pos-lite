export const version = 37;
export const name = 'display_menu_foundation';

export async function up(sql) {
  await sql`
    ALTER TABLE menu_items
    ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0
  `;

  await sql`
    WITH ranked AS (
      SELECT id,
             ROW_NUMBER() OVER (PARTITION BY category_id ORDER BY name ASC, id ASC) - 1 AS new_sort_order
      FROM menu_items
      WHERE sort_order IS NULL OR sort_order = 0
    )
    UPDATE menu_items mi
    SET sort_order = ranked.new_sort_order
    FROM ranked
    WHERE mi.id = ranked.id
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_menu_items_category_sort
    ON menu_items(tenant_id, category_id, sort_order, id)
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS display_assets (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
      kind TEXT NOT NULL,
      title TEXT,
      body TEXT,
      image_url TEXT,
      sort_order INTEGER DEFAULT 0,
      active BOOLEAN DEFAULT true,
      starts_at TIMESTAMPTZ,
      ends_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_display_assets_tenant
    ON display_assets(tenant_id, active, sort_order, id)
  `;

  await sql`
    ALTER TABLE display_assets ENABLE ROW LEVEL SECURITY
  `;

  await sql`
    ALTER TABLE display_assets FORCE ROW LEVEL SECURITY
  `;

  await sql`
    DROP POLICY IF EXISTS tenant_isolation ON display_assets
  `;

  await sql`
    CREATE POLICY tenant_isolation ON display_assets
      USING (tenant_id = current_setting('app.tenant_id', true))
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true))
  `;
}
