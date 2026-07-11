export const version = 78;
export const name = 'cfdi_invoices_receptor_email';

// Adds cfdi_invoices.receptor_email so we can persist the address the
// invoice was auto-sent to and, later, resend without re-prompting.

export async function up(sql) {
  await sql`
    ALTER TABLE cfdi_invoices
    ADD COLUMN IF NOT EXISTS receptor_email TEXT
  `;
}
