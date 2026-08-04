import { fetchWithTimeout } from '../lib/http.js';
import { Router } from 'express';
import { all, get, run, getTenantId } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { checkLimit, planUpgradeError } from '../planLimits.js';
import {
  buildResetPreview,
  resetInventoryData,
  InventoryStillReferencedError,
} from '../helpers/inventoryReset.js';
import { modelFor } from '../lib/aiModels.js';
// AI data pipeline removed in pos-lite
const logRestockEvent = () => {};

const router = Router();
let inventoryColumnsPromise = null;

async function getInventoryColumns() {
  if (!inventoryColumnsPromise) {
    inventoryColumnsPromise = all(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'inventory_items'
    `).then(rows => new Set(rows.map(row => row.column_name)));
  }

  return inventoryColumnsPromise;
}

function selectColumn(columns, columnName) {
  return columns.has(columnName) ? columnName : `NULL AS ${columnName}`;
}

// GET /api/inventory - list all inventory items
router.get('/', requireAuth(), async (req, res) => {
  try {
    const columns = await getInventoryColumns();
    const items = await all(`
      SELECT id, name, quantity, unit, low_stock_threshold, category, cost_price,
             ${selectColumn(columns, 'pack_size')},
             ${selectColumn(columns, 'last_counted_at')},
             ${selectColumn(columns, 'sku')},
             ${selectColumn(columns, 'barcode')},
             ${selectColumn(columns, 'expiry_date')},
             ${selectColumn(columns, 'lot_number')},
             ${selectColumn(columns, 'last_restocked_at')},
             ${selectColumn(columns, 'shelf_life_days')},
             ${selectColumn(columns, 'storage_type')},
             ${selectColumn(columns, 'kind')},
             ${selectColumn(columns, 'low_threshold_portions')},
             ${selectColumn(columns, 'auto_86')},
             ${selectColumn(columns, 'sold_out_manual')}
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
router.get('/search', requireAuth(), async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || typeof q !== 'string' || q.trim().length === 0) {
      return res.status(400).json({ error: 'q query parameter is required' });
    }

    const columns = await getInventoryColumns();
    const items = await all(`
      SELECT id, name, quantity, unit, cost_price, category,
             ${selectColumn(columns, 'pack_size')},
             ${selectColumn(columns, 'kind')}
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
router.get('/lookup', requireAuth(), async (req, res) => {
  try {
    const columns = await getInventoryColumns();
    const { barcode, sku } = req.query;
    if (!barcode && !sku) {
      return res.status(400).json({ error: 'barcode or sku query parameter required' });
    }

    const value = barcode || sku;
    const lookups = [];
    if (columns.has('barcode')) lookups.push('barcode = $1');
    if (columns.has('sku')) lookups.push('sku = $1');

    if (lookups.length === 0) {
      return res.status(404).json({ error: 'Item not found' });
    }

    const item = await get(`
      SELECT id, name, quantity, unit, cost_price, low_stock_threshold,
             category,
             ${selectColumn(columns, 'sku')},
             ${selectColumn(columns, 'barcode')},
             ${selectColumn(columns, 'expiry_date')}
      FROM inventory_items
      WHERE ${lookups.join(' OR ')}
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
router.get('/low-stock', requireAuth(), async (req, res) => {
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
router.get('/counts', requireAuth(), async (req, res) => {
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
router.get('/variance-report', requireAuth(), async (req, res) => {
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
router.get('/shrinkage-alerts', requireAuth(), async (req, res) => {
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

// GET /api/inventory/cost-review/candidates
// Surfaces SKUs whose stored cost_price is almost certainly a line_total
// (or pack price) that was treated as a per-unit price during the original
// receipt-vision ingest. Fingerprint (works for both single-line WhatsApp
// purchases AND multi-line receipts):
//   - the SKU's current cost_price equals an expense_items row's unit_cost
//   - that line's quantity > 1 (dividing would actually change the value)
//   - the receipt this line came from is "over-extracted":
//       sum(expense_items.line_total) on that expense > expense.amount × 1.05
//     This is the smoking gun — Claude treated per-line "amount" as
//     quantity × per-unit-price, but the per-line totals balloon past the
//     receipt total, meaning at least some unit_costs are actually line
//     totals being multiplied a second time.
//   - OR the expense had a single line and amount ≈ unit_cost (the original
//     single-line WhatsApp purchase fingerprint, still caught here)
// Owner sees stored vs proposed cost; one tap to apply. Once applied,
// inventory_items.cost_price no longer matches the original unit_cost, so
// the row drops out of the list naturally.
router.get('/cost-review/candidates', requireAuth('manage_inventory'), async (req, res) => {
  try {
    const rows = await all(`
      WITH receipt_totals AS (
        SELECT
          ei.expense_id,
          SUM(ei.line_total) AS items_total,
          COUNT(*) AS line_count
        FROM expense_items ei
        GROUP BY ei.expense_id
      )
      SELECT
        ii.id,
        ii.name,
        ii.unit,
        ii.cost_price::float AS stored_unit_cost,
        ei.id AS expense_item_id,
        ei.quantity::float AS quantity_added,
        ei.line_total::float AS line_total,
        e.amount::float AS expense_amount,
        rt.items_total::float AS items_total,
        rt.line_count::int AS line_count,
        e.expense_date,
        e.vendor,
        (ei.unit_cost / ei.quantity)::numeric(12,4)::float AS proposed_unit_cost,
        ei.created_at AS detected_at
      FROM inventory_items ii
      JOIN expense_items ei ON ei.inventory_item_id = ii.id
      JOIN expenses e ON e.id = ei.expense_id
      JOIN receipt_totals rt ON rt.expense_id = ei.expense_id
      WHERE ii.cost_price > 0
        AND ABS(ii.cost_price - ei.unit_cost) < 0.01
        AND ei.quantity > 1
        AND (
          rt.items_total > e.amount * 1.05
          OR (rt.line_count = 1 AND ABS(e.amount - ei.unit_cost) < 1.0)
        )
      ORDER BY ei.created_at DESC
      LIMIT 100
    `);

    res.json({ candidates: rows });
  } catch (error) {
    console.error('Error fetching cost-review candidates:', error);
    res.status(500).json({ error: 'Failed to fetch cost-review candidates' });
  }
});

// POST /api/inventory/cost-review/apply
// Body: { item_id, proposed_unit_cost, history_id? }
// Updates inventory_items.cost_price and appends a corrective
// inventory_cost_history row (quantity_added=0 marks it as a manual
// correction, not a restock — keeps the ledger honest).
router.post('/cost-review/apply', requireAuth('manage_inventory'), async (req, res) => {
  try {
    const { item_id, proposed_unit_cost } = req.body || {};
    const itemId = Number(item_id);
    const proposed = Number(proposed_unit_cost);
    if (!Number.isFinite(itemId) || itemId <= 0) {
      return res.status(400).json({ error: 'item_id required' });
    }
    if (!Number.isFinite(proposed) || proposed <= 0) {
      return res.status(400).json({ error: 'proposed_unit_cost must be > 0' });
    }

    const item = await get('SELECT id, cost_price FROM inventory_items WHERE id = $1', [itemId]);
    if (!item) return res.status(404).json({ error: 'Item not found' });

    const prevCost = Number(item.cost_price) || 0;
    const tid = getTenantId();
    await run('UPDATE inventory_items SET cost_price = $1 WHERE id = $2', [proposed, itemId]);
    try {
      await run(
        `INSERT INTO inventory_cost_history
           (tenant_id, inventory_item_id, vendor_id, expense_id, quantity_added, unit_cost, prev_cost_price, new_cost_price)
         VALUES ($1, $2, NULL, NULL, 0, $3, $4, $5)`,
        [tid, itemId, proposed, prevCost, proposed]
      );
    } catch (err) {
      // History append is non-fatal — primary cost_price update already landed.
      console.warn('[cost-review] history append failed:', err.message);
    }

    res.json({ success: true, item_id: itemId, prev_cost_price: prevCost, new_cost_price: proposed });
  } catch (error) {
    console.error('Error applying cost-review correction:', error);
    res.status(500).json({ error: 'Failed to apply correction' });
  }
});

// POST /api/inventory/scan-restock - restock by barcode/sku scan
router.post('/scan-restock', requireAuth('manage_inventory'), async (req, res) => {
  try {
    const columns = await getInventoryColumns();
    const { barcode, sku, quantity, cost_price } = req.body;

    if (!barcode && !sku) {
      return res.status(400).json({ error: 'barcode or sku is required' });
    }
    if (!quantity || quantity <= 0) {
      return res.status(400).json({ error: 'quantity must be greater than 0' });
    }

    const value = barcode || sku;
    const lookups = [];
    if (columns.has('barcode')) lookups.push('barcode = $1');
    if (columns.has('sku')) lookups.push('sku = $1');

    if (lookups.length === 0) {
      return res.status(404).json({ error: 'Item not found' });
    }

    const item = await get(`
      SELECT id, name, quantity, unit, cost_price
      FROM inventory_items
      WHERE ${lookups.join(' OR ')}
    `, [value]);

    if (!item) {
      return res.status(404).json({ error: 'Item not found' });
    }

    const quantityBefore = item.quantity;
    const newQuantity = quantityBefore + quantity;

    // Update quantity, optionally cost_price, and stamp last_restocked_at when available.
    const hasLastRestocked = columns.has('last_restocked_at');
    if (cost_price !== undefined && cost_price !== null) {
      await run(
        hasLastRestocked
          ? 'UPDATE inventory_items SET quantity = $1, cost_price = $2, last_restocked_at = NOW() WHERE id = $3'
          : 'UPDATE inventory_items SET quantity = $1, cost_price = $2 WHERE id = $3',
        [newQuantity, cost_price, item.id]
      );
    } else {
      await run(
        hasLastRestocked
          ? 'UPDATE inventory_items SET quantity = $1, last_restocked_at = NOW() WHERE id = $2'
          : 'UPDATE inventory_items SET quantity = $1 WHERE id = $2',
        [newQuantity, item.id]
      );
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
    const columns = await getInventoryColumns();
    const { id } = req.params;
    const { name, quantity, low_stock_threshold, category, sku, barcode, expiry_date, lot_number, cost_price, unit, pack_size, shelf_life_days, storage_type, kind, low_threshold_portions, auto_86, sold_out_manual } = req.body;

    const item = await get('SELECT id FROM inventory_items WHERE id = $1', [id]);
    if (!item) {
      return res.status(404).json({ error: 'Inventory item not found' });
    }
    if (name !== undefined && !String(name).trim()) {
      return res.status(400).json({ error: 'name is required' });
    }

    // Build dynamic SET clause for provided fields only
    const sets = [];
    const params = [];
    let paramIdx = 1;

    if (name !== undefined) {
      sets.push(`name = $${paramIdx++}`);
      params.push(String(name).trim());
    }
    if (quantity !== undefined) {
      sets.push(`quantity = $${paramIdx++}`);
      params.push(quantity);
    }
    if (low_stock_threshold !== undefined) {
      sets.push(`low_stock_threshold = $${paramIdx++}`);
      params.push(low_stock_threshold);
    }
    if (category !== undefined) {
      sets.push(`category = $${paramIdx++}`);
      params.push(category || null);
    }
    if (sku !== undefined && columns.has('sku')) {
      sets.push(`sku = $${paramIdx++}`);
      params.push(sku || null);
    }
    if (barcode !== undefined && columns.has('barcode')) {
      sets.push(`barcode = $${paramIdx++}`);
      params.push(barcode || null);
    }
    if (expiry_date !== undefined && columns.has('expiry_date')) {
      sets.push(`expiry_date = $${paramIdx++}`);
      params.push(expiry_date || null);
    }
    if (lot_number !== undefined && columns.has('lot_number')) {
      sets.push(`lot_number = $${paramIdx++}`);
      params.push(lot_number || null);
    }
    if (cost_price !== undefined) {
      sets.push(`cost_price = $${paramIdx++}`);
      params.push(cost_price);
    }
    if (unit !== undefined) {
      sets.push(`unit = $${paramIdx++}`);
      params.push(unit || null);
    }
    if (pack_size !== undefined && columns.has('pack_size')) {
      sets.push(`pack_size = $${paramIdx++}`);
      params.push(pack_size === '' || pack_size === null ? null : Number(pack_size));
    }
    if (shelf_life_days !== undefined && columns.has('shelf_life_days')) {
      sets.push(`shelf_life_days = $${paramIdx++}`);
      params.push(shelf_life_days === '' || shelf_life_days === null
        ? null
        : Math.max(1, Math.round(Number(shelf_life_days))));
    }
    if (storage_type !== undefined && columns.has('storage_type')) {
      sets.push(`storage_type = $${paramIdx++}`);
      params.push(STORAGE_TYPES.includes(storage_type) ? storage_type : null);
    }
    // Two-stage fields (migration 0103). `kind` is validated rather than
    // coerced — silently writing 'raw' for a typo would move an item between
    // inventory layers, which changes whether it gates the menu.
    if (kind !== undefined && columns.has('kind')) {
      if (!INVENTORY_KINDS.includes(kind)) {
        return res.status(400).json({ error: `kind must be one of: ${INVENTORY_KINDS.join(', ')}` });
      }
      sets.push(`kind = $${paramIdx++}`);
      params.push(kind);
    }
    if (low_threshold_portions !== undefined && columns.has('low_threshold_portions')) {
      sets.push(`low_threshold_portions = $${paramIdx++}`);
      params.push(low_threshold_portions === '' || low_threshold_portions === null
        ? null
        : Number(low_threshold_portions));
    }
    if (auto_86 !== undefined && columns.has('auto_86')) {
      sets.push(`auto_86 = $${paramIdx++}`);
      params.push(!!auto_86);
    }
    if (sold_out_manual !== undefined && columns.has('sold_out_manual')) {
      sets.push(`sold_out_manual = $${paramIdx++}`);
      params.push(!!sold_out_manual);
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
    const columns = await getInventoryColumns();
    const { name, quantity, unit, low_stock_threshold, category, cost_price, sku, barcode, expiry_date, lot_number, pack_size, shelf_life_days, storage_type, kind, low_threshold_portions, auto_86, sold_out_manual } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }
    if (kind !== undefined && !INVENTORY_KINDS.includes(kind)) {
      return res.status(400).json({ error: `kind must be one of: ${INVENTORY_KINDS.join(', ')}` });
    }

    // Plan limit check
    const plan = req.tenant?.plan || 'free';
    const { cnt } = await get('SELECT COUNT(*) as cnt FROM inventory_items') || { cnt: 0 };
    const check = checkLimit(plan, 'inventoryItems', cnt);
    if (!check.allowed) {
      return res.status(403).json(planUpgradeError('inventoryItems', plan, { limit: check.limit, current: check.current }));
    }

    const tid = getTenantId();
    const insertColumns = ['tenant_id', 'name', 'quantity', 'unit', 'low_stock_threshold', 'category', 'cost_price'];
    const insertValues = [tid, name, quantity || 0, unit || null, low_stock_threshold || 0, category || null, cost_price || 0];

    if (columns.has('sku')) {
      insertColumns.push('sku');
      insertValues.push(sku || null);
    }
    if (columns.has('barcode')) {
      insertColumns.push('barcode');
      insertValues.push(barcode || null);
    }
    if (columns.has('expiry_date')) {
      insertColumns.push('expiry_date');
      insertValues.push(expiry_date || null);
    }
    if (columns.has('lot_number')) {
      insertColumns.push('lot_number');
      insertValues.push(lot_number || null);
    }
    if (columns.has('pack_size')) {
      insertColumns.push('pack_size');
      insertValues.push(pack_size === undefined || pack_size === '' || pack_size === null ? null : Number(pack_size));
    }
    if (columns.has('shelf_life_days')) {
      insertColumns.push('shelf_life_days');
      insertValues.push(shelf_life_days === undefined || shelf_life_days === '' || shelf_life_days === null
        ? null
        : Math.max(1, Math.round(Number(shelf_life_days))));
    }
    if (columns.has('storage_type') && STORAGE_TYPES.includes(storage_type)) {
      insertColumns.push('storage_type');
      insertValues.push(storage_type);
    }
    // Two-stage fields (migration 0103). Omitting `kind` lets the column
    // default to 'raw', which is what an item created without an opinion is.
    if (columns.has('kind') && kind !== undefined) {
      insertColumns.push('kind');
      insertValues.push(kind);
    }
    if (columns.has('low_threshold_portions') && low_threshold_portions !== undefined
        && low_threshold_portions !== '' && low_threshold_portions !== null) {
      insertColumns.push('low_threshold_portions');
      insertValues.push(Number(low_threshold_portions));
    }
    if (columns.has('auto_86') && auto_86 !== undefined) {
      insertColumns.push('auto_86');
      insertValues.push(!!auto_86);
    }
    if (columns.has('sold_out_manual') && sold_out_manual !== undefined) {
      insertColumns.push('sold_out_manual');
      insertValues.push(!!sold_out_manual);
    }
    // Items born with stock start the stale clock immediately; manually created
    // empty rows (recipe-only) wait until first real restock through the expense flow.
    if (columns.has('last_restocked_at') && (quantity || 0) > 0) {
      insertColumns.push('last_restocked_at');
      insertValues.push(new Date().toISOString());
    }

    const placeholders = insertColumns.map((_, index) => `$${index + 1}`);
    const result = await run(`
      INSERT INTO inventory_items (${insertColumns.join(', ')})
      VALUES (${placeholders.join(', ')})
    `, insertValues);

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
      pack_size: pack_size === undefined || pack_size === '' || pack_size === null ? null : Number(pack_size),
      shelf_life_days: shelf_life_days === undefined || shelf_life_days === '' || shelf_life_days === null
        ? null
        : Math.max(1, Math.round(Number(shelf_life_days))),
      storage_type: STORAGE_TYPES.includes(storage_type) ? storage_type : null,
      kind: kind || 'raw',
    });
  } catch (error) {
    console.error('Error creating inventory item:', error);
    res.status(500).json({ error: 'Failed to create inventory item' });
  }
});

// DELETE /api/inventory/:id - delete inventory item if not referenced
router.delete('/:id', requireAuth('manage_inventory'), async (req, res) => {
  try {
    const { id } = req.params;

    const item = await get('SELECT id, name FROM inventory_items WHERE id = $1', [id]);
    if (!item) {
      return res.status(404).json({ error: 'Inventory item not found' });
    }

    const recipeUses = await all(`
      SELECT mi.name
      FROM menu_item_ingredients mii
      JOIN menu_items mi ON mi.id = mii.menu_item_id
      WHERE mii.inventory_item_id = $1
      ORDER BY mi.name
      LIMIT 5
    `, [id]);

    if (recipeUses.length > 0) {
      const names = recipeUses.map(row => row.name).join(', ');
      return res.status(409).json({
        error: `"${item.name}" is used in recipes (${names}). Remove it from those recipes first.`,
      });
    }

    try {
      await run('DELETE FROM inventory_items WHERE id = $1', [id]);
    } catch (error) {
      if (error?.code === '23503') {
        return res.status(409).json({
          error: `"${item.name}" is referenced by purchase orders, counts, or waste logs and cannot be deleted.`,
        });
      }
      throw error;
    }

    res.json({ id: Number(id), deleted: true });
  } catch (error) {
    console.error('Error deleting inventory item:', error);
    res.status(500).json({ error: 'Failed to delete inventory item' });
  }
});

// ==================== Inventory Reset (danger zone) ====================
//
// Clears inventory left behind by testing the system. Two modes, both
// irreversible — see server/helpers/inventoryReset.js for what each touches.
// 'wipe' is admin-only: it destroys menu cost math, not just stock levels.

// GET /api/inventory/reset/preview - row counts a reset would touch
router.get('/reset/preview', requireAuth('manage_inventory'), async (_req, res) => {
  try {
    res.json(await buildResetPreview(getTenantId()));
  } catch (error) {
    console.error('Error building inventory reset preview:', error);
    res.status(500).json({ error: 'Failed to load reset preview' });
  }
});

// POST /api/inventory/reset - zero out stock, or wipe the inventory slate
router.post('/reset', requireAuth('manage_inventory'), async (req, res) => {
  try {
    const { mode, confirm } = req.body || {};

    if (mode !== 'zero' && mode !== 'wipe') {
      return res.status(400).json({ error: "mode must be 'zero' or 'wipe'" });
    }

    // Typed confirmation, in either language the UI runs in.
    const word = typeof confirm === 'string' ? confirm.trim().toUpperCase() : '';
    if (word !== 'BORRAR' && word !== 'DELETE') {
      return res.status(400).json({ error: 'Confirmation word required' });
    }

    // A wipe destroys recipes and menu cost math, so it stays with the owner
    // even if a tenant has granted manage_inventory more widely.
    if (mode === 'wipe' && req.employee?.role !== 'admin') {
      return res.status(403).json({
        error: 'Only an admin can delete the whole inventory. Use "zero out stock" instead.',
      });
    }

    const tenantId = getTenantId();

    // No BEGIN here — tenantMiddleware owns the request transaction, so either
    // every statement in the reset lands or none of them do.
    let result;
    try {
      result = await resetInventoryData({ mode, tenantId });
    } catch (error) {
      if (error instanceof InventoryStillReferencedError) {
        return res.status(409).json({
          error: `${error.message} — reset aborted, nothing was deleted.`,
        });
      }
      throw error;
    }

    console.log(
      `[inventory-reset] tenant=${tenantId} mode=${mode} by=${req.employee?.id} ` +
      `items=${result.items_affected} ${JSON.stringify(result.deleted)}`
    );

    res.json({ mode, ...result });
  } catch (error) {
    console.error('Error resetting inventory:', error);
    res.status(500).json({ error: 'Failed to reset inventory' });
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
    const columns = await getInventoryColumns();

    if (columns.has('last_restocked_at')) {
      await run('UPDATE inventory_items SET quantity = $1, last_restocked_at = NOW() WHERE id = $2', [newQuantity, id]);
    } else {
      await run('UPDATE inventory_items SET quantity = $1 WHERE id = $2', [newQuantity, id]);
    }

    // Fire-and-forget: log restock for AI pattern analysis
    setImmediate(() => logRestockEvent(parseInt(id), item.quantity, amount));

    res.json({ id, quantity: newQuantity, restockAmount: amount });
  } catch (error) {
    console.error('Error restocking inventory:', error);
    res.status(500).json({ error: 'Failed to restock inventory' });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// Shelf life: AI suggestion + stale-stock detection + three-button actions.
// AI suggests, SQL detects, human decides. Mirrors the receipt-scanner pattern
// in expenses.js — same provider (Claude), same fallback discipline.
// ────────────────────────────────────────────────────────────────────────────

const STORAGE_TYPES = ['refrigerated', 'frozen', 'dry', 'ambient'];
// Which inventory layer a row belongs to (migration 0103): 'raw' is walk-in
// stock, 'component' is a counted portion on the line.
const INVENTORY_KINDS = ['raw', 'component'];
const WASTE_REASONS = ['spoilage', 'prep_error', 'dropped', 'expired', 'other'];

// Coarse fallback when AI is unavailable. Keeps the feature working offline.
const CATEGORY_DEFAULTS = {
  dairy: { shelf_life_days: 14, storage_type: 'refrigerated' },
  produce: { shelf_life_days: 7, storage_type: 'refrigerated' },
  meat: { shelf_life_days: 5, storage_type: 'refrigerated' },
  seafood: { shelf_life_days: 3, storage_type: 'refrigerated' },
  bakery: { shelf_life_days: 5, storage_type: 'ambient' },
  beverages: { shelf_life_days: 180, storage_type: 'ambient' },
  frozen: { shelf_life_days: 90, storage_type: 'frozen' },
  dry_goods: { shelf_life_days: 365, storage_type: 'dry' },
  spices: { shelf_life_days: 540, storage_type: 'dry' },
  cleaning: { shelf_life_days: 730, storage_type: 'dry' },
};

function fallbackAttrs(category) {
  const key = (category || '').toLowerCase().replace(/\s+/g, '_');
  return CATEGORY_DEFAULTS[key] || { shelf_life_days: 30, storage_type: 'ambient' };
}

const SHELF_LIFE_PROMPT = `You estimate shelf life for restaurant inventory items so a POS can flag stale stock.

Return ONLY valid JSON, no prose, with this exact schema:
{
  "shelf_life_days": number,     // typical days from purchase to spoilage assuming proper storage
  "storage_type": "refrigerated" | "frozen" | "dry" | "ambient",
  "category": "dairy" | "produce" | "meat" | "seafood" | "bakery" | "beverages" | "frozen" | "dry_goods" | "spices" | "cleaning" | "other",
  "confidence": "high" | "medium" | "low"
}

Rules:
- Be realistic for a small restaurant context (opened packages, not sealed manufacturer life).
- Cheese hard (cheddar, parmesan): 30-60 days refrigerated. Soft cheese (queso fresco, mozzarella): 7-14 days.
- Fresh produce by item: leafy greens 5-7, tomatoes 7-10, citrus 14-21, root veg 30+.
- Meat by item: ground 2-3, whole cuts 5-7, cured 21+.
- Cleaning supplies, oils, dry pantry items: 180-540 days.
- If the name is ambiguous (e.g. just "queso"), pick the most common interpretation and mark confidence "medium" or "low".
- All numbers as JSON numbers. No prose. No nulls.`;

// Single-item shelf-life inference. Shared by /suggest-attrs and /backfill-attrs.
async function inferShelfLife(name, categoryHint) {
  if (!process.env.ANTHROPIC_API_KEY) {
    const fb = fallbackAttrs(categoryHint);
    return { ...fb, category: categoryHint || 'other', confidence: 'low', source: 'fallback' };
  }

  const userText = categoryHint
    ? `Item name: ${name}\nUser-provided category hint: ${categoryHint}`
    : `Item name: ${name}`;

  let response;
  try {
    response = await fetchWithTimeout('https://api.anthropic.com/v1/messages', { timeoutMs: 30000,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: modelFor('inventory_attrs'),
        max_tokens: 256,
        system: SHELF_LIFE_PROMPT,
        messages: [{ role: 'user', content: userText }],
      }),
    });
  } catch (fetchErr) {
    console.warn('[Inventory] inferShelfLife network error:', fetchErr.message);
    const fb = fallbackAttrs(categoryHint);
    return { ...fb, category: categoryHint || 'other', confidence: 'low', source: 'fallback' };
  }

  if (!response.ok) {
    const fb = fallbackAttrs(categoryHint);
    return { ...fb, category: categoryHint || 'other', confidence: 'low', source: 'fallback' };
  }

  const data = await response.json();
  const content = data.content?.[0]?.text || '';

  let parsed = null;
  try {
    const m = content.match(/\{[\s\S]*\}/);
    if (m) parsed = JSON.parse(m[0]);
  } catch {
    /* fall through */
  }

  if (!parsed || typeof parsed.shelf_life_days !== 'number' || parsed.shelf_life_days <= 0) {
    const fb = fallbackAttrs(categoryHint);
    return { ...fb, category: categoryHint || 'other', confidence: 'low', source: 'fallback' };
  }

  if (!STORAGE_TYPES.includes(parsed.storage_type)) {
    parsed.storage_type = fallbackAttrs(parsed.category || categoryHint).storage_type;
  }

  return {
    shelf_life_days: Math.round(parsed.shelf_life_days),
    storage_type: parsed.storage_type,
    category: parsed.category || categoryHint || 'other',
    confidence: parsed.confidence || 'medium',
    source: 'ai',
  };
}

// POST /api/inventory/suggest-attrs — single-item AI inference (used by create-new modals).
router.post('/suggest-attrs', requireAuth('manage_inventory'), async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    const categoryHint = String(req.body?.category || '').trim();
    if (!name) return res.status(400).json({ error: 'name is required' });

    const result = await inferShelfLife(name, categoryHint);
    res.json(result);
  } catch (err) {
    console.error('[Inventory] suggest-attrs error:', err.message);
    const fb = fallbackAttrs(req.body?.category);
    res.json({ ...fb, category: req.body?.category || 'other', confidence: 'low', source: 'fallback' });
  }
});

// GET /api/inventory/audit-status — how many items still need shelf-life data.
// Drives the "Run AI audit" banner. Returns zeros when migration not applied.
router.get('/audit-status', requireAuth(), async (_req, res) => {
  try {
    const columns = await getInventoryColumns();
    if (!columns.has('shelf_life_days') || !columns.has('last_restocked_at')) {
      return res.json({ missing_shelf_life: 0, missing_clock: 0, total: 0 });
    }
    const row = await get(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE shelf_life_days IS NULL)::int AS missing_shelf_life,
         COUNT(*) FILTER (WHERE quantity > 0 AND last_restocked_at IS NULL)::int AS missing_clock
       FROM inventory_items`
    );
    res.json(row || { total: 0, missing_shelf_life: 0, missing_clock: 0 });
  } catch (err) {
    console.error('[Inventory] audit-status error:', err.message);
    res.status(500).json({ error: 'Failed to fetch audit status' });
  }
});

// POST /api/inventory/backfill-attrs — one-time audit: for every item with NULL
// shelf_life_days, call Claude and persist the suggestion. Also stamps
// last_restocked_at=NOW() on items with quantity>0 still missing the clock,
// so the stale detector has something to measure from. Capped per call to keep
// response time bounded — frontend can loop until backfilled=0.
router.post('/backfill-attrs', requireAuth('manage_inventory'), async (req, res) => {
  try {
    const columns = await getInventoryColumns();
    if (!columns.has('shelf_life_days') || !columns.has('last_restocked_at')) {
      return res.status(400).json({ error: 'shelf life columns not present — apply migration 0044' });
    }

    const limit = Math.min(Math.max(Number(req.body?.limit) || 25, 1), 50);

    const targets = await all(
      `SELECT id, name, category, quantity, last_restocked_at
       FROM inventory_items
       WHERE shelf_life_days IS NULL
       ORDER BY (quantity > 0) DESC, id ASC
       LIMIT $1`,
      [limit]
    );

    const results = [];
    let aiHits = 0;
    let fallbacks = 0;
    let restockClockSet = 0;

    for (const row of targets) {
      try {
        const inferred = await inferShelfLife(row.name, row.category || '');
        if (inferred.source === 'ai') aiHits++; else fallbacks++;

        // Set last_restocked_at to NOW() only when it's currently NULL AND we have
        // stock — implies "we don't know when this arrived, treat as fresh today".
        const shouldStampClock = row.quantity > 0 && row.last_restocked_at == null;
        if (shouldStampClock) restockClockSet++;

        await run(
          shouldStampClock
            ? `UPDATE inventory_items
               SET shelf_life_days = $1, storage_type = $2, last_restocked_at = NOW()
               WHERE id = $3 AND shelf_life_days IS NULL`
            : `UPDATE inventory_items
               SET shelf_life_days = $1, storage_type = $2
               WHERE id = $3 AND shelf_life_days IS NULL`,
          [inferred.shelf_life_days, inferred.storage_type, row.id]
        );

        results.push({
          id: row.id,
          name: row.name,
          shelf_life_days: inferred.shelf_life_days,
          storage_type: inferred.storage_type,
          source: inferred.source,
          restock_clock_set: shouldStampClock,
        });
      } catch (itemErr) {
        console.warn(`[Inventory] backfill failed for item ${row.id}:`, itemErr.message);
      }
    }

    // How many items still need backfilling after this batch?
    const remaining = await get(
      `SELECT COUNT(*)::int AS n FROM inventory_items WHERE shelf_life_days IS NULL`
    );

    res.json({
      processed: targets.length,
      ai_hits: aiHits,
      fallbacks,
      restock_clock_set: restockClockSet,
      remaining: remaining?.n || 0,
      items: results,
    });
  } catch (err) {
    console.error('[Inventory] backfill-attrs error:', err.message);
    res.status(500).json({ error: 'Failed to backfill shelf-life attributes' });
  }
});

// GET /api/inventory/stale — items past their shelf life with quantity remaining.
// Joins recent count history to suppress items the user already confirmed today.
router.get('/stale', requireAuth(), async (req, res) => {
  try {
    const columns = await getInventoryColumns();
    if (!columns.has('shelf_life_days') || !columns.has('last_restocked_at')) {
      // Migration not yet applied — return empty rather than error.
      return res.json([]);
    }

    const includeSoon = req.query.include_soon === '1';
    // soonFactor: items within 80% of shelf life. Inlined as a constant because
    // postgres.js was binding it as text and breaking the (int * text * interval)
    // operator chain. Compute the integer day threshold up-front instead.
    const SOON_PCT = 80; // 0.8 expressed as integer percent for clean SQL math

    const rows = await all(
      `SELECT
         ii.id, ii.name, ii.quantity, ii.unit, ii.category,
         ii.shelf_life_days, ii.storage_type, ii.last_restocked_at, ii.cost_price,
         EXTRACT(EPOCH FROM (NOW() - ii.last_restocked_at)) / 86400.0 AS days_since_restock,
         CASE
           WHEN ii.last_restocked_at IS NULL OR ii.shelf_life_days IS NULL THEN NULL
           WHEN NOW() > ii.last_restocked_at + (ii.shelf_life_days * INTERVAL '1 day') THEN 'expired'
           WHEN NOW() > ii.last_restocked_at + ((ii.shelf_life_days * ${SOON_PCT} / 100) * INTERVAL '1 day') THEN 'soon'
           ELSE NULL
         END AS stale_status
       FROM inventory_items ii
       WHERE ii.quantity > 0
         AND ii.last_restocked_at IS NOT NULL
         AND ii.shelf_life_days IS NOT NULL
         AND NOW() > ii.last_restocked_at + ((ii.shelf_life_days * ${SOON_PCT} / 100) * INTERVAL '1 day')
       ORDER BY (NOW() - ii.last_restocked_at - (ii.shelf_life_days * INTERVAL '1 day')) DESC NULLS LAST`
    );

    const filtered = includeSoon ? rows : rows.filter(r => r.stale_status === 'expired');
    res.json(filtered.map(r => ({
      ...r,
      days_since_restock: Math.round(Number(r.days_since_restock) || 0),
    })));
  } catch (err) {
    console.error('[Inventory] stale fetch error:', err.message);
    res.status(500).json({ error: 'Failed to fetch stale stock' });
  }
});

// GET /api/inventory/touched-today — inventory_item ids touched today by
// any restock action. Union of:
//   1. Direct manual restocks (last_restocked_at::date = today)
//   2. Expense-driven restocks, including retroactive links of older
//      purchases (inventory_cost_history.created_at::date = today)
// The 2nd half is what the user expects from "Agregado Hoy": when they
// link a Costco purchase from yesterday TODAY, those items show as added
// today even though last_restocked_at = yesterday (which is correct for
// the shelf-life clock).
router.get('/touched-today', requireAuth(), async (req, res) => {
  try {
    const columns = await getInventoryColumns();
    const hasLastRestocked = columns.has('last_restocked_at');

    const rows = await all(
      `SELECT DISTINCT inventory_item_id FROM (
         ${hasLastRestocked ? `
         SELECT id AS inventory_item_id
         FROM inventory_items
         WHERE last_restocked_at::date = CURRENT_DATE
         UNION
         ` : ''}
         SELECT ich.inventory_item_id
         FROM inventory_cost_history ich
         WHERE ich.created_at::date = CURRENT_DATE
       ) t`
    );
    res.json(rows.map(r => r.inventory_item_id));
  } catch (err) {
    // Tables may not exist on stale schema — degrade gracefully.
    console.warn('[Inventory] touched-today error:', err.message);
    res.json([]);
  }
});

// GET /api/inventory/dormant — items with quantity remaining that haven't
// been touched (counted, wasted, restocked) in DORMANT_DAYS or more. Useful
// for "stuff sitting in the back you're not using" — distinct from stale,
// which is shelf-life-based.
router.get('/dormant', requireAuth(), async (req, res) => {
  try {
    const columns = await getInventoryColumns();
    const hasLastRestocked = columns.has('last_restocked_at');
    const hasLastCounted = columns.has('last_counted_at');

    const days = Math.max(7, Math.min(180, parseInt(req.query.days, 10) || 30));

    const lastRestockedExpr = hasLastRestocked ? 'ii.last_restocked_at' : 'NULL::timestamptz';
    const lastCountedExpr = hasLastCounted ? 'ii.last_counted_at' : 'NULL::timestamptz';

    const rows = await all(
      `WITH activity AS (
         SELECT
           ii.id,
           ${lastRestockedExpr} AS last_restocked_at,
           ${lastCountedExpr}   AS last_counted_at,
           (SELECT MAX(created_at) FROM inventory_counts ic WHERE ic.inventory_item_id = ii.id) AS last_count_event,
           (SELECT MAX(created_at) FROM waste_log wl WHERE wl.inventory_item_id = ii.id) AS last_waste_event
         FROM inventory_items ii
         WHERE ii.quantity > 0
       )
       SELECT
         ii.id, ii.name, ii.quantity, ii.unit, ii.category, ii.cost_price,
         ${selectColumn(columns, 'last_restocked_at')},
         GREATEST(
           COALESCE(a.last_restocked_at, 'epoch'::timestamptz),
           COALESCE(a.last_counted_at, 'epoch'::timestamptz),
           COALESCE(a.last_count_event, 'epoch'::timestamptz),
           COALESCE(a.last_waste_event, 'epoch'::timestamptz)
         ) AS last_activity_at,
         EXTRACT(EPOCH FROM (NOW() - GREATEST(
           COALESCE(a.last_restocked_at, 'epoch'::timestamptz),
           COALESCE(a.last_counted_at, 'epoch'::timestamptz),
           COALESCE(a.last_count_event, 'epoch'::timestamptz),
           COALESCE(a.last_waste_event, 'epoch'::timestamptz)
         ))) / 86400.0 AS days_since_activity
       FROM inventory_items ii
       JOIN activity a ON a.id = ii.id
       WHERE ii.quantity > 0
         AND GREATEST(
           COALESCE(a.last_restocked_at, 'epoch'::timestamptz),
           COALESCE(a.last_counted_at, 'epoch'::timestamptz),
           COALESCE(a.last_count_event, 'epoch'::timestamptz),
           COALESCE(a.last_waste_event, 'epoch'::timestamptz)
         ) < NOW() - ($1 || ' days')::interval
       ORDER BY days_since_activity DESC NULLS LAST`,
      [String(days)]
    );

    res.json(rows.map(r => ({
      ...r,
      days_since_activity: Math.round(Number(r.days_since_activity) || 0),
    })));
  } catch (err) {
    console.error('[Inventory] dormant fetch error:', err.message);
    res.status(500).json({ error: 'Failed to fetch dormant stock' });
  }
});

// POST /api/inventory/:id/touch-restocked — user confirmed item is still good.
// Resets the stale clock without changing quantity.
router.post('/:id/touch-restocked', requireAuth('manage_inventory'), async (req, res) => {
  try {
    const { id } = req.params;
    const item = await get('SELECT id FROM inventory_items WHERE id = $1', [id]);
    if (!item) return res.status(404).json({ error: 'Item not found' });

    await run('UPDATE inventory_items SET last_restocked_at = NOW() WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('[Inventory] touch-restocked error:', err.message);
    res.status(500).json({ error: 'Failed to update item' });
  }
});

// POST /api/inventory/:id/mark-wasted — item gone (spoiled, used, discarded).
// Writes a waste_log row at current cost_price, zeros quantity (or subtracts a
// partial amount if `quantity` is in the body), clears last_restocked_at.
router.post('/:id/mark-wasted', requireAuth('manage_inventory'), async (req, res) => {
  try {
    const { id } = req.params;
    const reason = WASTE_REASONS.includes(req.body?.reason) ? req.body.reason : 'expired';
    const notes = req.body?.notes ? String(req.body.notes).slice(0, 500) : null;

    const item = await get('SELECT id, quantity, unit, cost_price FROM inventory_items WHERE id = $1', [id]);
    if (!item) return res.status(404).json({ error: 'Item not found' });

    const currentQty = Number(item.quantity) || 0;
    if (currentQty <= 0) return res.status(400).json({ error: 'Item already at zero quantity' });

    const requested = Number(req.body?.quantity);
    const wasteQty = Number.isFinite(requested) && requested > 0 && requested <= currentQty
      ? requested
      : currentQty;

    const employeeId = req.employee?.id || null;
    const costAtTime = (Number(item.cost_price) || 0) * wasteQty;

    await run(
      `INSERT INTO waste_log (inventory_item_id, quantity, unit, reason, cost_at_time, notes, logged_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, wasteQty, item.unit || null, reason, costAtTime.toFixed(2), notes, employeeId]
    );

    const newQty = currentQty - wasteQty;
    // Clearing last_restocked_at prevents the same item from re-flagging immediately
    // when the user later restocks it through the expense flow (which sets the clock fresh).
    await run(
      `UPDATE inventory_items SET quantity = $1, last_restocked_at = CASE WHEN $1 > 0 THEN last_restocked_at ELSE NULL END WHERE id = $2`,
      [newQty, id]
    );

    res.json({ success: true, new_quantity: newQty, wasted: wasteQty, cost_at_time: costAtTime });
  } catch (err) {
    console.error('[Inventory] mark-wasted error:', err.message);
    res.status(500).json({ error: 'Failed to mark wasted' });
  }
});

// POST /api/inventory/deduct - deduct ingredients for an order
//
// Dormant: no client calls this, and the live deduction path is
// deductInventoryForOrder() in helpers/inventory.js, invoked at payment time.
// It shipped with no auth middleware at all, so any caller who could reach
// /api/* could move stock for an arbitrary order id — closed here while the
// two-stage work was in the file. Left otherwise untouched.
router.post('/deduct', requireAuth('manage_inventory'), async (req, res) => {
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
