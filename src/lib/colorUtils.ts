/**
 * Generate a full color palette (50–900) from a single hex color.
 * Uses HSL lightness shifting to create lighter/darker variants.
 */

function hexToHsl(hex: string): [number, number, number] {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!result) return [0, 70, 50];

  let r = parseInt(result[1], 16) / 255;
  let g = parseInt(result[2], 16) / 255;
  let b = parseInt(result[3], 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      case b: h = ((r - g) / d + 4) / 6; break;
    }
  }

  return [Math.round(h * 360), Math.round(s * 100), Math.round(l * 100)];
}

function hslToHex(h: number, s: number, l: number): string {
  s /= 100;
  l /= 100;

  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color).toString(16).padStart(2, '0');
  };

  return `#${f(0)}${f(8)}${f(4)}`;
}

export interface BrandPalette {
  50: string;
  100: string;
  200: string;
  300: string;
  400: string;
  500: string;
  600: string;
  700: string;
  800: string;
  900: string;
}

/**
 * Generate a full Tailwind-style color palette from a single primary hex color.
 * The input color maps to the 600 shade (primary button/accent color).
 */
export function generatePalette(primaryHex: string): BrandPalette {
  const [h, s] = hexToHsl(primaryHex);

  // Lightness targets for each shade (600 = input color)
  const shades: Record<keyof BrandPalette, number> = {
    50: 96,
    100: 92,
    200: 85,
    300: 74,
    400: 62,
    500: 52,
    600: 43,
    700: 35,
    800: 28,
    900: 22,
  };

  const palette: Record<string, string> = {};
  for (const [shade, lightness] of Object.entries(shades)) {
    // Desaturate slightly for very light/dark shades
    const satAdjust = shade === '50' || shade === '100' ? Math.max(s - 10, 20) : s;
    palette[shade] = hslToHex(h, satAdjust, lightness);
  }

  return palette as unknown as BrandPalette;
}

/**
 * Apply a brand palette as CSS custom properties on the document root.
 */
export function applyBrandPalette(palette: BrandPalette): void {
  const root = document.documentElement;
  for (const [shade, hex] of Object.entries(palette)) {
    root.style.setProperty(`--brand-${shade}`, hex);
  }
}

/**
 * Reset brand palette to defaults (teal).
 */
export function resetBrandPalette(): void {
  const root = document.documentElement;
  const defaults: BrandPalette = {
    50: '#f0fdfa',
    100: '#ccfbf1',
    200: '#99f6e4',
    300: '#5eead4',
    400: '#2dd4bf',
    500: '#14b8a6',
    600: '#0d9488',
    700: '#0f766e',
    800: '#115e59',
    900: '#134e4a',
  };
  for (const [shade, hex] of Object.entries(defaults)) {
    root.style.setProperty(`--brand-${shade}`, hex);
  }
}
