import { adminSql, withTenant } from '../db/index.js';
import { sendRewardReminderMessage } from '../helpers/twilio.js';

// Nudge customers who completed a stamp card but haven't come back to redeem.
// Runs hourly; SQL guards against double-sending by checking loyalty_messages
// for a reminder logged after the card's completion timestamp.
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const REMINDER_AGE_DAYS = Number(process.env.REWARD_REMINDER_AGE_DAYS) || 7;
const BATCH_LIMIT = 100;

let timer = null;

async function sweepOnce() {
  try {
    // adminSql bypasses RLS so we can find candidates across all tenants in
    // one query. `t.name` is the display name shown in the SMS body.
    // DISTINCT ON (customer_id) so a customer with multiple stale unredeemed
    // cards gets at most one reminder per sweep. Take the newest card so the
    // logged reminder's created_at also satisfies the NOT EXISTS check for
    // any older unredeemed cards on future sweeps.
    const candidates = await adminSql`
      SELECT DISTINCT ON (sc.customer_id)
             sc.customer_id,
             sc.tenant_id,
             sc.completed_at,
             lc.name,
             lc.phone,
             lc.country_code,
             t.name AS restaurant_name
      FROM stamp_cards sc
      JOIN loyalty_customers lc ON lc.id = sc.customer_id
      JOIN tenants t ON t.id = sc.tenant_id
      WHERE sc.completed = true
        AND sc.redeemed = false
        AND sc.completed_at IS NOT NULL
        AND sc.completed_at < NOW() - ${REMINDER_AGE_DAYS} * INTERVAL '1 day'
        AND lc.sms_opt_in = true
        AND NOT EXISTS (
          SELECT 1 FROM loyalty_messages lm
          WHERE lm.customer_id = sc.customer_id
            AND lm.message_type = 'reward_reminder'
            AND lm.created_at >= sc.completed_at
        )
      ORDER BY sc.customer_id, sc.completed_at DESC
      LIMIT ${BATCH_LIMIT}
    `;

    if (candidates.length === 0) return;

    let sent = 0;
    for (const c of candidates) {
      try {
        // withTenant opens a tenant-scoped RLS transaction so tenant Twilio
        // creds resolve and the loyalty_messages INSERT gets the right
        // tenant_id from app.tenant_id.
        await withTenant(c.tenant_id, async () => {
          const sid = await sendRewardReminderMessage(
            c.phone,
            c.name,
            c.customer_id,
            c.restaurant_name || 'us',
            c.country_code || 'MX',
          );
          if (sid) sent++;
        });
      } catch (err) {
        console.error(
          `[RewardReminder] send failed for tenant=${c.tenant_id} customer=${c.customer_id}:`,
          err.message,
        );
      }
    }

    console.log(
      `[RewardReminder] sweep: ${candidates.length} candidates, ${sent} SMS sent`,
    );
  } catch (err) {
    console.error('[RewardReminder] sweep failed:', err.message);
  }
}

export function startRewardReminderSweep() {
  if (timer) return;
  // Delay first sweep to avoid competing with server boot / migration work.
  const bootDelay = setTimeout(sweepOnce, 30_000);
  bootDelay.unref?.();
  timer = setInterval(sweepOnce, SWEEP_INTERVAL_MS);
  timer.unref?.();
  console.log(
    `[RewardReminder] sweep started (every ${SWEEP_INTERVAL_MS / 60_000}min, threshold ${REMINDER_AGE_DAYS} days)`,
  );
}

export function stopRewardReminderSweep() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
