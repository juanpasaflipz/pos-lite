// Asset upload routes — menu item photos.
//
// POST /api/uploads/menu-image
//   multipart 'image' → Sharp → webp variants {thumb, card, hero} → storage
//   (R2 or disk, see server/lib/storage.js). Returns the public URLs. The
//   `card` variant is returned as `image_url` so existing renderers (POS grid,
//   kiosk menu, mobile grid) light up with no further change. Does NOT touch
//   the DB — the URL is persisted when the menu item itself is saved, exactly
//   like the receipt-upload flow.
//
// DELETE /api/uploads/:tenantId/menu/:uuid
//   Removes all variants of one photo. Tenant-scoped: you can only delete your
//   own tenant's assets.
//
// Both require `manage_menu`. The pipeline is gated by FEATURE_MENU_PHOTOS
// (default ON) so a misconfigured storage backend can be turned off without a
// deploy, and browsing a photo-less menu is never affected.

import { Router } from 'express';
import multer from 'multer';
import crypto from 'crypto';
import sharp from 'sharp';
import { requireAuth } from '../middleware/auth.js';
import { putObject, deletePrefix, storageBackend } from '../lib/storage.js';

const router = Router();

// Read at request time (not module load) so the flag can be toggled without a
// process restart, and so tests can flip it per-case.
function menuPhotosEnabled() {
  return process.env.FEATURE_MENU_PHOTOS !== 'false';
}

// Variant widths (px). Height auto-scales to preserve aspect ratio; we never
// enlarge past the source. card is the default rendered everywhere today.
const VARIANTS = { thumb: 160, card: 600, hero: 1280 };

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB raw upload; output webp is far smaller
  fileFilter: (_req, file, cb) => {
    if (/^image\/(jpe?g|png|webp|heic|heif|avif)$/i.test(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed (jpg, png, webp, heic, avif)'));
    }
  },
});

// Restrict a path segment to filesystem/URL-safe characters.
function safeSeg(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function gate(_req, res, next) {
  if (!menuPhotosEnabled()) {
    return res.status(404).json({ error: 'Menu photos are not enabled' });
  }
  next();
}

// POST /api/uploads/menu-image
router.post(
  '/menu-image',
  gate,
  requireAuth('manage_menu'),
  upload.single('image'),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No image file provided' });
      }
      const tenantId = req.tenant?.id;
      if (!tenantId) {
        return res.status(400).json({ error: 'Tenant not resolved' });
      }

      const uuid = crypto.randomUUID();
      const base = `${safeSeg(tenantId)}/menu/${uuid}`;

      // Source dimensions (post EXIF-rotation) for layout-shift-free rendering.
      const meta = await sharp(req.file.buffer, { failOn: 'none' }).rotate().metadata();

      const variants = {};
      for (const [name, width] of Object.entries(VARIANTS)) {
        const buf = await sharp(req.file.buffer, { failOn: 'none' })
          .rotate() // apply EXIF orientation, then drop metadata
          .resize({ width, withoutEnlargement: true })
          .webp({ quality: 82 })
          .toBuffer();
        variants[name] = await putObject(`${base}/${name}.webp`, buf, 'image/webp');
      }

      res.status(201).json({
        uuid,
        image_url: variants.card, // existing <img src={item.image_url}> renders this
        variants,
        width: meta.width || null,
        height: meta.height || null,
        storage: storageBackend(),
      });
    } catch (err) {
      console.error('[uploads/menu-image] error', err);
      // Surface storage outages as retryable rather than a generic 500.
      const msg = err?.message || '';
      if (/storage|R2|S3|ECONN|ETIMEDOUT|getaddrinfo/i.test(msg)) {
        return res
          .status(503)
          .json({ error: 'Image storage temporarily unavailable — please retry' });
      }
      // multer size/type errors carry a clear message; pass it through as 400.
      if (err instanceof multer.MulterError || /image files are allowed/i.test(msg)) {
        return res.status(400).json({ error: msg || 'Invalid upload' });
      }
      res.status(500).json({ error: 'Failed to process image' });
    }
  },
);

// DELETE /api/uploads/:tenantId/menu/:uuid — remove all variants of a photo.
router.delete('/:tenantId/menu/:uuid', gate, requireAuth('manage_menu'), async (req, res) => {
  try {
    const { tenantId, uuid } = req.params;

    // Tenant-scoping: the storage layer has no per-tenant ACL, so we enforce it
    // here — the caller may only touch their own tenant's key space.
    if (!req.tenant?.id || safeSeg(req.tenant.id) !== safeSeg(tenantId)) {
      return res.status(403).json({ error: 'Cannot delete assets for another tenant' });
    }
    // uuid is a server-generated v4 uuid; reject anything else.
    if (!/^[a-f0-9-]{16,}$/i.test(uuid)) {
      return res.status(400).json({ error: 'Invalid asset id' });
    }

    const removed = await deletePrefix(`${safeSeg(tenantId)}/menu/${safeSeg(uuid)}`);
    res.json({ deleted: true, removed });
  } catch (err) {
    console.error('[uploads/menu-image delete] error', err);
    res.status(500).json({ error: 'Failed to delete image' });
  }
});

export default router;
