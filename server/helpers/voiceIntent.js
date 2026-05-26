// Voice-note intent parsing + execution.
//
// Input: a transcript like "tiré tres burritos, se quemaron" or
//        "se acabó el chicharrón" or "ya hay tortillas".
// Output: { intent, items, ... } that the webhook turns into a SI/NO
//         confirmation, then writes to waste_log / expenses / inventory_counts
//         / menu_items once the user confirms.
//
// The Claude call gets the live INVENTORY list (for waste/purchase/count
// intents) and the MENU list (for toggle_menu_item) so it can bind item_id
// directly. Vendor names come back as free text and the executor does a
// pg_trgm fuzzy match (same pattern as the receipt scanner).

import { all, get, run, getTenantId } from '../db/index.js';
import { detectOverpay } from './inventory.js';

const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = 'claude-sonnet-4-6';

const VOICE_INTENT_PROMPT = `You parse a restaurant staff voice/text note (Spanish or English) into a structured action. The note will be one of:

  1. WASTE         — "tiré 3 burritos", "se echó a perder un kilo de pollo", "wasted 2 lb steak"
  2. PURCHASE      — "llegaron 20 kilos de arrachera de Sigma, 2800 pesos", "received 5 cases of beer for 1750"
  3. COUNT         — "conteo: pollo 14 kilos, arrachera 8 kilos", "we have 12 cases of beer"
  4. TOGGLE_MENU   — "se acabó el chicharrón", "86 the carne asada", "ya no hay tacos al pastor"
                  OR "ya hay tortillas", "vuelve el pollo", "activate the burrito"

You will be given two lists:
  - INVENTORY (id, name, unit) — raw ingredients you waste / buy / count
  - MENU (id, name, active) — sellable menu items you 86 (deactivate) or reactivate

Bind each spoken item to the correct id based on the intent: WASTE/PURCHASE/COUNT → inventory_item_id; TOGGLE_MENU → menu_item_id. If no confident match, set the id to null and put the spoken name in raw_name.

Return ONLY valid JSON, no prose, with this exact schema:
{
  "intent": "log_waste" | "record_purchase" | "count_inventory" | "toggle_menu_item" | "unknown",
  "confidence": number (0-1),
  "clarifying_question": "string or null — Spanish, one short sentence asking what's missing",
  "items": [
    {
      "inventory_item_id": number | null,
      "menu_item_id": number | null,
      "raw_name": "string — item name as spoken",
      "quantity": number | null,
      "unit": "string or null — lowercase (kg, g, l, ml, pcs, box, case)",
      "reason": "spoilage" | "prep_error" | "dropped" | "expired" | "other" | null,
      "unit_price": number | null,
      "active": boolean | null
    }
  ],
  "vendor": "string or null — supplier name as spoken (only for purchases)",
  "total_amount": number | null,
  "payment_method": "cash" | "card" | "transfer" | null,
  "note": "string or null — any extra context worth keeping"
}

Rules:
- TOGGLE_MENU: set "active" per item. Deactivation cues ("se acabó", "ya no hay", "86", "agotado", "no queda") → false. Reactivation cues ("ya hay", "vuelve", "regresa", "activate", "está disponible") → true. quantity/unit/reason all null for this intent.
- WASTE: infer reason — quemado/burnt → prep_error; vencido/expired/echó a perder → spoilage or expired; tiré/dropped → dropped; default → other.
- PURCHASE: total_amount is the total spent (number, no currency). If only line totals are mentioned, sum them.
- COUNT: quantity is the counted on-hand amount in the inventory's unit.
- Convert spoken quantity to the inventory item's unit when sensible (e.g. inventory in kg, voice says "500 gramos" → quantity 0.5, unit kg).
- If the transcript is unclear or refers to items not in INVENTORY/MENU, set intent to "unknown" and put a short Spanish clarifying_question.
- Numbers as JSON numbers, no strings, no currency symbols.`;

function buildUserMessage(transcript, inventory, menu) {
  const invLines = inventory.slice(0, 150).map(
    (i) => `- id=${i.id} name="${i.name}" unit=${i.unit || ''}`
  );
  const menuLines = menu.slice(0, 150).map(
    (m) => `- id=${m.id} name="${m.name}" active=${m.active ? 'true' : 'false'}`
  );
  return `INVENTORY:
${invLines.join('\n')}

MENU:
${menuLines.join('\n')}

TRANSCRIPT:
"""${transcript}"""

Parse it.`;
}

export async function parseVoiceIntent(transcript) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

  const [inventory, menu] = await Promise.all([
    all('SELECT id, name, unit FROM inventory_items ORDER BY name ASC LIMIT 150'),
    all('SELECT id, name, active FROM menu_items ORDER BY name ASC LIMIT 150'),
  ]);

  const res = await fetch(CLAUDE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      system: VOICE_INTENT_PROMPT,
      messages: [{ role: 'user', content: buildUserMessage(transcript, inventory, menu) }],
    }),
  });

  if (!res.ok) {
    throw new Error(`Claude ${res.status}: ${await res.text().catch(() => '')}`);
  }
  const data = await res.json();
  const text = data.content?.[0]?.text || '';
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Claude returned no JSON');
  return JSON.parse(match[0]);
}

// Human-readable Spanish confirmation message. Kept short so it fits in
// WhatsApp's single-message window without splitting awkwardly.
export function buildConfirmationMessage(parsed) {
  if (!parsed || parsed.intent === 'unknown') {
    return parsed?.clarifying_question || 'No entendí. ¿Puedes repetirlo?';
  }
  const items = Array.isArray(parsed.items) ? parsed.items : [];
  const lines = items
    .slice(0, 6)
    .map((it) => {
      const q = Number(it.quantity);
      const unit = it.unit || '';
      const name = it.raw_name || '(item)';
      const qstr = Number.isFinite(q) ? (Number.isInteger(q) ? q : q.toFixed(2)) : '?';
      return `• ${qstr} ${unit} ${name}`.trim();
    })
    .join('\n');

  if (parsed.intent === 'log_waste') {
    const reasons = [...new Set(items.map((i) => i.reason).filter(Boolean))].join(', ');
    return `⚠️ Registrar merma:\n${lines}${reasons ? `\nMotivo: ${reasons}` : ''}\n\nResponde SI para guardar, NO para cancelar.`;
  }
  if (parsed.intent === 'record_purchase') {
    // Purchase lines get a (NUEVO) tag for items enrichPurchaseItems() flagged
    // as not in inventory yet — owner sees what new SKUs they're approving.
    const purchaseLines = items
      .slice(0, 8)
      .map((it) => {
        const q = Number(it.quantity);
        const unit = it.unit || '';
        const name = it.raw_name || '(item)';
        const qstr = Number.isFinite(q) ? (Number.isInteger(q) ? q : q.toFixed(2)) : '?';
        const tag = it._will_create ? ' (NUEVO)' : '';
        return `• ${qstr} ${unit} ${name}${tag}`.replace(/\s+/g, ' ').trim();
      })
      .join('\n');
    const vendor = parsed.vendor ? `\nProveedor: ${parsed.vendor}` : '';
    const total = parsed.total_amount ? `\nTotal: $${Number(parsed.total_amount).toFixed(2)}` : '';
    return `📦 Registrar compra:\n${purchaseLines}${vendor}${total}\n\nResponde SI para guardar, NO para cancelar.`;
  }
  if (parsed.intent === 'count_inventory') {
    return `📋 Conteo físico:\n${lines}\n\nResponde SI para guardar, NO para cancelar.`;
  }
  if (parsed.intent === 'toggle_menu_item') {
    // Mixed: some on, some off. Show an explicit marker per item so the
    // staff can see exactly what each direction will do before confirming.
    const togLines = items.slice(0, 8).map((it) => {
      const marker = it.active ? '🟢' : '📴';
      const verb = it.active ? 'disponible' : 'agotado';
      return `${marker} ${it.raw_name || '(item)'} (${verb})`;
    }).join('\n');
    return `Cambiar disponibilidad:\n${togLines}\n\nResponde SI para guardar, NO para cancelar.`;
  }
  return 'No entendí la acción. Cancela con NO o repite el mensaje.';
}

const CONFIRM_TOKENS = new Set([
  'si', 'sí', 'yes', 'y', 'ok', 'okay', 'dale', 'va', 'confirmar', 'confirma',
  '1', '✅', '👍',
]);
const CANCEL_TOKENS = new Set([
  'no', 'n', 'cancel', 'cancelar', 'cancela', 'stop', 'alto',
  '0', '❌', '👎',
]);

export function parseConfirmReply(text) {
  const t = String(text || '').trim().toLowerCase().replace(/[.!?,]+$/g, '');
  if (!t) return 'unclear';
  if (CONFIRM_TOKENS.has(t)) return 'confirm';
  if (CANCEL_TOKENS.has(t)) return 'cancel';
  // Allow first-word match for replies like "si guarda" / "no cancela"
  const first = t.split(/\s+/)[0];
  if (CONFIRM_TOKENS.has(first)) return 'confirm';
  if (CANCEL_TOKENS.has(first)) return 'cancel';
  return 'unclear';
}

// Pre-confirmation enrichment for record_purchase intents. Runs server-side
// fuzzy match against existing inventory (pg_trgm) for any line the parser
// couldn't bind to an id. If still no match, flag the item as _will_create
// so buildConfirmationMessage shows "(NUEVO)" and executePurchase inserts
// a new inventory_items row on SI. Must be called inside withTenant().
export async function enrichPurchaseItems(parsed) {
  if (!parsed || parsed.intent !== 'record_purchase') return parsed;
  const items = Array.isArray(parsed.items) ? parsed.items : [];
  for (const it of items) {
    // Derive per-unit price once so the cost-price math has a value to use
    // whether the line came from voice (unit_price) or from a receipt
    // photo (only amount + quantity).
    if (it.unit_price == null && Number(it.amount) > 0 && Number(it.quantity) > 0) {
      it.unit_price = Number(it.amount) / Number(it.quantity);
    }
    if (it.inventory_item_id) continue;
    if (!it.raw_name || typeof it.raw_name !== 'string') continue;
    try {
      const match = await get(
        `SELECT id FROM inventory_items
         WHERE similarity(name, $1) > 0.4
         ORDER BY similarity(name, $1) DESC
         LIMIT 1`,
        [it.raw_name.trim()]
      );
      if (match?.id) {
        it.inventory_item_id = match.id;
        it._fuzzy_matched = true;
      } else {
        it._will_create = true;
      }
    } catch {
      // pg_trgm not available — assume the item is new so the owner can still
      // approve and the auto-create path runs.
      it._will_create = true;
    }
  }
  return parsed;
}

// === EXECUTORS ===
// Each must be called inside withTenant() so RLS + tenant defaults work.

async function findVendorIdByName(name) {
  if (!name) return null;
  try {
    const row = await get(
      `SELECT id FROM vendors
       WHERE active = true AND similarity(name, $1) > 0.4
       ORDER BY similarity(name, $1) DESC LIMIT 1`,
      [name.trim()]
    );
    return row?.id || null;
  } catch {
    return null;
  }
}

async function executeWaste(parsed, employeeId) {
  const tid = getTenantId();
  const created = [];
  for (const it of parsed.items || []) {
    if (!it.inventory_item_id || !it.quantity || it.quantity <= 0) continue;
    const item = await get(
      'SELECT id, name, quantity, unit, cost_price FROM inventory_items WHERE id = $1',
      [it.inventory_item_id]
    );
    if (!item) continue;
    const reason = it.reason && ['spoilage', 'prep_error', 'dropped', 'expired', 'other'].includes(it.reason)
      ? it.reason
      : 'other';
    const cost = Math.round((Number(item.cost_price) || 0) * Number(it.quantity) * 100) / 100;
    const result = await run(
      `INSERT INTO waste_log (tenant_id, inventory_item_id, quantity, unit, reason, cost_at_time, notes, logged_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [tid, item.id, it.quantity, item.unit, reason, cost, parsed.note || null, employeeId]
    );
    const newQty = Math.max(0, Number(item.quantity) - Number(it.quantity));
    await run('UPDATE inventory_items SET quantity = $1 WHERE id = $2', [newQty, item.id]);
    created.push({ resource_id: result.lastInsertRowid, item_name: item.name });
  }
  if (!created.length) throw new Error('No items matched inventory');
  return { resource_type: 'waste_log', resource_ids: created.map((c) => c.resource_id), summary: created };
}

async function executePurchase(parsed, employeeId) {
  const tid = getTenantId();
  const vendorId = await findVendorIdByName(parsed.vendor);
  const amount = Number(parsed.total_amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Purchase total amount missing or invalid');
  }
  const today = new Date().toISOString().slice(0, 10);

  // Auto-create inventory items for lines enrichPurchaseItems() flagged as new.
  // SI on the confirmation is the approval gate; we already showed "(NUEVO)"
  // next to these lines. Insert at qty=0/cost=0 so the existing restock loop
  // below handles the cost-price seeding through its normal path.
  for (const it of parsed.items || []) {
    if (it.inventory_item_id) continue;
    if (!it._will_create) continue;
    if (!it.raw_name || typeof it.raw_name !== 'string') continue;
    const unit = it.unit || 'pcs';
    const created = await get(
      `INSERT INTO inventory_items (name, quantity, unit, cost_price)
       VALUES ($1, 0, $2, 0)
       RETURNING id`,
      [it.raw_name.trim(), unit]
    );
    if (created?.id) it.inventory_item_id = created.id;
  }

  // Mirror the receipt_data shape used by /api/expenses/scan-receipt so the
  // expense list UI shows the line items the same way.
  const receiptData = {
    source: 'whatsapp_voice',
    vendor: parsed.vendor || null,
    items: (parsed.items || []).map((it) => ({
      description: it.raw_name,
      quantity: it.quantity,
      unit: it.unit,
      unit_price: it.unit_price ?? null,
      amount: it.unit_price != null ? Number(it.unit_price) * Number(it.quantity) : null,
    })),
    total: amount,
  };
  const inventoryMatches = (parsed.items || [])
    .filter((it) => it.inventory_item_id && it.quantity > 0)
    .map((it) => ({
      inventory_item_id: it.inventory_item_id,
      quantity: Number(it.quantity),
      cost_price: it.unit_price != null ? Number(it.unit_price) : null,
      raw_description: it.raw_name || null,
    }));
  receiptData.inventory_matches = inventoryMatches;

  // Detect vendor_id column once (matches the pattern in routes/expenses.js)
  const hasVendorId = await get(
    `SELECT 1 AS ok FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'expenses' AND column_name = 'vendor_id'`
  );
  const receiptImageUrl = parsed.receipt_image_url || null;
  const noteDefault = receiptImageUrl ? 'Logged via WhatsApp receipt photo' : 'Logged via WhatsApp voice note';
  let expense;
  if (hasVendorId) {
    expense = await get(
      `INSERT INTO expenses (tenant_id, category, vendor, vendor_id, amount, expense_date, payment_method, notes, receipt_data, receipt_image_url, created_by, payee)
       VALUES ($1, 'food_cost', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [tid, parsed.vendor || null, vendorId, amount, today, parsed.payment_method || null,
       parsed.note || noteDefault, JSON.stringify(receiptData), receiptImageUrl, employeeId, parsed.vendor || null]
    );
  } else {
    expense = await get(
      `INSERT INTO expenses (tenant_id, category, vendor, amount, expense_date, payment_method, notes, receipt_data, receipt_image_url, created_by, payee)
       VALUES ($1, 'food_cost', $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [tid, parsed.vendor || null, amount, today, parsed.payment_method || null,
       parsed.note || noteDefault, JSON.stringify(receiptData), receiptImageUrl, employeeId, parsed.vendor || null]
    );
  }

  // Restock + cost-price update for each matched line. Simplified clone of the
  // weighted-moving-average logic in routes/expenses.js — kept inline here
  // because we're already inside withTenant + need to be atomic with the expense.
  for (const m of inventoryMatches) {
    const item = await get(
      'SELECT id, quantity, cost_price FROM inventory_items WHERE id = $1',
      [m.inventory_item_id]
    );
    if (!item) continue;
    const qBefore = Number(item.quantity) || 0;
    const prevCost = item.cost_price == null ? null : Number(item.cost_price);
    const addQty = Number(m.quantity);
    const newQty = qBefore + addQty;
    const incomingCost = m.cost_price != null ? Number(m.cost_price) : null;
    let newCost = prevCost;
    if (incomingCost != null && incomingCost > 0) {
      newCost = qBefore <= 0 || prevCost == null || prevCost === 0
        ? incomingCost
        : Math.round(((qBefore * prevCost + addQty * incomingCost) / newQty) * 10000) / 10000;
    }
    if (newCost != null && newCost !== prevCost) {
      await run('UPDATE inventory_items SET quantity = $1, cost_price = $2 WHERE id = $3',
        [newQty, newCost, m.inventory_item_id]);
    } else {
      await run('UPDATE inventory_items SET quantity = $1 WHERE id = $2',
        [newQty, m.inventory_item_id]);
    }
    if (incomingCost != null && incomingCost > 0) {
      try {
        await run(
          `INSERT INTO inventory_cost_history
             (tenant_id, inventory_item_id, vendor_id, expense_id, quantity_added, unit_cost, prev_cost_price, new_cost_price)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [tid, m.inventory_item_id, vendorId, expense.id, addQty, incomingCost, prevCost, newCost]
        );
      } catch {}
      try {
        await detectOverpay(m.inventory_item_id, incomingCost);
      } catch {}
    }
  }

  return {
    resource_type: 'expense',
    resource_ids: [expense.id],
    summary: { vendor: parsed.vendor, amount, items: inventoryMatches.length },
  };
}

async function executeCount(parsed, employeeId) {
  const tid = getTenantId();
  const created = [];
  for (const it of parsed.items || []) {
    if (!it.inventory_item_id || it.quantity == null || it.quantity < 0) continue;
    const item = await get('SELECT id, name, quantity FROM inventory_items WHERE id = $1', [it.inventory_item_id]);
    if (!item) continue;
    const systemQty = Number(item.quantity) || 0;
    const counted = Number(it.quantity);
    const variance = counted - systemQty;
    const variancePct = systemQty > 0 ? Math.round((variance / systemQty) * 10000) / 100 : 0;
    const result = await run(
      `INSERT INTO inventory_counts (tenant_id, inventory_item_id, counted_quantity, system_quantity, variance, variance_percent, counted_by, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [tid, item.id, counted, systemQty, variance, variancePct, employeeId, parsed.note || null]
    );
    await run('UPDATE inventory_items SET quantity = $1, last_counted_at = NOW() WHERE id = $2',
      [counted, item.id]);
    if (Math.abs(variancePct) > 10) {
      const severity = Math.abs(variancePct) > 25 ? 'high' : 'medium';
      const alertType = variance < 0 ? 'shrinkage' : 'surplus';
      await run(
        `INSERT INTO shrinkage_alerts (tenant_id, inventory_item_id, alert_type, severity, message, variance_amount)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [tid, item.id, alertType, severity,
         `${item.name}: ${alertType} of ${Math.abs(variance).toFixed(2)} units (${Math.abs(variancePct)}% variance)`,
         variance]
      );
    }
    created.push({ resource_id: result.lastInsertRowid, item_name: item.name, variance });
  }
  if (!created.length) throw new Error('No items matched inventory');
  return { resource_type: 'inventory_count', resource_ids: created.map((c) => c.resource_id), summary: created };
}

async function executeToggleMenuItem(parsed, _employeeId) {
  const changed = [];
  for (const it of parsed.items || []) {
    if (!it.menu_item_id || typeof it.active !== 'boolean') continue;
    const item = await get(
      'SELECT id, name, active FROM menu_items WHERE id = $1',
      [it.menu_item_id]
    );
    if (!item) continue;
    if (item.active === it.active) {
      // Already in the requested state — record as a no-op so the audit trail
      // is honest about what actually changed.
      changed.push({ resource_id: item.id, item_name: item.name, active: it.active, noop: true });
      continue;
    }
    await run('UPDATE menu_items SET active = $1 WHERE id = $2', [it.active, item.id]);
    changed.push({ resource_id: item.id, item_name: item.name, active: it.active, noop: false });
  }
  if (!changed.length) throw new Error('No menu items matched');
  return {
    resource_type: 'menu_item',
    resource_ids: changed.map((c) => c.resource_id),
    summary: changed,
  };
}

export async function executeIntent(parsed, employeeId) {
  switch (parsed.intent) {
    case 'log_waste':         return executeWaste(parsed, employeeId);
    case 'record_purchase':   return executePurchase(parsed, employeeId);
    case 'count_inventory':   return executeCount(parsed, employeeId);
    case 'toggle_menu_item':  return executeToggleMenuItem(parsed, employeeId);
    default:
      throw new Error(`Cannot execute intent: ${parsed.intent}`);
  }
}

export function buildSuccessMessage(intent, result) {
  if (intent === 'log_waste') {
    const items = (result.summary || []).map((s) => s.item_name).join(', ');
    return `✅ Merma registrada: ${items}`;
  }
  if (intent === 'record_purchase') {
    return `✅ Compra registrada: ${result.summary.vendor || 'proveedor'} — $${Number(result.summary.amount).toFixed(2)} (${result.summary.items} item${result.summary.items === 1 ? '' : 's'} restock)`;
  }
  if (intent === 'count_inventory') {
    const items = (result.summary || []).map((s) => `${s.item_name} (${s.variance >= 0 ? '+' : ''}${Number(s.variance).toFixed(2)})`).join(', ');
    return `✅ Conteo guardado: ${items}`;
  }
  if (intent === 'toggle_menu_item') {
    const off = (result.summary || []).filter((s) => !s.active && !s.noop).map((s) => s.item_name);
    const on = (result.summary || []).filter((s) => s.active && !s.noop).map((s) => s.item_name);
    const noop = (result.summary || []).filter((s) => s.noop).map((s) => s.item_name);
    const parts = [];
    if (off.length) parts.push(`📴 Agotado: ${off.join(', ')}`);
    if (on.length) parts.push(`🟢 Disponible: ${on.join(', ')}`);
    if (noop.length) parts.push(`(sin cambio: ${noop.join(', ')})`);
    return `✅ ${parts.join(' · ')}`;
  }
  return '✅ Guardado.';
}
