// Wizard presentation metadata (prototype v12).
//
// The DB owns names, prices and structure; this file owns how they're drawn —
// which outline glyph a protein gets, what a style card says, which ingredient
// chips appear. Split from builderIcons.tsx because that file is GENERATED
// from the prototype's `I` map and shouldn't be hand-edited.
//
// Keys are the Spanish option names as seeded by scripts/seed-builder-menu.mjs
// (that's what the modifier rows literally contain), so a rename in Menu
// Management degrades to a fallback glyph rather than throwing.
import type { BuilderIconName } from './builderIcons';

/** Protein slug (kiosk_builder_map) → glyph. Mirrors prototype PROTEINS[].ico. */
export const PROTEIN_ICON: Record<string, BuilderIconName> = {
  asada: 'beef',
  pollo: 'drumstick',
  porkbelly: 'ham',
  huevo: 'eggfried',
  chorizo: 'sausage',
  portobello: 'mushroom',
  camaron: 'shrimp',
  pescado: 'fish',
};

/**
 * Protein display names, verbatim from prototype PROTEINS[].es/.en.
 * Deliberately not the menu item's own name: the DB calls these
 * "Burrito Carne Asada" / "Carne Asada Burrito" because they're sold as whole
 * items elsewhere, but on the protein grid and in a favorito's subtitle the
 * prototype names the protein alone.
 */
export const PROTEIN_LABEL: Record<string, { es: string; en: string }> = {
  asada: { es: 'Carne Asada', en: 'Carne Asada' },
  pollo: { es: 'Pollo Asado', en: 'Grilled Chicken' },
  porkbelly: { es: 'Porkbelly', en: 'Pork Belly' },
  huevo: { es: 'Huevo', en: 'Eggs' },
  chorizo: { es: 'Chorizo', en: 'Chorizo' },
  portobello: { es: 'Portobello', en: 'Portobello' },
  camaron: { es: 'Camarón', en: 'Shrimp' },
  pescado: { es: 'Pescado', en: 'Baja Fish' },
};

export function proteinLabel(slug: string, en: boolean): string {
  const l = PROTEIN_LABEL[slug];
  return l ? (en ? l.en : l.es) : slug;
}

/**
 * Attract-screen favoritos → glyph. Mirrors prototype PRESETS[].ico (v15).
 *
 * v15 dropped Pollos Hermanos, Surf-N-Turf and Carne Asada Fries from the
 * roster and added Cerveza Fría, so the grid is exactly six cards.
 */
export const PRESET_ICON: Record<string, BuilderIconName> = {
  california: 'sun',
  breakfast: 'eggfried',
  birria: 'soup',
  cochinita: 'pig',
  rollbertos: 'taquitos',
  cervezafria: 'beer',
};

/**
 * Segunda-proteína option label → protein slug. The `Segunda proteína__<slug>`
 * group stores plain display names ('Camarón'), not slugs, so this is how a
 * second protein selected on the multi-select grid resolves to its modifier.
 */
export const SEGUNDA_LABEL_TO_SLUG: Record<string, string> = {
  'Carne Asada': 'asada',
  'Pollo Asado': 'pollo',
  Porkbelly: 'porkbelly',
  Huevo: 'huevo',
  Portobello: 'portobello',
  Camarón: 'camaron',
  Pescado: 'pescado',
  Chorizo: 'chorizo',
};

export const SLUG_TO_SEGUNDA_LABEL: Record<string, string> = Object.fromEntries(
  Object.entries(SEGUNDA_LABEL_TO_SLUG).map(([label, slug]) => [slug, label]),
);

/** Ingredient chips on a style card. Mirrors prototype STYLES[].ing. */
export interface StyleIngredient {
  icon: BuilderIconName;
  es: string;
  en: string;
  /** Matches the `Sin <x>` Quitar option this chip corresponds to, so the
   *  opt-in Quitar step can be filtered to what the chosen style contains. */
  quitar: string;
}

export interface StyleInfo {
  /** Display name — v12 uses "California Style", not the DB's "California". */
  es: string;
  en: string;
  icon: BuilderIconName;
  /** California & Mission get the terracotta BURRITO pill; Fries the gray one. */
  isBurrito: boolean;
  subEs: string;
  subEn: string;
  ing: StyleIngredient[];
}

const CHIP = {
  papas: { icon: 'fries', es: 'Papas a la francesa', en: 'French fries', quitar: 'Sin papas a la francesa' },
  arroz: { icon: 'rice', es: 'Arroz', en: 'Rice', quitar: 'Sin arroz' },
  frijoles: { icon: 'beans', es: 'Frijoles', en: 'Beans', quitar: 'Sin frijoles' },
  queso: { icon: 'cheese', es: 'Queso', en: 'Cheese', quitar: 'Sin queso' },
  guac: { icon: 'avocado', es: 'Guacamole', en: 'Guacamole', quitar: 'Sin guacamole' },
  pico: { icon: 'pepper', es: 'Pico de gallo', en: 'Pico de gallo', quitar: 'Sin pico de gallo' },
  crema: { icon: 'milk', es: 'Crema', en: 'Sour cream', quitar: 'Sin crema' },
} satisfies Record<string, StyleIngredient>;

/**
 * Keyed on the DB Estilo option name ('California' | 'Mission' | 'Fries').
 * Ingredient lists are verbatim from the prototype, including the Fries card
 * listing beans as "(opcional)".
 */
export const STYLE_INFO: Record<string, StyleInfo> = {
  California: {
    es: 'California Style',
    en: 'California Style',
    icon: 'sun',
    isBurrito: true,
    subEs: 'El clásico de San Diego',
    subEn: 'The San Diego classic',
    ing: [CHIP.papas, CHIP.queso, CHIP.guac, CHIP.pico, CHIP.crema],
  },
  Mission: {
    es: 'Mission Style',
    en: 'Mission Style',
    icon: 'landmark',
    isBurrito: true,
    subEs: 'Al estilo San Francisco',
    subEn: 'San Francisco style',
    ing: [CHIP.arroz, CHIP.frijoles, CHIP.queso, CHIP.guac, CHIP.pico, CHIP.crema],
  },
  Fries: {
    es: 'Fries',
    en: 'Fries',
    icon: 'fries',
    isBurrito: false,
    subEs: 'Tu proteína sobre papas — sin tortilla',
    subEn: 'Your protein over fries — no tortilla',
    ing: [
      CHIP.papas,
      CHIP.guac,
      CHIP.pico,
      CHIP.crema,
      { icon: 'beans', es: 'Frijoles (opcional)', en: 'Beans (optional)', quitar: 'Sin frijoles' },
    ],
  },
};

/** Extras modifier name → glyph. Mirrors prototype EXTRAS[].ico. */
export const EXTRA_ICON: Record<string, BuilderIconName> = {
  'Guacamole extra': 'avocado',
  'Queso extra': 'cheese',
  'Cebollita asada': 'onion',
  'Chorizo extra': 'sausage',
};

/**
 * Sides & drinks come from kiosk_addon_map, which is curated per tenant, so
 * exact names are matched first and a keyword pass catches anything Juan adds
 * later. Never returns null — a missing glyph would leave a blank card.
 */
const ADDON_ICON_EXACT: Record<string, BuilderIconName> = {
  'Orden Papas': 'fries',
  'Brownie con crema': 'cookie',
  Refresco: 'cupsoda',
  Cerveza: 'beer',
  'CHELA 3X2': 'beer',
  'Michelada (tamarindo con clamato)': 'cocktail',
  Chelada: 'cocktail',
  Café: 'coffee',
  'Aguas Frescas (hechas en casa)': 'bottle',
};

const ADDON_ICON_KEYWORD: Array<[RegExp, BuilderIconName]> = [
  [/papa|fries/i, 'fries'],
  [/brownie|postre|pastel|dessert/i, 'cookie'],
  [/michelada|chelada|c[oó]ctel|cocktail/i, 'cocktail'],
  [/cerveza|beer|chela|heineken|estrella/i, 'beer'],
  [/caf[eé]|capuchino|coffee/i, 'coffee'],
  [/refresco|soda|coca/i, 'cupsoda'],
  [/agua|jugo|botella|vino|water/i, 'bottle'],
];

export function addonIcon(name: string): BuilderIconName {
  const exact = ADDON_ICON_EXACT[name];
  if (exact) return exact;
  for (const [re, icon] of ADDON_ICON_KEYWORD) if (re.test(name)) return icon;
  return 'cupsoda';
}

/** `Sin queso` → the chip glyph for queso. Falls back to the burrito mark. */
export function quitarIcon(optionName: string): BuilderIconName {
  const hit = Object.values(CHIP).find((c) => c.quitar === optionName);
  return hit ? hit.icon : 'burrito';
}
