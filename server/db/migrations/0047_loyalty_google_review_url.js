export const version = 47;
export const name = 'loyalty_google_review_url';

// Seeds an empty google_review_url row in loyalty_config for every existing
// tenant. Merchants paste their Google review short link via Loyalty settings;
// the SMS wrappers append a "déjanos una reseña" CTA when the value is set.
//
// Why: review nudges right after a stamp/reward are the highest-converting
// moment to ask for a 5-star Google review.

export async function up(sql) {
  await sql`
    INSERT INTO loyalty_config (tenant_id, key, value, description)
    SELECT DISTINCT tenant_id, 'google_review_url', '',
           'Google review link appended to stamp/reward SMS to drive 5-star reviews'
    FROM loyalty_config
    ON CONFLICT (tenant_id, key) DO NOTHING
  `;
}
