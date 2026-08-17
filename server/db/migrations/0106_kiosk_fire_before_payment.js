// Fire kiosk orders to the kitchen the moment the customer finishes ordering,
// instead of waiting for the card to clear.
//
// The pay-first lifecycle (draft_kiosk → active on payment) kept the kitchen
// from ever seeing an unpaid ticket, but it also parked the whole order behind
// the slowest step in the flow: the customer fishing out a card, tapping,
// waiting for the terminal. That's dead time the kitchen could have spent
// cooking. Firing at "ready to pay" hands the kitchen a head start roughly the
// length of the payment interaction.
//
// The trade is real: a customer who walks away mid-payment leaves food already
// in progress. That's why it's a per-tenant switch, DEFAULT OFF — every tenant
// keeps the pay-first lifecycle they have today until someone opts in, either
// from Account settings or here.
//
//   tenants.kiosk_fire_before_payment — ON: /kiosk/orders/send-to-kitchen and
//     /send-to-delivery create the order as status='active' (KDS sees it) with
//     payment_status='unpaid'. OFF: the original draft_kiosk lifecycle.
//   orders.kitchen_fire_at — stamped when an order was fired ahead of payment.
//     It's what tells the cashier banner, the MP-failure branch, and any later
//     reporting that this ticket is already being cooked, so nothing downstream
//     may quietly delete or cancel it.
export const version = 106;
export const name = 'kiosk_fire_before_payment';

export async function up(sql) {
  await sql`
    ALTER TABLE tenants
    ADD COLUMN IF NOT EXISTS kiosk_fire_before_payment BOOLEAN NOT NULL DEFAULT false
  `;
  // Idempotent belt-and-braces: if an earlier build of this migration already
  // landed the column with DEFAULT true on a branch, bring it back in line.
  await sql`
    ALTER TABLE tenants
    ALTER COLUMN kiosk_fire_before_payment SET DEFAULT false
  `;
  await sql`
    UPDATE tenants SET kiosk_fire_before_payment = false
    WHERE kiosk_fire_before_payment = true
  `;

  await sql`
    ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS kitchen_fire_at TIMESTAMPTZ
  `;
  // Powers the cashier's "already cooking, still unpaid" lookup. Partial so it
  // stays tiny — only kiosk orders that fired early ever land in it.
  await sql`
    CREATE INDEX IF NOT EXISTS idx_orders_fired_unpaid
    ON orders (tenant_id, created_at DESC)
    WHERE kitchen_fire_at IS NOT NULL
  `;

  // Juanberto's is the pilot: it's the tenant whose floor flow this was
  // designed against, and the one whose owner is on-site to watch what happens
  // to the tickets nobody pays for. Everyone else opts in from Account
  // settings. Harmless no-op on any database that doesn't have this tenant.
  const piloted = await sql`
    UPDATE tenants SET kiosk_fire_before_payment = true
    WHERE id = 'juanbertos' OR subdomain = 'juanbertos'
    RETURNING id
  `;
  // Say so out loud. A zero here on the production database would mean the
  // pilot silently didn't get the feature it was built for, and the only
  // symptom would be "nothing changed" — the hardest kind of bug to notice.
  console.log(`[Migrate] 0106: kiosk fire-before-payment enabled for ${piloted.length} tenant(s)`);
}
