// AI menu builder: turn free text ("taquería de pastor", a pasted menu, a
// description) into a structured menu payload for bulkInsertMenu.
//
// Same Claude setup as menuTranslate.js (ANTHROPIC_API_KEY, direct fetch).
// Returns the AIMenuParseResult shape the frontend expects:
//   { success: true, data: { categories: [...], items: [...] } }
//   { success: false, error: '...' }

const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = 'claude-sonnet-4-6';

const SYSTEM_PROMPT = `Eres un experto en menús de restaurantes en México. El usuario te da texto libre: puede ser un menú pegado, una lista de platillos, o solo una descripción del negocio (p. ej. "taquería de pastor").

Tu trabajo: producir un menú estructurado y realista en español.

Reglas:
- Si el texto YA contiene platillos y precios, transcríbelos fielmente (no inventes ni cambies precios existentes; corrige solo mayúsculas/ortografía obvia).
- Si el texto es solo una descripción del negocio, GENERA un menú inicial típico y bien pensado para ese tipo de negocio: 3-4 categorías, 10-16 platillos en total, con precios realistas en pesos mexicanos (MXN) para un negocio de servicio rápido.
- Nombres de platillos en español, descripciones cortas y apetitosas (máx. 90 caracteres), sin inventar ingredientes si el texto los especifica.
- prep_time_minutes: estimación razonable (bebidas 1-3, antojitos 5-10, platos fuertes 12-20).
- Cada item debe referir una categoría por nombre exacto de la lista de categorías.
- Precios: números (pueden llevar centavos), sin símbolo.

Responde SOLO con JSON válido, sin markdown, con esta forma exacta:
{
  "categories": [{ "name": "string", "sort_order": 1 }],
  "items": [{ "name": "string", "category": "string", "price": 0, "description": "string", "prep_time_minutes": 5 }]
}`;

/**
 * Parse/generate a menu from free text.
 * Returns { success, data?, error? } — never throws for expected failures.
 */
export async function parseMenuText(text) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { success: false, error: 'AI no configurada (falta ANTHROPIC_API_KEY)' };
  }

  try {
    const res = await fetch(CLAUDE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      signal: AbortSignal.timeout(50000),
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 4000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: `Texto del usuario:\n\n${text}\n\nResponde con el JSON.` }],
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[MenuAI] Claude error ${res.status}: ${body.slice(0, 300)}`);
      return { success: false, error: 'El servicio de IA no está disponible en este momento' };
    }

    const json = await res.json();
    const raw = (json.content?.[0]?.text || '').trim();
    // Tolerate accidental markdown fences
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const data = JSON.parse(cleaned);

    if (!Array.isArray(data.categories) || !Array.isArray(data.items) || data.items.length === 0) {
      return { success: false, error: 'No se pudo interpretar el menú — intenta con más detalle' };
    }

    // Normalize + clamp
    data.categories = data.categories
      .filter(c => c && typeof c.name === 'string' && c.name.trim())
      .slice(0, 12)
      .map((c, idx) => ({ name: c.name.trim().slice(0, 60), sort_order: Number(c.sort_order) || idx + 1 }));

    const catNames = new Set(data.categories.map(c => c.name));
    data.items = data.items
      .filter(it => it && typeof it.name === 'string' && it.name.trim() && Number.isFinite(Number(it.price)))
      .slice(0, 80)
      .map(it => ({
        name: it.name.trim().slice(0, 80),
        category: catNames.has((it.category || '').trim()) ? it.category.trim() : (data.categories[0]?.name || 'Menú'),
        price: Math.max(0, Number(it.price)),
        description: typeof it.description === 'string' ? it.description.trim().slice(0, 160) : '',
        prep_time_minutes: Math.min(60, Math.max(1, Number(it.prep_time_minutes) || 8)),
      }));

    if (data.items.length === 0) {
      return { success: false, error: 'No se pudo interpretar el menú — intenta con más detalle' };
    }

    return { success: true, data: { categories: data.categories, items: data.items } };
  } catch (err) {
    console.error('[MenuAI] parse failed:', err.message);
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return { success: false, error: 'La IA tardó demasiado — intenta de nuevo' };
    }
    return { success: false, error: 'No se pudo interpretar el menú' };
  }
}
