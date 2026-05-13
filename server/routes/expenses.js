import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { all, get, run, getTenantId } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { detectOverpay } from '../helpers/inventory.js';
import { matchAndCheckVariance } from './recurring-expenses.js';
// AI modules removed in pos-lite
const getConfig = () => ({});
const logRestockEvent = () => {};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const receiptsDir = path.join(__dirname, '../../data/uploads/receipts');

// Ensure receipts directory exists
if (!fs.existsSync(receiptsDir)) fs.mkdirSync(receiptsDir, { recursive: true });

// Multer config: 5MB limit, images only
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, receiptsDir),
  filename: (req, file, cb) => {
    const tenantId = req.tenant?.id || 'default';
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `receipt-${tenantId}-${Date.now()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (_req, file, cb) => {
    const allowed = ['.png', '.jpg', '.jpeg', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only image files (PNG, JPG, WEBP) are allowed'));
    }
  },
});

const router = Router();

const VALID_CATEGORIES = ['food_cost', 'supplies', 'utilities', 'rent', 'marketing', 'other'];
const VALID_PAYMENT_METHODS = ['cash', 'card', 'transfer'];

// GET /api/expenses/suppliers — list active suppliers for expense entry
router.get('/suppliers', requireAuth('view_reports'), async (_req, res) => {
  try {
    const suppliers = await all(
      'SELECT * FROM vendors WHERE active = true ORDER BY name ASC'
    );
    res.json(suppliers);
  } catch (err) {
    console.error('[Expenses] Suppliers list error:', err.message);
    res.status(500).json({ error: 'Failed to fetch suppliers' });
  }
});

// GET /api/expenses/suppliers/search?q=... — typeahead, trigram-ranked
router.get('/suppliers/search', requireAuth('view_reports'), async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const limit = Math.min(Number(req.query.limit) || 10, 25);

    if (!q) {
      const suppliers = await all(
        'SELECT id, name, contact_name, phone FROM vendors WHERE active = true ORDER BY name ASC LIMIT $1',
        [limit]
      );
      return res.json(suppliers);
    }

    let rows;
    try {
      rows = await all(
        `SELECT id, name, contact_name, phone, similarity(name, $1) AS score
         FROM vendors
         WHERE active = true AND (name ILIKE '%' || $1 || '%' OR similarity(name, $1) > 0.2)
         ORDER BY (name ILIKE $1 || '%') DESC, score DESC, name ASC
         LIMIT $2`,
        [q, limit]
      );
    } catch {
      // Fallback if pg_trgm extension not yet applied
      rows = await all(
        `SELECT id, name, contact_name, phone
         FROM vendors
         WHERE active = true AND name ILIKE '%' || $1 || '%'
         ORDER BY (name ILIKE $1 || '%') DESC, name ASC
         LIMIT $2`,
        [q, limit]
      );
    }
    res.json(rows);
  } catch (err) {
    console.error('[Expenses] Supplier search error:', err.message);
    res.status(500).json({ error: 'Failed to search suppliers' });
  }
});

// POST /api/expenses/suppliers/match — fuzzy lookup by name (for "did you mean?")
router.post('/suppliers/match', requireAuth('view_reports'), async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    const threshold = Math.min(Math.max(Number(req.body?.threshold) || 0.5, 0.1), 0.95);

    if (!name) return res.json({ match: null });

    // Exact case-insensitive first
    const exact = await get(
      'SELECT id, name, contact_name, phone FROM vendors WHERE active = true AND LOWER(name) = LOWER($1) LIMIT 1',
      [name]
    );
    if (exact) return res.json({ match: { ...exact, score: 1, exact: true } });

    // Fuzzy with pg_trgm
    try {
      const fuzzy = await get(
        `SELECT id, name, contact_name, phone, similarity(name, $1) AS score
         FROM vendors
         WHERE active = true AND similarity(name, $1) >= $2
         ORDER BY score DESC
         LIMIT 1`,
        [name, threshold]
      );
      return res.json({ match: fuzzy ? { ...fuzzy, exact: false } : null });
    } catch {
      return res.json({ match: null });
    }
  } catch (err) {
    console.error('[Expenses] Supplier match error:', err.message);
    res.status(500).json({ error: 'Failed to match supplier' });
  }
});

// POST /api/expenses/suppliers — create supplier for expense entry
router.post('/suppliers', requireAuth('manage_inventory'), async (req, res) => {
  try {
    const { name, contact_name, phone, email, address, notes } = req.body;

    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'Supplier name is required' });
    }

    const supplierName = String(name).trim();
    const existing = await get(
      'SELECT * FROM vendors WHERE LOWER(name) = LOWER($1) ORDER BY id ASC LIMIT 1',
      [supplierName]
    );

    if (existing) {
      if (!existing.active) {
        const reactivated = await get(
          `UPDATE vendors
           SET active = true,
               contact_name = COALESCE($1, contact_name),
               phone = COALESCE($2, phone),
               email = COALESCE($3, email),
               address = COALESCE($4, address),
               notes = COALESCE($5, notes)
           WHERE id = $6
           RETURNING *`,
          [
            contact_name || null,
            phone || null,
            email || null,
            address || null,
            notes || null,
            existing.id,
          ]
        );
        return res.json(reactivated);
      }
      return res.json(existing);
    }

    const tenantId = getTenantId();
    const result = await get(
      `INSERT INTO vendors (tenant_id, name, contact_name, phone, email, address, notes, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true)
       RETURNING *`,
      [
        tenantId,
        supplierName,
        contact_name || null,
        phone || null,
        email || null,
        address || null,
        notes || null,
      ]
    );

    res.status(201).json(result);
  } catch (err) {
    console.error('[Expenses] Supplier create error:', err.message);
    res.status(500).json({ error: 'Failed to create supplier' });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// Payees — dedupe across history + active employees, trigram-ranked typeahead.
// Payees are stored as TEXT on expenses (no normalized table) so this is a
// derived view, not a CRUD surface.
// ────────────────────────────────────────────────────────────────────────────

function normalizePayee(raw) {
  if (raw == null) return null;
  const trimmed = String(raw).trim().replace(/\s+/g, ' ');
  return trimmed.length > 0 ? trimmed : null;
}

// GET /api/expenses/payees/search?q=&limit=
router.get('/payees/search', requireAuth('view_reports'), async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const limit = Math.min(Number(req.query.limit) || 10, 25);

    // Empty query: most-recent payees first.
    if (!q) {
      const recent = await all(
        `WITH history AS (
           SELECT payee AS name, 'expense_history'::text AS source, MAX(created_at) AS last_used
           FROM expenses
           WHERE payee IS NOT NULL AND length(trim(payee)) > 0
           GROUP BY payee
         ),
         emp AS (
           SELECT name, 'employee'::text AS source, created_at AS last_used
           FROM employees
           WHERE name IS NOT NULL AND length(trim(name)) > 0
         ),
         combined AS (
           SELECT name, source, last_used FROM emp
           UNION ALL
           SELECT h.name, h.source, h.last_used FROM history h
           WHERE NOT EXISTS (SELECT 1 FROM emp e WHERE LOWER(e.name) = LOWER(h.name))
         )
         SELECT name, source FROM combined
         ORDER BY last_used DESC NULLS LAST, name ASC
         LIMIT $1`,
        [limit]
      );
      return res.json(recent);
    }

    let rows;
    try {
      rows = await all(
        `WITH history AS (
           SELECT payee AS name, 'expense_history'::text AS source, MAX(created_at) AS last_used
           FROM expenses
           WHERE payee IS NOT NULL AND length(trim(payee)) > 0
           GROUP BY payee
         ),
         emp AS (
           SELECT name, 'employee'::text AS source, created_at AS last_used
           FROM employees
           WHERE name IS NOT NULL AND length(trim(name)) > 0
         ),
         combined AS (
           SELECT name, source, last_used FROM emp
           UNION ALL
           SELECT h.name, h.source, h.last_used FROM history h
           WHERE NOT EXISTS (SELECT 1 FROM emp e WHERE LOWER(e.name) = LOWER(h.name))
         )
         SELECT name, source, similarity(name, $1) AS score
         FROM combined
         WHERE name ILIKE '%' || $1 || '%' OR similarity(name, $1) > 0.2
         ORDER BY (name ILIKE $1 || '%') DESC, score DESC, last_used DESC NULLS LAST
         LIMIT $2`,
        [q, limit]
      );
    } catch {
      // pg_trgm absent — fall back to plain ILIKE
      rows = await all(
        `WITH history AS (
           SELECT payee AS name, 'expense_history'::text AS source, MAX(created_at) AS last_used
           FROM expenses
           WHERE payee IS NOT NULL AND length(trim(payee)) > 0
           GROUP BY payee
         ),
         emp AS (
           SELECT name, 'employee'::text AS source, created_at AS last_used
           FROM employees
           WHERE name IS NOT NULL AND length(trim(name)) > 0
         ),
         combined AS (
           SELECT name, source, last_used FROM emp
           UNION ALL
           SELECT h.name, h.source, h.last_used FROM history h
           WHERE NOT EXISTS (SELECT 1 FROM emp e WHERE LOWER(e.name) = LOWER(h.name))
         )
         SELECT name, source FROM combined
         WHERE name ILIKE '%' || $1 || '%'
         ORDER BY (name ILIKE $1 || '%') DESC, name ASC
         LIMIT $2`,
        [q, limit]
      );
    }
    res.json(rows);
  } catch (err) {
    console.error('[Expenses] Payee search error:', err.message);
    res.status(500).json({ error: 'Failed to search payees' });
  }
});

// POST /api/expenses/payees/match — fuzzy "did you mean?" check
router.post('/payees/match', requireAuth('view_reports'), async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    const threshold = Math.min(Math.max(Number(req.body?.threshold) || 0.5, 0.1), 0.95);
    if (!name) return res.json({ match: null });

    // Exact case-insensitive first.
    const exact = await get(
      `WITH history AS (
         SELECT payee AS name, 'expense_history'::text AS source
         FROM expenses
         WHERE payee IS NOT NULL AND length(trim(payee)) > 0
         GROUP BY payee
       ),
       emp AS (
         SELECT name, 'employee'::text AS source
         FROM employees
         WHERE name IS NOT NULL AND length(trim(name)) > 0
       ),
       combined AS (
         SELECT name, source FROM emp
         UNION ALL
         SELECT h.name, h.source FROM history h
         WHERE NOT EXISTS (SELECT 1 FROM emp e WHERE LOWER(e.name) = LOWER(h.name))
       )
       SELECT name, source FROM combined WHERE LOWER(name) = LOWER($1) LIMIT 1`,
      [name]
    );
    if (exact) return res.json({ match: { ...exact, score: 1, exact: true } });

    try {
      const fuzzy = await get(
        `WITH history AS (
           SELECT payee AS name, 'expense_history'::text AS source
           FROM expenses
           WHERE payee IS NOT NULL AND length(trim(payee)) > 0
           GROUP BY payee
         ),
         emp AS (
           SELECT name, 'employee'::text AS source
           FROM employees
           WHERE name IS NOT NULL AND length(trim(name)) > 0
         ),
         combined AS (
           SELECT name, source FROM emp
           UNION ALL
           SELECT h.name, h.source FROM history h
           WHERE NOT EXISTS (SELECT 1 FROM emp e WHERE LOWER(e.name) = LOWER(h.name))
         )
         SELECT name, source, similarity(name, $1) AS score
         FROM combined
         WHERE similarity(name, $1) >= $2
         ORDER BY score DESC
         LIMIT 1`,
        [name, threshold]
      );
      return res.json({ match: fuzzy ? { ...fuzzy, exact: false } : null });
    } catch {
      return res.json({ match: null });
    }
  } catch (err) {
    console.error('[Expenses] Payee match error:', err.message);
    res.status(500).json({ error: 'Failed to match payee' });
  }
});

// GET /api/expenses — list expenses with optional date range
router.get('/', requireAuth('view_reports'), async (req, res) => {
  try {
    const { from, to } = req.query;

    let query = 'SELECT e.*, emp.name as created_by_name FROM expenses e LEFT JOIN employees emp ON e.created_by = emp.id';
    const conditions = [];
    const params = [];

    if (from) {
      params.push(from);
      conditions.push(`e.expense_date >= $${params.length}`);
    }
    if (to) {
      params.push(to);
      conditions.push(`e.expense_date <= $${params.length}`);
    }

    if (conditions.length) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY e.expense_date DESC, e.created_at DESC';

    const expenses = await all(query, params);
    res.json(expenses);
  } catch (err) {
    console.error('[Expenses] List error:', err.message);
    res.status(500).json({ error: 'Failed to fetch expenses' });
  }
});

// POST /api/expenses — create expense
router.post('/', requireAuth('manage_inventory'), async (req, res) => {
  try {
    const { category, vendor, vendor_id, description, amount, tax_amount, expense_date, payment_method, notes, receipt_image_url, receipt_data, inventory_matches, payee } = req.body;

    if (!category || !VALID_CATEGORIES.includes(category)) {
      return res.status(400).json({ error: `category must be one of: ${VALID_CATEGORIES.join(', ')}` });
    }
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'amount must be greater than 0' });
    }
    if (!expense_date) {
      return res.status(400).json({ error: 'expense_date is required' });
    }
    if (payment_method && !VALID_PAYMENT_METHODS.includes(payment_method)) {
      return res.status(400).json({ error: `payment_method must be one of: ${VALID_PAYMENT_METHODS.join(', ')}` });
    }

    const tenantId = getTenantId();
    const employeeId = req.employee?.id || null;

    // Store inventory_matches in receipt_data for audit trail
    const finalReceiptData = receipt_data ? { ...receipt_data } : null;
    if (inventory_matches && inventory_matches.length > 0 && finalReceiptData) {
      finalReceiptData.inventory_matches = inventory_matches;
    }

    // Detect whether vendor_id column exists (migration 0040)
    const hasVendorId = await get(
      `SELECT 1 AS ok FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'expenses' AND column_name = 'vendor_id'`
    );

    let result;
    if (hasVendorId) {
      result = await get(
        `INSERT INTO expenses (tenant_id, category, vendor, vendor_id, description, amount, tax_amount, expense_date, payment_method, notes, receipt_image_url, receipt_data, created_by, payee)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         RETURNING *`,
        [tenantId, category, vendor || null, vendor_id || null, description || null, amount, tax_amount || 0, expense_date, payment_method || null, notes || null, receipt_image_url || null, finalReceiptData ? JSON.stringify(finalReceiptData) : null, employeeId, normalizePayee(payee)]
      );
    } else {
      result = await get(
        `INSERT INTO expenses (tenant_id, category, vendor, description, amount, tax_amount, expense_date, payment_method, notes, receipt_image_url, receipt_data, created_by, payee)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         RETURNING *`,
        [tenantId, category, vendor || null, description || null, amount, tax_amount || 0, expense_date, payment_method || null, notes || null, receipt_image_url || null, finalReceiptData ? JSON.stringify(finalReceiptData) : null, employeeId, normalizePayee(payee)]
      );
    }

    // Recurring-expense variance check (rent/utilities/services).
    // Records the match (and any variance) regardless of category — rules
    // self-filter by category, so non-recurring categories simply return null.
    let varianceAlert = null;
    try {
      const matched = await matchAndCheckVariance({
        category,
        vendor_id: vendor_id || null,
        payee: payee || null,
        description: description || null,
        amount,
      });
      if (matched) {
        // Stamp the expense with the matched rule for trend reporting.
        try {
          await run(
            'UPDATE expenses SET recurring_expense_id = $1 WHERE id = $2',
            [matched.rule_id, result.id]
          );
          // Roll the rule's last_charged_date forward so the next bill compares fresh.
          await run(
            'UPDATE recurring_expenses SET last_charged_date = $1, updated_at = NOW() WHERE id = $2',
            [expense_date, matched.rule_id]
          );
        } catch (linkErr) {
          // Column / table may be missing pre-migration 0043; non-fatal.
          console.warn('[Expenses] recurring link skipped:', linkErr.message);
        }
        if (matched.flagged) varianceAlert = matched;
      }
    } catch (varErr) {
      console.warn('[Expenses] variance match failed:', varErr.message);
    }

    // Process inventory restocks from matches.
    // `quantity` is the amount to add in inventory's base unit (frontend computes parsed_qty * pack_size).
    // `cost_price` here is the per-unit cost (frontend computes amount / quantity).
    const overpayAlerts = [];
    if (inventory_matches && Array.isArray(inventory_matches)) {
      for (const match of inventory_matches) {
        if (!match.inventory_item_id || !match.quantity || match.quantity <= 0) continue;

        try {
          const item = await get('SELECT id, quantity, cost_price FROM inventory_items WHERE id = $1', [match.inventory_item_id]);
          if (!item) continue;

          const quantityBefore = Number(item.quantity) || 0;
          const prevCostPrice = item.cost_price == null ? null : Number(item.cost_price);
          const addedQty = Number(match.quantity);
          const newQuantity = quantityBefore + addedQty;
          const incomingUnitCost = (match.cost_price !== undefined && match.cost_price !== null)
            ? Number(match.cost_price)
            : null;

          // Weighted moving average: only update cost when we have a positive incoming
          // unit_cost. If there's no prior stock or no prior cost, the new purchase
          // defines the cost outright.
          let newCostPrice = prevCostPrice;
          if (incomingUnitCost != null && incomingUnitCost > 0) {
            if (quantityBefore <= 0 || prevCostPrice == null || prevCostPrice === 0) {
              newCostPrice = incomingUnitCost;
            } else {
              newCostPrice = (quantityBefore * prevCostPrice + addedQty * incomingUnitCost) / newQuantity;
              // Round to 4dp to avoid drift accumulation across many purchases.
              newCostPrice = Math.round(newCostPrice * 10000) / 10000;
            }
          }

          // Stamp last_restocked_at using the expense_date (the actual purchase
          // date the user entered), not NOW(). Backdated entries — bought weeks
          // ago, logged today — would otherwise reset the stale clock to today
          // and never flag. GREATEST() guards against an old backdated entry
          // pushing the clock backwards past a more recent restock.
          const restockTimestamp = expense_date ? `${expense_date}T00:00:00Z` : new Date().toISOString();
          try {
            if (newCostPrice != null && newCostPrice !== prevCostPrice) {
              await run(
                `UPDATE inventory_items
                 SET quantity = $1,
                     cost_price = $2,
                     last_restocked_at = GREATEST(COALESCE(last_restocked_at, '1970-01-01'::timestamptz), $3::timestamptz)
                 WHERE id = $4`,
                [newQuantity, newCostPrice, restockTimestamp, match.inventory_item_id]
              );
            } else {
              await run(
                `UPDATE inventory_items
                 SET quantity = $1,
                     last_restocked_at = GREATEST(COALESCE(last_restocked_at, '1970-01-01'::timestamptz), $2::timestamptz)
                 WHERE id = $3`,
                [newQuantity, restockTimestamp, match.inventory_item_id]
              );
            }
          } catch (colErr) {
            // last_restocked_at column missing (pre-migration). Retry without it.
            if (newCostPrice != null && newCostPrice !== prevCostPrice) {
              await run('UPDATE inventory_items SET quantity = $1, cost_price = $2 WHERE id = $3',
                [newQuantity, newCostPrice, match.inventory_item_id]);
            } else {
              await run('UPDATE inventory_items SET quantity = $1 WHERE id = $2',
                [newQuantity, match.inventory_item_id]);
            }
          }

          // Overpay detection BEFORE writing new history row so the median
          // reflects prior purchases only.
          if (incomingUnitCost != null && incomingUnitCost > 0) {
            const overpay = await detectOverpay(match.inventory_item_id, incomingUnitCost);
            if (overpay) {
              overpayAlerts.push({
                inventory_item_id: match.inventory_item_id,
                inventory_item_name: match.inventory_item_name || null,
                unit_cost: incomingUnitCost,
                median_cost: overpay.median,
                deviation_pct: overpay.deviation_pct,
                history_count: overpay.history_count,
              });
            }
          }

          // Append to cost history ledger (Phase 2 overpay detection reads from this).
          if (incomingUnitCost != null && incomingUnitCost > 0) {
            try {
              await run(
                `INSERT INTO inventory_cost_history
                   (tenant_id, inventory_item_id, vendor_id, expense_id, quantity_added, unit_cost, prev_cost_price, new_cost_price)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [tenantId, match.inventory_item_id, vendor_id || null, result.id, addedQty, incomingUnitCost, prevCostPrice, newCostPrice]
              );
            } catch (histErr) {
              // Table may not exist yet on a stale schema; non-fatal.
              console.warn('[Expenses] cost history insert skipped:', histErr.message);
            }
          }

          // Normalized expense_items row (audit trail + recipe cost queries).
          try {
            await run(
              `INSERT INTO expense_items
                 (tenant_id, expense_id, inventory_item_id, quantity, unit_cost, line_total, raw_description)
               VALUES ($1, $2, $3, $4, $5, $6, $7)`,
              [
                tenantId,
                result.id,
                match.inventory_item_id,
                addedQty,
                incomingUnitCost ?? 0,
                incomingUnitCost != null ? (addedQty * incomingUnitCost).toFixed(2) : 0,
                match.raw_description || null,
              ]
            );
          } catch (itemErr) {
            console.warn('[Expenses] expense_items insert skipped:', itemErr.message);
          }

          // Remember this vendor↔item mapping so next receipt auto-suggests
          if (vendor_id && match.raw_description) {
            try {
              await run(
                `INSERT INTO vendor_items (tenant_id, vendor_id, inventory_item_id, vendor_sku, unit_cost, last_seen_description, last_used_at)
                 VALUES ($1, $2, $3, NULL, $4, $5, NOW())
                 ON CONFLICT (vendor_id, inventory_item_id) DO UPDATE
                   SET unit_cost = COALESCE(EXCLUDED.unit_cost, vendor_items.unit_cost),
                       last_seen_description = EXCLUDED.last_seen_description,
                       last_used_at = NOW()`,
                [tenantId, vendor_id, match.inventory_item_id, incomingUnitCost ?? 0, match.raw_description]
              );
            } catch (mapErr) {
              // last_seen_description / last_used_at may not yet exist on older schema
              console.warn('[Expenses] vendor_items upsert skipped:', mapErr.message);
            }
          }

          // Fire-and-forget: log restock for AI
          setImmediate(() => logRestockEvent(match.inventory_item_id, quantityBefore, addedQty));
        } catch (restockErr) {
          console.error(`[Expenses] Restock error for item ${match.inventory_item_id}:`, restockErr.message);
        }
      }
    }

    res.json({
      ...result,
      overpay_alerts: overpayAlerts,
      variance_alert: varianceAlert,
    });
  } catch (err) {
    console.error('[Expenses] Create error:', err.message);
    res.status(500).json({ error: 'Failed to create expense' });
  }
});

// PUT /api/expenses/:id — update expense
router.put('/:id', requireAuth('manage_inventory'), async (req, res) => {
  try {
    const { id } = req.params;
    const { category, vendor, vendor_id, description, amount, tax_amount, expense_date, payment_method, notes, receipt_image_url, payee } = req.body;

    const existing = await get('SELECT id FROM expenses WHERE id = $1', [id]);
    if (!existing) {
      return res.status(404).json({ error: 'Expense not found' });
    }

    if (category && !VALID_CATEGORIES.includes(category)) {
      return res.status(400).json({ error: `category must be one of: ${VALID_CATEGORIES.join(', ')}` });
    }
    if (payment_method && !VALID_PAYMENT_METHODS.includes(payment_method)) {
      return res.status(400).json({ error: `payment_method must be one of: ${VALID_PAYMENT_METHODS.join(', ')}` });
    }

    const hasVendorId = await get(
      `SELECT 1 AS ok FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'expenses' AND column_name = 'vendor_id'`
    );

    let result;
    if (hasVendorId) {
      result = await get(
        `UPDATE expenses SET
          category = COALESCE($1, category),
          vendor = $2,
          vendor_id = $3,
          description = $4,
          amount = COALESCE($5, amount),
          tax_amount = COALESCE($6, tax_amount),
          expense_date = COALESCE($7, expense_date),
          payment_method = $8,
          notes = $9,
          receipt_image_url = COALESCE($10, receipt_image_url),
          payee = $11,
          updated_at = NOW()
        WHERE id = $12
        RETURNING *`,
        [category || null, vendor ?? null, vendor_id ?? null, description ?? null, amount || null, tax_amount ?? null, expense_date || null, payment_method ?? null, notes ?? null, receipt_image_url ?? null, payee === undefined ? null : normalizePayee(payee), id]
      );
    } else {
      result = await get(
        `UPDATE expenses SET
          category = COALESCE($1, category),
          vendor = $2,
          description = $3,
          amount = COALESCE($4, amount),
          tax_amount = COALESCE($5, tax_amount),
          expense_date = COALESCE($6, expense_date),
          payment_method = $7,
          notes = $8,
          receipt_image_url = COALESCE($9, receipt_image_url),
          payee = $10,
          updated_at = NOW()
        WHERE id = $11
        RETURNING *`,
        [category || null, vendor ?? null, description ?? null, amount || null, tax_amount ?? null, expense_date || null, payment_method ?? null, notes ?? null, receipt_image_url ?? null, payee === undefined ? null : normalizePayee(payee), id]
      );
    }

    res.json(result);
  } catch (err) {
    console.error('[Expenses] Update error:', err.message);
    res.status(500).json({ error: 'Failed to update expense' });
  }
});

// POST /api/expenses/upload-receipt — upload receipt image only (no AI parse)
router.post('/upload-receipt', requireAuth('manage_inventory'), upload.single('receipt'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No receipt image uploaded' });
    }
    const imageUrl = `/uploads/receipts/${req.file.filename}`;
    res.json({ image_url: imageUrl });
  } catch (err) {
    console.error('[Expenses] Upload error:', err.message);
    res.status(500).json({ error: 'Failed to upload receipt' });
  }
});

// DELETE /api/expenses/:id — delete expense
router.delete('/:id', requireAuth('manage_inventory'), async (req, res) => {
  try {
    const { id } = req.params;

    const existing = await get('SELECT id FROM expenses WHERE id = $1', [id]);
    if (!existing) {
      return res.status(404).json({ error: 'Expense not found' });
    }

    await run('DELETE FROM expenses WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('[Expenses] Delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete expense' });
  }
});

// POST /api/expenses/scan-receipt — upload receipt image, Claude vision parse
const RECEIPT_PARSER_PROMPT = `You parse purchase receipts for a restaurant inventory + expense system. Extract structured line-item data so the system can deduct cost AND restock inventory.

Return ONLY valid JSON, no prose, with this exact schema:
{
  "vendor": "string — store / supplier name as printed (e.g. \\"COSTCO WHOLESALE\\", \\"Central de Abastos - Bodega 14\\")",
  "date": "YYYY-MM-DD or null",
  "items": [
    {
      "description": "item name as printed",
      "quantity": number,        // packs/units purchased (e.g. 2 for "2 x")
      "unit": "kg" | "g" | "L" | "ml" | "pcs" | "box" | "case" | null,  // canonical unit, lowercase
      "pack_size": number | null,  // size of one pack in 'unit' (e.g. 5 for "5kg sack", 24 for "24-can case")
      "unit_price": number | null, // price per pack as printed
      "amount": number             // line total (quantity * unit_price)
    }
  ],
  "subtotal": number | null,
  "tax": number | null,
  "total": number,
  "payment_method": "cash" | "card" | "transfer" | null,
  "category": "food_cost" | "supplies" | "utilities" | "rent" | "marketing" | "other"
}

Rules:
- Numbers must be JSON numbers, not strings. No currency symbols, no thousands separators.
- For weights: prefer kg/L. Convert grams→kg only when the line clearly shows kg (e.g. "1.250 KG").
- "pack_size" is the content of ONE pack. Example: "ACEITE CAPULLO 1L x 2" → quantity=2, unit="L", pack_size=1. "HARINA 5KG" → quantity=1, unit="kg", pack_size=5.
- If a line is a single piece (eggs, fruit by count), use unit="pcs" and pack_size=1.
- If unit/pack_size genuinely can't be determined, use null — do NOT guess.
- "category" should be "food_cost" for groceries/produce/meat/beverage suppliers; "supplies" for cleaning, paper, kitchen tools; else best fit.
- Skip non-purchase lines (subtotal/tax/total/change/loyalty discount) from "items".`;

router.post('/scan-receipt', requireAuth('manage_inventory'), upload.single('receipt'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No receipt image uploaded' });
    }

    const imageUrl = `/uploads/receipts/${req.file.filename}`;

    if (!process.env.ANTHROPIC_API_KEY) {
      return res.json({
        image_url: imageUrl,
        parsed: null,
        message: 'AI parsing not available — ANTHROPIC_API_KEY not configured. You can enter details manually.',
      });
    }

    const imageBuffer = fs.readFileSync(req.file.path);
    const base64Image = imageBuffer.toString('base64');
    let mediaType = req.file.mimetype || 'image/jpeg';
    // Anthropic vision accepts: image/jpeg, image/png, image/gif, image/webp
    if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mediaType)) {
      mediaType = 'image/jpeg';
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2048,
        system: RECEIPT_PARSER_PROMPT,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: mediaType, data: base64Image },
              },
              { type: 'text', text: 'Parse this receipt.' },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('[Expenses] Claude vision error:', response.status, errText);
      return res.json({
        image_url: imageUrl,
        parsed: null,
        message: 'AI parsing failed. You can enter details manually.',
      });
    }

    const data = await response.json();
    const content = data.content?.[0]?.text || '';

    let parsed = null;
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      }
    } catch {
      console.warn('[Expenses] Failed to parse Claude response as JSON');
    }

    // Server-side vendor fuzzy match — let the client know if we recognized the vendor
    let vendorMatch = null;
    if (parsed?.vendor && typeof parsed.vendor === 'string') {
      try {
        vendorMatch = await get(
          `SELECT id, name, similarity(name, $1) AS score
           FROM vendors
           WHERE active = true AND similarity(name, $1) > 0.4
           ORDER BY score DESC
           LIMIT 1`,
          [parsed.vendor.trim()]
        );
      } catch (matchErr) {
        // pg_trgm not available — non-fatal
        console.warn('[Expenses] Vendor fuzzy match skipped:', matchErr.message);
      }
    }

    res.json({
      image_url: imageUrl,
      parsed,
      vendor_match: vendorMatch,
      message: parsed
        ? 'Receipt parsed successfully. Please review and confirm.'
        : 'Could not parse receipt. Please enter details manually.',
    });
  } catch (err) {
    console.error('[Expenses] Scan error:', err.message);
    res.status(500).json({ error: 'Failed to process receipt' });
  }
});

// GET /api/expenses/export — CSV export with date range
router.get('/export', requireAuth('view_reports'), async (req, res) => {
  try {
    const { from, to } = req.query;

    let query = 'SELECT * FROM expenses';
    const conditions = [];
    const params = [];

    if (from) {
      params.push(from);
      conditions.push(`expense_date >= $${params.length}`);
    }
    if (to) {
      params.push(to);
      conditions.push(`expense_date <= $${params.length}`);
    }

    if (conditions.length) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY expense_date ASC';

    const expenses = await all(query, params);

    // Build CSV
    const headers = ['Date', 'Category', 'Vendor', 'Description', 'Amount', 'Tax', 'Total', 'Payment Method', 'Payee', 'Notes'];
    const rows = expenses.map(e => [
      e.expense_date?.toISOString?.().slice(0, 10) || e.expense_date,
      e.category,
      csvEscape(e.vendor || ''),
      csvEscape(e.description || ''),
      e.amount,
      e.tax_amount || 0,
      (Number(e.amount) + Number(e.tax_amount || 0)).toFixed(2),
      e.payment_method || '',
      csvEscape(e.payee || ''),
      csvEscape(e.notes || ''),
    ]);

    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="expenses-${from || 'all'}-${to || 'all'}.csv"`);
    res.send(csv);
  } catch (err) {
    console.error('[Expenses] Export error:', err.message);
    res.status(500).json({ error: 'Failed to export expenses' });
  }
});

function csvEscape(str) {
  if (!str) return '';
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export default router;
