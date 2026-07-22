import { fetchWithTimeout } from '../lib/http.js';
// Recipe text → structured ingredient lines via Claude.
//
// Input: a free-text recipe pasted by the owner. Mixed Spanish/English,
//        decimal/integer quantities, gramos/gr/g/kg/ml/L/pcs/piezas/unidades.
// Output: [{ qty: number, unit: string, name: string, raw: string }, ...]
//
// We deliberately do NOT try to match against inventory here — that lives
// in the preview endpoint so unit tests and the UI can also drive matching
// without an LLM call.

const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';
import { modelFor } from '../lib/aiModels.js';

const CLAUDE_MODEL = modelFor('recipe_parse');

const SYSTEM_PROMPT = `You parse a restaurant recipe written in Spanish or English into structured ingredient lines.

Return ONLY valid JSON in this exact shape:
{
  "lines": [
    { "qty": number, "unit": "string", "name": "string", "raw": "string" }
  ]
}

Rules:
- "qty" is the numeric quantity as a JSON number (not a string). Convert fractions ("1/2" → 0.5).
- "unit" is lowercase, normalized to one of: g, kg, ml, l, pcs, oz, lb. Map "gramos"/"grs"/"gr" → "g"; "kilos"/"kg" → "kg"; "mililitros" → "ml"; "litros" → "l"; "piezas"/"pza"/"pieza"/"unidades"/"unidad" → "pcs".
- "name" is the ingredient name, trimmed, in the original language. Strip the quantity and unit.
- "raw" is the original line verbatim.
- If a line has no clear quantity, set qty=0 and unit="" but still include it.
- Ignore section headers, blank lines, recipe titles, and instructions ("mezclar", "calentar", "sirve para...").
- Each output line corresponds to exactly one input ingredient line.`;

export async function parseRecipeText(text) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

  const trimmed = String(text || '').trim();
  if (!trimmed) return { lines: [] };

  const res = await fetchWithTimeout(CLAUDE_URL, { timeoutMs: 30000,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `RECIPE TEXT:\n"""\n${trimmed}\n"""\n\nParse it.` }],
    }),
  });

  if (!res.ok) {
    throw new Error(`Claude ${res.status}: ${await res.text().catch(() => '')}`);
  }
  const data = await res.json();
  const raw = data.content?.[0]?.text || '';
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Claude returned no JSON');
  const parsed = JSON.parse(match[0]);
  const lines = Array.isArray(parsed.lines) ? parsed.lines : [];
  return {
    lines: lines.map((l) => ({
      qty: Number(l.qty) || 0,
      unit: String(l.unit || '').toLowerCase().trim(),
      name: String(l.name || '').trim(),
      raw: String(l.raw || '').trim(),
    })).filter((l) => l.name),
  };
}
