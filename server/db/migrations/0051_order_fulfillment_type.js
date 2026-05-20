export const version = 51;
export const name = 'order_fulfillment_type';

export async function up(sql) {
  await sql`
    ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS order_fulfillment_type TEXT DEFAULT 'to_go'
  `;
}
