// Prototype-matching emoji icons for the burrito-builder wizard.
// Keyed on slug / option name so the DB stays icon-agnostic (icons are a
// customer-facing polish concern, not menu data). If Juan later swaps to real
// imagery per protein, replace this file with an image URL map — the wizard
// components only reach for a string here.

export const PROTEIN_ICONS: Record<string, string> = {
  asada:      '🐮',
  pollo:      '🐔',
  porkbelly:  '🐷',
  huevo:      '🍳',
  chorizo:    '🌶️',
  portobello: '🍄',
  camaron:    '🦐',
  pescado:    '🐟',
  birria:     '🐂',
  cochinita:  '🐖',
  rollbertos: '🫔',
};

// Preset tiles on the wizard attract screen.
export const PRESET_ICONS: Record<string, string> = {
  california:      '🌊',   // El California
  pollos:          '🐔',   // Pollos Hermanos
  breakfast:       '🍳',
  surfnturf:       '🦐',
  asadafries:      '🍟',
  birria:          '🐂',
  cochinita:       '🐖',
  rollbertos:      '🫔',
};

// Style step: what's IN each style, mapped by ingredient name → icon.
export const INGREDIENT_ICONS: Record<string, string> = {
  'Papas a la francesa': '🍟',
  'Arroz':               '🍚',
  'Frijoles':            '🫘',
  'Queso':               '🧀',
  'Guacamole':           '🥑',
  'Pico de gallo':       '🍅',
  'Crema':               '🥛',
};

// Style card metadata — badge label (BURRITO vs NOT A BURRITO) + short subtitle
// + ingredient list (used to render the "what's in it" pills). Not derived from
// the DB because these are customer-facing description choices, not menu data.
export interface StyleInfo {
  badge: string;     // 'BURRITO' or 'NO ES BURRITO'
  isBurrito: boolean;
  subEs: string;
  subEn: string;
  ingredientsEs: string[];   // matches keys of INGREDIENT_ICONS
  ingredientsEn: string[];
}

export const STYLE_INFO: Record<string, StyleInfo> = {
  California: {
    badge: 'BURRITO',
    isBurrito: true,
    subEs: 'El clásico de San Diego',
    subEn: 'The San Diego classic',
    ingredientsEs: ['Papas a la francesa', 'Queso', 'Guacamole', 'Pico de gallo', 'Crema'],
    ingredientsEn: ['French fries', 'Cheese', 'Guacamole', 'Pico de gallo', 'Sour cream'],
  },
  Mission: {
    badge: 'BURRITO',
    isBurrito: true,
    subEs: 'Al estilo San Francisco',
    subEn: 'San Francisco style',
    ingredientsEs: ['Arroz', 'Frijoles', 'Queso', 'Guacamole', 'Pico de gallo', 'Crema'],
    ingredientsEn: ['Rice', 'Beans', 'Cheese', 'Guacamole', 'Pico de gallo', 'Sour cream'],
  },
  Fries: {
    badge: 'NO ES BURRITO',
    isBurrito: false,
    subEs: 'Tu proteína sobre papas — sin tortilla',
    subEn: 'Your protein over fries — no tortilla',
    ingredientsEs: ['Papas a la francesa', 'Guacamole', 'Pico de gallo', 'Crema'],
    ingredientsEn: ['French fries', 'Guacamole', 'Pico de gallo', 'Sour cream'],
  },
};

// Quitar options carry "Sin X" text; map back to the plain ingredient icon.
export function quitarIcon(name: string): string {
  const stripped = name.replace(/^Sin\s+/i, '').trim();
  // "Papas a la francesa" is what shows up as 'Sin papas a la francesa'
  const map: Record<string, string> = {
    'papas a la francesa': '🍟',
    'arroz':               '🍚',
    'frijoles':            '🫘',
    'queso':               '🧀',
    'guacamole':           '🥑',
    'pico de gallo':       '🍅',
    'crema':               '🥛',
  };
  return map[stripped.toLowerCase()] || '❌';
}

export const EXTRA_ICONS: Record<string, string> = {
  'Guacamole extra': '🥑',
  'Queso extra':     '🧀',
  'Cebollita asada': '🧅',
};
