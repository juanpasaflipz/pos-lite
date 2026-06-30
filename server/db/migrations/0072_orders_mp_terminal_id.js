export const version = 72;
export const name = 'orders_mp_terminal_id';

// Per-kiosk MP terminal binding. Two kiosks can now each own a separate MP
// Point device. We persist the terminal id used at charge time so:
//   - the status poll re-uses the same terminal (legacy payment-intents API
//     requires it; new /v1/orders ignores it but it's still useful forensics)
//   - findActiveTerminalLock can scope the "terminal busy" check by device,
//     so kiosk A doesn't 409 when kiosk B's terminal is in use

export async function up(sql) {
  await sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS mp_terminal_id TEXT`;
  await sql`CREATE INDEX IF NOT EXISTS idx_orders_mp_terminal_pending
    ON orders (tenant_id, mp_terminal_id)
    WHERE payment_status = 'pending_terminal'`;
}
