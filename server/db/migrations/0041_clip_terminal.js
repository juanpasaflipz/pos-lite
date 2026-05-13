export const version = 40;
export const name = 'clip_terminal';

export async function up(sql) {
  await sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS clip_payment_id TEXT`;
  await sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS clip_terminal_id TEXT`;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_orders_clip_payment_id
      ON orders(clip_payment_id) WHERE clip_payment_id IS NOT NULL
  `;
}
