export const version = 80;
export const name = 'cfdi_invoices_provider_response';

// Persist the raw Facturapi createInvoice response alongside each stamped
// CFDI. Cheap JSONB column, high forensic value: when a SAT cancellation
// dispute or "why does this UUID look wrong" ticket lands months later,
// having the full response (series/folio, verification URL, tax breakdown,
// stamped XML metadata) attached to the row turns a log-archaeology
// exercise into a single-row lookup.
//
// Written via adminSql.json() at the call site, NOT via `${JSON.stringify(x)}::jsonb`
// — that pattern silently double-encodes JSONB and reads come back as
// strings (see memory: postgres.js JSONB gotcha, auditLog.js:19 latent bug).

export async function up(sql) {
  await sql`
    ALTER TABLE cfdi_invoices
    ADD COLUMN IF NOT EXISTS provider_response JSONB
  `;
}
