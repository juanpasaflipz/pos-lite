// Photo → inventory, from the POS itself.
//
// This is the WhatsApp voice-ops photo path (helpers/inboundVoiceOps.js) with
// the transport removed. WhatsApp only ever supplied two things: the image
// bytes and which employee sent them. In the POS we already have both — the
// file input gives us the bytes and the employee JWT identifies the person far
// more reliably than a phone-number lookup — so the same engine runs with no
// Meta app, no WABA approval, and no per-employee phone registration.
//
// Shared with the WhatsApp path, unchanged:
//   parseReceiptImage()   classify-first vision call (receipt OR shelf count)
//   enrichItemBindings()  fuzzy-match anything the model left unbound
//   executeIntent()       the writes (expense + restock, or count + variance)
//
// Deliberately NOT shared: the SI/NO chat handshake. A screen can show the
// parsed lines in a table and let the operator fix a quantity or drop a line
// before committing, which is the one thing a chat confirmation cannot do.
//
// Drafts live in `voice_intents` with source='pos_scan' so the owner gets ONE
// audit trail regardless of how the photo arrived. twilio_message_sid stays
// NULL (the UNIQUE index permits many NULLs).
//
// Overlap note: POST /api/expenses/scan-receipt already handles receipt →
// expense on this same screen. It uses a different, expense-shaped prompt and
// its own inventory-match step. This route exists for the intent that has no
// in-app equivalent — count_inventory — and handles record_purchase only
// because the vision prompt classifies both and refusing one would mean asking
// the operator to know which button to press before taking the photo.

import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { all, get, run, getTenantId } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { getPlanLimits, planUpgradeError } from '../planLimits.js';
import { audit } from '../lib/auditLog.js';
import { parseReceiptImage, persistReceiptBuffer } from '../helpers/receiptVision.js';
import {
  enrichItemBindings,
  executeIntent,
  buildSuccessMessage,
} from '../helpers/voiceIntent.js';

// Memory storage, not disk: the buffer goes straight to the vision call, and
// persistReceiptBuffer() writes the copy we actually keep. A disk-storage
// multer would leave an orphan file behind every time parsing failed.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['.png', '.jpg', '.jpeg', '.webp'];
    const ext = path.extname(file.originalname || '').toLowerCase();
    // Phone cameras sometimes post a blob with no filename — trust the
    // mimetype in that case rather than rejecting a valid capture.
    if (allowed.includes(ext) || /^image\/(png|jpe?g|webp)$/.test(file.mimetype || '')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files (PNG, JPG, WEBP) are allowed'));
    }
  },
});

const router = Router();

// A draft older than this is stale — prices move, shelves get restocked, and
// committing an hour-old count would overwrite whatever happened since.
const DRAFT_TTL_MIN = 60;

// Every scan is a paid Claude vision call, so this route is gated the same way
// /api/ai/* is (routes/ai.js). Without it a free-plan tenant would get vision
// spend here that the rest of the platform refuses them.
function requireAiPlan(req, res, next) {
  const plan = req.tenant?.plan || 'free';
  if (getPlanLimits(plan).ai.mode === 'none') {
    // Explicit requiredPlan for the same reason ai.js states: getRequiredPlan()
    // reads mode:'none' as an unlocked value and would report 'free'.
    return res.status(403).json(planUpgradeError('ai', plan, { requiredPlan: 'pro' }));
  }
  next();
}

// Ceiling on vision spend per employee. A scan costs roughly $0.014 (Haiku
// 4.5: ~10k input + ~800 output tokens), so this caps one employee at about
// $0.42/hour — high enough that no honest count-and-restock session hits it,
// low enough that a stuck retry loop or a bored employee can't run up a bill.
// Keyed by employee, not IP: a whole restaurant shares one NAT address.
const scanLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  keyGenerator: (req) =>
    `inv-scan:${req.employee?.id || ipKeyGenerator(req.ip)}:${req.tenant?.id || 'unknown'}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'scan_rate_limited' },
});

/**
 * Committing a count and committing a purchase are different acts.
 *
 * A count writes stock levels — that's the line cook's job, and gating it
 * behind manage_inventory is what kept this feature away from the people who
 * actually stand in front of the shelf. A purchase books an expense AND
 * restocks (executePurchase), so it moves money and stays privileged.
 *
 * Mirrors the check inside requireAuth() rather than reusing it, because the
 * required permission isn't known until the stored draft is read.
 */
async function canCommitIntent(employee, intent) {
  const permission = intent === 'record_purchase' ? 'manage_inventory' : 'scan_inventory';
  const perm = await get(
    'SELECT granted FROM role_permissions WHERE role = $1 AND permission = $2',
    [employee.role, permission]
  );
  return { allowed: Boolean(perm?.granted), permission };
}

/**
 * Shape a parsed intent for the review screen. The client renders exactly what
 * it gets here; it never re-derives item state, so `_will_create` /
 * `_unmatched` are surfaced explicitly rather than left for the UI to infer.
 */
function toDraft(parsed) {
  const items = Array.isArray(parsed.items) ? parsed.items : [];
  return {
    intent: parsed.intent,
    confidence: parsed.confidence ?? null,
    clarifying_question: parsed.clarifying_question || null,
    vendor: parsed.vendor || null,
    total_amount: parsed.total_amount ?? null,
    payment_method: parsed.payment_method || null,
    note: parsed.note || null,
    receipt_image_url: parsed.receipt_image_url || null,
    items: items.map((it, index) => ({
      index,
      inventory_item_id: it.inventory_item_id ?? null,
      raw_name: it.raw_name || '',
      quantity: it.quantity ?? null,
      unit: it.unit || null,
      pack_size: it.pack_size ?? null,
      line_total: it.line_total ?? null,
      // true = no inventory row exists yet; committing creates one.
      will_create: Boolean(it._will_create),
      // true = we could not bind it and will not create it (counts only);
      // the line is dropped on commit unless the operator promotes it.
      unmatched: Boolean(it._unmatched),
      fuzzy_matched: Boolean(it._fuzzy_matched),
    })),
  };
}

// POST /api/inventory-scan — photo in, draft out. Nothing is written to
// inventory here; the operator still has to confirm.
// Drafting writes nothing to inventory, so anyone with scan_inventory may
// shoot a photo — the privilege check happens at commit, where the write lands.
router.post(
  '/',
  requireAuth('scan_inventory'),
  requireAiPlan,
  scanLimiter,
  (req, res, next) => {
    upload.single('photo')(req, res, (err) => {
      if (!err) return next();
      const msg = err.message || 'Upload failed';
      if (err instanceof multer.MulterError || /image files/i.test(msg)) {
        return res.status(400).json({ error: msg });
      }
      return next(err);
    });
  },
  async (req, res) => {
    try {
      if (!req.file?.buffer?.length) {
        return res.status(400).json({ error: 'No photo uploaded' });
      }
      const employeeId = req.employee?.id;
      if (!employeeId) {
        return res.status(401).json({ error: 'Employee context required' });
      }

      const caption = String(req.body?.caption || '').trim() || null;
      const contentType = req.file.mimetype || 'image/jpeg';

      // Already inside the tenant middleware's transaction, so the inventory
      // SELECT inside parseReceiptImage is RLS-scoped without withTenant().
      let parsed;
      try {
        parsed = await parseReceiptImage(req.file.buffer, contentType, caption);
      } catch (err) {
        console.error('[InventoryScan] vision failed:', err.message);
        return res.status(502).json({ error: 'vision_failed' });
      }

      if (!parsed || parsed.intent === 'unknown') {
        // Not a receipt and not a countable shelf. Nothing to draft — return
        // the model's own Spanish question so the operator can retake it.
        return res.status(200).json({
          id: null,
          draft: toDraft(parsed || { intent: 'unknown', items: [] }),
        });
      }

      // Persist the photo before drafting: the expense row created on confirm
      // links to this URL, and a draft that referenced a buffer we threw away
      // would lose its evidence. Non-fatal — the draft is still usable.
      try {
        parsed.receipt_image_url = await persistReceiptBuffer(req.file.buffer, contentType);
      } catch (err) {
        console.warn('[InventoryScan] persist failed (non-fatal):', err.message);
      }

      try {
        await enrichItemBindings(parsed);
      } catch (err) {
        console.warn('[InventoryScan] enrich failed (non-fatal):', err.message);
      }

      const tid = getTenantId();
      const row = await run(
        `INSERT INTO voice_intents
           (tenant_id, employee_id, source, raw_body, media_url, media_content_type,
            transcript, parsed_json, draft_action, status)
         VALUES ($1, $2, 'pos_scan', $3, $4, $5, $6, $7, $8, 'pending_confirm')`,
        [
          tid,
          employeeId,
          caption,
          parsed.receipt_image_url || null,
          contentType,
          caption || '[photo]',
          JSON.stringify(parsed),
          parsed.intent,
        ]
      );

      res.status(201).json({ id: row.lastInsertRowid, draft: toDraft(parsed) });
    } catch (error) {
      console.error('Error scanning inventory photo:', error);
      res.status(500).json({ error: 'Failed to scan photo' });
    }
  }
);

/**
 * Apply the operator's edits to a stored draft.
 *
 * ONLY scalars the review screen can legitimately change: quantity, line_total,
 * whether a line is included, and promoting an unmatched count line into a new
 * SKU. Everything identifying — inventory_item_id above all — is read from the
 * stored draft, never from the request. A client that could name an arbitrary
 * inventory_item_id could restock or zero out any row in the tenant by id.
 */
export function applyOverrides(parsed, overrides) {
  if (!Array.isArray(overrides) || overrides.length === 0) return parsed;
  const items = Array.isArray(parsed.items) ? parsed.items : [];
  const byIndex = new Map();
  for (const o of overrides) {
    const i = Number(o?.index);
    if (Number.isInteger(i) && i >= 0 && i < items.length) byIndex.set(i, o);
  }

  const kept = [];
  items.forEach((it, i) => {
    const o = byIndex.get(i);
    if (o && o.include === false) return; // dropped by the operator

    if (o && o.quantity != null) {
      const q = Number(o.quantity);
      // A negative count is meaningless and a NaN would silently become a
      // skipped line inside executeCount — reject rather than guess.
      if (Number.isFinite(q) && q >= 0) it.quantity = q;
    }
    if (o && o.line_total != null) {
      const amt = Number(o.line_total);
      if (Number.isFinite(amt) && amt >= 0) it.line_total = amt;
    }
    // Promote an unbound count line to a new SKU — the in-app equivalent of
    // replying AGREGAR on WhatsApp.
    if (o && o.create === true && !it.inventory_item_id) {
      it._will_create = true;
      delete it._unmatched;
    }
    kept.push(it);
  });

  parsed.items = kept;
  return parsed;
}

async function loadPendingDraft(id, employeeId) {
  const row = await get(
    `SELECT id, employee_id, parsed_json, status, created_at
     FROM voice_intents
     WHERE id = $1 AND source = 'pos_scan'`,
    [id]
  );
  if (!row) return { error: 'not_found' };
  // RLS already scopes to the tenant; this scopes to the person. One cashier
  // committing another's half-reviewed count would be untraceable otherwise.
  if (Number(row.employee_id) !== Number(employeeId)) return { error: 'not_found' };
  if (row.status !== 'pending_confirm') return { error: 'already_resolved', status: row.status };
  const ageMin = (Date.now() - new Date(row.created_at).getTime()) / 60000;
  if (ageMin > DRAFT_TTL_MIN) return { error: 'expired' };
  return { row };
}

// POST /api/inventory-scan/:id/confirm — commit the draft.
router.post('/:id/confirm', requireAuth('scan_inventory'), async (req, res) => {
  try {
    const employeeId = req.employee?.id;
    if (!employeeId) return res.status(401).json({ error: 'Employee context required' });

    const { row, error, status } = await loadPendingDraft(req.params.id, employeeId);
    if (error === 'not_found') return res.status(404).json({ error: 'Draft not found' });
    if (error === 'already_resolved') return res.status(409).json({ error: 'Draft already resolved', status });
    if (error === 'expired') {
      await run(`UPDATE voice_intents SET status = 'expired' WHERE id = $1`, [req.params.id]);
      return res.status(410).json({ error: 'Draft expired' });
    }

    // parsed_json is JSONB, but postgres.js + unsafe() round-trips it as a
    // JSON string. Parse defensively — same guard the WhatsApp path uses.
    let parsed = row.parsed_json;
    if (typeof parsed === 'string') parsed = JSON.parse(parsed);

    // Read the intent from the STORED draft, never the request — otherwise a
    // cook could relabel a purchase as a count and book an expense.
    const { allowed, permission } = await canCommitIntent(req.employee, parsed.intent);
    if (!allowed) {
      return res.status(403).json({
        error: `Permission denied: ${permission} is not granted for role ${req.employee.role}`,
        permission,
        intent: parsed.intent,
      });
    }

    parsed = applyOverrides(parsed, req.body?.items);

    if (!Array.isArray(parsed.items) || parsed.items.length === 0) {
      return res.status(400).json({ error: 'No items to save' });
    }

    let result;
    try {
      result = await executeIntent(parsed, employeeId);
    } catch (err) {
      console.error('[InventoryScan] execute failed:', err.message);
      await run(
        `UPDATE voice_intents SET status = 'failed', failure_reason = $1 WHERE id = $2`,
        [err.message?.slice(0, 500) || 'unknown', row.id]
      );
      return res.status(500).json({ error: 'Failed to save', detail: err.message });
    }

    await run(
      `UPDATE voice_intents
       SET status = 'confirmed', confirmed_at = NOW(), parsed_json = $1,
           executed_resource_type = $2, executed_resource_id = $3
       WHERE id = $4`,
      [JSON.stringify(parsed), result.resource_type, result.resource_ids?.[0] || null, row.id]
    );

    audit({
      tenantId: req.tenant?.id || 'default',
      actorType: 'employee',
      actorId: String(employeeId),
      action: 'create',
      resource: parsed.intent === 'count_inventory' ? 'inventory_count' : 'purchase',
      resourceId: String(result.resource_ids?.[0] || row.id),
      ip: req.ip,
    });

    res.json({
      intent: parsed.intent,
      message: buildSuccessMessage(parsed.intent, result),
      summary: result.summary || [],
      created_skus: result.created_skus || [],
    });
  } catch (error) {
    console.error('Error confirming inventory scan:', error);
    res.status(500).json({ error: 'Failed to confirm scan' });
  }
});

// GET /api/inventory-scan/recent — what the photo path has actually produced.
// Powers the owner-facing section on /admin/inventory: without it the feature
// is invisible from the desktop, since the capture screen is phone-only.
router.get('/recent', requireAuth('manage_inventory'), async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 50);
    const rows = await all(
      `SELECT vi.id, vi.draft_action AS intent, vi.status, vi.created_at,
              vi.confirmed_at, vi.media_url, e.name AS employee_name
       FROM voice_intents vi
       LEFT JOIN employees e ON e.id = vi.employee_id
       WHERE vi.source = 'pos_scan'
       ORDER BY vi.created_at DESC
       LIMIT $1`,
      [limit]
    );

    // Confirmed-in-last-30-days is the number that answers "is anyone using
    // this?" — a raw total would count abandoned drafts as adoption.
    const stats = await get(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'confirmed'
                          AND created_at > NOW() - INTERVAL '30 days') AS confirmed_30d,
         COUNT(*) FILTER (WHERE status = 'pending_confirm') AS pending
       FROM voice_intents WHERE source = 'pos_scan'`
    );

    res.json({
      scans: rows,
      confirmed_30d: Number(stats?.confirmed_30d || 0),
      pending: Number(stats?.pending || 0),
    });
  } catch (error) {
    console.error('Error listing inventory scans:', error);
    res.status(500).json({ error: 'Failed to list scans' });
  }
});

// POST /api/inventory-scan/:id/cancel — discard the draft. Own drafts only
// (loadPendingDraft scopes by employee), so scan_inventory is sufficient.
router.post('/:id/cancel', requireAuth('scan_inventory'), async (req, res) => {
  try {
    const employeeId = req.employee?.id;
    if (!employeeId) return res.status(401).json({ error: 'Employee context required' });

    const { row, error } = await loadPendingDraft(req.params.id, employeeId);
    // An expired or already-resolved draft is already "not pending", which is
    // what the caller wanted — report success rather than an error they cannot act on.
    if (error === 'not_found') return res.status(404).json({ error: 'Draft not found' });
    if (error) return res.json({ cancelled: true });

    await run(`UPDATE voice_intents SET status = 'cancelled' WHERE id = $1`, [row.id]);
    res.json({ cancelled: true });
  } catch (error) {
    console.error('Error cancelling inventory scan:', error);
    res.status(500).json({ error: 'Failed to cancel scan' });
  }
});

export default router;
