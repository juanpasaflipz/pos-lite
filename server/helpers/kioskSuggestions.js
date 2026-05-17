/**
 * Kiosk suggestion engine.
 *
 * Turns a customer's order history + the restaurant's business priorities
 * into a small set of personalized menu suggestions for the self-service
 * kiosk. The "intelligence" lives in three layers:
 *
 *   1. Taste profile  — what THIS customer actually orders (live SQL over
 *      orders + order_items + order_item_modifiers, keyed on loyalty_customer_id).
 *   2. Business feed   — what the restaurant needs to move (slow sellers,
 *      over-stocked ingredients) so suggestions also create value on the spot.
 *   3. Synthesis       — Claude blends 1 + 2 into warm, human suggestions.
 *      Policy: CUSTOMER FIRST. Business priorities only ever break a tie
 *      between things the customer would already love.
 *
 * DB-reading functions here expect to run inside withTenant() (RLS scoped).
 * The Claude call (synthesizeAISuggestions) does NOT touch the DB and must
 * run OUTSIDE the tenant transaction so a slow network call doesn't pin a
 * pooled connection.
 */

import { get, all } from '../db/index.js';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const PAID = "('paid','completed')";

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/* ==================== Day / time context ==================== */

export function getDayContext(timezone = 'UTC') {
  const tz = timezone || 'UTC';
  let hour = new Date().getUTCHours();
  let dayName = '';
  try {
    const parts = new Intl.DateTimeFormat('es-MX', {
      timeZone: tz,
      hour: 'numeric',
      hour12: false,
      weekday: 'long',
    }).formatToParts(new Date());
    hour = parseInt(parts.find((p) => p.type === 'hour')?.value ?? hour, 10);
    dayName = parts.find((p) => p.type === 'weekday')?.value ?? '';
  } catch {
    /* keep UTC defaults */
  }
  let daypart = 'el día';
  if (hour < 11) daypart = 'la mañana';
  else if (hour < 16) daypart = 'la comida';
  else if (hour < 20) daypart = 'la tarde';
  else daypart = 'la noche';
  return { hour, dayName, daypart };
}

/* ==================== DB reads (run inside withTenant) ==================== */

/**
 * Build a taste profile for one loyalty customer from their paid order history.
 */
export async function buildTasteProfile(customerId, timezone = 'UTC') {
  const tz = timezone || 'UTC';

  const stats = await get(
    `SELECT COUNT(*)::int           AS order_count,
            COALESCE(SUM(total),0)::float  AS total_spent,
            COALESCE(AVG(total),0)::float  AS avg_ticket,
            MIN(created_at)         AS first_visit,
            MAX(created_at)         AS last_visit
       FROM orders
      WHERE loyalty_customer_id = $1 AND payment_status IN ${PAID}`,
    [customerId]
  );

  const topItems = await all(
    `SELECT oi.menu_item_id,
            oi.item_name,
            SUM(oi.quantity)::int        AS units,
            COUNT(DISTINCT o.id)::int    AS orders_with
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
      WHERE o.loyalty_customer_id = $1
        AND o.payment_status IN ${PAID}
        AND oi.menu_item_id IS NOT NULL
      GROUP BY oi.menu_item_id, oi.item_name
      ORDER BY units DESC, orders_with DESC
      LIMIT 8`,
    [customerId]
  );

  const topCategories = await all(
    `SELECT mc.name AS category, SUM(oi.quantity)::int AS units
       FROM order_items oi
       JOIN orders o        ON o.id = oi.order_id
       JOIN menu_items mi   ON mi.id = oi.menu_item_id
       JOIN menu_categories mc ON mc.id = mi.category_id
      WHERE o.loyalty_customer_id = $1 AND o.payment_status IN ${PAID}
      GROUP BY mc.name
      ORDER BY units DESC
      LIMIT 5`,
    [customerId]
  );

  const modifiers = await all(
    `SELECT oim.modifier_name, COUNT(*)::int AS times
       FROM order_item_modifiers oim
       JOIN order_items oi ON oi.id = oim.order_item_id
       JOIN orders o       ON o.id = oi.order_id
      WHERE o.loyalty_customer_id = $1 AND o.payment_status IN ${PAID}
      GROUP BY oim.modifier_name
      ORDER BY times DESC
      LIMIT 5`,
    [customerId]
  );

  let favoriteHours = [];
  try {
    const hours = await all(
      `SELECT EXTRACT(HOUR FROM created_at AT TIME ZONE $2)::int AS hour,
              COUNT(*)::int AS visits
         FROM orders
        WHERE loyalty_customer_id = $1 AND payment_status IN ${PAID}
        GROUP BY hour
        ORDER BY visits DESC
        LIMIT 3`,
      [customerId, tz]
    );
    favoriteHours = hours.map((h) => h.hour);
  } catch {
    favoriteHours = [];
  }

  let daysSinceLastVisit = null;
  if (stats?.last_visit) {
    daysSinceLastVisit = Math.floor(
      (Date.now() - new Date(stats.last_visit).getTime()) / 86400000
    );
  }

  return {
    orderCount: stats?.order_count || 0,
    totalSpent: round2(stats?.total_spent),
    avgTicket: round2(stats?.avg_ticket),
    firstVisit: stats?.first_visit || null,
    lastVisit: stats?.last_visit || null,
    daysSinceLastVisit,
    topItems,
    topCategories,
    modifiers,
    favoriteHours,
  };
}

/**
 * The customer's most recent paid order — powers the one-tap "repeat" lane.
 * Only returns items that are still on the active menu.
 */
export async function getRepeatOrder(customerId) {
  const last = await get(
    `SELECT id, created_at
       FROM orders
      WHERE loyalty_customer_id = $1 AND payment_status IN ${PAID}
      ORDER BY created_at DESC
      LIMIT 1`,
    [customerId]
  );
  if (!last) return null;

  const items = await all(
    `SELECT oi.menu_item_id,
            mi.name        AS item_name,
            oi.quantity,
            mi.price::float AS price,
            mi.image_url
       FROM order_items oi
       JOIN menu_items mi ON mi.id = oi.menu_item_id
      WHERE oi.order_id = $1
        AND oi.menu_item_id IS NOT NULL
        AND mi.active = true`,
    [last.id]
  );
  if (!items.length) return null;
  return { orderId: last.id, orderedAt: last.created_at, items };
}

/** Active menu, flattened with category name — used for prompts and hydration. */
export async function getActiveMenu() {
  return all(
    `SELECT mi.id,
            mi.name,
            mi.price::float AS price,
            mi.description,
            mi.image_url,
            mc.name AS category
       FROM menu_items mi
       JOIN menu_categories mc ON mc.id = mi.category_id
      WHERE mi.active = true AND mc.active = true
      ORDER BY mc.sort_order NULLS LAST, mi.sort_order, mi.id`
  );
}

/**
 * Business-priority feed: what the restaurant should try to move.
 *  - slowMovers: active items with the weakest 45-day sales (puzzles to push)
 *  - overstock:  active items linked to heavily over-stocked ingredients
 */
export async function buildBusinessFeed() {
  const slowMovers = await all(
    `SELECT mi.id,
            mi.name,
            mi.price::float AS price,
            mc.name AS category,
            COALESCE(SUM(oi.quantity) FILTER (
              WHERE o.created_at > NOW() - INTERVAL '45 days'
                AND o.payment_status IN ${PAID}
            ), 0)::int AS units_45d
       FROM menu_items mi
       JOIN menu_categories mc ON mc.id = mi.category_id
       LEFT JOIN order_items oi ON oi.menu_item_id = mi.id
       LEFT JOIN orders o       ON o.id = oi.order_id
      WHERE mi.active = true
      GROUP BY mi.id, mi.name, mi.price, mc.name
      ORDER BY units_45d ASC, mi.price DESC
      LIMIT 10`
  );

  let overstock = [];
  try {
    overstock = await all(
      `SELECT DISTINCT mi.id,
              mi.name,
              mi.price::float AS price,
              mc.name AS category,
              ii.name AS ingredient
         FROM inventory_items ii
         JOIN menu_item_ingredients mii ON mii.inventory_item_id = ii.id
         JOIN menu_items mi            ON mi.id = mii.menu_item_id
         JOIN menu_categories mc       ON mc.id = mi.category_id
        WHERE mi.active = true
          AND ii.low_stock_threshold IS NOT NULL
          AND ii.low_stock_threshold > 0
          AND ii.quantity > ii.low_stock_threshold * 4
        LIMIT 8`
    );
  } catch {
    overstock = [];
  }

  return { slowMovers, overstock };
}

/**
 * Time-of-day popular items — the smart fallback for anonymous customers.
 * Top sellers within ±2h of the current hour over the last 30 days.
 */
export async function getPopularItems(timezone = 'UTC', limit = 6) {
  const tz = timezone || 'UTC';
  let rows = [];
  try {
    rows = await all(
      `WITH cur AS (SELECT EXTRACT(HOUR FROM NOW() AT TIME ZONE $1)::int AS h)
       SELECT mi.id,
              mi.name,
              mi.price::float AS price,
              mi.image_url,
              mc.name AS category,
              SUM(oi.quantity)::int AS units
         FROM order_items oi
         JOIN orders o          ON o.id = oi.order_id
         JOIN menu_items mi     ON mi.id = oi.menu_item_id
         JOIN menu_categories mc ON mc.id = mi.category_id, cur
        WHERE mi.active = true
          AND o.payment_status IN ${PAID}
          AND o.created_at > NOW() - INTERVAL '30 days'
          AND ABS(EXTRACT(HOUR FROM o.created_at AT TIME ZONE $1)::int - cur.h) <= 2
        GROUP BY mi.id, mi.name, mi.price, mi.image_url, mc.name
        ORDER BY units DESC
        LIMIT $2`,
      [tz, limit]
    );
  } catch {
    rows = [];
  }
  if (!rows.length) {
    rows = await all(
      `SELECT mi.id,
              mi.name,
              mi.price::float AS price,
              mi.image_url,
              mc.name AS category,
              COALESCE(SUM(oi.quantity), 0)::int AS units
         FROM menu_items mi
         JOIN menu_categories mc ON mc.id = mi.category_id
         LEFT JOIN order_items oi ON oi.menu_item_id = mi.id
        WHERE mi.active = true
        GROUP BY mi.id, mi.name, mi.price, mi.image_url, mc.name
        ORDER BY units DESC, mi.sort_order
        LIMIT $1`,
      [limit]
    );
  }
  return rows;
}

/* ==================== AI synthesis (no DB — runs outside withTenant) ==================== */

function extractJson(text) {
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function cleanReason(reason, fallback) {
  let r = typeof reason === 'string' ? reason.trim() : '';
  r = r.replace(/^["'“”]+|["'“”]+$/g, '').trim();
  if (!r) return fallback;
  if (r.length > 90) r = r.slice(0, 87).trimEnd() + '…';
  return r;
}

/**
 * Ask Claude to blend the taste profile with the business feed.
 * Returns { for_you: [...], house: {...}|null } or null if anything fails —
 * callers MUST fall back to deterministicSuggestions().
 */
export async function synthesizeAISuggestions({
  customer,
  profile,
  repeatOrder,
  menu,
  businessFeed,
  dayCtx,
  stamp,
}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  if (!menu.length) return null;

  const menuLines = menu
    .map(
      (m) =>
        `#${m.id} | ${m.name} | $${round2(m.price)} | ${m.category}` +
        (m.description ? ` | ${String(m.description).slice(0, 70)}` : '')
    )
    .join('\n');

  const topItemLine = profile.topItems.length
    ? profile.topItems.map((i) => `${i.item_name} (${i.units}x)`).join(', ')
    : 'sin historial';
  const catLine = profile.topCategories.map((c) => c.category).join(', ') || 'n/a';
  const modLine = profile.modifiers.length
    ? profile.modifiers.map((m) => `${m.modifier_name} (${m.times}x)`).join(', ')
    : 'ninguna';
  const repeatLine = repeatOrder
    ? repeatOrder.items.map((i) => `${i.quantity}x ${i.item_name}`).join(', ')
    : 'n/a';

  const bizLines =
    [
      ...businessFeed.slowMovers
        .slice(0, 8)
        .map((s) => `#${s.id} ${s.name} — venta lenta`),
      ...businessFeed.overstock
        .slice(0, 6)
        .map((s) => `#${s.id} ${s.name} — sobre-inventario de ${s.ingredient}`),
    ].join('\n') || 'ninguna';

  const system = `Eres el motor de recomendaciones de un kiosko de autoservicio de un restaurante. Tu tarea: elegir qué platillos sugerirle a un cliente que acaba de identificarse, para que pida algo que de verdad va a disfrutar.

REGLAS (en orden de importancia):
1. EL CLIENTE VA PRIMERO, SIEMPRE. Cada sugerencia debe ser algo que ESTA persona realmente querría según su historial de pedidos y preferencias.
2. Las prioridades del negocio (venta lenta, sobre-inventario) son SOLO un desempate: entre dos opciones que al cliente le gustarían por igual, elige la que ayuda al negocio. Nunca sugieras algo que no le quede al cliente solo porque al negocio le conviene.
3. Solo puedes usar platillos del MENÚ, referenciados por su número (#id). Jamás inventes platillos ni números.
4. "for_you" = 2 o 3 sugerencias personalizadas. "house" = 1 sugerencia que ayude al negocio Y que de verdad le quede a este cliente; si ninguna de las prioridades del negocio le queda bien, devuelve null.
5. No repitas en "house" un platillo que ya pusiste en "for_you".
6. Las razones van en español de México, cálidas y breves (máximo 80 caracteres), habladas de tú al cliente. Puedes usar su nombre o un emoji ocasional. Sin comillas dentro del texto.

Responde ÚNICAMENTE con un objeto JSON válido. Sin markdown, sin explicaciones.`;

  const user = `CLIENTE: ${customer.name}
- Visitas previas: ${profile.orderCount}
- Ticket promedio: $${profile.avgTicket}
- Última visita hace: ${profile.daysSinceLastVisit ?? 'n/a'} días
- Platillos favoritos: ${topItemLine}
- Categorías favoritas: ${catLine}
- Modificadores preferidos: ${modLine}
- Su última orden: ${repeatLine}
${stamp ? `- Tarjeta de sellos: ${stamp.earned}/${stamp.required} (premio: ${stamp.reward_description})` : ''}

CONTEXTO: hoy es ${dayCtx.dayName || 'día de semana'}, por ${dayCtx.daypart}.

MENÚ DISPONIBLE (id | nombre | precio | categoría | descripción):
${menuLines}

PRIORIDADES DEL NEGOCIO (úsalas SOLO como desempate):
${bizLines}

Devuelve exactamente esta estructura:
{
  "for_you": [ { "menu_item_id": 0, "reason": "" } ],
  "house": { "menu_item_id": 0, "reason": "" }
}`;

  try {
    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        system,
        messages: [{ role: 'user', content: user }],
      }),
    });
    if (!response.ok) {
      console.error(
        '[kiosk/suggest] Claude API error',
        response.status,
        await response.text().catch(() => '')
      );
      return null;
    }
    const data = await response.json();
    const text = (data.content || [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('');
    const parsed = extractJson(text);
    if (!parsed || !Array.isArray(parsed.for_you)) return null;
    return parsed;
  } catch (err) {
    console.error('[kiosk/suggest] Claude call failed:', err.message);
    return null;
  }
}

/* ==================== Deterministic fallback ==================== */

/**
 * History-only suggestions — used for the Free plan, when Claude is
 * unavailable, or when AI returns nothing usable. No network calls.
 */
export function deterministicSuggestions({ profile, menu, businessFeed }) {
  const menuIds = new Set(menu.map((m) => m.id));
  const favCats = new Set((profile?.topCategories || []).map((c) => c.category));

  const for_you = [];
  for (const it of profile?.topItems || []) {
    if (for_you.length >= 3) break;
    if (!menuIds.has(it.menu_item_id)) continue;
    for_you.push({
      menu_item_id: it.menu_item_id,
      reason: `Tu favorito — lo has pedido ${it.units} ${it.units === 1 ? 'vez' : 'veces'}`,
    });
  }

  let house = null;
  const chosen = new Set(for_you.map((f) => f.menu_item_id));
  const candidates = [...businessFeed.overstock, ...businessFeed.slowMovers];
  // Customer-first: prefer a business pick inside one of their favorite categories.
  const fit =
    candidates.find(
      (c) => favCats.has(c.category) && !chosen.has(c.id) && menuIds.has(c.id)
    ) || null;
  if (fit) {
    house = { menu_item_id: fit.id, reason: 'Recomendación de la casa para hoy' };
  }

  return { for_you, house };
}

/* ==================== Compose final payload ==================== */

function hydrate(rawList, menuById, lane, source) {
  const out = [];
  const seen = new Set();
  for (const r of rawList || []) {
    const id = Number(r?.menu_item_id);
    if (!Number.isInteger(id) || seen.has(id)) continue;
    const m = menuById.get(id);
    if (!m) continue;
    seen.add(id);
    out.push({
      menu_item_id: id,
      name: m.name,
      price: round2(m.price),
      image_url: m.image_url,
      category: m.category,
      reason: cleanReason(r.reason, defaultReason(lane)),
      lane,
      source,
    });
  }
  return out;
}

function defaultReason(lane) {
  if (lane === 'house') return 'Recomendación de la casa';
  return 'Creemos que te va a gustar';
}

/**
 * Merge the AI result (or deterministic fallback) with the repeat-order lane
 * into the final suggestions payload sent to the kiosk.
 */
export function composeSuggestions({ profile, repeatOrder, menu, businessFeed, aiResult }) {
  const menuById = new Map(menu.map((m) => [m.id, m]));

  // "usual" lane = one-tap repeat of the last order
  let usual = null;
  if (repeatOrder && repeatOrder.items.length) {
    const items = repeatOrder.items.map((i) => ({
      menu_item_id: i.menu_item_id,
      name: i.item_name,
      price: round2(i.price),
      image_url: i.image_url,
      quantity: i.quantity,
    }));
    usual = {
      order_id: repeatOrder.orderId,
      reason: 'Pide otra vez lo de siempre',
      items,
      total: round2(items.reduce((s, i) => s + i.price * i.quantity, 0)),
    };
  }

  let for_you = [];
  let house = null;
  let source = 'ai';

  if (aiResult) {
    for_you = hydrate(aiResult.for_you, menuById, 'for_you', 'ai');
    const h = aiResult.house ? hydrate([aiResult.house], menuById, 'house', 'ai') : [];
    house = h[0] || null;
  }

  if (for_you.length === 0) {
    const det = deterministicSuggestions({ profile, menu, businessFeed });
    for_you = hydrate(det.for_you, menuById, 'for_you', 'deterministic');
    if (!house) {
      const dh = det.house ? hydrate([det.house], menuById, 'house', 'deterministic') : [];
      house = dh[0] || null;
    }
    source = for_you.length ? 'deterministic' : 'none';
  }

  // de-dupe: "house" must not echo a "for_you" or "usual" item
  const taken = new Set([
    ...for_you.map((f) => f.menu_item_id),
    ...(usual ? usual.items.map((i) => i.menu_item_id) : []),
  ]);
  if (house && taken.has(house.menu_item_id)) house = null;

  return { usual, for_you: for_you.slice(0, 3), house, source };
}
