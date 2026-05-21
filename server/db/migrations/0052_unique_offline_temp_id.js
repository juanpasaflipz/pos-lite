export const version = 52;
export const name = 'unique_offline_temp_id';

export async function up(sql) {
  // Make existing duplicates safe before applying the unique constraint.
  // Keep the lowest-id order as canonical; null out offline_temp_id on dupes
  // so the surviving row still owns the dedup key and we don't delete history.
  await sql`
    WITH dupes AS (
      SELECT id
      FROM (
        SELECT id, ROW_NUMBER() OVER (
          PARTITION BY tenant_id, offline_temp_id ORDER BY id
        ) AS rn
        FROM orders
        WHERE offline_temp_id IS NOT NULL
      ) ranked
      WHERE rn > 1
    )
    UPDATE orders SET offline_temp_id = NULL
    WHERE id IN (SELECT id FROM dupes)
  `;

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS orders_tenant_offline_temp_id_uniq
    ON orders (tenant_id, offline_temp_id)
    WHERE offline_temp_id IS NOT NULL
  `;
}
