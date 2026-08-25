import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { requireOwner } from '../middleware/ownerAuth.js';
import { requireAuth } from '../middleware/auth.js';
import { updateTenant, getTenant } from '../tenants.js';
import { getPlanLimits, planUpgradeError } from '../planLimits.js';
import { isGetnetConfigured } from '../services/getnet/auth.js';
import { getClipAuthHeader } from '../services/clip.js';
import { getDisplayMenuSettings, setDisplayMenuSettings } from '../lib/displayMenu.js';
import { get as dbGet, adminSql } from '../db/index.js';
import { putObject, deletePrefix } from '../lib/storage.js';
import { refreshTenantPasses } from '../helpers/wallet/passSync.js';
import crypto from 'crypto';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadsDir = path.join(__dirname, '../../data/uploads');
const brandingPath = path.join(__dirname, '../../data/branding.json');

// Ensure uploads directory exists
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// Multer config: 2MB limit, images only
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const tenantId = req.tenant?.id || 'default';
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `logo-${tenantId}-${Date.now()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
  fileFilter: (_req, file, cb) => {
    const allowed = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  },
});

// Logo uploads go through lib/storage.js (R2 when configured, disk fallback)
// so they survive redeploys — Railway's local filesystem is ephemeral, which
// is how tenant logos used to silently vanish. Memory storage: the buffer is
// normalized by sharp and pushed to the storage backend, never written to
// the ephemeral disk directly.
const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
  fileFilter: (_req, file, cb) => {
    const allowed = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  },
});

function safeSeg(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Normalize any uploaded logo to PNG (≤1024px) and store it durably.
 * Returns the public URL (absolute on R2, /uploads/<key> on disk fallback).
 */
async function storeLogo(tenantSegment, buffer) {
  const png = await sharp(buffer)
    .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer();
  const prefix = `${safeSeg(tenantSegment)}/branding/`;
  // Best-effort cleanup of prior logos under this tenant's branding prefix.
  try { await deletePrefix(prefix); } catch {}
  return putObject(`${prefix}logo-${crypto.randomUUID()}.png`, png, 'image/png');
}

const router = Router();

function readLocalBranding() {
  try {
    return JSON.parse(fs.readFileSync(brandingPath, 'utf8'));
  } catch {
    return {};
  }
}

function writeLocalBranding(data) {
  fs.writeFileSync(brandingPath, JSON.stringify(data, null, 2));
}

/**
 * GET /api/branding — public branding for current tenant
 * Returns primaryColor, logoUrl, restaurantName, tagline for CSS theming.
 * Works with tenant middleware — no auth required.
 */
router.get('/', async (req, res) => {
  const tenant = req.tenant;

  // No tenant resolved — check branding.json for default mode
  if (!tenant) {
    const saved = readLocalBranding();

    return res.json({
      primaryColor: saved.primaryColor || '#0d9488',
      logoUrl: saved.logoUrl || null,
      restaurantName: saved.restaurantName || 'Desktop Kitchen',
      tagline: saved.tagline || '',
      address: saved.address || '',
    });
  }

  const branding = tenant.branding || {};
  const plan = tenant.plan || 'free';

  let getnetConfigured = false;
  let clipConfigured = false;
  let weekStartDow = 1; // Monday default — Reports presets and labor strip anchor here
  try {
    getnetConfigured = await isGetnetConfigured(tenant.id);
  } catch { /* non-blocking */ }
  try {
    clipConfigured = !!(await getClipAuthHeader(tenant.id));
  } catch { /* non-blocking */ }
  try {
    const row = await dbGet('SELECT period_start_dow FROM payroll_settings WHERE tenant_id = $1', [tenant.id]);
    if (row && Number.isFinite(Number(row.period_start_dow))) {
      weekStartDow = Number(row.period_start_dow);
    }
  } catch { /* table may not exist on very old tenants — keep default */ }

  // Non-integrated bank terminals (Inbursa, BBVA, ...). id + name only: the
  // POS payment modal needs the buttons and POSScreen pre-creates the order
  // when at least one exists. This endpoint is public like the rest of
  // branding, so the fee rate stays out of it (owner-only, /external-terminals/all).
  let externalTerminals = [];
  try {
    const rows = await adminSql`
      SELECT id, name FROM external_terminals
      WHERE tenant_id = ${tenant.id} AND active = true
      ORDER BY id ASC
    `;
    externalTerminals = rows.map(r => ({ id: r.id, name: r.name }));
  } catch { /* pre-migration DBs — no buttons, nothing breaks */ }

  res.json({
    primaryColor: branding.primaryColor || '#0d9488',
    logoUrl: branding.logoUrl || null,
    restaurantName: tenant.name || 'Desktop Kitchen',
    tagline: branding.tagline || '',
    address: branding.address || '',
    plan,
    limits: getPlanLimits(plan),
    // Non-null only while plan==='pro' comes from a signup trial rather than
    // a paid subscription — the UI uses it for the countdown banner.
    trialEndsAt: (tenant.stored_plan !== 'pro' && tenant.trial_ends_at) ? tenant.trial_ends_at : null,
    ownerEmail: tenant.owner_email || null,
    mpUserId: tenant.mp_user_id || null,
    mpDefaultTerminalId: tenant.mp_default_terminal_id || null,
    getnetConfigured,
    getnetEnabled: !!tenant.getnet_enabled,
    clipConfigured,
    externalTerminals,
    timezone: tenant.timezone || 'UTC',
    weekStartDow,
  });
});

/**
 * PUT /api/branding — update branding (owner-only)
 * Body: { primaryColor, logoUrl }
 */
router.put('/', requireOwner, async (req, res) => {
  try {
    const { primaryColor, logoUrl } = req.body;
    const tenantId = req.owner.tenantId;

    const tenant = await getTenant(tenantId);
    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const existing = tenant.branding_json ? JSON.parse(tenant.branding_json) : {};
    const updated = {
      ...existing,
      ...(primaryColor !== undefined && { primaryColor }),
      ...(logoUrl !== undefined && { logoUrl }),
    };

    await updateTenant(tenantId, { branding_json: JSON.stringify(updated) });

    res.json({
      primaryColor: updated.primaryColor || '#0d9488',
      logoUrl: updated.logoUrl || null,
      restaurantName: tenant.name,
      tagline: updated.tagline || '',
    });
  } catch (error) {
    console.error('Branding update error:', error);
    res.status(500).json({ error: 'Failed to update branding' });
  }
});

/**
 * PUT /api/branding/settings — update branding via employee auth
 * Body: { primaryColor, restaurantName, tagline }
 */
router.put('/settings', requireAuth('manage_branding'), async (req, res) => {
  try {
    const { primaryColor, restaurantName, tagline, address } = req.body;
    const tenantId = req.tenant?.id;

    // For non-tenant (default DB) — update a local branding file
    if (!tenantId) {
      const existing = readLocalBranding();

      const updated = {
        ...existing,
        ...(primaryColor !== undefined && { primaryColor }),
        ...(restaurantName !== undefined && { restaurantName }),
        ...(tagline !== undefined && { tagline }),
        ...(address !== undefined && { address }),
      };

      writeLocalBranding(updated);

      return res.json({
        primaryColor: updated.primaryColor || '#0d9488',
        logoUrl: updated.logoUrl || null,
        restaurantName: updated.restaurantName || 'Desktop Kitchen',
        tagline: updated.tagline || '',
        address: updated.address || '',
      });
    }

    const plan = req.tenant?.plan || 'free';
    if (!getPlanLimits(plan).branding.canRename) {
      return res.status(403).json(planUpgradeError('branding', plan));
    }

    const tenant = await getTenant(tenantId);
    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const existing = tenant.branding_json ? JSON.parse(tenant.branding_json) : {};
    const updated = {
      ...existing,
      ...(primaryColor !== undefined && { primaryColor }),
      ...(tagline !== undefined && { tagline }),
      ...(address !== undefined && { address }),
    };

    const tenantUpdates = { branding_json: JSON.stringify(updated) };
    if (restaurantName !== undefined) {
      tenantUpdates.name = restaurantName;
    }

    await updateTenant(tenantId, tenantUpdates);

    res.json({
      primaryColor: updated.primaryColor || '#0d9488',
      logoUrl: updated.logoUrl || null,
      restaurantName: restaurantName || tenant.name,
      tagline: updated.tagline || '',
      address: updated.address || '',
    });
  } catch (error) {
    console.error('Branding settings update error:', error);
    res.status(500).json({ error: 'Failed to update branding settings' });
  }
});

/**
 * PUT /api/branding/timezone — set tenant timezone (employee auth, manage_branding)
 * Body: { timezone: 'America/Mexico_City' }
 * Validates against IANA tz database via Intl.DateTimeFormat.
 */
router.put('/timezone', requireAuth('manage_branding'), async (req, res) => {
  try {
    const tenantId = req.tenant?.id;
    if (!tenantId) {
      return res.status(400).json({ error: 'No tenant context — timezone is per-tenant' });
    }

    const { timezone } = req.body;
    if (!timezone || typeof timezone !== 'string') {
      return res.status(400).json({ error: 'timezone is required' });
    }

    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
    } catch {
      return res.status(400).json({ error: `Invalid IANA timezone: ${timezone}` });
    }

    await updateTenant(tenantId, { timezone });
    res.json({ timezone });
  } catch (error) {
    console.error('Timezone update error:', error);
    res.status(500).json({ error: 'Failed to update timezone' });
  }
});

router.get('/display-menu', requireAuth('manage_branding'), async (req, res) => {
  try {
    if (!req.tenant?.id) {
      const branding = readLocalBranding();
      return res.json(getDisplayMenuSettings(branding));
    }

    res.json(getDisplayMenuSettings(req.tenant.branding));
  } catch (error) {
    console.error('Display menu settings fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch display menu settings' });
  }
});

router.put('/display-menu', requireAuth('manage_branding'), async (req, res) => {
  try {
    const tenantId = req.tenant?.id;

    if (!tenantId) {
      const branding = readLocalBranding();
      const updated = setDisplayMenuSettings(branding, req.body);
      writeLocalBranding(updated);
      return res.json(updated.displayMenu);
    }

    const tenant = await getTenant(tenantId);
    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const existing = tenant.branding_json ? JSON.parse(tenant.branding_json) : {};
    const updated = setDisplayMenuSettings(existing, req.body);
    await updateTenant(tenantId, { branding_json: JSON.stringify(updated) });

    res.json(updated.displayMenu);
  } catch (error) {
    console.error('Display menu settings update error:', error);
    res.status(500).json({ error: 'Failed to update display menu settings' });
  }
});

/**
 * POST /api/branding/logo — upload logo via employee auth
 * Accepts multipart form with 'logo' file field
 */
router.post('/logo', requireAuth('manage_branding'), (req, res) => {
  logoUpload.single('logo')(req, res, async (err) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ error: 'File too large. Max 2MB.' });
        }
        return res.status(400).json({ error: 'File upload error' });
      }
      return res.status(400).json({ error: 'File upload failed' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    try {
      const tenantId = req.tenant?.id;

      if (!tenantId) {
        // Default/single-tenant mode — use branding.json
        const existing = readLocalBranding();
        const logoUrl = await storeLogo('default', req.file.buffer);

        existing.logoUrl = logoUrl;
        writeLocalBranding(existing);

        return res.json({
          logoUrl,
          primaryColor: existing.primaryColor || '#0d9488',
          restaurantName: existing.restaurantName || 'Desktop Kitchen',
          tagline: existing.tagline || '',
        });
      }

      const tenant = await getTenant(tenantId);
      if (!tenant) {
        return res.status(404).json({ error: 'Tenant not found' });
      }

      const existing = tenant.branding_json ? JSON.parse(tenant.branding_json) : {};

      // Legacy cleanup: pre-storage.js logos lived as loose files on the
      // ephemeral disk — remove if one is still around locally.
      if (existing.logoUrl && existing.logoUrl.startsWith('/uploads/') && !existing.logoUrl.includes('/branding/')) {
        const oldPath = path.join(uploadsDir, path.basename(existing.logoUrl));
        try { fs.unlinkSync(oldPath); } catch {}
      }

      const logoUrl = await storeLogo(tenantId, req.file.buffer);

      existing.logoUrl = logoUrl;
      await updateTenant(tenantId, { branding_json: JSON.stringify(existing) });

      // The logo is rendered onto wallet passes — repaint issued cards.
      refreshTenantPasses();

      res.json({
        logoUrl,
        primaryColor: existing.primaryColor || '#0d9488',
        restaurantName: tenant.name,
        tagline: existing.tagline || '',
      });
    } catch (error) {
      console.error('Logo upload error:', error);
      res.status(500).json({ error: 'Failed to upload logo' });
    }
  });
});

export default router;
