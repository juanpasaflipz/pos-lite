export const version = 40;
export const name = 'expense_intelligence';

export async function up(sql) {
  await sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_vendors_name_trgm
      ON vendors USING GIN (name gin_trgm_ops)
  `;

  await sql`
    ALTER TABLE inventory_items
      ADD COLUMN IF NOT EXISTS pack_size NUMERIC(10,3)
  `;

  await sql`
    ALTER TABLE vendor_items
      ADD COLUMN IF NOT EXISTS last_seen_description TEXT
  `;
  await sql`
    ALTER TABLE vendor_items
      ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_vendor_items_desc_trgm
      ON vendor_items USING GIN (last_seen_description gin_trgm_ops)
  `;

  await sql`
    ALTER TABLE expenses
      ADD COLUMN IF NOT EXISTS vendor_id INTEGER REFERENCES vendors(id)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_expenses_vendor_id
      ON expenses(tenant_id, vendor_id)
      WHERE vendor_id IS NOT NULL
  `;
}
