import { adminSql } from '../db/index.js';

// Sweep cadence and threshold. Threshold is env-tunable so a tenant with
// slower runner/driver handoffs can stretch the window without a code change.
const SWEEP_INTERVAL_MS = 60_000;
const READY_AGE_MINUTES = Number(process.env.AUTO_COMPLETE_READY_MINUTES) || 5;

let timer = null;

async function sweepOnce() {
  try {
    // Paid filter is load-bearing: an unpaid ready order disappearing
    // would orphan revenue (no Cobrar button visible on the strip).
    const rows = await adminSql`
      UPDATE orders
      SET status = 'completed',
          completed_at = NOW()
      WHERE status = 'ready'
        AND payment_status IN ('paid', 'completed')
        AND ready_at IS NOT NULL
        AND ready_at < NOW() - ${READY_AGE_MINUTES} * INTERVAL '1 minute'
      RETURNING id, tenant_id
    `;
    if (rows.length > 0) {
      console.log(
        `[AutoComplete] Completed ${rows.length} ready order(s) older than ${READY_AGE_MINUTES}min`,
      );
    }
  } catch (err) {
    console.error('[AutoComplete] sweep failed:', err.message);
  }
}

export function startAutoCompleteSweep() {
  if (timer) return;
  sweepOnce();
  timer = setInterval(sweepOnce, SWEEP_INTERVAL_MS);
  timer.unref?.();
  console.log(
    `[AutoComplete] ready→completed sweep started (every ${SWEEP_INTERVAL_MS / 1000}s, threshold ${READY_AGE_MINUTES}min)`,
  );
}

export function stopAutoCompleteSweep() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
