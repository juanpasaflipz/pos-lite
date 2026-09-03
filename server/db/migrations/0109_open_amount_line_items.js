export const version = 109;
export const name = 'open_amount_line_items';

// Open-amount ("monto abierto") order lines, 2026-09-03.
//
// Why: the cashier needs to charge an arbitrary figure to the card terminal —
// a deposit, a catering balance, an off-menu extra. Every terminal path we
// have (MP Point, Clip, external bank terminals) is keyed on an order id, so
// the cheapest correct way to get there is a cart line whose price the cashier
// types instead of one the menu dictates. The order then reuses payment
// polling, terminal failover, receipts, reports, refunds and CFDI unchanged.
//
// The line itself is a normal order_items row with menu_item_id NULL. NULL
// alone is not the marker: delivery.js already writes NULL for marketplace
// items it could not match to our menu, and those DO belong on the kitchen
// display. Hence an explicit flag — it is the only thing that tells "the
// cashier typed this price" apart from "we could not match this item".
//
// Kitchen: an open-amount line is money, not food. GET /orders/kitchen/active
// drops these lines from every ticket, and drops the whole order when it has
// nothing else on it. Defaulting to false keeps every pre-existing order —
// and every non-POS ingestion path — rendering exactly as it does today.

export async function up(sql) {
  await sql`
    ALTER TABLE order_items
      ADD COLUMN IF NOT EXISTS is_open_amount BOOLEAN NOT NULL DEFAULT FALSE
  `;

  // Partial index: open-amount lines are a small minority of the table, and
  // the KDS "does this order have anything to cook?" check probes by order.
  await sql`
    CREATE INDEX IF NOT EXISTS idx_order_items_open_amount
      ON order_items(tenant_id, order_id)
      WHERE is_open_amount
  `;
}
