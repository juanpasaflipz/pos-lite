import { Router } from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { all, get, run, getConn, getTenantId } from '../db/index.js';
import { adminSql } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { requireAgentToken } from '../middleware/agentAuth.js';
import { enqueueTestTicket, enqueuePingJob, getBridgeHealth } from '../lib/printQueue.js';
import { renderInstallScript } from '../lib/installScript.js';
import { requirePlanFeature } from '../planLimits.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_JS_PATH = path.join(__dirname, '..', '..', 'print-bridge', 'bridge.js');

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

    const job = await get('SELECT id, attempts, job_type FROM print_jobs WHERE id = $1', [id]);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    if (ok) {
      await run(
        "UPDATE print_jobs SET status = 'done', printed_at = NOW(), last_error = NULL WHERE id = $1",
        [id]
      );
    } else {
      // Pings fail hard on the first error — someone is watching a spinner
      // in the UI, so a 3-attempt retry loop only delays the bad news.
      const failed = job.job_type === 'ping' || job.attempts >= MAX_ATTEMPTS;
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
 * GET /api/print-jobs/customer-ticket-setting
 * Whether the "auto-print customer ticket" (loyalty QR + name + for-here/
 * to-go, on the same kitchen printer) is turned on for this tenant. Off by
 * default — opt-in, since it prints an extra ticket per paid order.
 */
router.get('/customer-ticket-setting', requireAuth('manage_printers'), async (req, res) => {
  try {
    const tenantId = getTenantId();
    const rows = await adminSql`
      SELECT value FROM tenant_credentials
      WHERE tenant_id = ${tenantId} AND service = 'print_agent' AND key = 'auto_print_customer_ticket'
      LIMIT 1
    `;
    res.json({ enabled: rows[0]?.value === 'true' });
  } catch (error) {
    console.error('[PrintJobs] Customer ticket setting fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch setting' });
  }
});

/**
 * PUT /api/print-jobs/customer-ticket-setting
 * Body: { enabled: boolean }
 */
router.put('/customer-ticket-setting', requireAuth('manage_printers'), requirePlanFeature('printers'), async (req, res) => {
  try {
    const tenantId = getTenantId();
    const enabled = req.body?.enabled === true;

    await adminSql`
      INSERT INTO tenant_credentials (tenant_id, service, key, value)
      VALUES (${tenantId}, 'print_agent', 'auto_print_customer_ticket', ${enabled ? 'true' : 'false'})
      ON CONFLICT (tenant_id, service, key)
      DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `;

    res.json({ enabled });
  } catch (error) {
    console.error('[PrintJobs] Customer ticket setting update error:', error);
    res.status(500).json({ error: 'Failed to update setting' });
  }
});

// ==================== Customer ticket logo ====================

// Printable width of an 80mm thermal head: 576 dots = 72 bytes per row.
const LOGO_PAPER_DOTS = 576;
const LOGO_MAX_WIDTH = 384;   // ~48mm — logo band, not edge-to-edge
const LOGO_MAX_HEIGHT = 600;  // ~75mm of paper; caps absurd uploads

/**
 * PUT /api/print-jobs/customer-ticket-logo
 * Body: { image: <base64 PNG/JPEG> }
 *
 * Converts the upload to the printer's native format ONCE at upload time:
 * grayscale → hard 1-bit threshold → packed raster bytes, pre-centered on
 * the 576-dot printable width. Print time then just streams stored bytes —
 * no image work in the payment path. Thermal heads print 1-bit only, so
 * the ideal upload is black line art on white; anything grey or colored
 * gets thresholded and may fill solid.
 */
router.put('/customer-ticket-logo', requireAuth('manage_printers'), requirePlanFeature('printers'), async (req, res) => {
  try {
    const tenantId = getTenantId();
    const b64 = String(req.body?.image || '');
    if (!b64) return res.status(400).json({ error: 'image (base64) requerido' });

    let input;
    try {
      input = Buffer.from(b64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
    } catch {
      return res.status(400).json({ error: 'base64 inválido' });
    }
    if (!input.length || input.length > 1_500_000) {
      return res.status(400).json({ error: 'Imagen vacía o mayor a 1.5MB' });
    }

    const { default: sharp } = await import('sharp');
    const { data, info } = await sharp(input)
      .resize({ width: LOGO_MAX_WIDTH, height: LOGO_MAX_HEIGHT, fit: 'inside', withoutEnlargement: false })
      .flatten({ background: '#ffffff' })
      .greyscale()
      .threshold(160)
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { width: W, height: H } = info;
    const widthBytes = LOGO_PAPER_DOTS / 8; // 72 — full row, image centered inside
    const leftDots = Math.floor((LOGO_PAPER_DOTS - W) / 2);
    const packed = Buffer.alloc(widthBytes * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (data[(y * W + x) * info.channels] < 128) {
          const dot = leftDots + x;
          packed[y * widthBytes + (dot >> 3)] |= 0x80 >> (dot & 7);
        }
      }
    }

    const stored = JSON.stringify({
      width_bytes: widthBytes,
      height: H,
      data: packed.toString('base64'),
    });

    await adminSql`
      INSERT INTO tenant_credentials (tenant_id, service, key, value)
      VALUES (${tenantId}, 'print_agent', 'customer_ticket_logo', ${stored})
      ON CONFLICT (tenant_id, service, key)
      DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `;

    res.json({ ok: true, width: W, height: H });
  } catch (error) {
    console.error('[PrintJobs] Logo upload error:', error);
    res.status(500).json({ error: 'No pudimos procesar el logo' });
  }
});

/**
 * GET /api/print-jobs/customer-ticket-logo — presence + dimensions only.
 */
router.get('/customer-ticket-logo', requireAuth('manage_printers'), async (req, res) => {
  try {
    const tenantId = getTenantId();
    const rows = await adminSql`
      SELECT value FROM tenant_credentials
      WHERE tenant_id = ${tenantId} AND service = 'print_agent' AND key = 'customer_ticket_logo'
      LIMIT 1
    `;
    if (!rows[0]) return res.json({ configured: false });
    try {
      const meta = JSON.parse(rows[0].value);
      res.json({ configured: true, height: meta.height || null });
    } catch {
      res.json({ configured: true, height: null });
    }
  } catch (error) {
    console.error('[PrintJobs] Logo fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch logo' });
  }
});

/**
 * DELETE /api/print-jobs/customer-ticket-logo
 * Kill switch: tickets return to text-only header on the next print — the
 * rollback path if a printer turns out not to support raster images.
 */
router.delete('/customer-ticket-logo', requireAuth('manage_printers'), async (req, res) => {
  try {
    const tenantId = getTenantId();
    await adminSql`
      DELETE FROM tenant_credentials
      WHERE tenant_id = ${tenantId} AND service = 'print_agent' AND key = 'customer_ticket_logo'
    `;
    res.json({ ok: true });
  } catch (error) {
    console.error('[PrintJobs] Logo delete error:', error);
    res.status(500).json({ error: 'Failed to delete logo' });
  }
});

/**
 * POST /api/print-jobs/install-code
 * Generates a one-time, 10-minute install code. The Printer Management UI
 * turns it into a copy-paste one-liner:
 *   curl -fsSL https://<tenant>/api/print-jobs/install.sh?code=XXXX | bash
 */
router.post('/install-code', requireAuth('manage_printers'), async (req, res) => {
  try {
    const tenantId = getTenantId();
    const code = crypto.randomBytes(8).toString('hex');
    const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    await adminSql`
      INSERT INTO tenant_credentials (tenant_id, service, key, value)
      VALUES (${tenantId}, 'print_agent', 'install_code', ${code}),
             (${tenantId}, 'print_agent', 'install_code_expires', ${expires})
      ON CONFLICT (tenant_id, service, key)
      DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `;

    const command = `curl -fsSL "https://${req.get('host')}/api/print-jobs/install.sh?code=${code}" | bash`;
    res.json({ code, command, expires_at: expires });
  } catch (error) {
    console.error('[PrintJobs] Install code error:', error);
    res.status(500).json({ error: 'Failed to generate install code' });
  }
});

/**
 * GET /api/print-jobs/install.sh?code=...
 * Gated by the one-time install code (no JWT — this is fetched by curl on
 * the store's Mac). Consumes the code, reuses-or-creates the agent token,
 * and serves a bash installer with the tenant URL + token embedded.
 */
router.get('/install.sh', async (req, res) => {
  try {
    const tenantId = getTenantId();
    const provided = String(req.query.code || '');

    const rows = await adminSql`
      SELECT key, value FROM tenant_credentials
      WHERE tenant_id = ${tenantId} AND service = 'print_agent'
    `;
    const creds = Object.fromEntries(rows.map(r => [r.key, r.value]));

    const stored = creds.install_code;
    const expired = !creds.install_code_expires || new Date(creds.install_code_expires).getTime() < Date.now();
    const a = Buffer.from(provided);
    const b = Buffer.from(stored || '');
    const match = stored && a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!match || expired) {
      return res.status(401).type('text/plain').send(
        'echo "Codigo de instalacion invalido o vencido. Genera uno nuevo en el POS (Gestion de Impresoras)."; exit 1\n'
      );
    }

    // Consume the code (single use)
    await adminSql`
      DELETE FROM tenant_credentials
      WHERE tenant_id = ${tenantId} AND service = 'print_agent'
        AND key IN ('install_code', 'install_code_expires')
    `;

    // Reuse the existing agent token so an already-running bridge at the same
    // store keeps working; create one only if none exists yet.
    let token = creds.token;
    if (!token) {
      token = 'pb_' + crypto.randomBytes(24).toString('hex');
      await adminSql`
        INSERT INTO tenant_credentials (tenant_id, service, key, value)
        VALUES (${tenantId}, 'print_agent', 'token', ${token})
        ON CONFLICT (tenant_id, service, key)
        DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
      `;
    }

    const serverUrl = `https://${req.get('host')}`;
    res.type('text/x-shellscript').send(renderInstallScript({ serverUrl, token }));
  } catch (error) {
    console.error('[PrintJobs] Install script error:', error);
    res.status(500).type('text/plain').send('echo "Error del servidor generando el instalador."; exit 1\n');
  }
});

/**
 * GET /api/print-jobs/bridge.js
 * Serves the bridge client so the installer (and manual updates) can fetch
 * it from the tenant's own server. No secrets inside — safe to be public.
 */
router.get('/bridge.js', async (_req, res) => {
  try {
    const source = await fs.promises.readFile(BRIDGE_JS_PATH, 'utf8');
    res.type('application/javascript').send(source);
  } catch (error) {
    console.error('[PrintJobs] Bridge source error:', error);
    res.status(500).json({ error: 'Bridge source unavailable' });
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

    // Pings are connectivity probes, not tickets — keep them out of the counts
    const counts = await all(`
      SELECT status, COUNT(*)::int AS n
      FROM print_jobs
      WHERE created_at > NOW() - INTERVAL '24 hours'
        AND job_type <> 'ping'
      GROUP BY status
    `);
    const byStatus = Object.fromEntries(counts.map(c => [c.status, c.n]));

    // Real tickets sitting queued for 2+ minutes — the "orders aren't
    // printing" signal the POS banner surfaces during service.
    const stuck = await get(`
      SELECT COUNT(*)::int AS n
      FROM print_jobs
      WHERE status = 'queued'
        AND job_type <> 'ping'
        AND created_at < NOW() - INTERVAL '2 minutes'
    `);

    const lastSeen = creds.last_seen || null;
    const online = lastSeen
      ? (Date.now() - new Date(lastSeen).getTime()) < 90_000
      : false;

    res.json({
      configured: Boolean(creds.token),
      online,
      last_seen: lastSeen,
      queued: byStatus.queued || 0,
      stuck_queued: stuck?.n || 0,
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
 * POST /api/print-jobs/ping
 * Body: { printer_id?: number }
 *
 * End-to-end printer connectivity check: enqueues a 'ping' job that the
 * on-site bridge claims and answers by opening a TCP socket to the printer
 * (no paper output). Fails fast without queueing when the bridge itself
 * isn't configured or hasn't polled recently.
 */
router.post('/ping', requireAuth('manage_printers'), async (req, res) => {
  try {
    const health = await getBridgeHealth(getTenantId());
    if (!health.configured) return res.json({ status: 'not_configured' });
    if (!health.online) return res.json({ status: 'bridge_offline', last_seen: health.last_seen });

    const printerId = req.body?.printer_id || null;
    const jobId = await enqueuePingJob(printerId);
    res.status(201).json({ status: 'queued', job_id: jobId });
  } catch (error) {
    console.error('[PrintJobs] Ping error:', error);
    res.status(500).json({ error: 'Failed to enqueue printer check' });
  }
});

/**
 * GET /api/print-jobs/:id/status
 * Poll a single job (used by the UI while a ping/test is in flight).
 */
router.get('/:id/status', requireAuth(), async (req, res) => {
  try {
    const job = await get(
      'SELECT id, job_type, status, attempts, last_error, printed_at, created_at FROM print_jobs WHERE id = $1',
      [req.params.id]
    );
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
  } catch (error) {
    console.error('[PrintJobs] Status error:', error);
    res.status(500).json({ error: 'Failed to fetch job status' });
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
