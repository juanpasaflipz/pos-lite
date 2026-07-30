// Match a delivery platform's product name against the tenant's POS menu.
//
// Platform menus are maintained separately from the POS menu and drift: DiDi
// bills "PORK BELLY BURRITO" for what the POS calls "Porkbelly", and
// "Bean-n-Cheese Burrito" for "Bean & Cheese". Some platform items have no POS
// row at all (virtual-brand SKUs), which must come back as "no match" rather
// than a forced wrong one — a bad match deducts the wrong ingredients.
//
// Pure and DB-free so it can be unit tested. Every result is a SUGGESTION the
// tenant confirms once; the confirmed answer is persisted to platform_item_map
// and this matcher never runs for that name again.

const norm = (s) => String(s || '')
  .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

/** Alphanumeric-only form, so "Porkbelly" and "PORK BELLY" collapse together. */
const squash = (s) => norm(s).replace(/[^a-z0-9]/g, '');

// Stem a trailing plural 's', but only on tokens long enough that we are not
// eating a meaningful ending.
const stem = (t) => (t.length > 4 && t.endsWith('s') ? t.slice(0, -1) : t);
const tokens = (s) => new Set(
  norm(s).split(/[^a-z0-9]+/).filter((t) => t.length >= 3).map(stem)
);

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let intersect = 0;
  for (const t of a) if (b.has(t)) intersect++;
  return intersect / (a.size + b.size - intersect);
}

const MIN_SQUASH_LEN = 5; // below this, containment is noise ("res" in "fresa")
const MIN_FUZZY_SCORE = 0.4;

/**
 * @param {string} platformName    product name exactly as the export wrote it
 * @param {Array<{id:number,name:string,price:number|string}>} menuItems
 * @returns {{ menu_item_id:number|null, name:string|null, price:number|null,
 *             confidence:'exact'|'contains'|'fuzzy'|'none',
 *             candidates:Array<{menu_item_id:number,name:string,price:number,score:number}> }}
 */
export function matchPlatformItem(platformName, menuItems) {
  const items = menuItems || [];
  const n = norm(platformName);
  const sq = squash(platformName);

  const shape = (item, confidence, candidates = []) => ({
    menu_item_id: item ? Number(item.id) : null,
    name: item ? item.name : null,
    price: item ? Number(item.price) || null : null,
    confidence,
    candidates,
  });

  if (!n) return shape(null, 'none');

  // 1. exact
  const exact = items.find((i) => norm(i.name) === n);
  if (exact) return shape(exact, 'exact');

  // 2. squashed containment either direction — catches spacing/punctuation
  //    differences ("PORK BELLY BURRITO" -> "Porkbelly").
  if (sq.length >= MIN_SQUASH_LEN) {
    const hit = items.find((i) => {
      const si = squash(i.name);
      if (si.length < MIN_SQUASH_LEN) return false;
      return si.includes(sq) || sq.includes(si);
    });
    if (hit) return shape(hit, 'contains');
  }

  // 3. token overlap — keep the top 3 either way so the UI can offer them even
  //    when nothing clears the bar.
  const platformTokens = tokens(platformName);
  const scored = items
    .map((i) => ({ item: i, score: jaccard(platformTokens, tokens(i.name)) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  const candidates = scored.map((s) => ({
    menu_item_id: Number(s.item.id),
    name: s.item.name,
    price: Number(s.item.price) || 0,
    score: Number(s.score.toFixed(2)),
  }));

  if (scored[0] && scored[0].score >= MIN_FUZZY_SCORE) {
    return shape(scored[0].item, 'fuzzy', candidates);
  }
  return shape(null, 'none', candidates);
}
