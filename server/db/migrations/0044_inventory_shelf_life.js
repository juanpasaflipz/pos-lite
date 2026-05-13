export const version = 44;
export const name = 'inventory_shelf_life';

export async function up(sql) {
  // Per-item shelf life intelligence. shelf_life_days is suggested by Claude
  // on creation/restock but user-editable. storage_type is a coarse bucket
  // (refrigerated/frozen/dry/ambient) used for default fallbacks. last_restocked_at
  // is the clock the stale-stock detector measures against — set on every
  // expense restock.
  await sql`
    ALTER TABLE inventory_items
      ADD COLUMN IF NOT EXISTS shelf_life_days INTEGER
  `;
  await sql`
    ALTER TABLE inventory_items
      ADD COLUMN IF NOT EXISTS storage_type TEXT
        CHECK (storage_type IS NULL OR storage_type IN ('refrigerated', 'frozen', 'dry', 'ambient'))
  `;
  await sql`
    ALTER TABLE inventory_items
      ADD COLUMN IF NOT EXISTS last_restocked_at TIMESTAMPTZ
  `;

  // Backfill last_restocked_at from inventory_cost_history if rows exist.
  // For items with no purchase history (manually created), leave NULL — the
  // stale detector skips NULL so they don't false-positive until first restock.
  await sql`
    UPDATE inventory_items ii
    SET last_restocked_at = ch.last_restock
    FROM (
      SELECT inventory_item_id, MAX(created_at) AS last_restock
      FROM inventory_cost_history
      GROUP BY inventory_item_id
    ) ch
    WHERE ii.id = ch.inventory_item_id
      AND ii.last_restocked_at IS NULL
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_inventory_items_stale
      ON inventory_items(tenant_id, last_restocked_at)
      WHERE quantity > 0 AND last_restocked_at IS NOT NULL
  `;
}
