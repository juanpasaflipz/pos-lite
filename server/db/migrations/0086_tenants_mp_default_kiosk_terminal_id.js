export const version = 86;
export const name = 'tenants_mp_default_kiosk_terminal_id';

// Kiosk-scoped default MP terminal — separate from the POS default so an
// unpaired kiosk device falls back to the customer-side terminal instead of
// the counter terminal. When null, kiosks continue to fall back to
// mp_default_terminal_id (unchanged behavior).

export async function up(sql) {
  await sql`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS mp_default_kiosk_terminal_id TEXT`;
}
