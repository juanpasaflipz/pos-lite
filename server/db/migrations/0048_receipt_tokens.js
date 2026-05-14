export const version = 48;
export const name = 'receipt_tokens';

// Tokenized public access to a single order's receipt — for the
// "Enviar recibo por SMS" flow. The customer gets a short URL by SMS,
// the link resolves to a read-only receipt page (no auth, no PII beyond
// what's on the printed ticket).
//
// Why a separate table (vs a column on orders): mirrors the existing
// cfdi_invoice_tokens pattern so the public lookup path uses adminSql to
// bypass RLS, and so we can issue multiple tokens per order if needed
// (re-send, expiry refresh, etc.) without rewriting the canonical row.

export async function up(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS receipt_tokens (
      id SERIAL PRIMARY KEY,
      token TEXT NOT NULL UNIQUE,
      tenant_id TEXT NOT NULL,
      order_id INTEGER NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_receipt_tokens_token ON receipt_tokens(token)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_receipt_tokens_order ON receipt_tokens(order_id)`;
}
