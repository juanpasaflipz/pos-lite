export const version = 107;
export const name = 'drop_kiosk_wizard_objects';

// Removes what the burrito-builder wizard left behind. The feature itself was
// deleted from the code in 1.21.0 (the kiosk is grid-only now, every tenant is
// on the grid menu and no device carries a mode override), which left these
// objects live in the schema but unreachable:
//
//   - kiosk_builder_map  — slug → menu_item_id map for the wizard's protein grid
//   - kiosk_addon_map    — curated sides/drinks for the "¿algo más?" step
//   - tenants.kiosk_mode                 — per-tenant 'grid' | 'wizard'
//   - kiosk_devices.kiosk_mode_override  — per-device override of the above
//   - the shadow menu items the Phase 1 seed created with active=false so they
//     would stay off grid / QR / POS, plus the Estilo__* / Extras__* modifier
//     groups that only those items pointed at
//
// This is deliberately conservative, because it is the one-way half of the
// removal and there are no down migrations:
//
//   - An item is only deleted if it is STILL inactive and has NO order history.
//     A tenant who mapped a real, orderable item into the builder keeps it.
//   - A modifier group is only deleted if no surviving menu item still points
//     at it AND none of its options appear in order history. On juanbertos the
//     group "¿Con birria o cochinita?" is shared with the live Rollbertos items
//     and is preserved by exactly this rule — 28 of the 29 linked groups go, it
//     stays.
//   - Order history is never deleted. If a group's options were ever ordered,
//     the group survives rather than the rows being cleaned up under it.

export async function up(sql) {
  const [{ present }] = await sql`
    SELECT to_regclass('public.kiosk_builder_map') IS NOT NULL AS present
  `;

  if (present) {
    // The set of wizard-only items, derived from the map before it is dropped.
    await sql`
      CREATE TEMP TABLE _wiz_items ON COMMIT DROP AS
      SELECT DISTINCT mi.id
      FROM kiosk_builder_map bm
      JOIN menu_items mi
        ON mi.id = bm.menu_item_id AND mi.tenant_id = bm.tenant_id
      WHERE mi.active = false
        AND NOT EXISTS (SELECT 1 FROM order_items oi WHERE oi.menu_item_id = mi.id)
    `;

    // Groups nothing else points at, and that were never ordered from.
    await sql`
      CREATE TEMP TABLE _wiz_groups ON COMMIT DROP AS
      SELECT g.id FROM (
        SELECT modifier_group_id AS id
        FROM menu_item_modifier_groups
        WHERE menu_item_id IN (SELECT id FROM _wiz_items)
        EXCEPT
        SELECT modifier_group_id
        FROM menu_item_modifier_groups
        WHERE menu_item_id NOT IN (SELECT id FROM _wiz_items)
      ) g
      WHERE NOT EXISTS (
        SELECT 1 FROM order_item_modifiers oim
        JOIN modifiers m ON m.id = oim.modifier_id
        WHERE m.group_id = g.id
      )
    `;

    // Children first — every FK into menu_items / modifier_groups that matters
    // here is ON DELETE NO ACTION.
    await sql`DELETE FROM modifiers WHERE group_id IN (SELECT id FROM _wiz_groups)`;
    await sql`DELETE FROM menu_item_modifier_groups WHERE menu_item_id IN (SELECT id FROM _wiz_items)`;
    await sql`DELETE FROM modifier_groups WHERE id IN (SELECT id FROM _wiz_groups)`;
    await sql`DELETE FROM menu_item_ingredients WHERE menu_item_id IN (SELECT id FROM _wiz_items)`;
    await sql`DELETE FROM menu_items WHERE id IN (SELECT id FROM _wiz_items)`;
  }

  // kiosk_addon_map points at ordinary, live menu items — only the map goes.
  await sql`DROP TABLE IF EXISTS kiosk_builder_map`;
  await sql`DROP TABLE IF EXISTS kiosk_addon_map`;

  await sql`ALTER TABLE tenants DROP COLUMN IF EXISTS kiosk_mode`;
  await sql`ALTER TABLE kiosk_devices DROP COLUMN IF EXISTS kiosk_mode_override`;
}
