import { Router } from 'express';
import { all, get, run, getTenantId } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// GET /api/order-templates - list active templates
router.get('/', async (req, res) => {
  try {
    const templates = await all(`
      SELECT id, name, description, items_json, created_by, active, sort_order, created_at
      FROM order_templates
      WHERE active = true
      ORDER BY sort_order ASC, created_at DESC
    `);
    const parsed = templates.map(t => ({
      ...t,
      items: JSON.parse(t.items_json),
    }));
    res.json(parsed);
  } catch (error) {
    console.error('Error fetching order templates:', error);
    res.status(500).json({ error: 'Failed to fetch order templates' });
  }
});

// POST /api/order-templates - create template
router.post('/', requireAuth('manage_menu'), async (req, res) => {
  try {
    const { name, description, items } = req.body;
    if (!name || !items || !items.length) {
      return res.status(400).json({ error: 'Name and items are required' });
    }

    const items_json = JSON.stringify(items);
    const employeeId = req.employee?.id || null;

    const tid = getTenantId();
    const result = await run(`
      INSERT INTO order_templates (tenant_id, name, description, items_json, created_by, active)
      VALUES ($1, $2, $3, $4, $5, true)
    `, [tid, name.trim(), description || null, items_json, employeeId]);

    res.status(201).json({
      id: result.lastInsertRowid,
      name: name.trim(),
      description,
      items,
      active: true,
    });
  } catch (error) {
    console.error('Error creating order template:', error);
    res.status(500).json({ error: 'Failed to create order template' });
  }
});

// PUT /api/order-templates/:id/toggle - activate/deactivate
router.put('/:id/toggle', requireAuth('manage_menu'), async (req, res) => {
  try {
    const { id } = req.params;
    const template = await get('SELECT id, active FROM order_templates WHERE id = $1', [id]);
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }

    const newActive = !template.active;
    await run('UPDATE order_templates SET active = $1 WHERE id = $2', [newActive, id]);

    res.json({ id: parseInt(id), active: newActive });
  } catch (error) {
    console.error('Error toggling order template:', error);
    res.status(500).json({ error: 'Failed to toggle order template' });
  }
});

export default router;
