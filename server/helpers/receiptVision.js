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
import { all } from '../db/index.js';

const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = 'claude-sonnet-4-6';

const ALLOWED_MEDIA = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

const RECEIPT_VISION_PROMPT = `You parse a photo from a Mexican restaurant operator. The photo is one of these document types (don't ask which — just read what you see):
  - Preprinted "Nota de Venta" or "Remisión" with handwritten line items
  - Thermal payment terminal slip (Fiserv, clip.mx, Mercado Pago) — usually total + card mask only
  - Handwritten shopping list with prices
  - Standard printed supermarket receipt

You will receive an INVENTORY list (id, name, unit). Bind each line in the photo to the closest inventory id when confident; accept colloquial Spanish (jitomate=tomate, aguacate, cebolla, chiles secos, etc.). If no confident match, set inventory_item_id=null and put the written description in raw_name.

Return ONLY valid JSON, no prose:
{
  "intent": "record_purchase" | "unknown",
  "confidence": number (0-1),
  "clarifying_question": "string or null — Spanish, one short sentence if image is not a receipt",
  "items": [
    {
      "inventory_item_id": number | null,
      "menu_item_id": null,
      "raw_name": "string — item description as written",
      "quantity": number | null,
      "unit": "kg" | "g" | "l" | "ml" | "pcs" | "box" | "case" | null,
      "unit_price": number | null,
      "amount": number | null
    }
  ],
  "vendor": "string or null — supplier / store name as printed",
  "total_amount": number | null,
  "payment_method": "cash" | "card" | "transfer" | null,
  "note": "string or null — date, invoice number, or other useful context"
}

Rules:
- If the photo is not a receipt/nota/shopping list (e.g. food, person, room, screenshot of something else), set intent="unknown" and put a Spanish clarifying_question like "Esa foto no parece un recibo. ¿Qué quieres registrar?".
- A payment terminal slip with only a total is STILL intent="record_purchase" — leave items=[] and populate total_amount + payment_method. The owner will pair it with the matching nota later.
- Numbers as JSON numbers — no currency symbols, no thousands separators.
- Convert weights to kg/L when sensible. If a unit can't be determined, use null. Do not guess.
- Skip subtotal/tax/change/discount/loyalty lines from items[].
- If there is a CAPTION from the owner, use it as a hint for vendor/category.`;

function buildUserContent(inventory, caption) {
  const lines = inventory.slice(0, 150).map(
    (i) => `- id=${i.id} name="${i.name}" unit=${i.unit || ''}`
  );
  const captionLine = caption ? `\n\nCAPTION FROM OWNER: "${caption}"` : '';
  return `INVENTORY:\n${lines.join('\n')}${captionLine}\n\nParse the attached photo.`;
}

export async function parseReceiptImage(imageBuffer, mediaType, caption) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

  const inventory = await all(
    'SELECT id, name, unit FROM inventory_items ORDER BY name ASC LIMIT 150'
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
  const uploadsDir = path.resolve(process.cwd(), 'uploads', 'receipts');
  await fs.mkdir(uploadsDir, { recursive: true });
  await fs.writeFile(path.join(uploadsDir, filename), buffer);
  return `/uploads/receipts/${filename}`;
}
