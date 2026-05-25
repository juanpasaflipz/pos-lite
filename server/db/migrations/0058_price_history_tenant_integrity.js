export const version = 58;
export const name = 'price_history_tenant_integrity';

export async function up(sql) {
  // (1) Replace the menu_item_id FK with ON DELETE CASCADE so deleting a
  // tenant's menu_items also drops dependent price_history rows — including
  // any cross-tenant orphans inserted by past adminSql paths. Without this,
  // tenant offboarding blocks on FK violations from historical bad data.
  await sql`ALTER TABLE price_history DROP CONSTRAINT IF EXISTS price_history_menu_item_id_fkey`;
  await sql`
    ALTER TABLE price_history
    ADD CONSTRAINT price_history_menu_item_id_fkey
    FOREIGN KEY (menu_item_id) REFERENCES menu_items(id) ON DELETE CASCADE
  `;

  // (2) Trigger-level enforcement that price_history.tenant_id matches the
  // tenant_id of the referenced menu_items row. RLS already covers tenant-pool
  // INSERTs via the WITH CHECK clause, but adminSql.unsafe bypasses RLS, so
  // RLS alone is not sufficient. The trigger fires regardless of connection
  // role, closing the bleed at the database layer.
  await sql`
    CREATE OR REPLACE FUNCTION enforce_price_history_tenant_match()
    RETURNS TRIGGER AS $$
    DECLARE
      mi_tenant_id TEXT;
    BEGIN
      SELECT tenant_id INTO mi_tenant_id
      FROM menu_items
      WHERE id = NEW.menu_item_id;
      IF mi_tenant_id IS NULL THEN
        RAISE EXCEPTION 'price_history: menu_items[%] does not exist', NEW.menu_item_id;
      END IF;
      IF mi_tenant_id <> NEW.tenant_id THEN
        RAISE EXCEPTION 'price_history.tenant_id=% does not match menu_items.tenant_id=% for menu_item_id=%',
          NEW.tenant_id, mi_tenant_id, NEW.menu_item_id;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `;

  await sql`DROP TRIGGER IF EXISTS price_history_tenant_match ON price_history`;
  await sql`
    CREATE TRIGGER price_history_tenant_match
    BEFORE INSERT OR UPDATE ON price_history
    FOR EACH ROW EXECUTE FUNCTION enforce_price_history_tenant_match()
  `;
}
