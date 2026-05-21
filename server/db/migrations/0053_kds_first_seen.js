export const version = 53;
export const name = 'kds_first_seen';

export async function up(sql) {
  // Stamps when the kitchen display first saw an order. Lets us answer
  // "did the kitchen actually see ticket X?" — a real gap when network
  // blips can cause an order to be created and resolved without ever
  // appearing on a KDS screen.
  await sql`
    ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS first_kds_seen_at TIMESTAMPTZ
  `;
}
