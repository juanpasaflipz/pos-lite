// WhatsApp receipt-photo → voice-intent shape.
//
// Single Claude vision call that combines two things the codebase already
// does separately:
//   - Receipt OCR (vendor, items, total)  — see RECEIPT_PARSER_PROMPT in
//     routes/expenses.js (web upload path).
//   - Inventory binding (item_id per line) — see VOICE_INTENT_PROMPT in
//     helpers/voiceIntent.js (voice-note path).
//
// Output shape mirrors parseVoiceIntent() return so buildConfirmationMessage()
// and executePurchase() consume it unchanged. Caller persists the image and
// sets parsed.receipt_image_url so the SI/NO → expense flow can attach the
// photo to the expense row.
//
// Assumes the caller has already wrapped this in withTenant() — the inventory
// query relies on RLS for tenant scoping.

import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { all } from '../db/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RECEIPTS_DIR = path.join(__dirname, '../../data/uploads/receipts');

const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = 'claude-sonnet-4-6';

const ALLOWED_MEDIA = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

const RECEIPT_VISION_PROMPT = `You parse a photo from a Mexican restaurant operator. The photo is ONE of these (classify first, then extract):

(A) RECEIPT / PURCHASE EVIDENCE → intent="record_purchase"
    - Preprinted "Nota de Venta" or "Remisión" with handwritten line items
    - Thermal payment terminal slip (Fiserv, clip.mx, Mercado Pago) — total + card mask only
    - Handwritten shopping list with prices
    - Standard printed supermarket receipt

(B) INVENTORY COUNT → intent="count_inventory"
    - Photo of a fridge, freezer, walk-in, shelf, pantry, bar back, or any storage
      where the operator is showing stock-on-hand they want recorded.
    - Identify each visible product brand/variant and count visible units of each.
      (Beer brands: Dos Equis Lager, Dos Equis Ámbar, Bohemia, Bohemia Vienna,
       Heineken, Tecate, Amstel Ultra, Indio, Modelo, Victoria, etc. Sodas: Coca,
       Sprite, Topo Chico, etc. Etc.)
    - Be honest about hidden back rows — count only what you can see, lower
      confidence, and add a note like "approximated; back rows hidden".

(C) NEITHER → intent="unknown" with a Spanish clarifying_question

You will receive an INVENTORY list (id, name, unit). For BOTH intents, bind each line / counted brand to the closest inventory id when confident; accept colloquial Spanish (jitomate=tomate, XX=Dos Equis, etc.). If no confident match, set inventory_item_id=null and put the description in raw_name.

Return ONLY valid JSON, no prose:
{
  "intent": "record_purchase" | "count_inventory" | "unknown",
  "confidence": number (0-1),
  "clarifying_question": "string or null — Spanish, one short sentence if intent=unknown",
  "items": [
    {
      "inventory_item_id": number | null,
      "menu_item_id": null,
      "raw_name": "string — brand / item description",
      "quantity": number | null,
      "unit": "kg" | "g" | "l" | "ml" | "pcs" | "btl" | "can" | "box" | "case" | null,
      "pack_size": number | null,    // contents of ONE pack expressed in 'unit'. "1 saco de 5 kg" → quantity=1, unit="kg", pack_size=5. "2.02 kg suelto" → quantity=2.02, unit="kg", pack_size=1. "caja de 24 latas" → quantity=1, unit="can", pack_size=24.
      "line_total": number | null    // record_purchase only — TOTAL MONEY PAID for this whole line, before tax. Null for count.
    }
  ],
  "vendor": "string or null — supplier / store name (record_purchase only)",
  "total_amount": number | null,
  "payment_method": "cash" | "card" | "transfer" | null,
  "note": "string or null — date, invoice number, count caveats, or other useful context"
}

Rules:
- raw_name MUST be the clean brand or product label only (e.g. "Bohemia", "Bohemia Vienna", "XX Ámbar", "Tecate Original", "Vaso S113"). Do NOT add shelf positions, visibility caveats, observations, or any "(...)" annotations to raw_name — those go in the top-level "note" field. If you see the SAME brand on two shelves, emit ONE item line with the combined count; never emit two lines for the same product with positional labels.
- If image is neither a receipt nor a count-able shelf/fridge (a person, raw food, prep area, screenshot, etc.), set intent="unknown" and put a Spanish clarifying_question like "Esa foto no parece recibo ni inventario. ¿Qué quieres registrar?".
- A payment terminal slip with only a total is STILL intent="record_purchase" — leave items=[] and populate total_amount + payment_method.
- For count_inventory: set vendor=null, total_amount=null, payment_method=null. Each item's line_total must be null. Use "pcs" or "btl"/"can" as appropriate.
- CRITICAL: line_total is the money paid for the WHOLE line. Do NOT divide it. Do NOT confuse it with a per-kg or per-piece price. If the line shows "Picana 2.020 kg $888.70", emit quantity=2.02, unit="kg", pack_size=1, line_total=888.70 — the executor computes per-kg cost itself.
- pack_size is the content of ONE pack. Loose produce/meat sold by weight → pack_size=1 always. Sealed pack ("5 kg sack", "24-can case", "1 L bottle in a 12-pack") → pack_size is the contents of one pack; quantity is how many packs were bought.
- Numbers as JSON numbers — no currency symbols, no thousands separators.
- Convert weights to kg/L when sensible. If a unit can't be determined, use null. Do not guess.
- Skip subtotal/tax/change/discount/loyalty lines from items[].
- If there is a CAPTION from the owner, use it as a hint (e.g. "conteo" → prefer count_inventory; vendor name → prefer record_purchase).`;

function buildUserContent(inventory, caption) {
  const lines = inventory.map(
    (i) => `- id=${i.id} name="${i.name}" unit=${i.unit || ''}`
  );
  const captionLine = caption ? `\n\nCAPTION FROM OWNER: "${caption}"` : '';
  return `INVENTORY:\n${lines.join('\n')}${captionLine}\n\nParse the attached photo.`;
}

export async function parseReceiptImage(imageBuffer, mediaType, caption) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

  // Active items first (anything with stock on hand), then alphabetical.
  // 500 covers the vast majority of restaurants; beyond that we'd need a
  // category-aware bucketing step pre-call.
  const inventory = await all(
    `SELECT id, name, unit FROM inventory_items
     ORDER BY (quantity > 0) DESC, name ASC
     LIMIT 500`
  );

  const mt = ALLOWED_MEDIA.includes(mediaType) ? mediaType : 'image/jpeg';
  const base64 = imageBuffer.toString('base64');

  const res = await fetch(CLAUDE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 2048,
      system: RECEIPT_VISION_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mt, data: base64 } },
            { type: 'text', text: buildUserContent(inventory, caption) },
          ],
        },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(`Claude vision ${res.status}: ${await res.text().catch(() => '')}`);
  }
  const data = await res.json();
  const text = data.content?.[0]?.text || '';
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Claude vision returned no JSON');
  return JSON.parse(match[0]);
}

// Persist a WhatsApp media buffer to /uploads/receipts/ so the expense row
// keeps a stable URL after the Twilio media URL expires. Mirrors the path
// shape that multer uses in routes/expenses.js (upload-receipt / scan-receipt).
export async function persistReceiptBuffer(buffer, contentType) {
  const subtype = String(contentType || '').split('/')[1] || 'jpg';
  const ext = subtype === 'jpeg' ? 'jpg' : subtype.replace(/[^a-z0-9]/gi, '') || 'jpg';
  const filename = `wa-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  await fs.mkdir(RECEIPTS_DIR, { recursive: true });
  await fs.writeFile(path.join(RECEIPTS_DIR, filename), buffer);
  return `/uploads/receipts/${filename}`;
}
