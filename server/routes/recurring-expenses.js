import { Router } from 'express';
import { all, get, run, getTenantId } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

const VALID_CATEGORIES = ['food_cost', 'supplies', 'utilities', 'rent', 'marketing', 'other'];
const VALID_FREQUENCIES = ['weekly', 'biweekly', 'monthly', 'bimonthly', 'quarterly', 'annual'];

// GET /api/recurring-expenses — list rules
router.get('/', requireAuth('view_reports'), async (req, res) => {
  try {
    const activeOnly = req.query.active_only === '1';
    const rows = await all(
      `SELECT re.*, v.name AS vendor_name
       FROM recurring_expenses re
       LEFT JOIN vendors v ON re.vendor_id = v.id
       ${activeOnly ? 'WHERE re.active = true' : ''}
       ORDER BY re.active DESC, re.category ASC, re.label ASC`
    );
    res.json(rows);
  } catch (err) {
    console.error('[RecurringExpenses] List error:', err.message);
    res.status(500).json({ error: 'Failed to fetch recurring expenses' });
  }
});

// POST /api/recurring-expenses — create rule
router.post('/', requireAuth('manage_inventory'), async (req, res) => {
  try {
    const {
      label,
      category,
      vendor_id,
      payee,
      expected_amount,
      variance_threshold_pct,
      frequency,
      last_charged_date,
      next_expected_date,
      notes,
    } = req.body;

    if (!label || !String(label).trim()) {
      return res.status(400).json({ error: 'label is required' });
    }
    if (!category || !VALID_CATEGORIES.includes(category)) {
      return res.status(400).json({ error: `category must be one of: ${VALID_CATEGORIES.join(', ')}` });
    }
    if (!expected_amount || expected_amount <= 0) {
      return res.status(400).json({ error: 'expected_amount must be > 0' });
    }
    const freq = frequency || 'monthly';
    if (!VALID_FREQUENCIES.includes(freq)) {
      return res.status(400).json({ error: `frequency must be one of: ${VALID_FREQUENCIES.join(', ')}` });
    }

    const tenantId = getTenantId();
    const employeeId = req.employee?.id || null;
    const variance = variance_threshold_pct != null ? Number(variance_threshold_pct) : 10;

    const row = await get(
      `INSERT INTO recurring_expenses
         (tenant_id, label, category, vendor_id, payee, expected_amount, variance_threshold_pct,
          frequency, last_charged_date, next_expected_date, notes, created_by, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, true)
       RETURNING *`,
      [
        tenantId,
        String(label).trim(),
        category,
        vendor_id || null,
        payee || null,
        expected_amount,
        variance,
        freq,
        last_charged_date || null,
        next_expected_date || null,
        notes || null,
        employeeId,
      ]
    );

    res.status(201).json(row);
  } catch (err) {
    console.error('[RecurringExpenses] Create error:', err.message);
    res.status(500).json({ error: 'Failed to create recurring expense' });
  }
});

// PUT /api/recurring-expenses/:id — update rule
router.put('/:id', requireAuth('manage_inventory'), async (req, res) => {
  try {
    const { id } = req.params;
    const {
      label,
      category,
      vendor_id,
      payee,
      expected_amount,
      variance_threshold_pct,
      frequency,
      last_charged_date,
      next_expected_date,
      notes,
      active,
    } = req.body;

    const existing = await get('SELECT id FROM recurring_expenses WHERE id = $1', [id]);
    if (!existing) return res.status(404).json({ error: 'Rule not found' });

    if (category && !VALID_CATEGORIES.includes(category)) {
      return res.status(400).json({ error: `invalid category` });
    }
    if (frequency && !VALID_FREQUENCIES.includes(frequency)) {
      return res.status(400).json({ error: `invalid frequency` });
    }

    const row = await get(
      `UPDATE recurring_expenses SET
         label = COALESCE($1, label),
         category = COALESCE($2, category),
         vendor_id = $3,
         payee = $4,
         expected_amount = COALESCE($5, expected_amount),
         variance_threshold_pct = COALESCE($6, variance_threshold_pct),
         frequency = COALESCE($7, frequency),
         last_charged_date = $8,
         next_expected_date = $9,
         notes = $10,
         active = COALESCE($11, active),
         updated_at = NOW()
       WHERE id = $12
       RETURNING *`,
      [
        label ?? null,
        category ?? null,
        vendor_id ?? null,
        payee ?? null,
        expected_amount ?? null,
        variance_threshold_pct ?? null,
        frequency ?? null,
        last_charged_date ?? null,
        next_expected_date ?? null,
        notes ?? null,
        active ?? null,
        id,
      ]
    );

    res.json(row);
  } catch (err) {
    console.error('[RecurringExpenses] Update error:', err.message);
    res.status(500).json({ error: 'Failed to update recurring expense' });
  }
});

// DELETE /api/recurring-expenses/:id
router.delete('/:id', requireAuth('manage_inventory'), async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await get('SELECT id FROM recurring_expenses WHERE id = $1', [id]);
    if (!existing) return res.status(404).json({ error: 'Rule not found' });
    await run('DELETE FROM recurring_expenses WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('[RecurringExpenses] Delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete recurring expense' });
  }
});

/**
 * Find the best matching recurring rule for a new expense and compute variance.
 * Match priority: vendor_id > payee (case-insensitive) > label substring on description.
 * Returns the rule + variance details, or null if no match.
 */
export async function matchAndCheckVariance({ category, vendor_id, payee, description, amount }) {
  if (!category || !amount || amount <= 0) return null;
  try {
    const candidates = await all(
      `SELECT * FROM recurring_expenses
       WHERE active = true AND category = $1`,
      [category]
    );
    if (candidates.length === 0) return null;

    const payeeLower = (payee || '').trim().toLowerCase();
    const descLower = (description || '').trim().toLowerCase();

    // Rank by specificity.
    let match = null;
    let matchScore = 0;
    for (const rule of candidates) {
      let score = 0;
      if (vendor_id && rule.vendor_id && Number(rule.vendor_id) === Number(vendor_id)) score += 100;
      if (payeeLower && rule.payee && rule.payee.trim().toLowerCase() === payeeLower) score += 50;
      if (descLower && rule.label && descLower.includes(rule.label.toLowerCase())) score += 10;
      if (score > matchScore) { match = rule; matchScore = score; }
    }
    if (!match || matchScore === 0) return null;

    const expected = Number(match.expected_amount);
    const variance = Number(match.variance_threshold_pct) || 10;
    if (expected <= 0) return null;

    const deviation_pct = ((Number(amount) - expected) / expected) * 100;
    const flagged = Math.abs(deviation_pct) > variance;

    return {
      rule_id: match.id,
      rule_label: match.label,
      expected_amount: expected,
      variance_threshold_pct: variance,
      actual_amount: Number(amount),
      deviation_pct: Math.round(deviation_pct * 10) / 10,
      flagged,
    };
  } catch (err) {
    console.warn('[RecurringExpenses] variance check skipped:', err.message);
    return null;
  }
}

export default router;
