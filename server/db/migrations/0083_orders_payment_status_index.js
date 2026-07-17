export const version = 83;
export const name = 'orders_payment_status_index';

// idx_orders_payment_status lives in pg-schema.sql:836 but pg-schema.sql is
// bootstrap-only; existing prod databases were provisioned before the index
// was added and never picked it up. This migration ships it to every deploy
// via the normal runner. Speeds up "unpaid orders" scans (LiveOrdersStrip,
// purge-unpaid, kiosk-held, needs-payment predicates).
export async function up(sql) {
  await sql`
    CREATE INDEX IF NOT EXISTS idx_orders_payment_status
      ON orders(tenant_id, payment_status, paid_at)
  `;
}
