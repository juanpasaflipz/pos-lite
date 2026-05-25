// Voice-note intent parsing + execution.
//
// Input: a transcript like "tiré tres burritos, se quemaron" or
//        "llegaron 20 kilos de arrachera de Sigma, 2800 pesos".
// Output: { intent, items, ... } that the webhook turns into a SI/NO
//         confirmation, then writes to /api/waste, /api/expenses, or
//         /api/inventory/:id/count once the user confirms.
//
// The Claude call gets the live inventory list (name + id + unit) so it can
// bind item_id directly. For purchases, the vendor name comes back as free
// text and the route does a pg_trgm fuzzy match (same pattern as the receipt
// scanner in routes/expenses.js).

import { all, get, run, getTenantId } from '../db/index.js';
import { detectOverpay } from './inventory.js';

const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = 'claude-sonnet-4-6';

const VOICE_INTENT_PROMPT = `You parse a restaurant staff voice note (Spanish or English) into a structured action for an inventory + expense system. The note will be one of:

  1. WASTE   — "tiré 3 burritos", "se echó a perder un kilo de pollo", "wasted 2 lb steak"
  2. PURCHASE — "llegaron 20 kilos de arrachera de Sigma, 2800 pesos", "received 5 cases of beer for 1750"
  3. COUNT   — "conteo: pollo 14 kilos, arrachera 8 kilos", "we have 12 cases of beer"

You will be given the current INVENTORY list (id, name, unit) and a hint for the most likely intent. Bind each spoken item to one inventory_item_id when possible; if no confident match, set inventory_item_id to null and put the spoken name in raw_name.

Return ONLY valid JSON, no prose, with this exact schema:
{
  "intent": "log_waste" | "record_purchase" | "count_inventory" | "unknown",
  "confidence": number (0-1),
  "clarifying_question": "string or null — Spanish, one short sentence asking what's missing",
  "items": [
    {
      "inventory_item_id": number | null,
      "raw_name": "string — item name as spoken",
      "quantity": number,
      "unit": "string — unit as spoken, lowercase (kg, g, l, ml, pcs, box, case)",
      "reason": "spoilage" | "prep_error" | "dropped" | "expired" | "other" | null,
      "unit_price": number | null
    }
  ],
  "vendor": "string or null — supplier name as spoken (only for purchases)",
  "total_amount": number | null,
  "payment_method": "cash" | "card" | "transfer" | null,
  "note": "string or null — any extra context worth keeping"
}

Rules:
- Convert quantity to the inventory item's own unit when you can (e.g. inventory is kg, voice says "500 gramos" → quantity 0.5, unit kg).
- For WASTE, infer reason from keywords: quemado/burnt → prep_error; vencido/expired/echó a perder → spoilage or expired; tiré/dropped → dropped; default → other.
- For PURCHASE, total_amount is the total spent (number, no currency). If only line totals are mentioned, sum them.
- For COUNT, quantity is the counted on-hand amount in the inventory's unit.
- If the transcript is unclear or refers to items not in INVENTORY, set intent to "unknown" and put a short Spanish clarifying_question.
- Numbers as JSON numbers, no strings, no currency symbols.`;

function buildUserMessage(transcript, inventory) {
  const lines = inventory.slice(0, 200).map(
    (i) => `- id=${i.id} name="${i.name}" unit=${i.unit || ''}`
  );
  return `INVENTORY:
${lines.join('\n')}

TRANSCRIPT:
"""${transcript}"""

Parse it.`;
}

export async function parseVoiceIntent(transcript) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

  const inventory = await all(
    'SELECT id, name, unit FROM inventory_items ORDER BY name ASC LIMIT 200'
  );

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
      messages: [{ role: 'user', content: buildUserMessage(transcript, inventory) }],
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
    const vendor = parsed.vendor ? `\nProveedor: ${parsed.vendor}` : '';
    const total = parsed.total_amount ? `\nTotal: $${Number(parsed.total_amount).toFixed(2)}` : '';
    return `📦 Registrar compra:\n${lines}${vendor}${total}\n\nResponde SI para guardar, NO para cancelar.`;
  }
  if (parsed.intent === 'count_inventory') {
    return `📋 Conteo físico:\n${lines}\n\nResponde SI para guardar, NO para cancelar.`;
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
  let expense;
  if (hasVendorId) {
    expense = await get(
      `INSERT INTO expenses (tenant_id, category, vendor, vendor_id, amount, expense_date, payment_method, notes, receipt_data, created_by, payee)
       VALUES ($1, 'food_cost', $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [tid, parsed.vendor || null, vendorId, amount, today, parsed.payment_method || null,
       parsed.note || 'Logged via WhatsApp voice note', JSON.stringify(receiptData), employeeId, parsed.vendor || null]
    );
  } else {
    expense = await get(
      `INSERT INTO expenses (tenant_id, category, vendor, amount, expense_date, payment_method, notes, receipt_data, created_by, payee)
       VALUES ($1, 'food_cost', $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [tid, parsed.vendor || null, amount, today, parsed.payment_method || null,
       parsed.note || 'Logged via WhatsApp voice note', JSON.stringify(receiptData), employeeId, parsed.vendor || null]
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

export async function executeIntent(parsed, employeeId) {
  switch (parsed.intent) {
    case 'log_waste':       return executeWaste(parsed, employeeId);
    case 'record_purchase': return executePurchase(parsed, employeeId);
    case 'count_inventory': return executeCount(parsed, employeeId);
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
  return '✅ Guardado.';
}
