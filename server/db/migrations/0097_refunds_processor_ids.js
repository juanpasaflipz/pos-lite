export const version = 97;
export const name = 'refunds_processor_ids';

// Codify two columns that existed only in prod (2026-07-30).
//
// `POST /api/payments/refund` has always INSERTed conekta_refund_id and
// getnet_refund_id, but neither column was ever in pg-schema.sql or a
// migration — they were added to prod by hand. The test branch inherited them
// by being branched off prod, so the whole suite passed while any DB actually
// built from schema + migrations would fail EVERY refund with
// `column "conekta_refund_id" does not exist`.
//
// Nothing surfaced it because refunds were only reachable from the live-order
// lane; exposing refunds on completed orders makes that latent break much
// easier to hit. Same codification pattern as 0088 (introspect prod,
// transcribe faithfully, keep it idempotent).
//
// Conekta was dropped 2026-07-16 and its column is retained for historical
// rows only — see the Conekta note in CLAUDE.md. Do not read this as the
// integration coming back.
export async function up(sql) {
  await sql`ALTER TABLE refunds ADD COLUMN IF NOT EXISTS conekta_refund_id TEXT`;
  await sql`ALTER TABLE refunds ADD COLUMN IF NOT EXISTS getnet_refund_id TEXT`;
}
