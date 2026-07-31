// Price + option resolution for the burrito-builder wizard (prototype v12).
//
// The prototype carries its own hardcoded price tables (PROTEINS, COMBO_PRICES,
// FRIES_PRICES). Those are its stand-in for the database — per D6 the real
// wizard must derive every number from the fetched builder data, so this module
// reproduces the prototype's ARITHMETIC against live modifiers instead of
// copying its numbers.
//
// Model: one selected protein is the base menu item; a second protein is an
// option in that base item's `Segunda proteína` group; the style is an option
// in its `Estilo` group. Line total = item.price + estilo + segunda + extras.
import type { BuilderItem, BuilderGroup, BuilderModifier } from './kioskApi';
import { SEGUNDA_LABEL_TO_SLUG, SLUG_TO_SEGUNDA_LABEL } from './builderMeta';

export const MAX_PROTEINS = 2;

/** The seven slugs that are real base items, in prototype grid order. */
export const PROTEIN_SLUGS = [
  'asada', 'pollo', 'porkbelly', 'huevo', 'portobello', 'camaron', 'pescado',
] as const;

/** Never on the grid unless already selected — reachable only via the
 *  Breakfast "¿Con chorizo?" overlay, mirroring the prototype's `hidden` flag. */
export const HIDDEN_PROTEIN_SLUGS = ['chorizo'];

export function groupOf(item: BuilderItem | null, kind: string): BuilderGroup | null {
  if (!item) return null;
  return item.groups.find((g) => g.kind === kind) || null;
}

/** The `¿Con birria o cochinita?` group on Rollbertos — matched on the leading
 *  '¿Con' rather than the full string so a copy tweak doesn't break it. */
export function choiceGroup(item: BuilderItem | null): BuilderGroup | null {
  if (!item) return null;
  return item.groups.find((g) => g.kind.startsWith('¿Con')) || null;
}

export function estiloOptions(item: BuilderItem | null): BuilderModifier[] {
  return groupOf(item, 'Estilo')?.options || [];
}

export function findEstilo(item: BuilderItem | null, name: string | null): BuilderModifier | null {
  if (!name) return null;
  return estiloOptions(item).find((o) => o.name === name) || null;
}

export function extrasOptions(item: BuilderItem | null): BuilderModifier[] {
  return groupOf(item, 'Extras')?.options || [];
}

export function extrasMax(item: BuilderItem | null): number {
  return groupOf(item, 'Extras')?.max_selections ?? 4;
}

export function quitarOptions(item: BuilderItem | null): BuilderModifier[] {
  return groupOf(item, 'Quitar')?.options || [];
}

/** The `Segunda proteína` option representing `slug` on this base item. */
export function segundaFor(item: BuilderItem | null, slug: string | null): BuilderModifier | null {
  if (!slug) return null;
  const label = SLUG_TO_SEGUNDA_LABEL[slug];
  if (!label) return null;
  return groupOf(item, 'Segunda proteína')?.options.find((o) => o.name === label) || null;
}

/** Which protein slugs can serve as a second protein on this base item. */
export function segundaSlugs(item: BuilderItem | null): string[] {
  return (groupOf(item, 'Segunda proteína')?.options || [])
    .map((o) => SEGUNDA_LABEL_TO_SLUG[o.name])
    .filter(Boolean);
}

export interface ResolvedSelection {
  base: BuilderItem;
  /** The second protein's slug, or null for a single-protein burrito. */
  secondSlug: string | null;
  segunda: BuilderModifier | null;
}

/**
 * Decide which selected protein is the base item.
 *
 * This is NOT arbitrary. The seeded `Segunda proteína` adjustments make combo
 * totals symmetric — asada-base + porkbelly and porkbelly-base + asada both
 * come to $340 (verified across all 21 pairs). The **Fries** surcharge is not:
 * it is seeded per base item and porkbelly's is $69 where every other protein
 * is $49, so a naive "first tapped wins" base would price
 * porkbelly+asada Fries at $409 one way and $389 the other — the guest could
 * change the price by changing tap order.
 *
 * The prototype has no such hazard: it applies one flat +$49 to every
 * two-protein Fries (FRIES_FALLBACK_ADDON) and only uses the per-protein
 * FRIES_PRICES for singles. Picking the base with the LOWEST Fries surcharge
 * reproduces that exactly — every combo lands on +$49, while a lone porkbelly
 * still resolves to its real $299 menu price. Ties fall back to the pricier
 * protein, then slug, so the result is deterministic and order-independent.
 */
export function resolveSelection(
  slugs: string[],
  items: BuilderItem[],
): ResolvedSelection | null {
  const bySlug = new Map(items.map((i) => [i.slug || '', i]));
  const withItem = slugs.filter((s) => bySlug.has(s));
  if (withItem.length === 0) return null;

  if (withItem.length === 1 && slugs.length === 1) {
    return { base: bySlug.get(withItem[0])!, secondSlug: null, segunda: null };
  }

  // A slug with no base item (chorizo) can only ever be the second protein.
  const others = slugs.filter((s) => !withItem.includes(s));
  if (withItem.length === 1) {
    const base = bySlug.get(withItem[0])!;
    const secondSlug = others[0] ?? null;
    const segunda = segundaFor(base, secondSlug);
    // Selected a second protein this base can't carry → not a valid burrito.
    if (secondSlug && !segunda) return null;
    return { base, secondSlug, segunda };
  }

  const friesAdj = (item: BuilderItem) =>
    findEstilo(item, 'Fries')?.price_adjustment ?? Number.POSITIVE_INFINITY;

  const ranked = [...withItem].sort((a, b) => {
    const ia = bySlug.get(a)!;
    const ib = bySlug.get(b)!;
    return (
      friesAdj(ia) - friesAdj(ib) ||
      ib.price - ia.price ||
      a.localeCompare(b)
    );
  });

  for (const candidate of ranked) {
    const base = bySlug.get(candidate)!;
    const secondSlug = ranked.find((s) => s !== candidate) ?? null;
    const segunda = segundaFor(base, secondSlug);
    if (segunda) return { base, secondSlug, segunda };
  }
  return null;
}

/** Price with proteins chosen but no style yet — the protein step's footer. */
export function proteinPrice(slugs: string[], items: BuilderItem[]): number {
  const sel = resolveSelection(slugs, items);
  if (!sel) return 0;
  return sel.base.price + (sel.segunda?.price_adjustment ?? 0);
}

/** Price for a given style — the live number on each style card. */
export function stylePrice(
  slugs: string[],
  estiloName: string | null,
  items: BuilderItem[],
): number {
  const sel = resolveSelection(slugs, items);
  if (!sel) return 0;
  const estilo = findEstilo(sel.base, estiloName);
  return sel.base.price + (sel.segunda?.price_adjustment ?? 0) + (estilo?.price_adjustment ?? 0);
}

export interface DraftLine {
  proteins: string[];
  estiloName: string | null;
  /** Quitar modifier ids (always $0, but they ride along to the kitchen). */
  removed: number[];
  /** Extras modifier id → quantity. */
  extras: Record<number, number>;
}

export function emptyDraft(): DraftLine {
  return { proteins: [], estiloName: null, removed: [], extras: {} };
}

export function draftPrice(draft: DraftLine, items: BuilderItem[]): number {
  const sel = resolveSelection(draft.proteins, items);
  if (!sel) return 0;
  const base = stylePrice(draft.proteins, draft.estiloName, items);
  const opts = extrasOptions(sel.base);
  const extras = Object.entries(draft.extras).reduce((sum, [id, qty]) => {
    const opt = opts.find((o) => o.id === Number(id));
    return sum + (opt ? opt.price_adjustment * qty : 0);
  }, 0);
  return base + extras;
}

/** Flatten a draft into the modifier list the cart + server expect. */
export function draftModifiers(draft: DraftLine, items: BuilderItem[]): BuilderModifier[] {
  const sel = resolveSelection(draft.proteins, items);
  if (!sel) return [];
  const out: BuilderModifier[] = [];
  const estilo = findEstilo(sel.base, draft.estiloName);
  if (estilo) out.push(estilo);
  if (sel.segunda) out.push(sel.segunda);
  for (const opt of quitarOptions(sel.base)) {
    if (draft.removed.includes(opt.id)) out.push(opt);
  }
  const exOpts = extrasOptions(sel.base);
  for (const [id, qty] of Object.entries(draft.extras)) {
    const opt = exOpts.find((o) => o.id === Number(id));
    if (!opt) continue;
    for (let i = 0; i < qty; i += 1) out.push(opt);
  }
  return out;
}

/** How many selections the Extras group currently holds (its own max applies). */
export function extrasCount(draft: DraftLine): number {
  return Object.values(draft.extras).reduce((s, q) => s + q, 0);
}

/**
 * Whole-peso money, matching the prototype's `mxn = '$' + n.toFixed(0)`.
 * Deliberately not `lib/format`'s `formatMoney` — that renders $250.00 with
 * centavos, and every price on these screens is a whole peso by design.
 */
export const pesos = (n: number): string => `$${n.toFixed(0)}`;
