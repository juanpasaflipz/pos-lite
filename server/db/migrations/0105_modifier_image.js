// Modifier photos. The kiosk builder's Estilo cards (California / Mission /
// Fries) are modifier rows, and the owner wants real food photography on them
// like the rest of the wizard. menu_items has carried image_url since the
// beginning; this brings modifiers to parity. NULL means "no photo" and every
// renderer falls back to its icon, so existing surfaces are unaffected.
export const version = 105;
export const name = 'modifier_image';

export async function up(sql) {
  await sql`ALTER TABLE modifiers ADD COLUMN IF NOT EXISTS image_url TEXT`;
}
