import { adminSql } from '../db/index.js';
import { syncKioskClipCharge, dispatchPendingCourier } from '../routes/kiosk.js';

// Late Clip approvals on kiosk orders.
//
// A decline on the Clip reader is not final: the guest can pay the same intent
// with another card. But the kiosk stops polling the moment it sees 'failed'
// (or after ~2.5 minutes), and Clip's webhook is best-effort — so an approval
// that lands after that had nobody listening. The reader collected the money
// and the order stayed "sin cobrar" (order 20261110013, 2026-11-10).
//
// The status poll, the webhook, the kiosk's retry and the cashier claim all
// re-read such an intent now, but each needs someone to act. This sweep is the
// backstop that needs nobody: it re-reads the Clip intent of recent kiosk
// orders we gave up on and settles the ones Clip approved.
//
// Scope, deliberately narrow:
//   - 'failed' / 'unpaid' rows that still carry a clip_payment_id, and
//   - 'pending_terminal' rows nobody has settled for STALE_PENDING_MINUTES —
//     long past the kiosk's own poll, so this never races a live charge.
// syncKioskClipCharge owns the outcome (atomic pending→paid claim, so a
// concurrent webhook or poll can't settle the same intent twice).
const SWEEP_INTERVAL_MS = 60_000;
const LOOKBACK_HOURS = 3;
const STALE_PENDING_MINUTES = 10;
const BATCH_LIMIT = 25;

let timer = null;
let running = false;

export async function sweepKioskClipLateApprovals() {
  if (running) return { checked: 0, settled: 0 };
  running = true;
  let checked = 0;
  let settled = 0;
  try {
    const rows = await adminSql`
      SELECT o.id, o.tenant_id, o.order_number, o.payment_status
      FROM orders o
      JOIN tenants t ON t.id = o.tenant_id AND t.active = true
      WHERE o.source = 'customer_kiosk'
        AND o.clip_payment_id IS NOT NULL
        AND o.created_at > NOW() - ${LOOKBACK_HOURS} * INTERVAL '1 hour'
        AND (
          o.payment_status IN ('failed', 'unpaid')
          OR (o.payment_status = 'pending_terminal'
              AND o.created_at < NOW() - ${STALE_PENDING_MINUTES} * INTERVAL '1 minute')
        )
      ORDER BY o.created_at DESC
      LIMIT ${BATCH_LIMIT}
    `;
    for (const row of rows) {
      checked += 1;
      try {
        const synced = await syncKioskClipCharge(row.id, row.tenant_id);
        if (synced?.mapped === 'paid') {
          settled += 1;
          await dispatchPendingCourier(row.id, row.tenant_id);
          console.warn(
            `[KioskClipLate] order ${row.order_number} (id ${row.id}) was '${row.payment_status}' — Clip approved it; marked paid`,
          );
        }
      } catch (err) {
        // One unreadable intent must not stop the rest of the batch.
        console.error(`[KioskClipLate] order ${row.id} check failed:`, err.message);
      }
    }
  } catch (err) {
    console.error('[KioskClipLate] sweep failed:', err.message);
  } finally {
    running = false;
  }
  return { checked, settled };
}

export function startKioskClipLateApprovalSweep() {
  // Same NODE_ENV gate as the other background sweeps: local `npm run dev`
  // shares prod's DATABASE_URL, and this one both calls Clip and marks orders
  // paid — never from a laptop.
  if (process.env.NODE_ENV !== 'production' && process.env.KIOSK_CLIP_LATE_SWEEP_ENABLED !== 'on') {
    console.log('[KioskClipLate] sweep disabled (NODE_ENV != production; set KIOSK_CLIP_LATE_SWEEP_ENABLED=on to override)');
    return;
  }
  if (timer) return;
  sweepKioskClipLateApprovals();
  timer = setInterval(sweepKioskClipLateApprovals, SWEEP_INTERVAL_MS);
  timer.unref?.();
  console.log(`[KioskClipLate] late-approval sweep started (every ${SWEEP_INTERVAL_MS / 1000}s, lookback ${LOOKBACK_HOURS}h)`);
}

export function stopKioskClipLateApprovalSweep() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
