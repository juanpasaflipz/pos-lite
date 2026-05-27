export const version = 63;
export const name = 'order_item_edits';

// Edit-tracking for order_items so a sent order can be modified after KDS
// has seen it: items can be appended, quantity-changed, or soft-voided —
// all while preserving the kitchen's audit trail and a "what changed since
// last fire" badge on the KDS ticket.

export async function up(sql) {
  await sql`
    ALTER TABLE order_items
    ADD COLUMN IF NOT EXISTS added_at TIMESTAMPTZ
  `;
  await sql`
    ALTER TABLE order_items
    ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ
  `;
  await sql`
    ALTER TABLE order_items
    ADD COLUMN IF NOT EXISTS voided_by INTEGER REFERENCES employees(id)
  `;
  await sql`
    ALTER TABLE order_items
    ADD COLUMN IF NOT EXISTS void_reason TEXT
  `;
  await sql`
    ALTER TABLE order_items
    ADD COLUMN IF NOT EXISTS qty_changed_at TIMESTAMPTZ
  `;
  await sql`
    ALTER TABLE order_items
    ADD COLUMN IF NOT EXISTS original_quantity INTEGER
  `;

  // KDS frequently filters active rows by "not voided" — partial index keeps
  // the existing kitchen query fast even after lots of voids accumulate.
  await sql`
    CREATE INDEX IF NOT EXISTS idx_order_items_active_by_order
      ON order_items(tenant_id, order_id)
      WHERE voided_at IS NULL
  `;
}
