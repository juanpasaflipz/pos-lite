import { Router } from 'express';
import crypto from 'crypto';
import { all, get, run, getConn, getTenantId } from '../db/index.js';
import { adminSql } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { requireAgentToken } from '../middleware/agentAuth.js';
import { enqueueTestTicket } from '../lib/printQueue.js';

const router = Router();

const MAX_ATTEMPTS = 3;
const STALE_CLAIM_MINUTES = 2;

// ==================== Agent endpoints (print bridge) ====================

/**
 * POST /api/print-jobs/claim
 * Body: { agent_id?: string, max?: number }
 *
 * Atomically claims up to `max` queued jobs for this tenant.
 * Also reclaims jobs stuck in 'printing' (bridge crashed mid-print).
 */
router.post('/claim', requireAgentToken(), async (req, res) => {
  try {
    const agentId = String(req.body?.agent_id || 'bridge').slice(0, 64);
    const max = Math.min(Math.max(parseInt(req.body?.max) || 5, 1), 20);

    const conn = getConn();
    const jobs = await conn.unsafe(`
      UPDATE print_jobs SET
        status = 'printing',
        claimed_by = $1,
        claimed_at = NOW(),
        attempts = attempts + 1
      WHERE id IN (
        SELECT id FROM print_jobs
        WHERE status = 'queued'
           OR (status = 'printing'
               AND claimed_at < NOW() - INTERVAL '${STALE_CLAIM_MINUTES} minutes'
               AND attempts < ${MAX_ATTEMPTS})
        ORDER BY id
        LIMIT $2
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, order_id, printer_id, job_type, source, payload, attempts, created_at
    `, [agentId, max]);

    res.json({ jobs: Array.from(jobs) });
  } catch (error) {
    console.error('[PrintJobs] Claim error:', error);
    res.status(500).json({ error: 'Failed to claim print jobs' });
  }
});

/**
 * POST /api/print-jobs/:id/result
 * Body: { ok: boolean, error?: string }
 */
router.post('/:id/result', requireAgentToken(), async (req, res) => {
  try {
    const { id } = req.params;
    const { ok, error } = req.body || {};

    const job = await get('SELECT id, attempts FROM print_jobs WHERE id = $1', [id]);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    if (ok) {
      await run(
        "UPDATE print_jobs SET status = 'done', printed_at = NOW(), last_error = NULL WHERE id = $1",
        [id]
      );
    } else {
      const failed = job.attempts >= MAX_ATTEMPTS;
      await run(
        'UPDATE print_jobs SET status = $1, last_error = $2 WHERE id = $3',
        [failed ? 'error' : 'queued', String(error || 'unknown').slice(0, 500), id]
      );
    }

    res.json({ success: true });
  } catch (error) {
    console.error('[PrintJobs] Result error:', error);
    res.status(500).json({ error: 'Failed to record print result' });
  }
});

// ==================== Management endpoints (POS UI) ====================

/**
 * POST /api/print-jobs/agent-token
 * Generates (or rotates) the agent token for this tenant. Returned ONCE.
 */
router.post('/agent-token', requireAuth('manage_printers'), async (req, res) => {
  try {
    const tenantId = getTenantId();
    const token = 'pb_' + crypto.randomBytes(24).toString('hex');

    await adminSql`
      INSERT INTO tenant_credentials (tenant_id, service, key, value)
      VALUES (${tenantId}, 'print_agent', 'token', ${token})
      ON CONFLICT (tenant_id, service, key)
      DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `;

    res.json({ token });
  } catch (error) {
    console.error('[PrintJobs] Token generation error:', error);
    res.status(500).json({ error: 'Failed to generate agent token' });
  }
});

/**
 * GET /api/print-jobs/bridge-status
 * Returns bridge liveness + queue counts for the Printer Management screen.
 */
router.get('/bridge-status', requireAuth(), async (req, res) => {
  try {
    const tenantId = getTenantId();

    const rows = await adminSql`
      SELECT key, value FROM tenant_credentials
      WHERE tenant_id = ${tenantId} AND service = 'print_agent'
    `;
    const creds = Object.fromEntries(rows.map(r => [r.key, r.value]));

    const counts = await all(`
      SELECT status, COUNT(*)::int AS n
      FROM print_jobs
      WHERE created_at > NOW() - INTERVAL '24 hours'
      GROUP BY status
    `);
    const byStatus = Object.fromEntries(counts.map(c => [c.status, c.n]));

    const lastSeen = creds.last_seen || null;
    const online = lastSeen
      ? (Date.now() - new Date(lastSeen).getTime()) < 60_000
      : false;

    res.json({
      configured: Boolean(creds.token),
      online,
      last_seen: lastSeen,
      queued: byStatus.queued || 0,
      printing: byStatus.printing || 0,
      done_24h: byStatus.done || 0,
      errors_24h: byStatus.error || 0,
    });
  } catch (error) {
    console.error('[PrintJobs] Bridge status error:', error);
    res.status(500).json({ error: 'Failed to fetch bridge status' });
  }
});

/**
 * POST /api/print-jobs/test
 * Body: { printer_id?: number }
 * Enqueues a test ticket.
 */
router.post('/test', requireAuth('manage_printers'), async (req, res) => {
  try {
    const printerId = req.body?.printer_id || null;
    let printerName = '';
    if (printerId) {
      const printer = await get('SELECT name FROM printers WHERE id = $1', [printerId]);
      printerName = printer?.name || '';
    }
    const jobId = await enqueueTestTicket(printerId, printerName);
    res.status(201).json({ job_id: jobId });
  } catch (error) {
    console.error('[PrintJobs] Test print error:', error);
    res.status(500).json({ error: 'Failed to enqueue test print' });
  }
});

/**
 * GET /api/print-jobs?status=&limit=
 * Recent jobs for debugging.
 */
router.get('/', requireAuth(), async (req, res) => {
  try {
    const { status } = req.query;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const jobs = status
      ? await all(
          `SELECT id, order_id, printer_id, job_type, source, status, attempts, last_error, claimed_by, printed_at, created_at
           FROM print_jobs WHERE status = $1 ORDER BY id DESC LIMIT $2`,
          [status, limit]
        )
      : await all(
          `SELECT id, order_id, printer_id, job_type, source, status, attempts, last_error, claimed_by, printed_at, created_at
           FROM print_jobs ORDER BY id DESC LIMIT $1`,
          [limit]
        );
    res.json(jobs);
  } catch (error) {
    console.error('[PrintJobs] List error:', error);
    res.status(500).json({ error: 'Failed to fetch print jobs' });
  }
});

export default router;
