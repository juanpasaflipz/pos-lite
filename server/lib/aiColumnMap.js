// AI cold start for delivery-export column mapping.
//
// Runs ONLY when a file layout is unknown to the registry (migration 0102) AND
// the candidate lists in salesImport.js failed to find the fields that matter.
// After the first tenant confirms that layout, the registry answers and this
// file is never called for it again — so this is a per-format cost, not a
// per-upload one.
//
// What it does and does not do:
//   DOES  — read a list of Spanish/English column names plus a few sample rows
//           and say which column is the gross, which is the platform fee, etc.
//           That is semantic disambiguation, which is what a model is good at:
//           Rappi's Detalle tab carries "Uso y alquiler de plataforma Rappi",
//           "Ventas base por Uso y alquiler...", and "IVA Uso y alquiler..."
//           side by side, and only one of them is the commission.
//   DOES NOT — compute anything. No totals, no quantities, no commission math.
//           Those stay in the deterministic code in salesImport.js. A model
//           that hallucinates a column name yields a mapping the user visibly
//           corrects; a model that hallucinates a NUMBER silently corrupts
//           revenue and stock. It never sees a figure it could get wrong.
//
// The result is a suggestion shown in the preview for confirmation, exactly
// like heuristic detection — salesImport.js already treats detection as
// "a HINT, never truth" and this changes nothing about that.

import { fetchWithTimeout } from './http.js';
import { modelFor } from './aiModels.js';

const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = modelFor('sales_import_mapping');

const SAMPLE_ROWS = 3;
const MAX_CELL_CHARS = 48;
const MAX_HEADERS = 120;

// Logical fields per parser, with the meaning the model has to distinguish.
// Deliberately worded around the traps the real exports contain.
const FIELD_GUIDE = {
  settlement: `
- external_order_id: the platform's unique id for ONE order. Must vary row to row. A store id or branch id repeated on every row is NOT this.
- business_date: the date the order happened or was billed.
- order_count: number of orders represented by the row. Only present in daily-summary files, where one row is one DAY. Absent in per-order files.
- avg_ticket: average value per order, if the file states it.
- gross: total sales BEFORE the platform's commission is taken out. Prefer a column that is sales revenue, not a fee, tax, or payout.
- commission: the fee the PLATFORM charges the restaurant. Beware lookalikes: a sales base used to compute the fee, a VAT/IVA line on the fee, and penalty fees are all different columns.
- commission_rebate: a credit that gives commission back during a promo. Cancels part or all of the commission.
- net: what the platform actually deposits after fees.`,
  products: `
- business_date: the date the sales happened.
- item_name: the name of the PRODUCT sold. Beware lookalikes: store name, branch name, and signatory name are constant on every row and are NOT this.
- quantity: units sold, if the file states a count. Often absent.
- gross: sales value for that product on that date. Strongly prefer a column measured at LIST price ("sin descuento" / undiscounted) over one net of promotions, because units are derived by dividing by unit price and only the undiscounted figure divides evenly.`,
};

const FIELDS = {
  settlement: ['external_order_id', 'business_date', 'order_count', 'avg_ticket', 'gross', 'commission', 'commission_rebate', 'net'],
  products: ['business_date', 'item_name', 'quantity', 'gross'],
};

function buildPrompt(kind, headers, sampleRows) {
  const cols = headers.map((h, i) => {
    const samples = sampleRows
      .map((r) => String(r?.[h] ?? '').trim().slice(0, MAX_CELL_CHARS))
      .filter(Boolean);
    return `${i + 1}. ${JSON.stringify(h)}${samples.length ? `  e.g. ${samples.map((s) => JSON.stringify(s)).join(', ')}` : ''}`;
  }).join('\n');

  return `A restaurant is uploading a sales export from a food-delivery platform (Rappi, DiDi Food, Uber Eats or similar). The files are usually in Mexican Spanish. Identify which column holds which piece of information.

COLUMNS IN THIS FILE (name, then a few example values):
${cols}

FIELDS TO FIND:
${FIELD_GUIDE[kind]}

Rules:
- Use a column name EXACTLY as written above, or null if this file has no column for that field.
- Never assign the same column to two fields.
- null is the right answer when you are unsure. A wrong column silently books wrong money; a null just asks the restaurant owner to pick.

Reply with only a JSON object, no prose:
{${FIELDS[kind].map((f) => `"${f}": string|null`).join(', ')}}`;
}

/**
 * Ask Claude which column feeds which logical field.
 *
 * @param {'settlement'|'products'} kind
 * @param {string[]} headers   column names, exactly as the file wrote them
 * @param {object[]} rows      raw parsed rows; only the first few are sampled
 * @returns {Promise<object|null>} mapping, or null if unavailable/unusable
 */
export async function aiDetectMapping(kind, headers, rows) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  if (!FIELDS[kind]) return null;

  const cols = (headers || []).slice(0, MAX_HEADERS);
  if (!cols.length) return null;

  try {
    const res = await fetchWithTimeout(CLAUDE_URL, {
      timeoutMs: 20000,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 1024,
        messages: [{ role: 'user', content: buildPrompt(kind, cols, (rows || []).slice(0, SAMPLE_ROWS)) }],
      }),
    });

    if (!res.ok) {
      console.warn(`[aiColumnMap] ${res.status}: ${await res.text().catch(() => '')}`);
      return null;
    }
    const data = await res.json();
    const u = data.usage || {};
    console.log(`[aiColumnMap] ${kind} cols=${cols.length} tokens in=${u.input_tokens ?? 0} out=${u.output_tokens ?? 0}`);

    return coerceMapping(data.content?.[0]?.text || '', kind, cols);
  } catch (err) {
    // Cold-start assist only — a failure here just means the user maps the
    // columns by hand in the preview, which already works.
    console.warn('[aiColumnMap] skipped:', err.message);
    return null;
  }
}

/**
 * Parse and sanitize the model's answer.
 *
 * Every returned column name is checked against the real header list and any
 * value that isn't an exact header is dropped — a hallucinated column would
 * otherwise be silently read as "no such data" downstream, or worse, matched
 * loosely. Duplicate assignments are dropped too, matching the guarantee
 * detectMapping() already makes.
 */
export function coerceMapping(text, kind, headers) {
  const match = String(text).match(/\{[\s\S]*\}/);
  if (!match) return null;

  let raw;
  try {
    raw = JSON.parse(match[0]);
  } catch {
    return null;
  }

  const valid = new Set(headers);
  const taken = new Set();
  const mapping = {};
  let hits = 0;

  for (const field of FIELDS[kind]) {
    const value = raw?.[field];
    if (typeof value === 'string' && valid.has(value) && !taken.has(value)) {
      mapping[field] = value;
      taken.add(value);
      hits++;
    } else {
      mapping[field] = null;
    }
  }

  return hits > 0 ? mapping : null;
}
