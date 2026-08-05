// Pricing arithmetic for the kiosk burrito-builder wizard.
//
// Pure-function tests against a fixture shaped exactly like the
// /api/kiosk/builder-menu payload, with the real numbers seeded by
// scripts/seed-builder-menu.mjs for juanbertos. No DB: the risk here is
// arithmetic and option resolution, and a fixture pins the exact prices the
// parity spec's acceptance checklist calls out.
import { describe, it, expect } from 'vitest';
import type { BuilderItem } from '../kiosk/src/lib/kioskApi';
import {
  resolveSelection, proteinPrice, stylePrice, draftPrice, draftModifiers,
  emptyDraft, extrasCount, decodeDraft,
} from '../kiosk/src/lib/builderPricing';

let nextId = 1000;
const mod = (name: string, adj: number) => ({ id: nextId++, name, price_adjustment: adj });

function group(kind: string, slug: string, options: ReturnType<typeof mod>[], extra: Partial<{ required: boolean; min: number; max: number }> = {}) {
  return {
    id: nextId++,
    kind,
    slug,
    name: `${kind}__${slug}`,
    selection_type: (extra.max ?? 1) > 1 ? ('multiple' as const) : ('single' as const),
    required: extra.required ?? false,
    min_selections: extra.min ?? 0,
    max_selections: extra.max ?? 1,
    options,
  };
}

/**
 * Base prices and adjustments are the ones actually seeded for juanbertos.
 * Note porkbelly's Fries adjustment is $69 where every other protein is $49 —
 * that asymmetry is the whole reason resolveSelection canonicalises the base.
 */
const P = { asada: 250, pollo: 219, porkbelly: 230, huevo: 180, portobello: 170, camaron: 240 };
// Fries surcharge = 299 − price, so every single-protein fries rings at $299
// (Juan 2026-07-31). Because the surcharge falls as the protein price rises,
// resolveSelection's "lowest Fries surcharge" base is normally the PRICIER
// protein, whose Segunda adjustment is exactly +$90 — which is what makes
// two-protein fries land on $389.
//
// huevo is the one hand-set exception: $89 instead of $119, so that
// huevo+chorizo over fries hits $299 like the other meat fries (Juan
// 2026-07-31). That has two knock-on effects, both asserted below — plain
// egg-over-fries drops to $269, and huevo now out-ranks portobello for the
// base slot, so huevo+portobello fries is $359 rather than $389.
const FRIES = { asada: 49, pollo: 80, porkbelly: 69, huevo: 89, portobello: 129, camaron: 59 };
// SECOND_MATRIX[base][added] from the seed script.
const SEGUNDA: Record<string, Record<string, number>> = {
  asada: { 'Pollo Asado': 90, Porkbelly: 90, Huevo: 90, Portobello: 90, Camarón: 90 },
  pollo: { 'Carne Asada': 121, Porkbelly: 101, Huevo: 90, Portobello: 90, Camarón: 111 },
  porkbelly: { 'Carne Asada': 110, 'Pollo Asado': 90, Huevo: 90, Portobello: 90, Camarón: 100 },
  huevo: { 'Carne Asada': 160, 'Pollo Asado': 129, Porkbelly: 140, Portobello: 90, Camarón: 150, Chorizo: 30 },
  portobello: { 'Carne Asada': 170, 'Pollo Asado': 139, Porkbelly: 150, Huevo: 100, Camarón: 160 },
  camaron: { 'Carne Asada': 100, 'Pollo Asado': 90, Porkbelly: 90, Huevo: 90, Portobello: 90 },
};

function buildItem(slug: keyof typeof P): BuilderItem {
  return {
    id: nextId++,
    slug,
    name: `Burrito ${slug}`,
    name_en: null,
    description: null,
    description_en: null,
    price: P[slug],
    groups: [
      group('Estilo', slug, [mod('California', 0), mod('Mission', 0), mod('Fries', FRIES[slug])], { required: true, min: 1, max: 1 }),
      group('Segunda proteína', slug, Object.entries(SEGUNDA[slug]).map(([n, a]) => mod(n, a)), { max: 1 }),
      group('Quitar', slug, [mod('Sin queso', 0), mod('Sin arroz', 0), mod('Sin crema', 0)], { max: 7 }),
      group('Extras', slug, [mod('Guacamole extra', 35), mod('Queso extra', 25), mod('Chorizo extra', 35)], { max: 4 }),
    ],
  } as BuilderItem;
}

const ITEMS = (Object.keys(P) as Array<keyof typeof P>).map(buildItem);

describe('kiosk builder pricing', () => {
  describe('single protein', () => {
    it('prices each style off the base item', () => {
      // Acceptance item 3: the three Estilo cards for asada.
      expect(stylePrice(['asada'], 'California', ITEMS)).toBe(250);
      expect(stylePrice(['asada'], 'Mission', ITEMS)).toBe(250);
      expect(stylePrice(['asada'], 'Fries', ITEMS)).toBe(299);
    });

    it('rings every single-protein Fries at the flat $299 menu price, except egg', () => {
      for (const slug of Object.keys(P)) {
        expect(stylePrice([slug], 'Fries', ITEMS)).toBe(slug === 'huevo' ? 269 : 299);
      }
    });

    it('rings egg + chorizo over fries at $299, the meat-fries price', () => {
      // The reason huevo's surcharge is hand-set: 180 + 30 chorizo + 89.
      expect(stylePrice(['huevo', 'chorizo'], 'Fries', ITEMS)).toBe(299);
      // …without disturbing Breakfast con chorizo on a tortilla.
      expect(stylePrice(['huevo', 'chorizo'], 'California', ITEMS)).toBe(210);
    });
  });

  describe('two proteins', () => {
    it('shows $340 for asada + camarón before a style is picked', () => {
      // Acceptance item 2.
      expect(proteinPrice(['asada', 'camaron'], ITEMS)).toBe(340);
    });

    it('is independent of selection order for every pair', () => {
      const slugs = Object.keys(P);
      for (const a of slugs) {
        for (const b of slugs) {
          if (a === b) continue;
          expect(proteinPrice([a, b], ITEMS)).toBe(proteinPrice([b, a], ITEMS));
        }
      }
    });

    it('rings every two-protein Fries at $389, in either tap order', () => {
      // $299 flat + the $90 combo upcharge. This is also the regression guard
      // for the original defect: with a naive "first tapped is the base",
      // porkbelly+asada Fries came to $409 one way and $389 the other, so a
      // guest could move the price by changing tap order.
      //
      // huevo+portobello is the single exception, at $359: huevo's hand-set
      // $89 surcharge is lower than portobello's $129, so huevo takes the base
      // slot and its cheaper surcharge applies. Both are cheap proteins and
      // the pair is vanishingly rare, so it's accepted rather than special-cased.
      const slugs = Object.keys(P);
      for (const a of slugs) {
        for (const b of slugs) {
          if (a === b) continue;
          const eggAndMushroom = [a, b].sort().join('+') === 'huevo+portobello';
          expect(stylePrice([a, b], 'Fries', ITEMS)).toBe(eggAndMushroom ? 359 : 389);
        }
      }
    });

    it('resolves the second protein to a Segunda option on the chosen base', () => {
      const sel = resolveSelection(['asada', 'camaron'], ITEMS);
      expect(sel).not.toBeNull();
      expect(sel!.base.slug).toBe('asada');
      expect(sel!.segunda?.name).toBe('Camarón');
    });
  });

  describe('chorizo — reachable only via the Breakfast overlay', () => {
    it('totals $210 for huevo + chorizo', () => {
      // Acceptance item 5. 180 + 30.
      expect(proteinPrice(['huevo', 'chorizo'], ITEMS)).toBe(210);
      expect(stylePrice(['huevo', 'chorizo'], 'California', ITEMS)).toBe(210);
    });

    it('makes huevo the base, since chorizo has no base item of its own', () => {
      const sel = resolveSelection(['huevo', 'chorizo'], ITEMS);
      expect(sel!.base.slug).toBe('huevo');
      expect(sel!.segunda?.name).toBe('Chorizo');
    });

    it('refuses a selection with no usable base item', () => {
      // Deselecting huevo after backing out of Breakfast leaves chorizo alone;
      // there is no chorizo menu item, so Continue must stay disabled rather
      // than build an order the server would reject.
      expect(resolveSelection(['chorizo'], ITEMS)).toBeNull();
      expect(proteinPrice(['chorizo'], ITEMS)).toBe(0);
    });

    it('refuses a pair the base cannot carry', () => {
      // camaron's Segunda group has no Chorizo option.
      expect(resolveSelection(['camaron', 'chorizo'], ITEMS)).toBeNull();
    });
  });

  describe('draft totals', () => {
    it('adds extras on top of the styled price', () => {
      const draft = { ...emptyDraft(), proteins: ['asada'], estiloName: 'California' };
      const guac = ITEMS[0].groups.find((g) => g.kind === 'Extras')!.options.find((o) => o.name === 'Guacamole extra')!;
      draft.extras = { [guac.id]: 2 };
      expect(draftPrice(draft, ITEMS)).toBe(250 + 70);
      expect(extrasCount(draft)).toBe(2);
    });

    it('emits every pick as a flat modifier list, repeating extras by quantity', () => {
      const base = ITEMS[0];
      const estilo = base.groups.find((g) => g.kind === 'Estilo')!.options.find((o) => o.name === 'Fries')!;
      const quitar = base.groups.find((g) => g.kind === 'Quitar')!.options[0];
      const queso = base.groups.find((g) => g.kind === 'Extras')!.options.find((o) => o.name === 'Queso extra')!;
      const draft = {
        proteins: ['asada', 'camaron'],
        estiloName: estilo.name,
        removed: [quitar.id],
        extras: { [queso.id]: 2 },
      };
      const mods = draftModifiers(draft, ITEMS);
      expect(mods.map((m) => m.name)).toEqual([
        'Fries', 'Camarón', 'Sin queso', 'Queso extra', 'Queso extra',
      ]);
      // 250 base + 90 segunda + 49 fries + 50 extras
      expect(draftPrice(draft, ITEMS)).toBe(439);
    });

    it('returns zero rather than a partial price when nothing resolves', () => {
      expect(draftPrice(emptyDraft(), ITEMS)).toBe(0);
      expect(draftModifiers(emptyDraft(), ITEMS)).toEqual([]);
    });
  });
});

/**
 * "Editar" on the wizard summary reopens a committed cart line. A cart line
 * only carries the base menu item id and a flat list of modifier ids, so the
 * whole feature rests on decodeDraft reversing draftModifiers exactly. A drift
 * here doesn't throw — it silently reopens the burrito with the wrong
 * ingredients, which the guest then pays for.
 */
describe('kiosk builder draft decoding (summary → Editar)', () => {
  const base = ITEMS[0]; // asada
  const optOf = (kind: string, name: string) =>
    base.groups.find((g) => g.kind === kind)!.options.find((o) => o.name === name)!;

  it('round-trips a fully-loaded draft through the modifier list', () => {
    const draft = {
      proteins: ['asada', 'camaron'],
      estiloName: 'Fries',
      removed: [optOf('Quitar', 'Sin crema').id],
      extras: { [optOf('Extras', 'Queso extra').id]: 2 },
    };
    const sel = resolveSelection(draft.proteins, ITEMS)!;
    const ids = draftModifiers(draft, ITEMS).map((m) => m.id);

    const decoded = decodeDraft(sel.base.id, ids, ITEMS)!;
    expect(decoded.proteins).toEqual(['asada', 'camaron']);
    expect(decoded.estiloName).toBe('Fries');
    expect(decoded.removed).toEqual(draft.removed);
    expect(decoded.extras).toEqual(draft.extras);
    // The decoded draft must also price identically, or Editar would change
    // the total without the guest touching anything.
    expect(draftPrice(decoded, ITEMS)).toBe(draftPrice(draft, ITEMS));
  });

  it('round-trips a plain single-protein burrito', () => {
    const draft = { proteins: ['asada'], estiloName: 'California', removed: [], extras: {} };
    const ids = draftModifiers(draft, ITEMS).map((m) => m.id);
    const decoded = decodeDraft(base.id, ids, ITEMS)!;
    expect(decoded).toEqual(draft);
  });

  it('drops modifier ids the base item no longer offers', () => {
    // Juan deletes an option in Menu Management while a line is in the cart.
    const decoded = decodeDraft(base.id, [999999], ITEMS)!;
    expect(decoded.proteins).toEqual(['asada']);
    expect(decoded.estiloName).toBeNull();
    expect(decoded.removed).toEqual([]);
    expect(decoded.extras).toEqual({});
  });

  it('returns null for a line whose item is not a builder item', () => {
    // Fixed favoritos (Birria, Rollbertos) and drinks render as plain lines
    // with no Editar button — decode must refuse them rather than invent one.
    expect(decodeDraft(424242, [], ITEMS)).toBeNull();
  });
});
