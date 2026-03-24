import { Router } from 'express';
import { all, get, run, getTenantId } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { getPlanLimits, requirePlanFeature } from '../planLimits.js';

const router = Router();

// GET /api/printers - list all printers
router.get('/', async (req, res) => {
  try {
    const printers = await all('SELECT * FROM printers ORDER BY name');
    res.json(printers);
  } catch (error) {
    console.error('Error fetching printers:', error);
    res.status(500).json({ error: 'Failed to fetch printers' });
  }
});

// POST /api/printers - create printer
router.post('/', requireAuth('manage_printers'), requirePlanFeature('printers'), async (req, res) => {
  try {
    const { name, printer_type, address } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });

    const tid = getTenantId();
    const result = await run(
      'INSERT INTO printers (tenant_id, name, printer_type, address, active) VALUES ($1, $2, $3, $4, true)',
      [tid, name, printer_type || 'receipt', address || '']
    );

    res.status(201).json({ id: result.lastInsertRowid, name, printer_type, address, active: true });
  } catch (error) {
    console.error('Error creating printer:', error);
    res.status(500).json({ error: 'Failed to create printer' });
  }
});

// PUT /api/printers/:id - update printer
router.put('/:id', requireAuth('manage_printers'), requirePlanFeature('printers'), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, printer_type, address, active } = req.body;

    const printer = await get('SELECT * FROM printers WHERE id = $1', [id]);
    if (!printer) return res.status(404).json({ error: 'Printer not found' });

    await run(
      'UPDATE printers SET name = $1, printer_type = $2, address = $3, active = $4 WHERE id = $5',
      [
        name ?? printer.name,
        printer_type ?? printer.printer_type,
        address ?? printer.address,
        active !== undefined ? (active ? true : false) : printer.active,
        id,
      ]
    );

    res.json({ id, success: true });
  } catch (error) {
    console.error('Error updating printer:', error);
    res.status(500).json({ error: 'Failed to update printer' });
  }
});

// GET /api/printers/routes - get category -> printer routing
router.get('/routes', async (req, res) => {
  try {
    const routes = await all(`
      SELECT cpr.category_id, cpr.printer_id, mc.name as category_name, p.name as printer_name
      FROM category_printer_routes cpr
      JOIN menu_categories mc ON cpr.category_id = mc.id
      LEFT JOIN printers p ON cpr.printer_id = p.id
    `);
    res.json(routes);
  } catch (error) {
    console.error('Error fetching printer routes:', error);
    res.status(500).json({ error: 'Failed to fetch printer routes' });
  }
});

// PUT /api/printers/routes - set category -> printer route
router.put('/routes', requireAuth('manage_printers'), requirePlanFeature('printers'), async (req, res) => {
  try {
    const { category_id, printer_id } = req.body;
    if (!category_id) return res.status(400).json({ error: 'category_id is required' });

    const existing = await get('SELECT * FROM category_printer_routes WHERE category_id = $1', [category_id]);
    if (existing) {
      await run('UPDATE category_printer_routes SET printer_id = $1 WHERE category_id = $2', [printer_id, category_id]);
    } else {
      const tid = getTenantId();
      await run('INSERT INTO category_printer_routes (tenant_id, category_id, printer_id) VALUES ($1, $2, $3)', [tid, category_id, printer_id]);
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error updating printer route:', error);
    res.status(500).json({ error: 'Failed to update printer route' });
  }
});

// POST /api/printers/print-ticket - generate ticket data grouped by printer
router.post('/print-ticket', async (req, res) => {
  try {
    const { order_id } = req.body;
    if (!order_id) return res.status(400).json({ error: 'order_id is required' });

    const order = await get('SELECT * FROM orders WHERE id = $1', [order_id]);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const items = await all(`
      SELECT oi.*, mi.category_id
      FROM order_items oi
      JOIN menu_items mi ON oi.menu_item_id = mi.id
      WHERE oi.order_id = $1
    `, [order_id]);

    // Group items by printer
    const printerGroups = {};
    for (const item of items) {
      const route = await get(
        'SELECT printer_id FROM category_printer_routes WHERE category_id = $1',
        [item.category_id]
      );
      const printerId = route?.printer_id || 'default';
      if (!printerGroups[printerId]) printerGroups[printerId] = [];
      printerGroups[printerId].push(item);
    }

    res.json({ order, printerGroups });
  } catch (error) {
    console.error('Error generating ticket:', error);
    res.status(500).json({ error: 'Failed to generate ticket' });
  }
});

export default router;
