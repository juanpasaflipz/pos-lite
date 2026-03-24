import { Router } from 'express';
import { all, get, run, getConn, getTenantId } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

const VALID_REASONS = ['spoilage', 'prep_error', 'dropped', 'expired', 'other'];

// POST /api/waste - log a waste event
router.post('/', requireAuth('manage_inventory'), async (req, res) => {
  try {
    const { inventory_item_id, quantity, reason, notes } = req.body;

    if (!inventory_item_id) {
      return res.status(400).json({ error: 'inventory_item_id is required' });
    }
    if (!quantity || quantity <= 0) {
      return res.status(400).json({ error: 'quantity must be greater than 0' });
    }
    if (!reason || !VALID_REASONS.includes(reason)) {
      return res.status(400).json({ error: `reason must be one of: ${VALID_REASONS.join(', ')}` });
    }

    const item = await get(
      'SELECT id, name, quantity, unit, cost_price FROM inventory_items WHERE id = $1',
      [inventory_item_id]
    );
    if (!item) {
      return res.status(404).json({ error: 'Inventory item not found' });
    }

    const costAtTime = Math.round((item.cost_price || 0) * quantity * 100) / 100;
    const employeeId = req.employee?.id || null;

    // Atomic: insert waste_log + deduct inventory in same connection
    const conn = getConn();
    const wasteId = await new Promise(async (resolve, reject) => {
      try {
        // Insert waste log
        const tid = getTenantId();
        const result = await run(`
          INSERT INTO waste_log (tenant_id, inventory_item_id, quantity, unit, reason, cost_at_time, notes, logged_by)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          RETURNING id
        `, [tid, inventory_item_id, quantity, item.unit, reason, costAtTime, notes || null, employeeId]);

        // Deduct from inventory (floor at 0)
        const newQty = Math.max(0, item.quantity - quantity);
        await run('UPDATE inventory_items SET quantity = $1 WHERE id = $2', [newQty, inventory_item_id]);

        resolve(result.lastInsertRowid);
      } catch (err) {
        reject(err);
      }
    });

    res.json({
      id: wasteId,
      inventory_item_id,
      item_name: item.name,
      quantity,
      unit: item.unit,
      reason,
      cost_at_time: costAtTime,
      notes: notes || null,
      logged_by: employeeId,
    });
  } catch (error) {
    console.error('Error logging waste:', error);
    res.status(500).json({ error: 'Failed to log waste' });
  }
});

// GET /api/waste - list waste log entries
router.get('/', async (req, res) => {
  try {
    const { start_date, end_date, item_id } = req.query;
    let query = `
      SELECT wl.*, ii.name as item_name, e.name as logged_by_name
      FROM waste_log wl
      JOIN inventory_items ii ON wl.inventory_item_id = ii.id
      LEFT JOIN employees e ON wl.logged_by = e.id
      WHERE 1=1
    `;
    const params = [];
    let paramIdx = 1;

    if (start_date) {
      query += ` AND wl.created_at::date >= $${paramIdx++}`;
      params.push(start_date);
    } else {
      // Default: last 30 days
      query += ` AND wl.created_at >= NOW() - INTERVAL '30 days'`;
    }
    if (end_date) {
      query += ` AND wl.created_at::date <= $${paramIdx++}`;
      params.push(end_date);
    }
    if (item_id) {
      query += ` AND wl.inventory_item_id = $${paramIdx++}`;
      params.push(item_id);
    }

    query += ' ORDER BY wl.created_at DESC LIMIT 200';

    const entries = await all(query, params);
    res.json(entries);
  } catch (error) {
    console.error('Error fetching waste log:', error);
    res.status(500).json({ error: 'Failed to fetch waste log' });
  }
});

// GET /api/waste/report - waste report with summary, by-item, and daily trend
router.get('/report', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;

    let dateFilter = '';
    const params = [];
    let paramIdx = 1;

    if (start_date) {
      dateFilter += ` AND wl.created_at::date >= $${paramIdx++}`;
      params.push(start_date);
    } else {
      dateFilter += ` AND wl.created_at >= NOW() - INTERVAL '30 days'`;
    }
    if (end_date) {
      dateFilter += ` AND wl.created_at::date <= $${paramIdx++}`;
      params.push(end_date);
    }

    // Summary
    const summaryRow = await get(`
      SELECT
        COALESCE(SUM(wl.cost_at_time), 0) as total_waste_cost,
        COUNT(*) as total_entries
      FROM waste_log wl
      WHERE 1=1 ${dateFilter}
    `, params);

    // By reason
    const byReasonRows = await all(`
      SELECT
        wl.reason,
        COUNT(*) as count,
        COALESCE(SUM(wl.cost_at_time), 0) as cost
      FROM waste_log wl
      WHERE 1=1 ${dateFilter}
      GROUP BY wl.reason
    `, params);

    const byReason = {};
    for (const r of byReasonRows) {
      byReason[r.reason] = { count: Number(r.count), cost: Number(r.cost) };
    }

    // By item (top 20)
    const byItem = await all(`
      SELECT
        wl.inventory_item_id,
        ii.name,
        ii.unit,
        SUM(wl.quantity) as total_quantity,
        COALESCE(SUM(wl.cost_at_time), 0) as total_cost,
        COUNT(*) as entry_count,
        MODE() WITHIN GROUP (ORDER BY wl.reason) as top_reason
      FROM waste_log wl
      JOIN inventory_items ii ON wl.inventory_item_id = ii.id
      WHERE 1=1 ${dateFilter}
      GROUP BY wl.inventory_item_id, ii.name, ii.unit
      ORDER BY total_cost DESC
      LIMIT 20
    `, params);

    // Daily trend
    const dailyTrend = await all(`
      SELECT
        wl.created_at::date as date,
        COALESCE(SUM(wl.cost_at_time), 0) as total_cost,
        COUNT(*) as entry_count
      FROM waste_log wl
      WHERE 1=1 ${dateFilter}
      GROUP BY wl.created_at::date
      ORDER BY date ASC
    `, params);

    res.json({
      summary: {
        total_waste_cost: Number(summaryRow?.total_waste_cost || 0),
        total_entries: Number(summaryRow?.total_entries || 0),
        by_reason: byReason,
      },
      by_item: byItem.map(r => ({
        ...r,
        total_quantity: Number(r.total_quantity),
        total_cost: Number(r.total_cost),
        entry_count: Number(r.entry_count),
      })),
      daily_trend: dailyTrend.map(r => ({
        date: r.date,
        total_cost: Number(r.total_cost),
        entry_count: Number(r.entry_count),
      })),
    });
  } catch (error) {
    console.error('Error fetching waste report:', error);
    res.status(500).json({ error: 'Failed to fetch waste report' });
  }
});

export default router;
