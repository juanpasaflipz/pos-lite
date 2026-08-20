import { Router } from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { all, get, run } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { getPlanLimits, planUpgradeError } from '../planLimits.js';
import { JWT_SECRET } from '../lib/constants.js';
import { audit } from '../lib/auditLog.js';
import { APP_BUILD } from '../helpers/appVersion.js';

const router = Router();

// Pairing code alphabet: uppercase, no 0/O/1/I/L for readability on a TV.
const CODE_ALPHABET = '23456789ACDEFGHJKMNPQRSTUVWXYZ';
const CODE_LENGTH = 6;
const CODE_TTL_MS = 15 * 60 * 1000;
const DEVICE_JWT_EXPIRY = '365d';

function generatePairingCode() {
  let out = '';
  const bytes = crypto.randomBytes(CODE_LENGTH);
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return out;
}

function signDeviceToken({ deviceId, tenantId, deviceType, jti }) {
  return jwt.sign(
    { type: 'device', deviceId, tenantId, deviceType, jti },
    JWT_SECRET,
    { expiresIn: DEVICE_JWT_EXPIRY }
  );
}

// Throttle pair-init so a single tenant can't burn through codes.
const pairInitLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many pair attempts. Slow down.' },
});

// POST /api/devices/pair/init
// Unauthenticated (TV-side). Creates a kds_devices row scoped to the
// resolved tenant, returns a one-time 6-char code. Code expires in 15 min.
router.post('/pair/init', pairInitLimiter, async (req, res) => {
  try {
    if (!req.tenant?.id) {
      return res.status(400).json({ error: 'Tenant must be resolved via subdomain' });
    }
    const deviceType = (req.body?.device_type || 'kds').toString();
    if (!['kds', 'bar', 'expo'].includes(deviceType)) {
      return res.status(400).json({ error: 'Invalid device_type' });
    }

    // Retry a few times on the (extremely unlikely) collision.
    let row, attempt = 0;
    while (!row && attempt < 5) {
      const code = generatePairingCode();
      try {
        const result = await get(
          `INSERT INTO kds_devices
             (device_type, pairing_code, pairing_code_expires_at, user_agent)
           VALUES ($1, $2, NOW() + INTERVAL '15 minutes', $3)
           RETURNING id, pairing_code, pairing_code_expires_at`,
          [deviceType, code, (req.headers['user-agent'] || '').slice(0, 500)]
        );
        row = result;
      } catch (err) {
        // Unique violation on (tenant_id, pairing_code) — retry with a new code.
        if (err.code === '23505') { attempt++; continue; }
        throw err;
      }
    }
    if (!row) return res.status(503).json({ error: 'Could not generate code; try again' });

    res.json({
      device_id: row.id,
      pairing_code: row.pairing_code,
      expires_at: row.pairing_code_expires_at,
    });
  } catch (err) {
    console.error('[devices/pair/init]', err);
    res.status(500).json({ error: 'Failed to init pairing' });
  }
});

// POST /api/devices/pair/poll  { device_id }
// Unauthenticated. TV polls every ~3s. Returns 'pending' until a manager
// claims it, then returns the device JWT exactly once (pairing_code is
// cleared on claim, so re-polling after claim still works via device_id
// + tenant scope).
router.post('/pair/poll', async (req, res) => {
  try {
    if (!req.tenant?.id) {
      return res.status(400).json({ error: 'Tenant must be resolved via subdomain' });
    }
    const deviceId = (req.body?.device_id || '').toString();
    if (!deviceId) return res.status(400).json({ error: 'device_id required' });

    const row = await get(
      `SELECT id, device_label, device_type, claimed_at, revoked_at,
              pairing_code_expires_at, token_jti
       FROM kds_devices WHERE id = $1`,
      [deviceId]
    );
    if (!row) return res.status(404).json({ error: 'Unknown device' });

    if (row.revoked_at) return res.json({ status: 'revoked' });
    if (!row.claimed_at) {
      if (row.pairing_code_expires_at && new Date(row.pairing_code_expires_at) < new Date()) {
        return res.json({ status: 'expired' });
      }
      return res.json({ status: 'pending' });
    }

    // Already claimed — issue a fresh token bound to the CURRENT token_jti.
    // (The jti was set at claim time; we don't rotate on poll.)
    const token = signDeviceToken({
      deviceId: row.id,
      tenantId: req.tenant.id,
      deviceType: row.device_type,
      jti: row.token_jti,
    });
    res.json({
      status: 'claimed',
      token,
      device_id: row.id,
      device_label: row.device_label,
      device_type: row.device_type,
      tenant_name: req.tenant.name,
    });
  } catch (err) {
    console.error('[devices/pair/poll]', err);
    res.status(500).json({ error: 'Poll failed' });
  }
});

// Per-tenant attempt counter for code-claim brute force protection.
// 30 attempts / 15 min per IP — generous for ops, deadly for guessing
// 30^6 = 729M codes.
const claimLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many claim attempts. Wait and try again.' },
});

// POST /api/devices/pair/claim  { pairing_code, device_label? }
// Manager/admin only. Binds the device to this tenant and sets a fresh
// token_jti. The TV's next poll() will receive a valid JWT.
router.post('/pair/claim', claimLimiter, requireAuth('manage_devices'), async (req, res) => {
  try {
    const code = (req.body?.pairing_code || '').toString().trim().toUpperCase();
    const label = (req.body?.device_label || '').toString().trim().slice(0, 100) || null;
    if (!/^[A-Z2-9]{6}$/.test(code)) {
      return res.status(400).json({ error: 'Invalid code format' });
    }

    const row = await get(
      `SELECT id, device_type, claimed_at, pairing_code_expires_at, revoked_at
       FROM kds_devices
       WHERE pairing_code = $1`,
      [code]
    );
    if (!row) return res.status(404).json({ error: 'Code not found' });
    if (row.revoked_at) return res.status(410).json({ error: 'Device was revoked' });
    if (row.claimed_at) return res.status(409).json({ error: 'Code already used' });
    if (row.pairing_code_expires_at && new Date(row.pairing_code_expires_at) < new Date()) {
      return res.status(410).json({ error: 'Code expired' });
    }

    // Plan gate (repackaged 2026-07-23): free = ONE claimed KDS device, and
    // only the kitchen station. Extra screens / bar / expo stations are Pro.
    // req.tenant.plan is the effective plan (paid Pro or active trial).
    const plan = req.tenant?.plan || 'free';
    const kdsLimits = getPlanLimits(plan).kdsDevices || { max: Infinity, stations: ['kds', 'bar', 'expo'] };
    if (!kdsLimits.stations.includes(row.device_type)) {
      return res.status(403).json(planUpgradeError('kdsDevices', plan, { station: row.device_type }));
    }
    const { cnt } = await get(
      `SELECT COUNT(*) AS cnt FROM kds_devices
       WHERE claimed_at IS NOT NULL AND revoked_at IS NULL`
    ) || { cnt: 0 };
    if (Number(cnt) >= kdsLimits.max) {
      return res.status(403).json(planUpgradeError('kdsDevices', plan, { limit: kdsLimits.max, current: Number(cnt) }));
    }

    const jti = crypto.randomUUID();
    await run(
      `UPDATE kds_devices
       SET claimed_at = NOW(),
           claimed_by_employee_id = $2,
           device_label = COALESCE($3, device_label),
           token_jti = $4,
           pairing_code = NULL,
           pairing_code_expires_at = NULL
       WHERE id = $1`,
      [row.id, req.employee.id, label, jti]
    );

    audit({
      tenantId: req.tenant?.id,
      actorType: 'employee',
      actorId: req.employee.id,
      action: 'create',
      resource: 'kds_device',
      resourceId: row.id,
      details: { device_type: row.device_type, device_label: label },
      ip: req.ip,
    });

    res.json({ ok: true, device_id: row.id });
  } catch (err) {
    console.error('[devices/pair/claim]', err);
    res.status(500).json({ error: 'Claim failed' });
  }
});

// GET /api/devices
router.get('/', requireAuth('manage_devices'), async (req, res) => {
  try {
    const rows = await all(
      `SELECT d.id, d.device_label, d.device_type, d.claimed_at, d.last_seen_at,
              d.last_seen_ip, d.revoked_at, d.created_at,
              e.name AS claimed_by_name
       FROM kds_devices d
       LEFT JOIN employees e ON e.id = d.claimed_by_employee_id
       WHERE d.claimed_at IS NOT NULL
       ORDER BY d.revoked_at NULLS FIRST, d.last_seen_at DESC NULLS LAST, d.claimed_at DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error('[devices list]', err);
    res.status(500).json({ error: 'Failed to list devices' });
  }
});

// GET /api/devices/kiosks — bound customer kiosks and the build each is running.
//
// Separate table from kds_devices (kiosks bind by PIN, not pairing code), but
// the same operational question: which screens are alive and are any of them
// stale? Web/iPad kiosks self-update, so a mismatch here almost always means an
// Android tablet needs `npm run android:install`.
router.get('/kiosks', requireAuth('manage_devices'), async (req, res) => {
  try {
    const rows = await all(
      `SELECT id, name, bound_at, last_seen_at, client_version, client_platform,
              revoked_at
       FROM kiosk_devices
       WHERE revoked_at IS NULL
       ORDER BY last_seen_at DESC NULLS LAST, bound_at DESC`
    );
    res.json({ devices: rows, current_version: APP_BUILD.buildId });
  } catch (err) {
    console.error('[kiosk devices list]', err);
    res.status(500).json({ error: 'Failed to list kiosk devices' });
  }
});

// PATCH /api/devices/:id  { device_label }
router.patch('/:id', requireAuth('manage_devices'), async (req, res) => {
  try {
    const label = (req.body?.device_label || '').toString().trim().slice(0, 100);
    if (!label) return res.status(400).json({ error: 'device_label required' });
    const existing = await get(`SELECT id, device_label FROM kds_devices WHERE id = $1`, [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Device not found' });
    await run(`UPDATE kds_devices SET device_label = $2 WHERE id = $1`, [req.params.id, label]);

    audit({
      tenantId: req.tenant?.id,
      actorType: 'employee',
      actorId: req.employee?.id,
      action: 'update',
      resource: 'kds_device',
      resourceId: req.params.id,
      details: { from: existing.device_label, to: label },
      ip: req.ip,
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('[devices patch]', err);
    res.status(500).json({ error: 'Failed to update device' });
  }
});

// DELETE /api/devices/:id  — revoke (token instantly stops working)
router.delete('/:id', requireAuth('manage_devices'), async (req, res) => {
  try {
    const existing = await get(`SELECT id, device_label, revoked_at FROM kds_devices WHERE id = $1`, [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Device not found' });
    if (existing.revoked_at) return res.json({ ok: true, already_revoked: true });
    await run(
      `UPDATE kds_devices SET revoked_at = NOW(), token_jti = NULL WHERE id = $1`,
      [req.params.id]
    );

    // This is the only intentional path that kills a device's binding —
    // logged so a future "why did the KDS un-bind" question has an answer
    // that isn't a guess: who revoked it, and when.
    console.warn(
      `[devices] REVOKED deviceId=${req.params.id} label="${existing.device_label || ''}" ` +
      `by employeeId=${req.employee?.id ?? 'unknown'} tenant=${req.tenant?.id ?? 'unknown'}`
    );
    audit({
      tenantId: req.tenant?.id,
      actorType: 'employee',
      actorId: req.employee?.id,
      action: 'delete',
      resource: 'kds_device',
      resourceId: req.params.id,
      details: { device_label: existing.device_label },
      ip: req.ip,
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('[devices delete]', err);
    res.status(500).json({ error: 'Failed to revoke device' });
  }
});

export default router;
