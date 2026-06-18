export const version = 71;
export const name = 'delivery_pending_dispatch';

// Kiosk delivery orders are now created BEFORE the customer has paid (status
// 'draft_kiosk'). We can't dispatch the Uber Direct courier until the card
// clears — otherwise we'd be paying for couriers on abandoned orders. Stash
// the dispatch payload on the delivery_orders row so the payment-success
// handler can re-hydrate it and book the courier after the charge succeeds.
//
// platform_status uses two new sentinel values that the operator UIs already
// tolerate as opaque strings:
//   - 'pending_payment' → row exists but courier has not been booked yet
//   - 'dispatch_failed' → payment succeeded, courier dispatch errored; an
//                          operator must rebook from the POS Delivery screen

export async function up(sql) {
  await sql`ALTER TABLE delivery_orders ADD COLUMN IF NOT EXISTS pending_dispatch JSONB`;
}
