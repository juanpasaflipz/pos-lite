import { Router } from 'express';
import { all, get, run, getTenantId } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// ==================== Vendor CRUD ====================

// GET /api/purchase-orders/vendors
router.get('/vendors', async (req, res) => {
  try {
    const vendors = await all('SELECT * FROM vendors ORDER BY name ASC');
    res.json(vendors);
  } catch (error) {
    console.error('Error fetching vendors:', error);
    res.status(500).json({ error: 'Failed to fetch vendors' });
  }
});

// POST /api/purchase-orders/vendors
router.post('/vendors', requireAuth('manage_purchase_orders'), async (req, res) => {
  try {
    const { name, contact_name, phone, email, address, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'Vendor name is required' });

    const tid = getTenantId();
    const result = await run(`
      INSERT INTO vendors (tenant_id, name, contact_name, phone, email, address, notes, active)
      VALUES ($1, $2, $3, $4, $5, $6, $7, true)
    `, [tid, name, contact_name || null, phone || null, email || null, address || null, notes || null]);

    res.status(201).json({ id: result.lastInsertRowid, name });
  } catch (error) {
    console.error('Error creating vendor:', error);
    res.status(500).json({ error: 'Failed to create vendor' });
  }
});

// PUT /api/purchase-orders/vendors/:id
router.put('/vendors/:id', requireAuth('manage_purchase_orders'), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, contact_name, phone, email, address, notes, active } = req.body;

    const vendor = await get('SELECT * FROM vendors WHERE id = $1', [id]);
    if (!vendor) return res.status(404).json({ error: 'Vendor not found' });

    await run(`
      UPDATE vendors SET name = $1, contact_name = $2, phone = $3, email = $4, address = $5, notes = $6, active = $7
      WHERE id = $8
    `, [
      name ?? vendor.name,
      contact_name ?? vendor.contact_name,
      phone ?? vendor.phone,
      email ?? vendor.email,
      address ?? vendor.address,
      notes ?? vendor.notes,
      active !== undefined ? (active ? true : false) : vendor.active,
      id,
    ]);

    res.json({ id, success: true });
  } catch (error) {
    console.error('Error updating vendor:', error);
    res.status(500).json({ error: 'Failed to update vendor' });
  }
});

// ==================== Purchase Order Lifecycle ====================

async function generatePONumber() {
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0].replace(/-/g, '');
  const existing = await get(`
    SELECT COUNT(*) as count FROM purchase_orders
    WHERE po_number LIKE $1
  `, [`PO-${dateStr}-%`]);
  const seq = (existing?.count || 0) + 1;
  return `PO-${dateStr}-${String(seq).padStart(3, '0')}`;
}

// POST /api/purchase-orders - create PO
router.post('/', requireAuth('manage_purchase_orders'), async (req, res) => {
  try {
    const { vendor_id, items, notes } = req.body;
    if (!vendor_id) return res.status(400).json({ error: 'vendor_id is required' });

    const vendor = await get('SELECT id FROM vendors WHERE id = $1', [vendor_id]);
    if (!vendor) return res.status(404).json({ error: 'Vendor not found' });

    const poNumber = await generatePONumber();
    const employeeId = req.employee?.id || null;

    const tid = getTenantId();
    const result = await run(`
      INSERT INTO purchase_orders (tenant_id, po_number, vendor_id, status, total_amount, notes, created_by)
      VALUES ($1, $2, $3, 'draft', 0, $4, $5)
    `, [tid, poNumber, vendor_id, notes || null, employeeId]);

    const poId = result.lastInsertRowid;
    let totalAmount = 0;

    // Add items if provided
    if (items && items.length > 0) {
      for (const item of items) {
        const lineTotal = (item.quantity_ordered || 0) * (item.unit_cost || 0);
        totalAmount += lineTotal;
        await run(`
          INSERT INTO purchase_order_items (tenant_id, po_id, inventory_item_id, quantity_ordered, unit_cost, line_total)
          VALUES ($1, $2, $3, $4, $5, $6)
        `, [tid, poId, item.inventory_item_id, item.quantity_ordered, item.unit_cost || 0, lineTotal]);
      }
      await run('UPDATE purchase_orders SET total_amount = $1 WHERE id = $2', [totalAmount, poId]);
    }

    res.status(201).json({ id: poId, po_number: poNumber, status: 'draft', total_amount: totalAmount });
  } catch (error) {
    console.error('Error creating purchase order:', error);
    res.status(500).json({ error: 'Failed to create purchase order' });
  }
});

// GET /api/purchase-orders - list POs
router.get('/', async (req, res) => {
  try {
    const { status } = req.query;
    let query = `
      SELECT po.*, v.name as vendor_name, e.name as created_by_name
      FROM purchase_orders po
      JOIN vendors v ON po.vendor_id = v.id
      LEFT JOIN employees e ON po.created_by = e.id
    `;
    const params = [];

    if (status) {
      query += ' WHERE po.status = $1';
      params.push(status);
    }

    query += ' ORDER BY po.created_at DESC';
    const orders = await all(query, params);
    res.json(orders);
  } catch (error) {
    console.error('Error fetching purchase orders:', error);
    res.status(500).json({ error: 'Failed to fetch purchase orders' });
  }
});

// GET /api/purchase-orders/:id - PO detail with items
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const po = await get(`
      SELECT po.*, v.name as vendor_name, e.name as created_by_name
      FROM purchase_orders po
      JOIN vendors v ON po.vendor_id = v.id
      LEFT JOIN employees e ON po.created_by = e.id
      WHERE po.id = $1
    `, [id]);

    if (!po) return res.status(404).json({ error: 'Purchase order not found' });

    const items = await all(`
      SELECT poi.*, ii.name as item_name, ii.unit
      FROM purchase_order_items poi
      JOIN inventory_items ii ON poi.inventory_item_id = ii.id
      WHERE poi.po_id = $1
    `, [id]);

    res.json({ ...po, items });
  } catch (error) {
    console.error('Error fetching purchase order:', error);
    res.status(500).json({ error: 'Failed to fetch purchase order' });
  }
});

// PUT /api/purchase-orders/:id - update draft PO
router.put('/:id', requireAuth('manage_purchase_orders'), async (req, res) => {
  try {
    const { id } = req.params;
    const { vendor_id, items, notes } = req.body;

    const po = await get('SELECT * FROM purchase_orders WHERE id = $1', [id]);
    if (!po) return res.status(404).json({ error: 'Purchase order not found' });
    if (po.status !== 'draft') return res.status(400).json({ error: 'Can only edit draft POs' });

    if (notes !== undefined) {
      await run('UPDATE purchase_orders SET notes = $1 WHERE id = $2', [notes, id]);
    }

    if (items && items.length > 0) {
      // Remove existing items and re-add
      await run('DELETE FROM purchase_order_items WHERE po_id = $1', [id]);

      const tid = getTenantId();
      let totalAmount = 0;
      for (const item of items) {
        const lineTotal = (item.quantity_ordered || 0) * (item.unit_cost || 0);
        totalAmount += lineTotal;
        await run(`
          INSERT INTO purchase_order_items (tenant_id, po_id, inventory_item_id, quantity_ordered, unit_cost, line_total)
          VALUES ($1, $2, $3, $4, $5, $6)
        `, [tid, id, item.inventory_item_id, item.quantity_ordered, item.unit_cost || 0, lineTotal]);
      }
      await run('UPDATE purchase_orders SET total_amount = $1 WHERE id = $2', [totalAmount, id]);
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error updating purchase order:', error);
    res.status(500).json({ error: 'Failed to update purchase order' });
  }
});

// POST /api/purchase-orders/:id/submit
router.post('/:id/submit', requireAuth('manage_purchase_orders'), async (req, res) => {
  try {
    const { id } = req.params;
    const po = await get('SELECT * FROM purchase_orders WHERE id = $1', [id]);
    if (!po) return res.status(404).json({ error: 'Purchase order not found' });
    if (po.status !== 'draft') return res.status(400).json({ error: 'Can only submit draft POs' });

    await run(`UPDATE purchase_orders SET status = 'submitted', submitted_at = NOW() WHERE id = $1`, [id]);
    res.json({ success: true, status: 'submitted' });
  } catch (error) {
    console.error('Error submitting purchase order:', error);
    res.status(500).json({ error: 'Failed to submit purchase order' });
  }
});

// POST /api/purchase-orders/:id/receive - partial/full receive
router.post('/:id/receive', requireAuth('manage_purchase_orders'), async (req, res) => {
  try {
    const { id } = req.params;
    const { items } = req.body;

    const po = await get('SELECT * FROM purchase_orders WHERE id = $1', [id]);
    if (!po) return res.status(404).json({ error: 'Purchase order not found' });
    if (!['submitted', 'partial'].includes(po.status)) {
      return res.status(400).json({ error: 'PO must be submitted or partial to receive' });
    }

    if (!items || items.length === 0) {
      return res.status(400).json({ error: 'Items to receive are required' });
    }

    let allFullyReceived = true;

    for (const receiveItem of items) {
      const poItem = await get(
        'SELECT * FROM purchase_order_items WHERE id = $1 AND po_id = $2',
        [receiveItem.po_item_id, id]
      );
      if (!poItem) continue;

      const newReceived = (poItem.quantity_received || 0) + receiveItem.quantity_received;
      await run('UPDATE purchase_order_items SET quantity_received = $1 WHERE id = $2',
        [newReceived, receiveItem.po_item_id]);

      // Restock inventory
      if (receiveItem.quantity_received > 0) {
        await run('UPDATE inventory_items SET quantity = quantity + $1 WHERE id = $2',
          [receiveItem.quantity_received, poItem.inventory_item_id]);
      }

      if (newReceived < poItem.quantity_ordered) {
        allFullyReceived = false;
      }
    }

    // Check if all items are fully received
    if (!allFullyReceived) {
      const remaining = await all(`
        SELECT * FROM purchase_order_items
        WHERE po_id = $1 AND quantity_received < quantity_ordered
      `, [id]);
      allFullyReceived = remaining.length === 0;
    }

    const newStatus = allFullyReceived ? 'received' : 'partial';
    await run(`UPDATE purchase_orders SET status = $1${allFullyReceived ? ", received_at = NOW()" : ''} WHERE id = $2`,
      [newStatus, id]);

    res.json({ success: true, status: newStatus, fully_received: allFullyReceived });
  } catch (error) {
    console.error('Error receiving purchase order:', error);
    res.status(500).json({ error: 'Failed to receive purchase order' });
  }
});

// POST /api/purchase-orders/:id/cancel
router.post('/:id/cancel', requireAuth('manage_purchase_orders'), async (req, res) => {
  try {
    const { id } = req.params;
    const po = await get('SELECT * FROM purchase_orders WHERE id = $1', [id]);
    if (!po) return res.status(404).json({ error: 'Purchase order not found' });
    if (po.status === 'received' || po.status === 'cancelled') {
      return res.status(400).json({ error: 'Cannot cancel a received or already cancelled PO' });
    }

    await run("UPDATE purchase_orders SET status = 'cancelled' WHERE id = $1", [id]);
    res.json({ success: true, status: 'cancelled' });
  } catch (error) {
    console.error('Error cancelling purchase order:', error);
    res.status(500).json({ error: 'Failed to cancel purchase order' });
  }
});

export default router;
