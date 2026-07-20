export const version = 87;
export const name = 'menu_items_i18n';

// English translation columns for menu items. Spanish (name/description) stays
// the source of truth — merchants edit in Spanish, and a Claude call at write
// time populates the _en columns as a cache. Kiosk falls back to the Spanish
// original when the translation is missing (null or empty) so the customer
// never sees a blank tile.

export async function up(sql) {
  await sql`ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS name_en TEXT`;
  await sql`ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS description_en TEXT`;
}
