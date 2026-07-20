import { adminSql } from '../db/index.js';

// Periodic housekeeping: delete terminal print_jobs once they're old enough.
//
// Every kitchen ticket stores its full payload twice inside `payload` JSONB
// (the base64 ESC/POS blob AND the rendered ticket object — see
// printQueue.js), and nothing ever deleted them, so the table grows without
// bound. Once a job is 'done' (printed) or 'error' (terminally failed) and a
// week has passed, the payload has no reader left — the bridge won't re-claim
// it and no reprint reaches that far back — so it's safe to drop.
//
// Retention is env-tunable; 'error' rows are kept the same window so there's a
// few days to inspect a failure before it's swept. Age is measured from
// printed_at for done jobs (NULL for errors) and falls back to created_at.
const SWEEP_INTERVAL_MS = 60 * 60_000; // hourly — this is slow-moving cleanup
const RETENTION_DAYS = Number(process.env.PRINT_JOB_RETENTION_DAYS) || 7;

let timer = null;

async function sweepOnce() {
  try {
    // adminSql (neondb_owner) bypasses RLS, so this prunes every tenant in one
    // pass. Only terminal states are eligible — 'queued'/'printing' jobs are
    // still in flight and must never be touched regardless of age.
    const rows = await adminSql`
      DELETE FROM print_jobs
      WHERE status IN ('done', 'error')
        AND COALESCE(printed_at, created_at) < NOW() - ${RETENTION_DAYS} * INTERVAL '1 day'
      RETURNING id
    `;
    if (rows.length > 0) {
      console.log(
        `[PrunePrintJobs] Deleted ${rows.length} terminal print job(s) older than ${RETENTION_DAYS}d`,
      );
    }
  } catch (err) {
    console.error('[PrunePrintJobs] sweep failed:', err.message);
  }
}

export function startPrunePrintJobsSweep() {
  // Same NODE_ENV gate as the other background sweeps: local `npm run dev`
  // shares prod's DATABASE_URL, and a DELETE is destructive — an ungated
  // laptop boot would erase real prod rows. Set PRUNE_PRINT_JOBS_ENABLED=on to
  // run it outside production (e.g. a maintenance script).
  if (process.env.NODE_ENV !== 'production' && process.env.PRUNE_PRINT_JOBS_ENABLED !== 'on') {
    console.log('[PrunePrintJobs] sweep disabled (NODE_ENV != production; set PRUNE_PRINT_JOBS_ENABLED=on to override)');
    return;
  }
  if (timer) return;
  sweepOnce();
  timer = setInterval(sweepOnce, SWEEP_INTERVAL_MS);
  timer.unref?.();
  console.log(
    `[PrunePrintJobs] print_jobs prune sweep started (every ${SWEEP_INTERVAL_MS / 60_000}min, retention ${RETENTION_DAYS}d)`,
  );
}

export function stopPrunePrintJobsSweep() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
