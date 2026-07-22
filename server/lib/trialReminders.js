import { adminSql } from '../db/index.js';
import { sendTrialEndingSoonEmail, sendTrialEndedEmail } from '../helpers/email.js';

// Trial lifecycle emails for freemium signups (see migrations/0090).
// The downgrade itself is implicit — planLimits.effectivePlan stops granting
// Pro the moment trial_ends_at passes — so this sweep only sends the two
// emails, each exactly once per tenant:
//   1. "ending soon": trial ends within REMINDER_DAYS, founders offer CTA
//   2. "ended": trial is over, POS-keeps-working reassurance + offer CTA
// Tenants who upgraded (plan='pro') are skipped — no point nudging buyers.
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 4×/day keeps "1 día" accurate
const REMINDER_DAYS = Number(process.env.TRIAL_REMINDER_DAYS) || 3;
const BATCH_LIMIT = 100;

let timer = null;

export async function sweepTrialsOnce() {
  // Ending soon — claim the batch by setting the sent-at marker in the same
  // statement, so a crashed loop or overlapping sweep can't double-send.
  try {
    const endingSoon = await adminSql`
      UPDATE tenants
      SET trial_reminder_sent_at = NOW()
      WHERE id IN (
        SELECT id FROM tenants
        WHERE plan <> 'pro'
          AND active = true
          AND trial_ends_at > NOW()
          AND trial_ends_at <= NOW() + make_interval(days => ${REMINDER_DAYS})
          AND trial_reminder_sent_at IS NULL
        ORDER BY trial_ends_at
        LIMIT ${BATCH_LIMIT}
      )
      RETURNING id, name, subdomain, owner_email, trial_ends_at
    `;
    for (const t of endingSoon) {
      const daysLeft = Math.max(1, Math.ceil((new Date(t.trial_ends_at).getTime() - Date.now()) / 86_400_000));
      await sendTrialEndingSoonEmail({
        email: t.owner_email,
        restaurantName: t.name,
        subdomain: t.subdomain,
        daysLeft,
      });
    }
    if (endingSoon.length) console.log(`[Trial] ending-soon emails sent: ${endingSoon.length}`);
  } catch (err) {
    console.error('[Trial] ending-soon sweep failed:', err.message);
  }

  // Ended — same claim-then-send pattern.
  try {
    const ended = await adminSql`
      UPDATE tenants
      SET trial_ended_notified_at = NOW()
      WHERE id IN (
        SELECT id FROM tenants
        WHERE plan <> 'pro'
          AND active = true
          AND trial_ends_at <= NOW()
          AND trial_ended_notified_at IS NULL
        ORDER BY trial_ends_at
        LIMIT ${BATCH_LIMIT}
      )
      RETURNING id, name, subdomain, owner_email
    `;
    for (const t of ended) {
      await sendTrialEndedEmail({
        email: t.owner_email,
        restaurantName: t.name,
        subdomain: t.subdomain,
      });
    }
    if (ended.length) console.log(`[Trial] trial-ended emails sent: ${ended.length}`);
  } catch (err) {
    console.error('[Trial] ended sweep failed:', err.message);
  }
}

export function startTrialSweep() {
  if (timer) return;
  // Same guard rationale as the SMS sweeps: local dev points at prod Neon,
  // and a `npm run dev` boot must not email real trial signups.
  if (process.env.NODE_ENV !== 'production' && process.env.ENABLE_BACKGROUND_EMAIL !== 'true') {
    console.log('[Trial] sweep disabled (NODE_ENV != production; set ENABLE_BACKGROUND_EMAIL=true to override)');
    return;
  }
  const bootDelay = setTimeout(sweepTrialsOnce, 90_000);
  bootDelay.unref?.();
  timer = setInterval(sweepTrialsOnce, SWEEP_INTERVAL_MS);
  timer.unref?.();
  console.log(`[Trial] sweep started (every ${SWEEP_INTERVAL_MS / 3600_000}h, reminder at ${REMINDER_DAYS} days)`);
}

export function stopTrialSweep() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
