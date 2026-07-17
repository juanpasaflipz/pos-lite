export const version = 84;
export const name = 'stripe_webhook_events';

// Stripe retries webhooks aggressively on any non-2xx (including transient
// 500s), and even 2xx retries happen if their edge times out. Without an
// event_id dedupe, subscription.deleted retries after a real cancel
// overwrite subscription_cancelled_at and re-toggle downgrade side effects.
// One tiny append-only table + ON CONFLICT makes the handler idempotent.
export async function up(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS stripe_webhook_events (
      event_id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
}
