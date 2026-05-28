export const version = 65;
export const name = 'order_customer_secret';

// Per-order secret issued at QR/customer-order creation, required on the
// public status/payment-intent/confirm-payment endpoints. Closes the
// enumerate-orders-by-id hole on those public routes.

export async function up(sql) {
  await sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_secret TEXT`;
}
