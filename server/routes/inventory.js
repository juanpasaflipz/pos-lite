import { Router } from 'express';
import { all, get, run, getTenantId } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { checkLimit, planUpgradeError } from '../planLimits.js';
// AI data pipeline removed in pos-lite
const logRestockEvent = () => {};

const router = Router();

// GET /api/inventory - list all inventory items
router.get('/', async (req, res) => {
  try {
    const items = await all(`
      SELECT id, name, quantity, unit, low_stock_threshold, category, cost_price,
             last_counted_at, sku, barcode, expiry_date, lot_number
      FROM inventory_items
      ORDER BY category ASC, name ASC
    `);

    res.json(items);
  } catch (error) {
    console.error('Error fetching inventory:', error);
    res.status(500).json({ error: 'Failed to fetch inventory' });
  }
});

// GET /api/inventory/search - fuzzy name search for inventory matching
router.get('/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || typeof q !== 'string' || q.trim().length === 0) {
      return res.status(400).json({ error: 'q query parameter is required' });
    }

    const items = await all(`
      SELECT id, name, quantity, unit, cost_price, category
      FROM inventory_items
      WHERE name ILIKE '%' || $1 || '%'
      ORDER BY name ASC
      LIMIT 10
    `, [q.trim()]);

    res.json(items);
  } catch (error) {
    console.error('Error searching inventory:', error);
    res.status(500).json({ error: 'Failed to search inventory' });
  }
});

// GET /api/inventory/lookup - look up item by barcode or sku
router.get('/lookup', async (req, res) => {
  try {
    const { barcode, sku } = req.query;
    if (!barcode && !sku) {
      return res.status(400).json({ error: 'barcode or sku query parameter required' });
    }

    const value = barcode || sku;
    const item = await get(`
      SELECT id, name, quantity, unit, cost_price, low_stock_threshold,
             category, sku, barcode, expiry_date
      FROM inventory_items
      WHERE barcode = $1 OR sku = $1
    `, [value]);

    if (!item) {
      return res.status(404).json({ error: 'Item not found' });
    }

    res.json(item);
  } catch (error) {
    console.error('Error looking up inventory item:', error);
    res.status(500).json({ error: 'Failed to look up inventory item' });
  }
});

// GET /api/inventory/low-stock - items below threshold
router.get('/low-stock', async (req, res) => {
  try {
    const items = await all(`
      SELECT id, name, quantity, unit, low_stock_threshold, category
      FROM inventory_items
      WHERE quantity < low_stock_threshold
      ORDER BY category ASC, name ASC
    `);

    res.json(items);
  } catch (error) {
    console.error('Error fetching low stock items:', error);
    res.status(500).json({ error: 'Failed to fetch low stock items' });
  }
});

// GET /api/inventory/counts - count history
router.get('/counts', async (req, res) => {
  try {
    const { item_id, start_date, end_date } = req.query;
    let query = `
      SELECT ic.*, ii.name as item_name, ii.unit, e.name as counted_by_name
      FROM inventory_counts ic
      JOIN inventory_items ii ON ic.inventory_item_id = ii.id
      LEFT JOIN employees e ON ic.counted_by = e.id
      WHERE 1=1
    `;
    const params = [];
    let paramIdx = 1;

    if (item_id) {
      query += ` AND ic.inventory_item_id = $${paramIdx++}`;
      params.push(item_id);
    }
    if (start_date) {
      query += ` AND ic.created_at::date >= $${paramIdx++}`;
      params.push(start_date);
    }
    if (end_date) {
      query += ` AND ic.created_at::date <= $${paramIdx++}`;
      params.push(end_date);
    }

    query += ' ORDER BY ic.created_at DESC LIMIT 200';

    const counts = await all(query, params);
    res.json(counts);
  } catch (error) {
    console.error('Error fetching inventory counts:', error);
    res.status(500).json({ error: 'Failed to fetch inventory counts' });
  }
});

// GET /api/inventory/variance-report - aggregated variance
router.get('/variance-report', async (req, res) => {
  try {
    const report = await all(`
      SELECT
        ii.id as inventory_item_id,
        ii.name,
        ii.unit,
        ii.category,
        COUNT(ic.id) as count_sessions,
        ROUND(AVG(ic.variance)::numeric, 2) as avg_variance,
        ROUND(AVG(ic.variance_percent)::numeric, 2) as avg_variance_percent,
        ROUND(SUM(ic.variance)::numeric, 2) as total_variance,
        MAX(ic.created_at) as last_counted
      FROM inventory_items ii
      LEFT JOIN inventory_counts ic ON ii.id = ic.inventory_item_id
      GROUP BY ii.id, ii.name, ii.unit, ii.category
      HAVING COUNT(ic.id) > 0
      ORDER BY ABS(AVG(ic.variance_percent)) DESC
    `);

    res.json(report);
  } catch (error) {
    console.error('Error fetching variance report:', error);
    res.status(500).json({ error: 'Failed to fetch variance report' });
  }
});

// GET /api/inventory/shrinkage-alerts - active alerts
router.get('/shrinkage-alerts', async (req, res) => {
  try {
    const { acknowledged } = req.query;
    let query = `
      SELECT sa.*, ii.name as item_name, ii.unit
      FROM shrinkage_alerts sa
      JOIN inventory_items ii ON sa.inventory_item_id = ii.id
    `;
    const params = [];

    if (acknowledged === '0' || acknowledged === 'false') {
      query += ' WHERE sa.acknowledged = false';
    } else if (acknowledged === '1' || acknowledged === 'true') {
      query += ' WHERE sa.acknowledged = true';
    }

    query += ' ORDER BY sa.created_at DESC LIMIT 100';

    const alerts = await all(query, params);
    res.json(alerts);
  } catch (error) {
    console.error('Error fetching shrinkage alerts:', error);
    res.status(500).json({ error: 'Failed to fetch shrinkage alerts' });
  }
});

// PUT /api/inventory/shrinkage-alerts/:id/acknowledge
router.put('/shrinkage-alerts/:id/acknowledge', requireAuth('manage_inventory'), async (req, res) => {
  try {
    const { id } = req.params;
    const alert = await get('SELECT id FROM shrinkage_alerts WHERE id = $1', [id]);
    if (!alert) return res.status(404).json({ error: 'Alert not found' });

    const employeeId = req.employee?.id || null;
    await run('UPDATE shrinkage_alerts SET acknowledged = true, acknowledged_by = $1 WHERE id = $2', [employeeId, id]);

    res.json({ success: true });
  } catch (error) {
    console.error('Error acknowledging alert:', error);
    res.status(500).json({ error: 'Failed to acknowledge alert' });
  }
});

// POST /api/inventory/scan-restock - restock by barcode/sku scan
router.post('/scan-restock', requireAuth('manage_inventory'), async (req, res) => {
  try {
    const { barcode, sku, quantity, cost_price } = req.body;

    if (!barcode && !sku) {
      return res.status(400).json({ error: 'barcode or sku is required' });
    }
    if (!quantity || quantity <= 0) {
      return res.status(400).json({ error: 'quantity must be greater than 0' });
    }

    const value = barcode || sku;
    const item = await get(`
      SELECT id, name, quantity, unit, cost_price
      FROM inventory_items
      WHERE barcode = $1 OR sku = $1
    `, [value]);

    if (!item) {
      return res.status(404).json({ error: 'Item not found' });
    }

    const quantityBefore = item.quantity;
    const newQuantity = quantityBefore + quantity;

    // Update quantity and optionally cost_price
    if (cost_price !== undefined && cost_price !== null) {
      await run('UPDATE inventory_items SET quantity = $1, cost_price = $2 WHERE id = $3',
        [newQuantity, cost_price, item.id]);
    } else {
      await run('UPDATE inventory_items SET quantity = $1 WHERE id = $2',
        [newQuantity, item.id]);
    }

    // Log restock for AI
    setImmediate(() => logRestockEvent(item.id, quantityBefore, quantity));

    // Log to ai_restock_log with trigger = 'scan'
    try {
      const tid = getTenantId();
      await run(`
        INSERT INTO ai_restock_log (tenant_id, inventory_item_id, quantity_before, quantity_added, quantity_after)
        VALUES ($1, $2, $3, $4, $5)
      `, [tid, item.id, quantityBefore, quantity, newQuantity]);
    } catch (err) {
      console.error('Error logging scan restock:', err.message);
    }

    res.json({
      id: item.id,
      name: item.name,
      quantity_before: quantityBefore,
      quantity_after: newQuantity,
      restockAmount: quantity,
    });
  } catch (error) {
    console.error('Error scan-restocking inventory:', error);
    res.status(500).json({ error: 'Failed to restock inventory' });
  }
});

// POST /api/inventory/:id/count - record physical count
router.post('/:id/count', requireAuth('manage_inventory'), async (req, res) => {
  try {
    const { id } = req.params;
    const { counted_quantity, notes } = req.body;

    if (counted_quantity === undefined || counted_quantity < 0) {
      return res.status(400).json({ error: 'Invalid counted quantity' });
    }

    const item = await get('SELECT id, name, quantity FROM inventory_items WHERE id = $1', [id]);
    if (!item) return res.status(404).json({ error: 'Inventory item not found' });

    const systemQty = item.quantity;
    const variance = counted_quantity - systemQty;
    const variancePercent = systemQty > 0 ? Math.round((variance / systemQty) * 10000) / 100 : 0;
    const employeeId = req.employee?.id || null;

    // Record the count
    const tid = getTenantId();
    const result = await run(`
      INSERT INTO inventory_counts (tenant_id, inventory_item_id, counted_quantity, system_quantity, variance, variance_percent, counted_by, notes)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [tid, id, counted_quantity, systemQty, variance, variancePercent, employeeId, notes || null]);

    // Update the system quantity to match the count
    await run('UPDATE inventory_items SET quantity = $1, last_counted_at = NOW() WHERE id = $2',
      [counted_quantity, id]);

    // Create shrinkage alert if variance > 10%
    if (Math.abs(variancePercent) > 10) {
      const severity = Math.abs(variancePercent) > 25 ? 'high' : 'medium';
      const alertType = variance < 0 ? 'shrinkage' : 'surplus';
      await run(`
        INSERT INTO shrinkage_alerts (tenant_id, inventory_item_id, alert_type, severity, message, variance_amount)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [
        tid, id, alertType, severity,
        `${item.name}: ${alertType} of ${Math.abs(variance).toFixed(2)} units (${Math.abs(variancePercent)}% variance)`,
        variance,
      ]);
    }

    res.json({
      id: result.lastInsertRowid,
      inventory_item_id: parseInt(id),
      counted_quantity,
      system_quantity: systemQty,
      variance,
      variance_percent: variancePercent,
    });
  } catch (error) {
    console.error('Error recording inventory count:', error);
    res.status(500).json({ error: 'Failed to record inventory count' });
  }
});

// PUT /api/inventory/:id - update item fields
router.put('/:id', requireAuth('manage_inventory'), async (req, res) => {
  try {
    const { id } = req.params;
    const { quantity, low_stock_threshold, sku, barcode, expiry_date, lot_number, cost_price } = req.body;

    const item = await get('SELECT id FROM inventory_items WHERE id = $1', [id]);
    if (!item) {
      return res.status(404).json({ error: 'Inventory item not found' });
    }

    // Build dynamic SET clause for provided fields only
    const sets = [];
    const params = [];
    let paramIdx = 1;

    if (quantity !== undefined) {
      sets.push(`quantity = $${paramIdx++}`);
      params.push(quantity);
    }
    if (low_stock_threshold !== undefined) {
      sets.push(`low_stock_threshold = $${paramIdx++}`);
      params.push(low_stock_threshold);
    }
    if (sku !== undefined) {
      sets.push(`sku = $${paramIdx++}`);
      params.push(sku || null);
    }
    if (barcode !== undefined) {
      sets.push(`barcode = $${paramIdx++}`);
      params.push(barcode || null);
    }
    if (expiry_date !== undefined) {
      sets.push(`expiry_date = $${paramIdx++}`);
      params.push(expiry_date || null);
    }
    if (lot_number !== undefined) {
      sets.push(`lot_number = $${paramIdx++}`);
      params.push(lot_number || null);
    }
    if (cost_price !== undefined) {
      sets.push(`cost_price = $${paramIdx++}`);
      params.push(cost_price);
    }

    if (sets.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    params.push(id);
    await run(`UPDATE inventory_items SET ${sets.join(', ')} WHERE id = $${paramIdx}`, params);

    res.json({ id: parseInt(id), ...req.body });
  } catch (error) {
    console.error('Error updating inventory:', error);
    res.status(500).json({ error: 'Failed to update inventory' });
  }
});

// POST /api/inventory - create inventory item
router.post('/', requireAuth('manage_inventory'), async (req, res) => {
  try {
    const { name, quantity, unit, low_stock_threshold, category, cost_price, sku, barcode, expiry_date, lot_number } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }

    // Plan limit check
    const plan = req.tenant?.plan || 'free';
    const { cnt } = await get('SELECT COUNT(*) as cnt FROM inventory_items') || { cnt: 0 };
    const check = checkLimit(plan, 'inventoryItems', cnt);
    if (!check.allowed) {
      return res.status(403).json(planUpgradeError('inventoryItems', plan, { limit: check.limit, current: check.current }));
    }

    const tid = getTenantId();
    const result = await run(`
      INSERT INTO inventory_items (tenant_id, name, quantity, unit, low_stock_threshold, category, cost_price, sku, barcode, expiry_date, lot_number)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    `, [
      tid,
      name,
      quantity || 0,
      unit || null,
      low_stock_threshold || 0,
      category || null,
      cost_price || 0,
      sku || null,
      barcode || null,
      expiry_date || null,
      lot_number || null,
    ]);

    res.json({
      id: result.lastInsertRowid,
      name,
      quantity: quantity || 0,
      unit: unit || null,
      low_stock_threshold: low_stock_threshold || 0,
      category: category || null,
      cost_price: cost_price || 0,
      sku: sku || null,
      barcode: barcode || null,
      expiry_date: expiry_date || null,
      lot_number: lot_number || null,
    });
  } catch (error) {
    console.error('Error creating inventory item:', error);
    res.status(500).json({ error: 'Failed to create inventory item' });
  }
});

// POST /api/inventory/:id/restock - add to quantity
router.post('/:id/restock', requireAuth('manage_inventory'), async (req, res) => {
  try {
    const { id } = req.params;
    const amount = req.body.quantity ?? req.body.amount;

    if (amount === undefined || amount <= 0) {
      return res.status(400).json({ error: 'Invalid restock amount' });
    }

    const item = await get('SELECT id, quantity FROM inventory_items WHERE id = $1', [id]);
    if (!item) {
      return res.status(404).json({ error: 'Inventory item not found' });
    }

    const newQuantity = item.quantity + amount;

    await run(`
      UPDATE inventory_items
      SET quantity = $1
      WHERE id = $2
    `, [newQuantity, id]);

    // Fire-and-forget: log restock for AI pattern analysis
    setImmediate(() => logRestockEvent(parseInt(id), item.quantity, amount));

    res.json({ id, quantity: newQuantity, restockAmount: amount });
  } catch (error) {
    console.error('Error restocking inventory:', error);
    res.status(500).json({ error: 'Failed to restock inventory' });
  }
});

// POST /api/inventory/deduct - deduct ingredients for an order
router.post('/deduct', async (req, res) => {
  try {
    const { order_id } = req.body;

    if (!order_id) {
      return res.status(400).json({ error: 'Missing order_id' });
    }

    // Get all order items
    const orderItems = await all(`
      SELECT menu_item_id, quantity
      FROM order_items
      WHERE order_id = $1
    `, [order_id]);

    if (orderItems.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // For each order item, deduct ingredients
    for (const orderItem of orderItems) {
      const ingredients = await all(`
        SELECT inventory_item_id, quantity_used
        FROM menu_item_ingredients
        WHERE menu_item_id = $1
      `, [orderItem.menu_item_id]);

      for (const ingredient of ingredients) {
        const totalNeeded = ingredient.quantity_used * orderItem.quantity;

        const inventoryItem = await get(`
          SELECT id, quantity
          FROM inventory_items
          WHERE id = $1
        `, [ingredient.inventory_item_id]);

        if (inventoryItem) {
          const newQuantity = Math.max(0, inventoryItem.quantity - totalNeeded);
          await run(`
            UPDATE inventory_items
            SET quantity = $1
            WHERE id = $2
          `, [newQuantity, ingredient.inventory_item_id]);
        }
      }
    }

    res.json({ message: 'Inventory deducted successfully' });
  } catch (error) {
    console.error('Error deducting inventory:', error);
    res.status(500).json({ error: 'Failed to deduct inventory' });
  }
});

export default router;
