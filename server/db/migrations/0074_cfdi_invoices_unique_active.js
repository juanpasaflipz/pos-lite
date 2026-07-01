export const version = 74;
export const name = 'cfdi_invoices_unique_active';

// Enforce at the DB layer that a single order cannot hold more than one live
// CFDI. Both /api/cfdi/invoices (staff) and /api/cfdi-public/:token/issue
// (customer QR) do a "does this order already have an invoice?" check before
// insert — but the check and the insert aren't atomic, so two concurrent
// requests can each pass the check and both stamp a CFDI at FacturAPI. The
// second row is legally a duplicate. This partial unique index closes the
// window regardless of which route lost the race: the loser's INSERT gets
// 23505 and the route surfaces a 409.
//
// Partial (WHERE status <> 'cancelled') so a cancelled invoice can be
// replaced by a substitute for the same order without dropping the index.

export async function up(sql) {
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_cfdi_invoices_order_active
      ON cfdi_invoices (order_id)
      WHERE status <> 'cancelled'
  `;
}
