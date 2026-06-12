export const version = 70;
export const name = 'unaccent_extension';

// Enables Postgres `unaccent` so kiosk name-lookup ("Pagar mi cuenta" /
// "Agregar a mi orden") can match "José" against "Jose". Used in
// server/routes/kiosk.js → GET /orders/open name matcher.
export async function up(sql) {
  await sql`CREATE EXTENSION IF NOT EXISTS unaccent`;
}
