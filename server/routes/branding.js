import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { requireOwner } from '../middleware/ownerAuth.js';
import { requireAuth } from '../middleware/auth.js';
import { updateTenant, getTenant } from '../tenants.js';
import { getPlanLimits, planUpgradeError } from '../planLimits.js';
import { isConektaConfigured } from '../conekta.js';
import { isGetnetConfigured } from '../services/getnet/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadsDir = path.join(__dirname, '../../data/uploads');

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

const router = Router();

/**
 * GET /api/branding — public branding for current tenant
 * Returns primaryColor, logoUrl, restaurantName, tagline for CSS theming.
 * Works with tenant middleware — no auth required.
 */
router.get('/', async (req, res) => {
  const tenant = req.tenant;

  // No tenant resolved — check branding.json for default mode
  if (!tenant) {
    const brandingPath = path.join(__dirname, '../../data/branding.json');
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(brandingPath, 'utf8')); } catch {}

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

  let conektaConfigured = false;
  let getnetConfigured = false;
  try {
    conektaConfigured = await isConektaConfigured(tenant.id);
  } catch { /* non-blocking */ }
  try {
    getnetConfigured = await isGetnetConfigured(tenant.id);
  } catch { /* non-blocking */ }

  res.json({
    primaryColor: branding.primaryColor || '#0d9488',
    logoUrl: branding.logoUrl || null,
    restaurantName: tenant.name || 'Desktop Kitchen',
    tagline: branding.tagline || '',
    address: branding.address || '',
    plan,
    limits: getPlanLimits(plan),
    ownerEmail: tenant.owner_email || null,
    mpUserId: tenant.mp_user_id || null,
    mpDefaultTerminalId: tenant.mp_default_terminal_id || null,
    conektaConfigured,
    getnetConfigured,
    getnetEnabled: !!tenant.getnet_enabled,
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
      // Store in a simple JSON file for default/single-tenant mode
      const brandingPath = path.join(__dirname, '../../data/branding.json');
      let existing = {};
      try { existing = JSON.parse(fs.readFileSync(brandingPath, 'utf8')); } catch {}

      const updated = {
        ...existing,
        ...(primaryColor !== undefined && { primaryColor }),
        ...(restaurantName !== undefined && { restaurantName }),
        ...(tagline !== undefined && { tagline }),
        ...(address !== undefined && { address }),
      };

      fs.writeFileSync(brandingPath, JSON.stringify(updated, null, 2));

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
 * POST /api/branding/logo — upload logo via employee auth
 * Accepts multipart form with 'logo' file field
 */
router.post('/logo', requireAuth('manage_branding'), (req, res) => {
  upload.single('logo')(req, res, async (err) => {
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
      const logoUrl = `/uploads/${req.file.filename}`;
      const tenantId = req.tenant?.id;

      if (!tenantId) {
        // Default/single-tenant mode — use branding.json
        const brandingPath = path.join(__dirname, '../../data/branding.json');
        let existing = {};
        try { existing = JSON.parse(fs.readFileSync(brandingPath, 'utf8')); } catch {}

        // Delete previous uploaded logo
        if (existing.logoUrl && existing.logoUrl.startsWith('/uploads/')) {
          const oldPath = path.join(uploadsDir, path.basename(existing.logoUrl));
          try { fs.unlinkSync(oldPath); } catch {}
        }

        existing.logoUrl = logoUrl;
        fs.writeFileSync(brandingPath, JSON.stringify(existing, null, 2));

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

      // Delete previous uploaded logo
      if (existing.logoUrl && existing.logoUrl.startsWith('/uploads/')) {
        const oldPath = path.join(uploadsDir, path.basename(existing.logoUrl));
        try { fs.unlinkSync(oldPath); } catch {}
      }

      existing.logoUrl = logoUrl;
      await updateTenant(tenantId, { branding_json: JSON.stringify(existing) });

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
