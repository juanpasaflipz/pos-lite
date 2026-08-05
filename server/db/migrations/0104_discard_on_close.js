export const version = 104;
export const name = 'discard_on_close';

// Perishable components that don't survive the night.
//
// The end-of-day count (P3 of PORTION_INVENTORY_SPEC.md) asks the kitchen what
// is actually on the line, but some components are never carried over — cooked
// rice goes in the bin, salsas usually don't. Flagging that per component turns
// "throw it out and zero the count" into one tap instead of a manual count of
// zero, and it books the loss as a real ledger movement
// (reason='carryover_discard') rather than letting it hide inside tomorrow's
// variance.
//
// Defaults to false, so nothing is discarded until someone says so, and the
// EOD screen behaves exactly as it would without this column.
export async function up(sql) {
  await sql`
    ALTER TABLE inventory_items
      ADD COLUMN IF NOT EXISTS discard_on_close BOOLEAN NOT NULL DEFAULT false
  `;
}
