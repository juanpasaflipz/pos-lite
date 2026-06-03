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
import { detectOverpay, detectCostAnomaly } from './inventory.js';

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
      "pack_size": number | null,
      "line_total": number | null,
      "reason": "spoilage" | "prep_error" | "dropped" | "expired" | "other" | null,
      "active": boolean | null
    }
  ],
  "vendor": "string or null — supplier name as spoken (only for purchases)",
  "total_amount": number | null,
  "payment_method": "cash" | "card" | "transfer" | null,
  "note": "string or null — any extra context worth keeping"
}

Rules:
- TOGGLE_MENU: set "active" per item. Deactivation cues ("se acabó", "ya no hay", "86", "agotado", "no queda") → false. Reactivation cues ("ya hay", "vuelve", "regresa", "activate", "está disponible") → true. quantity/unit/reason/pack_size/line_total all null for this intent.
- WASTE: infer reason — quemado/burnt → prep_error; vencido/expired/echó a perder → spoilage or expired; tiré/dropped → dropped; default → other. pack_size and line_total are null.
- PURCHASE: total_amount is the TOTAL spent across all lines. line_total is the money paid for that ONE item line. If only one item is mentioned with one price ("20 kilos de arrachera, 2800 pesos"), set both: total_amount=2800 and line_total=2800.
- PURCHASE CRITICAL: line_total is the MONEY PAID for the whole line. Do NOT divide it by quantity. Do NOT report a per-kilo or per-piece price. "Picana 2 kilos 888 pesos" → quantity=2, unit="kg", pack_size=1, line_total=888 — the executor computes per-kilo cost itself.
- pack_size is the content of ONE pack expressed in 'unit'. Loose-by-weight ("2 kilos de picana") → pack_size=1. Sealed packs ("1 saco de 5 kilos", "caja de 24 latas") → pack_size = contents of one pack, quantity = number of packs.
- COUNT: quantity is the counted on-hand amount in the inventory's unit. pack_size and line_total null.
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
    // Purchase lines now surface the DERIVED per-unit cost so the owner sees
    // "$439.95/kg" before SI — the human checkpoint that catches the
    // unit-of-measure mismatch class (line_total mistaken for per-kg price)
    // BEFORE it propagates into recipe-cost math.
    const fmtMoney = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const purchaseLines = items
      .slice(0, 8)
      .map((it) => {
        const received = Number(it.received_qty_base_unit ?? it.quantity);
        const unit = it.unit || '';
        const name = it.raw_name || '(item)';
        const qstr = Number.isFinite(received) ? (Number.isInteger(received) ? received : received.toFixed(2)) : '?';
        const tag = it._will_create ? ' (NUEVO)' : '';
        const alertTag = it._cost_alert?.severity === 'severe' ? ' ⚠️' : '';
        const perUnit = it.derived_unit_cost;
        const lineTotal = it.line_total;
        if (perUnit != null && lineTotal != null) {
          return `•${alertTag} ${name} — ${qstr} ${unit} @ $${fmtMoney(perUnit)}/${unit || 'u'} = $${fmtMoney(lineTotal)}${tag}`.replace(/\s+/g, ' ').trim();
        }
        return `• ${qstr} ${unit} ${name}${tag}`.replace(/\s+/g, ' ').trim();
      })
      .join('\n');
    const vendor = parsed.vendor ? `\nProveedor: ${parsed.vendor}` : '';
    const total = parsed.total_amount ? `\nTotal: $${fmtMoney(parsed.total_amount)}` : '';

    // If any line tripped a severe alert, surface a single combined Spanish
    // warning between the lines and the SI prompt. The intent is: don't block,
    // but make absolutely sure the owner sees it before pressing SI on autopilot.
    const flagged = items.filter((it) => it._cost_alert?.severity === 'severe');
    const warningBlock = flagged.length
      ? `\n\n⚠️ Revisa el precio:\n` + flagged.slice(0, 4).map((it) => {
          const perUnit = it.derived_unit_cost;
          const median = it._cost_alert.median;
          const basis = it._cost_alert.basis === 'history' ? 'precio anterior' : 'productos similares';
          return `  · ${it.raw_name}: $${fmtMoney(perUnit)}/${it.unit || 'u'} (vs ${basis} $${fmtMoney(median)}/${it.unit || 'u'}). ¿El precio era por una sola unidad?`;
        }).join('\n')
      : '';

    return `📦 Registrar compra:\n${purchaseLines}${vendor}${total}${warningBlock}\n\nResponde SI para guardar, NO para cancelar.`;
  }
  if (parsed.intent === 'count_inventory') {
    // Surface SKUs the photo showed but inventory doesn't have so the owner
    // can decide: SI = count only the matched ones; AGREGAR = create the
    // unknowns at their counted qty AND save the count in one round-trip.
    const unmatched = items.filter((it) => it._unmatched && it.raw_name).map((it) => it.raw_name);
    const skipped = unmatched.length
      ? `\n(no en inventario: ${unmatched.slice(0, 6).join(', ')}${unmatched.length > 6 ? '…' : ''})`
      : '';
    const matchedLines = items
      .filter((it) => it.inventory_item_id)
      .slice(0, 8)
      .map((it) => {
        const q = Number(it.quantity);
        const unit = it.unit || '';
        const name = it.raw_name || '(item)';
        const qstr = Number.isFinite(q) ? (Number.isInteger(q) ? q : q.toFixed(2)) : '?';
        return `• ${qstr} ${unit} ${name}`.replace(/\s+/g, ' ').trim();
      })
      .join('\n');
    if (!matchedLines && !unmatched.length) {
      return 'No reconocí ningún artículo. Manda otra foto o agrega los SKUs primero.';
    }
    if (!matchedLines) {
      return `📋 Conteo físico (nada hace match):${skipped}\n\nResponde AGREGAR para crear esos SKUs y contarlos, o NO para cancelar.`;
    }
    const verbs = unmatched.length
      ? 'Responde SI para guardar el conteo, AGREGAR para crear esos SKUs y contarlos también, o NO para cancelar.'
      : 'Responde SI para guardar, NO para cancelar.';
    return `📋 Conteo físico:\n${matchedLines}${skipped}\n\n${verbs}`;
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
// "AGREGAR" on a count = create the unmatched SKUs at their counted qty and
// save the count. On a purchase it's an alias for SI (auto-create already
// happens via _will_create on SI). On other intents the webhook treats it
// as SI too.
const ADD_TOKENS = new Set([
  'agregar', 'agrega', 'agg', 'add', 'crear', 'crea', 'create', '+',
]);

export function parseConfirmReply(text) {
  const t = String(text || '').trim().toLowerCase().replace(/[.!?,]+$/g, '');
  if (!t) return 'unclear';
  if (CONFIRM_TOKENS.has(t)) return 'confirm';
  if (CANCEL_TOKENS.has(t)) return 'cancel';
  if (ADD_TOKENS.has(t)) return 'add';
  // Allow first-word match for replies like "si guarda" / "agregar todo"
  const first = t.split(/\s+/)[0];
  if (CONFIRM_TOKENS.has(first)) return 'confirm';
  if (CANCEL_TOKENS.has(first)) return 'cancel';
  if (ADD_TOKENS.has(first)) return 'add';
  return 'unclear';
}

// Strong modifiers that distinguish otherwise-similar SKUs. If one name has
// the token and the other doesn't, refuse the fuzzy match — e.g. "Bohemia
// Vienna" should NOT collapse into "Bohemia Clara". Better to surface as
// _unmatched than to silently merge two different products.
const STRONG_MODIFIERS = [
  'vienna', 'ámbar', 'ambar', 'clara', 'oscura', 'obscura', 'negra', 'roja',
  'ultra', 'light', 'lite', 'zero', 'cero', 'sin alcohol',
  'lager', 'pilsner', 'stout', 'ipa', 'porter', 'wheat', 'trigo',
  'especial', 'original', 'premium', 'familiar',
];

function hasToken(haystack, token) {
  // word-boundary-ish: token surrounded by non-letter chars (or start/end)
  const re = new RegExp(`(^|[^\\p{L}])${token.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}([^\\p{L}]|$)`, 'iu');
  return re.test(haystack);
}

function modifierConflict(a, b) {
  if (!a || !b) return false;
  for (const m of STRONG_MODIFIERS) {
    const inA = hasToken(a, m);
    const inB = hasToken(b, m);
    if (inA !== inB) return true;
  }
  return false;
}

// Pre-confirmation enrichment for record_purchase and count_inventory intents.
// Four responsibilities (purchase doors run all four; count runs 2+3):
//   1. Normalize line_total per line (fall back to legacy amount/unit_price
//      or to total_amount for single-line purchases).
//   2. Fuzzy-match unbound items against existing inventory (pg_trgm @ 0.55),
//      rejecting matches that disagree on a strong modifier (Vienna/Clara,
//      Ultra/Light, etc.) so different products don't silently collapse.
//   3. Dedup-and-sum: when Claude returns multiple lines binding to the same
//      inventory_item_id (e.g. "Bohemia shelf superior" + "Bohemia shelf
//      inferior"), merge into one line — otherwise executeCount overwrites
//      qty on the second iteration and the first count is lost. Sums
//      quantity AND line_total so step 4 derives the right basis.
//   4. Derive received_qty_base_unit (quantity × pack_size) and
//      derived_unit_cost (line_total ÷ received_qty_base_unit). These are
//      the ONLY numbers executePurchase trusts for restock + cost-history.
//
// For purchase intents, true misses are flagged _will_create so
// buildConfirmationMessage shows "(NUEVO)" and executePurchase inserts a
// new inventory_items row on SI. For count intents, misses stay unbound —
// the AGREGAR token converts them on demand.
// Must be called inside withTenant().
export async function enrichItemBindings(parsed) {
  if (!parsed) return parsed;
  if (parsed.intent !== 'record_purchase' && parsed.intent !== 'count_inventory') return parsed;
  const allowCreate = parsed.intent === 'record_purchase';
  const items = Array.isArray(parsed.items) ? parsed.items : [];

  // Purchase-only step 1: normalize each line's line_total. The model now
  // reports line_total directly, but legacy callers (older pending intents in
  // voice_intents) may still send `amount` or `unit_price`. Reconstruct so
  // confirmation replies from before the schema change still execute.
  if (allowCreate) {
    const onlyItem = items.length === 1 ? items[0] : null;
    for (const it of items) {
      if (it.line_total == null) {
        if (Number(it.amount) > 0) it.line_total = Number(it.amount);
        else if (Number(it.unit_price) > 0 && Number(it.quantity) > 0) {
          it.line_total = Number(it.unit_price) * Number(it.quantity);
        }
      }
      // Single-line purchases like "20 kilos arrachera 2800 pesos" often arrive
      // with only total_amount set — fall back so we still have a line_total.
      if (it === onlyItem && it.line_total == null && Number(parsed.total_amount) > 0) {
        it.line_total = Number(parsed.total_amount);
      }
    }
  }

  for (const it of items) {
    if (it.inventory_item_id) continue;
    if (!it.raw_name || typeof it.raw_name !== 'string') continue;
    try {
      const match = await get(
        `SELECT id, name FROM inventory_items
         WHERE similarity(name, $1) > 0.55
         ORDER BY similarity(name, $1) DESC
         LIMIT 1`,
        [it.raw_name.trim()]
      );
      if (match?.id && !modifierConflict(it.raw_name, match.name || '')) {
        it.inventory_item_id = match.id;
        it._fuzzy_matched = true;
      } else if (allowCreate) {
        it._will_create = true;
      } else {
        it._unmatched = true;
      }
    } catch {
      // pg_trgm not available. For purchases, fall through to auto-create so
      // the owner can still approve. For counts, leave unmatched.
      if (allowCreate) it._will_create = true;
      else it._unmatched = true;
    }
  }

  // Dedup-and-sum: when two lines bind to the same inventory_item_id (e.g.
  // Claude returned "Bohemia shelf superior" + "Bohemia shelf inferior"),
  // merge into one line so executeCount/executePurchase don't run twice on
  // the same id (count: last write overwrites; purchase: two restock rows).
  // line_total is summed so the per-unit derivation below stays correct after
  // a merge (otherwise picana on two lines would double-count quantity but
  // keep a single-line cost basis).
  const byId = new Map();
  const out = [];
  for (const it of items) {
    if (!it.inventory_item_id) { out.push(it); continue; }
    const prior = byId.get(it.inventory_item_id);
    if (prior) {
      prior.quantity = Number(prior.quantity || 0) + Number(it.quantity || 0);
      if (Number(it.line_total) > 0) prior.line_total = Number(prior.line_total || 0) + Number(it.line_total);
      if (Number(it.amount) > 0) prior.amount = Number(prior.amount || 0) + Number(it.amount);
      // Keep the shorter raw_name — Claude tends to put shelf/position context
      // in the longer one, and we want the clean brand label.
      if ((it.raw_name?.length || 0) < (prior.raw_name?.length || 0)) {
        prior.raw_name = it.raw_name;
      }
      continue;
    }
    byId.set(it.inventory_item_id, it);
    out.push(it);
  }
  parsed.items = out;

  // Purchase-only step 2: derive received_qty_base_unit and derived_unit_cost
  // AFTER dedup, so a merged line gets the correct (summed-quantity,
  // summed-line_total) basis. The model never reports cost_per_unit directly;
  // that ratio is server-derived so a mis-labeled "unit_price" can't become
  // the SKU's per-unit cost (the bug that turned $888.70 for 2.02 kg of
  // picana into $888.70/kg).
  if (allowCreate) {
    for (const it of parsed.items) {
      const packSize = Number(it.pack_size) > 0 ? Number(it.pack_size) : 1;
      const qty = Number(it.quantity);
      const received = Number.isFinite(qty) && qty > 0 ? qty * packSize : null;
      it.received_qty_base_unit = received;

      if (received && received > 0 && Number(it.line_total) > 0) {
        it.derived_unit_cost = Number(it.line_total) / received;
      } else {
        it.derived_unit_cost = null;
      }

      // Pre-write anomaly check. _cost_alert is consumed by
      // buildConfirmationMessage to render ⚠️ + a Spanish hint before SI.
      // Existing items use their own history; new items (_will_create) fall
      // back to same-unit peer median.
      if (it.derived_unit_cost && it.derived_unit_cost > 0) {
        try {
          it._cost_alert = await detectCostAnomaly({
            inventoryItemId: it._will_create ? null : it.inventory_item_id,
            incomingUnitCost: it.derived_unit_cost,
            unit: it.unit || null,
          });
        } catch {
          it._cost_alert = null;
        }
      }
    }
  }

  return parsed;
}

// Backwards-compatible alias — kept so external callers don't break.
export const enrichPurchaseItems = enrichItemBindings;

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
  // expense list UI shows the line items the same way. unit_price here is the
  // derived per-base-unit cost (line_total ÷ received_qty), NOT a model-reported
  // value — keeps recipe-cost math consistent across all purchase doors.
  const receiptData = {
    source: 'whatsapp_voice',
    vendor: parsed.vendor || null,
    items: (parsed.items || []).map((it) => ({
      description: it.raw_name,
      quantity: it.received_qty_base_unit ?? it.quantity,
      unit: it.unit,
      pack_size: it.pack_size ?? null,
      unit_price: it.derived_unit_cost ?? null,
      amount: it.line_total ?? null,
    })),
    total: amount,
  };
  const inventoryMatches = (parsed.items || [])
    .filter((it) => it.inventory_item_id && Number(it.received_qty_base_unit ?? it.quantity) > 0)
    .map((it) => ({
      inventory_item_id: it.inventory_item_id,
      // Restock in the inventory item's BASE unit, not "packs of N". A 1-sack
      // line with pack_size=5 kg restocks 5 kg, not 1.
      quantity: Number(it.received_qty_base_unit ?? it.quantity),
      cost_price: it.derived_unit_cost != null ? Number(it.derived_unit_cost) : null,
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

  // AGREGAR on a count: convert _will_create items into real inventory_items
  // rows at their counted qty. We seed quantity = counted so the subsequent
  // count loop produces variance=0 (no false shrinkage alert), and the SKU's
  // existence + opening state are written in the same tenant transaction.
  const newlyCreated = [];
  for (const it of parsed.items || []) {
    if (it.inventory_item_id) continue;
    if (!it._will_create) continue;
    if (!it.raw_name || typeof it.raw_name !== 'string') continue;
    const startQty = Number(it.quantity) > 0 ? Number(it.quantity) : 0;
    const unit = it.unit || 'pcs';
    const row = await get(
      `INSERT INTO inventory_items (name, quantity, unit, cost_price)
       VALUES ($1, $2, $3, 0)
       RETURNING id`,
      [it.raw_name.trim(), startQty, unit]
    );
    if (row?.id) {
      it.inventory_item_id = row.id;
      newlyCreated.push({ id: row.id, name: it.raw_name.trim(), qty: startQty });
    }
  }

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
  if (!created.length && !newlyCreated.length) throw new Error('No items matched inventory');
  return {
    resource_type: 'inventory_count',
    resource_ids: created.map((c) => c.resource_id),
    summary: created,
    created_skus: newlyCreated,
  };
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
    const created = result.created_skus || [];
    const createdLine = created.length
      ? `\n+ ${created.length} SKU${created.length === 1 ? '' : 's'} creado${created.length === 1 ? '' : 's'}: ${created.map((c) => c.name).join(', ')}`
      : '';
    if (!items) return `✅ ${created.length} SKU${created.length === 1 ? '' : 's'} creado${created.length === 1 ? '' : 's'}: ${created.map((c) => c.name).join(', ')}`;
    return `✅ Conteo guardado: ${items}${createdLine}`;
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
