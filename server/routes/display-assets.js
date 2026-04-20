import { Router } from 'express';
import { all, get, run, getTenantId } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
const VALID_KINDS = new Set(['shop_photo', 'neighborhood_photo', 'seasonal_callout']);

router.get('/', requireAuth('manage_branding'), async (_req, res) => {
  try {
    const assets = await all(`
      SELECT id, kind, title, body, image_url, sort_order, active, starts_at, ends_at, created_at
      FROM display_assets
      ORDER BY sort_order ASC NULLS LAST, id ASC
    `);
    res.json(assets);
  } catch (error) {
    console.error('Error fetching display assets:', error);
    res.status(500).json({ error: 'Failed to fetch display assets' });
  }
});

router.post('/', requireAuth('manage_branding'), async (req, res) => {
  try {
    const {
      kind,
      title,
      body,
      image_url,
      sort_order,
      active,
      starts_at,
      ends_at,
    } = req.body;

    if (!VALID_KINDS.has(kind)) {
      return res.status(400).json({ error: 'Invalid display asset kind' });
    }

    const tid = getTenantId();
    const result = await run(`
      INSERT INTO display_assets (tenant_id, kind, title, body, image_url, sort_order, active, starts_at, ends_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `, [
      tid,
      kind,
      title?.trim() || null,
      body?.trim() || null,
      image_url?.trim() || null,
      Number.isFinite(Number(sort_order)) ? Number(sort_order) : 0,
      active === undefined ? true : !!active,
      starts_at || null,
      ends_at || null,
    ]);

    const asset = await get(`
      SELECT id, kind, title, body, image_url, sort_order, active, starts_at, ends_at, created_at
      FROM display_assets
      WHERE id = $1
    `, [result.lastInsertRowid]);

    res.status(201).json(asset);
  } catch (error) {
    console.error('Error creating display asset:', error);
    res.status(500).json({ error: 'Failed to create display asset' });
  }
});

router.put('/:id', requireAuth('manage_branding'), async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await get('SELECT id FROM display_assets WHERE id = $1', [id]);
    if (!existing) {
      return res.status(404).json({ error: 'Display asset not found' });
    }

    const updates = [];
    const values = [];
    const push = (field, value) => {
      updates.push(`${field} = $${values.length + 1}`);
      values.push(value);
    };

    if (req.body.kind !== undefined) {
      if (!VALID_KINDS.has(req.body.kind)) {
        return res.status(400).json({ error: 'Invalid display asset kind' });
      }
      push('kind', req.body.kind);
    }
    if (req.body.title !== undefined) push('title', req.body.title?.trim() || null);
    if (req.body.body !== undefined) push('body', req.body.body?.trim() || null);
    if (req.body.image_url !== undefined) push('image_url', req.body.image_url?.trim() || null);
    if (req.body.sort_order !== undefined) push('sort_order', Number.isFinite(Number(req.body.sort_order)) ? Number(req.body.sort_order) : 0);
    if (req.body.active !== undefined) push('active', !!req.body.active);
    if (req.body.starts_at !== undefined) push('starts_at', req.body.starts_at || null);
    if (req.body.ends_at !== undefined) push('ends_at', req.body.ends_at || null);

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    values.push(id);
    await run(`
      UPDATE display_assets
      SET ${updates.join(', ')}
      WHERE id = $${values.length}
    `, values);

    const updated = await get(`
      SELECT id, kind, title, body, image_url, sort_order, active, starts_at, ends_at, created_at
      FROM display_assets
      WHERE id = $1
    `, [id]);

    res.json(updated);
  } catch (error) {
    console.error('Error updating display asset:', error);
    res.status(500).json({ error: 'Failed to update display asset' });
  }
});

router.delete('/:id', requireAuth('manage_branding'), async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await get('SELECT id FROM display_assets WHERE id = $1', [id]);
    if (!existing) {
      return res.status(404).json({ error: 'Display asset not found' });
    }

    await run('DELETE FROM display_assets WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting display asset:', error);
    res.status(500).json({ error: 'Failed to delete display asset' });
  }
});

export default router;
