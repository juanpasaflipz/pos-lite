// Match parsed recipe lines against the tenant's inventory.
//
// Strategy (in order, first hit wins):
//   1. exact case-insensitive name match
//   2. exact alias match (inventory_aliases)
//   3. ILIKE prefix / contains
//   4. token-overlap score (Jaccard on lowercase word sets) — top 3 candidates
//
// We also detect:
//   - zombie: matched inventory has stock=0 AND a same-prefix sibling has stock>0
//   - unit reconciliation needed: parsed unit ≠ inventory unit, no auto-convert
//
// Output per line:
//   { raw, qty, unit, name,
//     match: { inventory_item_id, name, unit, cost_price, stock,
//              confidence: "exact"|"alias"|"contains"|"fuzzy"|"none",
//              quantity_used,        // converted to inventory unit
//              unit_mismatch: bool,  // ask owner to confirm conversion
//              line_cost },
//     candidates: [{ inventory_item_id, name, score }],
//     zombie_warning: { sibling_name, sibling_id } | null
//   }

const UNIT_TO_GRAMS = { g: 1, kg: 1000, oz: 28.3495, lb: 453.592 };
const UNIT_TO_ML = { ml: 1, l: 1000 };

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();

// Stem trailing plural 's' so "tortilla" ⇄ "tortillas" overlap, but only on
// tokens long enough that we're not stripping meaningful endings.
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

function convertQuantity(qty, fromUnit, toUnit) {
  if (!qty) return { qty: 0, ok: true };
  const f = norm(fromUnit);
  const tt = norm(toUnit);
  if (f === tt) return { qty, ok: true };
  if (f in UNIT_TO_GRAMS && tt in UNIT_TO_GRAMS) {
    return { qty: (qty * UNIT_TO_GRAMS[f]) / UNIT_TO_GRAMS[tt], ok: true };
  }
  if (f in UNIT_TO_ML && tt in UNIT_TO_ML) {
    return { qty: (qty * UNIT_TO_ML[f]) / UNIT_TO_ML[tt], ok: true };
  }
  // pcs ↔ kg/g — never auto-convert; ask owner
  return { qty, ok: false };
}

export function matchRecipeLines(lines, inventory, aliases) {
  const aliasMap = new Map();
  for (const a of aliases || []) {
    aliasMap.set(norm(a.alias), a.inventory_item_id);
  }
  const invByNorm = new Map();
  for (const inv of inventory) invByNorm.set(norm(inv.name), inv);

  // Index siblings for zombie detection: group by first significant token
  const byPrefix = new Map();
  for (const inv of inventory) {
    const t = norm(inv.name).split(/\s+/)[0];
    if (!t) continue;
    if (!byPrefix.has(t)) byPrefix.set(t, []);
    byPrefix.get(t).push(inv);
  }

  return lines.map((line) => {
    const n = norm(line.name);
    let match = null;
    let confidence = 'none';
    let candidates = [];

    // 1. exact
    if (invByNorm.has(n)) {
      match = invByNorm.get(n);
      confidence = 'exact';
    }

    // 2. alias
    if (!match && aliasMap.has(n)) {
      const id = aliasMap.get(n);
      match = inventory.find((i) => i.id === id) || null;
      if (match) confidence = 'alias';
    }

    // 3. contains (either direction)
    if (!match) {
      const hit = inventory.find((i) => {
        const ni = norm(i.name);
        return ni.includes(n) || n.includes(ni);
      });
      if (hit) {
        match = hit;
        confidence = 'contains';
      }
    }

    // 4. token overlap — top 3 candidates, pick if best ≥ 0.4
    if (!match) {
      const lineTokens = tokens(line.name);
      const scored = inventory
        .map((i) => ({ inv: i, score: jaccard(lineTokens, tokens(i.name)) }))
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);
      candidates = scored.map((s) => ({
        inventory_item_id: s.inv.id, name: s.inv.name, unit: s.inv.unit, score: Number(s.score.toFixed(2)),
      }));
      if (scored[0] && scored[0].score >= 0.4) {
        match = scored[0].inv;
        confidence = 'fuzzy';
      }
    }

    // build the match object
    if (!match) {
      return { ...line, match: null, candidates, zombie_warning: null };
    }

    const conv = convertQuantity(line.qty, line.unit, match.unit);
    const stock = Number(match.quantity) || 0;
    const cost = Number(match.cost_price) || 0;
    const line_cost = conv.ok ? Number((conv.qty * cost).toFixed(2)) : null;

    // zombie detection
    let zombie_warning = null;
    if (stock === 0) {
      const prefix = norm(match.name).split(/\s+/)[0];
      const siblings = (byPrefix.get(prefix) || [])
        .filter((s) => s.id !== match.id && Number(s.quantity) > 0);
      if (siblings.length > 0) {
        zombie_warning = { sibling_id: siblings[0].id, sibling_name: siblings[0].name };
      }
    }

    return {
      ...line,
      match: {
        inventory_item_id: match.id,
        name: match.name,
        unit: match.unit,
        cost_price: cost,
        stock,
        confidence,
        quantity_used: conv.ok ? Number(conv.qty.toFixed(4)) : line.qty,
        unit_mismatch: !conv.ok,
        line_cost,
      },
      candidates,
      zombie_warning,
    };
  });
}
