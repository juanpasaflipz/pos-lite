import { adminSql, withTenant } from '../db/index.js';
import { sendWinbackMessage } from '../helpers/twilio.js';

// Nudge customers who stopped visiting. Runs daily; skips anyone with a
// completed unredeemed card (they get reward-reminder instead) and anyone
// who already got a winback since their last visit.
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const LAPSE_DAYS = Number(process.env.WINBACK_LAPSE_DAYS) || 45;
const BATCH_LIMIT = 100;

let timer = null;

async function sweepOnce() {
  try {
    // adminSql bypasses RLS. Fetch active (uncompleted) stamp card progress
    // via LATERAL — customers with no active card get NULL progress and the
    // template falls back to a phrase without stamp counts.
    // Skip customers with a completed unredeemed card so we don't double-nudge
    // alongside the reward-reminder sweep.
    const candidates = await adminSql`
      SELECT DISTINCT ON (lc.id)
             lc.id AS customer_id,
             lc.tenant_id,
             lc.last_visit,
             lc.name,
             lc.phone,
             lc.country_code,
             t.name AS restaurant_name,
             COALESCE(sc.stamps_earned, 0) AS stamps_earned,
             COALESCE(sc.stamps_required, 10) AS stamps_required
      FROM loyalty_customers lc
      JOIN tenants t ON t.id = lc.tenant_id
      LEFT JOIN LATERAL (
        SELECT stamps_earned, stamps_required
        FROM stamp_cards
        WHERE customer_id = lc.id AND completed = false
        ORDER BY id DESC LIMIT 1
      ) sc ON TRUE
      WHERE lc.sms_opt_in = true
        AND lc.last_visit IS NOT NULL
        AND lc.last_visit < NOW() - ${LAPSE_DAYS} * INTERVAL '1 day'
        AND NOT EXISTS (
          SELECT 1 FROM stamp_cards
          WHERE customer_id = lc.id
            AND completed = true AND redeemed = false
        )
        AND NOT EXISTS (
          SELECT 1 FROM loyalty_messages lm
          WHERE lm.customer_id = lc.id
            AND lm.message_type = 'winback'
            AND lm.created_at >= lc.last_visit
        )
      ORDER BY lc.id, lc.last_visit DESC
      LIMIT ${BATCH_LIMIT}
    `;

    if (candidates.length === 0) return;

    let sent = 0;
    for (const c of candidates) {
      try {
        await withTenant(c.tenant_id, async () => {
          const sid = await sendWinbackMessage(
            c.phone,
            c.name,
            c.customer_id,
            c.restaurant_name || 'us',
            c.stamps_earned || 0,
            c.stamps_required || 10,
            c.country_code || 'MX',
          );
          if (sid) sent++;
        });
      } catch (err) {
        console.error(
          `[Winback] send failed for tenant=${c.tenant_id} customer=${c.customer_id}:`,
          err.message,
        );
      }
    }

    console.log(
      `[Winback] sweep: ${candidates.length} candidates, ${sent} SMS sent`,
    );
  } catch (err) {
    console.error('[Winback] sweep failed:', err.message);
  }
}

export function startWinbackSweep() {
  if (timer) return;
  // Local dev typically points at prod Neon; without this gate a `npm run dev`
  // boot would fire real winback SMS to real customers from whatever
  // TWILIO_PHONE_NUMBER the laptop happens to have. Explicit override for
  // intentional local SMS testing.
  if (process.env.NODE_ENV !== 'production' && process.env.ENABLE_BACKGROUND_SMS !== 'true') {
    console.log('[Winback] sweep disabled (NODE_ENV != production; set ENABLE_BACKGROUND_SMS=true to override)');
    return;
  }
  // Delay first sweep 60s so we don't overlap with reward-reminder + boot work.
  const bootDelay = setTimeout(sweepOnce, 60_000);
  bootDelay.unref?.();
  timer = setInterval(sweepOnce, SWEEP_INTERVAL_MS);
  timer.unref?.();
  console.log(
    `[Winback] sweep started (every ${SWEEP_INTERVAL_MS / 3600_000}h, threshold ${LAPSE_DAYS} days)`,
  );
}

export function stopWinbackSweep() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
