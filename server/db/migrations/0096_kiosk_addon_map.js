export const version = 96;
export const name = 'kiosk_addon_map';

// Wizard parity (prototype v12, D5) — the "¿Deseas agregar algo?" step needs a
// Complementos (sides) and a Bebidas (drinks) section fed from real menu items.
//
// Why an explicit allowlist instead of reading a category:
// juanbertos has no sides category at all — `Orden Papas` lives in `otros`
// alongside Carne Asada Fries ($299), La Gran Chimichanga ($320), Rollberto's
// and a $2,000 accounting line, and `Brownie con crema` lives in
// `Postre / Sweets`. Pointing a section at a category would drop entrée-priced
// items and a bookkeeping row into an upsell strip. So the section membership
// is curated per tenant, exactly like kiosk_builder_map curates the wizard's
// protein slugs.
//
// Rows point at ordinary active=true menu items, so they flow through the
// normal cart path (buildKioskOrderItems) as their own lines with no special
// casing — unlike builder items, which are active=false and need the
// kiosk_builder_map allowlist to pass validation.
//
// Empty for every tenant on deploy → the sides/drinks sections render nothing
// and wizard mode is unreachable anyway outside juanbertos. No grid-mode
// surface reads this table.
export async function up(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS kiosk_addon_map (
      tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
      section TEXT NOT NULL,
      menu_item_id INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (tenant_id, section, menu_item_id),
      CONSTRAINT kiosk_addon_map_section_valid CHECK (section IN ('side', 'drink'))
    )
  `;

  await sql.unsafe(`
    DO $$
    BEGIN
      EXECUTE 'ALTER TABLE kiosk_addon_map ENABLE ROW LEVEL SECURITY';
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE tablename = 'kiosk_addon_map' AND policyname = 'tenant_isolation'
      ) THEN
        EXECUTE
          'CREATE POLICY tenant_isolation ON kiosk_addon_map '
          || 'USING (tenant_id = current_setting(''app.tenant_id'', true)) '
          || 'WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true))';
      END IF;
    END $$;
  `);
  await sql.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON kiosk_addon_map TO app_user`);
}
