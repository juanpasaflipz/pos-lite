import { Router } from 'express';
import { all, adminSql } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { requireOwner } from '../middleware/ownerAuth.js';

const router = Router();

// Non-integrated bank terminals (Inbursa, BBVA, ...): the bank publishes no
// charge API, so DK only REGISTERS the device (name + agreed discount rate).
// The cashier keys the amount into the terminal by hand; the POS button just
// marks the order paid and tags which terminal took it so reports can split
// the sales out and estimate fees. See migration 0108.

function serialize(row) {
  return {
    id: row.id,
    name: row.name,
    fee_percent: Number(row.fee_percent),
    active: !!row.active,
  };
}

// GET /api/external-terminals — list for the POS (active only).
// pos_access: cashiers need the names for the payment modal.
router.get('/', requireAuth('pos_access'), async (_req, res) => {
  try {
    const rows = await all(`
      SELECT id, name, fee_percent, active
      FROM external_terminals
      WHERE active = true
      ORDER BY id ASC
    `);
    res.json({ terminals: rows.map(serialize) });
  } catch (error) {
    console.error('Error listing external terminals:', error);
    res.status(500).json({ error: 'Failed to list external terminals' });
  }
});

// ---- Owner CRUD (Account screen). requireOwner does not run RLS through the
// tenant middleware's employee path, so scope explicitly via adminSql like
// getnet.js does. ----

// GET /api/external-terminals/all — include deactivated, for the settings list
router.get('/all', requireOwner, async (req, res) => {
  try {
    const rows = await adminSql`
      SELECT id, name, fee_percent, active
      FROM external_terminals
      WHERE tenant_id = ${req.owner.tenantId}
      ORDER BY active DESC, id ASC
    `;
    res.json({ terminals: rows.map(serialize) });
  } catch (error) {
    console.error('Error listing external terminals:', error);
    res.status(500).json({ error: 'Failed to list external terminals' });
  }
});

// POST /api/external-terminals — register a terminal
router.post('/', requireOwner, async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    const feePercent = Number(req.body?.fee_percent);
    if (!name || name.length > 40) {
      return res.status(400).json({ error: 'Terminal name is required (max 40 chars)' });
    }
    if (!Number.isFinite(feePercent) || feePercent < 0 || feePercent > 15) {
      return res.status(400).json({ error: 'fee_percent must be between 0 and 15' });
    }
    const rows = await adminSql`
      INSERT INTO external_terminals (tenant_id, name, fee_percent)
      VALUES (${req.owner.tenantId}, ${name}, ${feePercent})
      RETURNING id, name, fee_percent, active
    `;
    res.status(201).json({ terminal: serialize(rows[0]) });
  } catch (error) {
    console.error('Error creating external terminal:', error);
    res.status(500).json({ error: 'Failed to create external terminal' });
  }
});

// PUT /api/external-terminals/:id — rename / adjust rate / (de)activate
router.put('/:id', requireOwner, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });

    const existing = await adminSql`
      SELECT id, name, fee_percent, active FROM external_terminals
      WHERE id = ${id} AND tenant_id = ${req.owner.tenantId}
    `;
    if (!existing[0]) return res.status(404).json({ error: 'Terminal not found' });

    const name = req.body?.name !== undefined ? String(req.body.name).trim() : existing[0].name;
    const feePercent = req.body?.fee_percent !== undefined ? Number(req.body.fee_percent) : Number(existing[0].fee_percent);
    const active = req.body?.active !== undefined ? !!req.body.active : !!existing[0].active;
    if (!name || name.length > 40) {
      return res.status(400).json({ error: 'Terminal name is required (max 40 chars)' });
    }
    if (!Number.isFinite(feePercent) || feePercent < 0 || feePercent > 15) {
      return res.status(400).json({ error: 'fee_percent must be between 0 and 15' });
    }

    const rows = await adminSql`
      UPDATE external_terminals
      SET name = ${name}, fee_percent = ${feePercent}, active = ${active}
      WHERE id = ${id} AND tenant_id = ${req.owner.tenantId}
      RETURNING id, name, fee_percent, active
    `;
    res.json({ terminal: serialize(rows[0]) });
  } catch (error) {
    console.error('Error updating external terminal:', error);
    res.status(500).json({ error: 'Failed to update external terminal' });
  }
});

// DELETE /api/external-terminals/:id — soft-deactivate (history keeps the row)
router.delete('/:id', requireOwner, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
    const rows = await adminSql`
      UPDATE external_terminals SET active = false
      WHERE id = ${id} AND tenant_id = ${req.owner.tenantId}
      RETURNING id
    `;
    if (!rows[0]) return res.status(404).json({ error: 'Terminal not found' });
    res.json({ success: true });
  } catch (error) {
    console.error('Error deactivating external terminal:', error);
    res.status(500).json({ error: 'Failed to deactivate external terminal' });
  }
});

export default router;
