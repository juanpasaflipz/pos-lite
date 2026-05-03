export const version = 38;
export const name = 'order_discounts';

export async function up(sql) {
  await sql`
    ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(10,2) DEFAULT 0
  `;
  await sql`
    ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS discount_type TEXT
  `;
  await sql`
    ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS discount_reason TEXT
  `;
  await sql`
    ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS discount_authorized_by INTEGER REFERENCES employees(id)
  `;

  await sql`
    ALTER TABLE order_items
    ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(10,2) DEFAULT 0
  `;
  await sql`
    ALTER TABLE order_items
    ADD COLUMN IF NOT EXISTS discount_type TEXT
  `;
  await sql`
    ALTER TABLE order_items
    ADD COLUMN IF NOT EXISTS discount_reason TEXT
  `;
  await sql`
    ALTER TABLE order_items
    ADD COLUMN IF NOT EXISTS discount_authorized_by INTEGER REFERENCES employees(id)
  `;
}
