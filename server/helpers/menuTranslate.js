// Translate a menu item's Spanish name + description into English via Claude,
// so the kiosk can render EN when the customer flips the language toggle.
// Spanish stays the source of truth; the EN copy is a write-through cache
// stored in menu_items.name_en / description_en.
//
// Called fire-and-forget from the menu create/update handlers so the write
// stays fast — see server/routes/menu.js. The kiosk falls back to the ES
// original when a translation hasn't landed yet.

const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';
import { modelFor } from '../lib/aiModels.js';

const CLAUDE_MODEL = modelFor('menu_translate');

const SYSTEM_PROMPT = `You translate one Mexican restaurant menu item from Spanish to natural, appetizing US English.

Rules:
- Keep proper nouns, brand names, and regional dish names untranslated ("California", "Chimichanga", "Al Pastor", "Pollos Hermanos", "Juanberto's").
- Where a dish name is a well-known Spanish word for an ingredient (asada, lengua, camarón, pollo), use the English equivalent in the item name if it reads more naturally to a US customer (e.g. "Burrito de Lengua" → "Beef Tongue Burrito"), but always keep parentheticals like "(el de la casa)" as parentheticals with a translated inside.
- Translate the description faithfully. Don't add ingredients that aren't there. Don't invent marketing copy.
- Preserve any weight/measure the Spanish uses (kilo, 1/4, ½, etc.) as-is.
- Preserve punctuation and casing style of the source.
- If either input is empty, return an empty string in the corresponding output.

Return ONLY valid JSON in this shape:
{ "name_en": "string", "description_en": "string" }`;

/**
 * Translate a single menu item's name + description.
 * Returns { name_en, description_en } — either may be empty string.
 * Throws on network/parse errors so callers can log; safe to try/catch.
 */
export async function translateMenuItem({ name, description }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

  const es = {
    name: String(name || '').trim(),
    description: String(description || '').trim(),
  };
  if (!es.name && !es.description) {
    return { name_en: '', description_en: '' };
  }

  const res = await fetch(CLAUDE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    signal: AbortSignal.timeout(15000),
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 512,
      system: SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: `Item to translate:\nname: "${es.name}"\ndescription: "${es.description}"\n\nReturn the JSON.`,
      }],
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
  return {
    name_en: String(parsed.name_en || '').trim(),
    description_en: String(parsed.description_en || '').trim(),
  };
}
