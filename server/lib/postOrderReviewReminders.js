import { adminSql, withTenant } from '../db/index.js';
import { sendPostOrderReviewMessage } from '../helpers/twilio.js';

// Sends a "gracias por tu visita, ¿nos calificas?" SMS ~1 hour after an
// order is marked completed. Gated by POST_ORDER_REVIEW_TENANTS env var so
// the flow can be enabled per-tenant during rollout. Skips customers who
// received any review-CTA-carrying SMS in the last 14 days (post_order_review,
// stamp_earned, reward_reminder) so daily regulars don't get spammed.
const SWEEP_INTERVAL_MS = 15 * 60 * 1000;
const DELAY_MINUTES = Number(process.env.POST_ORDER_REVIEW_DELAY_MINUTES) || 60;
const DEDUP_DAYS = Number(process.env.POST_ORDER_REVIEW_DEDUP_DAYS) || 14;
const BATCH_LIMIT = 100;

let timer = null;

function enabledTenants() {
  return (process.env.POST_ORDER_REVIEW_TENANTS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function sweepOnce() {
  const tenants = enabledTenants();
  if (tenants.length === 0) return;

  try {
    // Upper bound of 4h from the sweep prevents retroactive blasts on first
    // enable — only orders completed within the last 4h AND >DELAY_MINUTES
    // old qualify. DISTINCT ON (customer_id) so a customer with two recent
    // completed orders gets a single SMS. The 14-day dedup then blocks
    // subsequent orders from this same customer.
    const candidates = await adminSql`
      SELECT DISTINCT ON (lc.id)
             o.id AS order_id,
             lc.id AS customer_id,
             lc.tenant_id,
             lc.name,
             lc.phone,
             lc.country_code,
             t.name AS restaurant_name,
             (SELECT value FROM loyalty_config
              WHERE tenant_id = lc.tenant_id AND key = 'google_review_url') AS review_url
      FROM orders o
      JOIN loyalty_customers lc ON lc.id = o.loyalty_customer_id
      JOIN tenants t ON t.id = lc.tenant_id
      WHERE lc.tenant_id = ANY(${tenants}::text[])
        AND lc.sms_opt_in = true
        AND o.status = 'completed'
        AND o.payment_status IN ('paid', 'completed')
        AND o.completed_at IS NOT NULL
        AND o.completed_at < NOW() - ${DELAY_MINUTES} * INTERVAL '1 minute'
        AND o.completed_at > NOW() - INTERVAL '4 hours'
        AND NOT EXISTS (
          SELECT 1 FROM loyalty_messages lm
          WHERE lm.customer_id = lc.id
            AND lm.message_type IN ('post_order_review', 'stamp_earned', 'reward_reminder')
            AND lm.created_at > NOW() - ${DEDUP_DAYS} * INTERVAL '1 day'
        )
      ORDER BY lc.id, o.completed_at DESC
      LIMIT ${BATCH_LIMIT}
    `;

    if (candidates.length === 0) return;

    let sent = 0;
    let skippedNoUrl = 0;
    for (const c of candidates) {
      if (!c.review_url) {
        skippedNoUrl++;
        continue;
      }
      try {
        await withTenant(c.tenant_id, async () => {
          const sid = await sendPostOrderReviewMessage(
            c.phone,
            c.name,
            c.customer_id,
            c.restaurant_name || 'us',
            c.review_url,
            c.country_code || 'MX',
          );
          if (sid) sent++;
        });
      } catch (err) {
        console.error(
          `[PostOrderReview] send failed for tenant=${c.tenant_id} customer=${c.customer_id}:`,
          err.message,
        );
      }
    }

    console.log(
      `[PostOrderReview] sweep: ${candidates.length} candidates, ${sent} sent, ${skippedNoUrl} skipped (no review URL)`,
    );
  } catch (err) {
    console.error('[PostOrderReview] sweep failed:', err.message);
  }
}

export function startPostOrderReviewSweep() {
  if (timer) return;
  // Local dev typically points at prod Neon; without this gate a `npm run dev`
  // boot would fire real review-request SMS to real customers. Explicit
  // override for intentional local SMS testing.
  if (process.env.NODE_ENV !== 'production' && process.env.ENABLE_BACKGROUND_SMS !== 'true') {
    console.log('[PostOrderReview] sweep disabled (NODE_ENV != production; set ENABLE_BACKGROUND_SMS=true to override)');
    return;
  }
  // Delay first sweep 90s so we don't overlap with other startup jobs.
  const bootDelay = setTimeout(sweepOnce, 90_000);
  bootDelay.unref?.();
  timer = setInterval(sweepOnce, SWEEP_INTERVAL_MS);
  timer.unref?.();
  const tenants = enabledTenants();
  console.log(
    `[PostOrderReview] sweep started (every ${SWEEP_INTERVAL_MS / 60_000}min, delay ${DELAY_MINUTES}min, dedup ${DEDUP_DAYS}d, tenants=[${tenants.join(',') || 'none'}])`,
  );
}

export function stopPostOrderReviewSweep() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
