export const version = 75;
export const name = 'loyalty_google_review_target';

// Splits the review-link config into two rows per tenant:
//   google_review_target — the raw Google URL (g.page/... or maps.app.goo.gl/...).
//                         Owner pastes this via the Loyalty settings screen.
//   google_review_url    — the customer-facing short URL rendered in SMS bodies.
//                         Always `https://{subdomain}.desktop.kitchen/gr`, which
//                         the public /gr redirect resolves to google_review_target.
//
// Before this migration, google_review_url held whatever the owner pasted
// (empty for demo, our own /gr URL for juanbertos). This migration:
//   1. Inserts google_review_target for every tenant that doesn't have one.
//   2. Overwrites empty google_review_url values with the subdomain-derived
//      /gr URL so new SMS sends work without owner action.
//   3. Leaves already-populated google_review_url values alone (juanbertos'
//      row is already correct).

export async function up(sql) {
  await sql`
    INSERT INTO loyalty_config (tenant_id, key, value, description)
    SELECT t.id, 'google_review_target', '',
           'Raw Google review link (g.page/... or maps.app.goo.gl/...). Owner pastes this; the public /gr route redirects to it.'
    FROM tenants t
    ON CONFLICT (tenant_id, key) DO NOTHING
  `;

  await sql`
    UPDATE loyalty_config lc
    SET value = 'https://' || t.subdomain || '.desktop.kitchen/gr',
        description = 'Auto-generated short URL that appears in review-driving SMS. System-owned; do not edit.'
    FROM tenants t
    WHERE lc.tenant_id = t.id
      AND lc.key = 'google_review_url'
      AND (lc.value IS NULL OR lc.value = '')
  `;
}
