import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { all, get, run, getTenantId } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
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
    const { category, vendor, description, amount, tax_amount, expense_date, payment_method, notes, receipt_image_url, receipt_data, inventory_matches, payee } = req.body;

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

    const result = await get(
      `INSERT INTO expenses (tenant_id, category, vendor, description, amount, tax_amount, expense_date, payment_method, notes, receipt_image_url, receipt_data, created_by, payee)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING *`,
      [tenantId, category, vendor || null, description || null, amount, tax_amount || 0, expense_date, payment_method || null, notes || null, receipt_image_url || null, finalReceiptData ? JSON.stringify(finalReceiptData) : null, employeeId, payee || null]
    );

    // Process inventory restocks from matches
    if (inventory_matches && Array.isArray(inventory_matches)) {
      for (const match of inventory_matches) {
        if (!match.inventory_item_id || !match.quantity || match.quantity <= 0) continue;

        try {
          const item = await get('SELECT id, quantity FROM inventory_items WHERE id = $1', [match.inventory_item_id]);
          if (!item) continue;

          const quantityBefore = item.quantity;
          const newQuantity = quantityBefore + match.quantity;

          if (match.cost_price !== undefined && match.cost_price !== null) {
            await run('UPDATE inventory_items SET quantity = $1, cost_price = $2 WHERE id = $3',
              [newQuantity, match.cost_price, match.inventory_item_id]);
          } else {
            await run('UPDATE inventory_items SET quantity = $1 WHERE id = $2',
              [newQuantity, match.inventory_item_id]);
          }

          // Fire-and-forget: log restock for AI
          setImmediate(() => logRestockEvent(match.inventory_item_id, quantityBefore, match.quantity));
        } catch (restockErr) {
          console.error(`[Expenses] Restock error for item ${match.inventory_item_id}:`, restockErr.message);
        }
      }
    }

    res.json(result);
  } catch (err) {
    console.error('[Expenses] Create error:', err.message);
    res.status(500).json({ error: 'Failed to create expense' });
  }
});

// PUT /api/expenses/:id — update expense
router.put('/:id', requireAuth('manage_inventory'), async (req, res) => {
  try {
    const { id } = req.params;
    const { category, vendor, description, amount, tax_amount, expense_date, payment_method, notes, receipt_image_url, payee } = req.body;

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

    const result = await get(
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
      [category || null, vendor ?? null, description ?? null, amount || null, tax_amount ?? null, expense_date || null, payment_method ?? null, notes ?? null, receipt_image_url ?? null, payee ?? null, id]
    );

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

// POST /api/expenses/scan-receipt — upload receipt image, AI parse
router.post('/scan-receipt', requireAuth('manage_inventory'), upload.single('receipt'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No receipt image uploaded' });
    }

    const imageUrl = `/uploads/receipts/${req.file.filename}`;

    // Check if Grok API is available
    if (!process.env.XAI_API_KEY) {
      return res.json({
        image_url: imageUrl,
        parsed: null,
        message: 'AI parsing not available — XAI_API_KEY not configured. You can enter details manually.',
      });
    }

    // Read file as base64 for vision API
    const imageBuffer = fs.readFileSync(req.file.path);
    const base64Image = imageBuffer.toString('base64');
    const mimeType = req.file.mimetype || 'image/jpeg';

    const model = (await getConfig('grok_model')) || 'grok-4-1-fast-reasoning';

    const response = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.XAI_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        messages: [
          {
            role: 'system',
            content: `You are a receipt parser for a restaurant expense tracking system. Extract structured data from receipt images.
Return ONLY valid JSON with this schema:
{
  "vendor": "store/vendor name",
  "date": "YYYY-MM-DD",
  "items": [{ "description": "item name", "amount": 123.45 }],
  "subtotal": 0,
  "tax": 0,
  "total": 0,
  "payment_method": "cash" | "card" | "transfer" | null,
  "category": "food_cost" | "supplies" | "utilities" | "rent" | "marketing" | "other"
}
If a field cannot be determined, use null. Amounts should be numbers. Dates in YYYY-MM-DD format.`,
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Parse this receipt and extract the structured data:' },
              {
                type: 'image_url',
                image_url: { url: `data:${mimeType};base64,${base64Image}` },
              },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('[Expenses] Grok vision error:', errText);
      return res.json({
        image_url: imageUrl,
        parsed: null,
        message: 'AI parsing failed. You can enter details manually.',
      });
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';

    // Extract JSON from response
    let parsed = null;
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      }
    } catch {
      console.warn('[Expenses] Failed to parse AI response as JSON');
    }

    res.json({
      image_url: imageUrl,
      parsed,
      message: parsed ? 'Receipt parsed successfully. Please review and confirm.' : 'Could not parse receipt. Please enter details manually.',
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
