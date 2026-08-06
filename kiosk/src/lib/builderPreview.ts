// Illustrated-icon PREVIEW for the wizard's photo cards. The owner is deciding
// between food photos and flat illustrated icons; this lets staff flip the real
// kiosk to the icon look from the hidden terminal-settings screen — per device,
// stored locally, invisible to every other kiosk — and flip it back. Customers
// on an untouched device never see it. If the icon direction wins, the icons
// move into menu/modifier image_url data and this preview layer goes away.
//
// Icons: Freepik "Basic Straight Flat" (Flaticon Premium, Juanberto's account),
// bundled under /builder-icons so the preview also works on the offline APK.

const PREVIEW_KEY = 'kiosk-icon-preview';

export function iconPreviewOn(): boolean {
  try {
    return localStorage.getItem(PREVIEW_KEY) === '1';
  } catch {
    return false;
  }
}

export function setIconPreview(on: boolean): void {
  try {
    if (on) localStorage.setItem(PREVIEW_KEY, '1');
    else localStorage.removeItem(PREVIEW_KEY);
  } catch {
    // storage unavailable — preview simply stays off
  }
}

const ICON = (name: string) => `/builder-icons/${name}.svg`;

/** Protein slug → bundled icon. */
const PROTEIN_PREVIEW: Record<string, string> = {
  asada: 'steak',
  pollo: 'chicken-leg',
  porkbelly: 'bacon-strips',
  huevo: 'fried-egg',
  portobello: 'shiitake',
  camaron: 'prawn',
  pescado: 'fish',
};

/** Attract favorito id → bundled icon. */
const FAVORITO_PREVIEW: Record<string, string> = {
  california: 'sun',
  breakfast: 'fried-egg',
  birria: 'soup',
  cochinita: 'pig',
  rollbertos: 'spring-rolls',
  cervezafria: 'beer-bottle',
};

/** Estilo option name → bundled icon. */
const ESTILO_PREVIEW: Record<string, string> = {
  California: 'sun',
  Mission: 'burrito',
  Fries: 'french-fries',
};

export function previewProteinIcon(slug: string): string | null {
  const n = PROTEIN_PREVIEW[slug];
  return n ? ICON(n) : null;
}

export function previewFavoritoIcon(id: string): string | null {
  const n = FAVORITO_PREVIEW[id];
  return n ? ICON(n) : null;
}

export function previewEstiloIcon(name: string): string | null {
  const n = ESTILO_PREVIEW[name];
  return n ? ICON(n) : null;
}

/** Sides/drinks match by name, same spirit as builderMeta's addonIcon. */
export function previewAddonIcon(name: string): string | null {
  const s = name.toLowerCase();
  if (/cerveza|beer|chela/.test(s)) return ICON('beer-bottle');
  if (/papas|fries|frita/.test(s)) return ICON('french-fries');
  if (/refresco|soda|coca|agua/.test(s)) return ICON('soda');
  return null;
}
