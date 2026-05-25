export const version = 55;
export const name = 'order_payments_processor_fee';

export async function up(sql) {
  await sql`
    ALTER TABLE order_payments
    ADD COLUMN IF NOT EXISTS processor_fee NUMERIC(10,2),
    ADD COLUMN IF NOT EXISTS processor_net NUMERIC(10,2),
    ADD COLUMN IF NOT EXISTS processor_response JSONB
  `;
}
