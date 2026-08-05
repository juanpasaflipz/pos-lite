// Outline icon set for the burrito-builder wizard (prototype v12, D8).
//
// GENERATED from design/kiosk-builder-prototype.html — the `I` map is the
// normative source. Every glyph is 24x24, stroke-2, currentColor, so it tints
// from CSS (`text-brand-300` on cards) exactly like the prototype's
// `.card .ico { color: var(--brand-300) }`.
//
// Sources: Lucide + Tabler (both MIT) for the stock glyphs, plus six drawn for
// this menu because no library has them — burrito, fries, rice, beans,
// taquitos, onion.
//
// This replaces emoji everywhere in wizard-mode UI. Emoji render from the OS
// font, so the Samsung and the iPad drew different pictures and neither took
// the terracotta.
import React from 'react';

// Path markup only — the shared <svg> wrapper lives in <BuilderIcon>. Static
// compile-time constants copied from the prototype; no runtime input reaches
// dangerouslySetInnerHTML.
const PATHS = {
  beef: "<path d=\"M16.4 13.7A6.5 6.5 0 1 0 6.28 6.6c-1.1 3.13-.78 3.9-3.18 6.08A3 3 0 0 0 5 18c4 0 8.4-1.8 11.4-4.3\" /> <path d=\"m18.5 6 2.19 4.5a6.48 6.48 0 0 1-2.29 7.2C15.4 20.2 11 22 7 22a3 3 0 0 1-2.68-1.66L2.4 16.5\" /> <circle cx=\"12.5\" cy=\"8.5\" r=\"2.5\" />",
  drumstick: "<path d=\"M15.4 15.63a7.875 6 135 1 1 6.23-6.23 4.5 3.43 135 0 0-6.23 6.23\" /> <path d=\"m8.29 12.71-2.6 2.6a2.5 2.5 0 1 0-1.65 4.65A2.5 2.5 0 1 0 8.7 18.3l2.59-2.59\" />",
  ham: "<path d=\"M13.144 21.144A7.274 10.445 45 1 0 2.856 10.856\" /> <path d=\"M13.144 21.144A7.274 4.365 45 0 0 2.856 10.856a7.274 4.365 45 0 0 10.288 10.288\" /> <path d=\"M16.565 10.435 18.6 8.4a2.501 2.501 0 1 0 1.65-4.65 2.5 2.5 0 1 0-4.66 1.66l-2.024 2.025\" /> <path d=\"m8.5 16.5-1-1\" />",
  eggfried: "<circle cx=\"11.5\" cy=\"12.5\" r=\"3.5\" /> <path d=\"M3 8c0-3.5 2.5-6 6.5-6 5 0 4.83 3 7.5 5s5 2 5 6c0 4.5-2.5 6.5-7 6.5-2.5 0-2.5 2.5-6 2.5s-7-2-7-5.5c0-3 1.5-3 1.5-5C3.5 10 3 9 3 8Z\" />",
  mushroom: "<path d=\"M20 11.1c0 -4.474 -3.582 -8.1 -8 -8.1s-8 3.626 -8 8.1a.9 .9 0 0 0 .9 .9h14.2a.9 .9 0 0 0 .9 -.9\" /> <path d=\"M10 12v7a2 2 0 1 0 4 0v-7\" />",
  shrimp: "<path d=\"M11 12h.01\" /> <path d=\"M13 22c.5-.5 1.12-1 2.5-1-1.38 0-2-.5-2.5-1\" /> <path d=\"M14 2a3.28 3.28 0 0 1-3.227 1.798l-6.17-.561A2.387 2.387 0 1 0 4.387 8H15.5a1 1 0 0 1 0 13 1 1 0 0 0 0-5H12a7 7 0 0 1-7-7V8\" /> <path d=\"M14 8a8.5 8.5 0 0 1 0 8\" /> <path d=\"M16 16c2 0 4.5-4 4-6\" />",
  fish: "<path d=\"M6.5 12c.94-3.46 4.94-6 8.5-6 3.56 0 6.06 2.54 7 6-.94 3.47-3.44 6-7 6s-7.56-2.53-8.5-6Z\" /> <path d=\"M18 12v.5\" /> <path d=\"M16 17.93a9.77 9.77 0 0 1 0-11.86\" /> <path d=\"M7 10.67C7 8 5.58 5.97 2.73 5.5c-1 1.5-1 5 .23 6.5-1.24 1.5-1.24 5-.23 6.5C5.58 18.03 7 16 7 13.33\" /> <path d=\"M10.46 7.26C10.2 5.88 9.17 4.24 8 3h5.8a2 2 0 0 1 1.98 1.67l.23 1.4\" /> <path d=\"m16.01 17.93-.23 1.4A2 2 0 0 1 13.8 21H9.5a5.96 5.96 0 0 0 1.49-3.98\" />",
  sausage: "<path d=\"M5.5 5.5a2.5 2.5 0 0 0 -2.5 2.5c0 7.18 5.82 13 13 13a2.5 2.5 0 1 0 0 -5a8 8 0 0 1 -8 -8a2.5 2.5 0 0 0 -2.5 -2.5\" /> <path d=\"M5.195 5.519l-1.243 -1.989a1 1 0 0 1 .848 -1.53h1.392a1 1 0 0 1 .848 1.53l-1.245 1.99\" /> <path d=\"M18.482 18.225l1.989 -1.243a1 1 0 0 1 1.53 .848v1.392a1 1 0 0 1 -1.53 .848l-1.991 -1.245\" />",
  pig: "<path d=\"M15 11v.01\" /> <path d=\"M16 3l0 3.803a6.019 6.019 0 0 1 2.658 3.197h1.341a1 1 0 0 1 1 1v2a1 1 0 0 1 -1 1h-1.342a6.008 6.008 0 0 1 -1.658 2.473v2.027a1.5 1.5 0 0 1 -3 0v-.583a6.04 6.04 0 0 1 -1 .083h-4a6.04 6.04 0 0 1 -1 -.083v.583a1.5 1.5 0 0 1 -3 0v-2l0 -.027a6 6 0 0 1 4 -10.473h2.5l4.5 -3\" />",
  cheese: "<path d=\"M4.519 20.008l16.481 -.008v-3.5a2 2 0 1 1 0 -4v-3.5h-16.722\" /> <path d=\"M21 9l-9.385 -4.992c-2.512 .12 -4.758 1.42 -6.327 3.425c-1.423 1.82 -2.288 4.221 -2.288 6.854c0 2.117 .56 4.085 1.519 5.721\" /> <path d=\"M15 13v.01\" /> <path d=\"M8 13v.01\" /> <path d=\"M11 16v.01\" />",
  avocado: "<path d=\"M17.8 14.04a3.905 3.905 0 0 1 1.337 -2.075c1.195 -.985 1.816 -2.285 1.863 -3.902c-.047 -1.43 -.54 -2.626 -1.477 -3.586c-.96 -.938 -2.156 -1.43 -3.585 -1.477c-1.618 .047 -2.918 .668 -3.903 1.863c-.562 .68 -1.254 1.125 -2.074 1.336c-.938 .188 -1.828 .48 -2.672 .88c-.844 .398 -1.559 .878 -2.144 1.44c-1.43 1.501 -2.145 3.224 -2.145 5.169c0 1.946 .715 3.668 2.145 5.168c1.5 1.429 3.222 2.144 5.168 2.144c1.945 0 3.667 -.715 5.167 -2.145c.563 -.585 1.055 -1.3 1.477 -2.144c.398 -.844 .68 -1.723 .844 -2.637v-.035l-.001 .001\" /> <path d=\"M10.87 10.036c-.942 .112 -1.794 .538 -2.556 1.278c-.74 .762 -1.166 1.614 -1.278 2.556c-.135 .92 .112 1.704 .74 2.354c.65 .628 1.435 .875 2.354 .74c.942 -.112 1.794 -.538 2.556 -1.278c.74 -.762 1.166 -1.614 1.278 -2.556c.135 -.92 -.112 -1.704 -.74 -2.354c-.65 -.628 -1.435 -.875 -2.354 -.74\" />",
  pepper: "<path d=\"M13 11c0 2.21 -2.239 4 -5 4s-5 -1.79 -5 -4a8 8 0 1 0 16 0a3 3 0 0 0 -6 0\" /> <path d=\"M16 8c0 -2 2 -4 4 -4\" />",
  milk: "<path d=\"M8 2h8\" /> <path d=\"M9 2v2.789a4 4 0 0 1-.672 2.219l-.656.984A4 4 0 0 0 7 10.212V20a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-9.789a4 4 0 0 0-.672-2.219l-.656-.984A4 4 0 0 1 15 4.788V2\" /> <path d=\"M7 15a6.472 6.472 0 0 1 5 0 6.47 6.47 0 0 0 5 0\" />",
  soup: "<path d=\"M12 21a9 9 0 0 0 9-9H3a9 9 0 0 0 9 9Z\" /> <path d=\"M7 21h10\" /> <path d=\"M19.5 12 22 6\" /> <path d=\"M16.25 3c.27.1.8.53.75 1.36-.06.83-.93 1.2-1 2.02-.05.78.34 1.24.73 1.62\" /> <path d=\"M11.25 3c.27.1.8.53.74 1.36-.05.83-.93 1.2-.98 2.02-.06.78.33 1.24.72 1.62\" /> <path d=\"M6.25 3c.27.1.8.53.75 1.36-.06.83-.93 1.2-1 2.02-.05.78.34 1.24.74 1.62\" />",
  sun: "<circle cx=\"12\" cy=\"12\" r=\"4\" /> <path d=\"M12 2v2\" /> <path d=\"M12 20v2\" /> <path d=\"m4.93 4.93 1.41 1.41\" /> <path d=\"m17.66 17.66 1.41 1.41\" /> <path d=\"M2 12h2\" /> <path d=\"M20 12h2\" /> <path d=\"m6.34 17.66-1.41 1.41\" /> <path d=\"m19.07 4.93-1.41 1.41\" />",
  landmark: "<path d=\"M10 18v-7\" /> <path d=\"M11.119 2.205a2 2 0 0 1 1.762 0l7.84 3.846A.5.5 0 0 1 20.5 7h-17a.5.5 0 0 1-.22-.949z\" /> <path d=\"M14 18v-7\" /> <path d=\"M18 18v-7\" /> <path d=\"M3 22h18\" /> <path d=\"M6 18v-7\" />",
  cupsoda: "<path d=\"m6 8 1.75 12.28a2 2 0 0 0 2 1.72h4.54a2 2 0 0 0 2-1.72L18 8\" /> <path d=\"M5 8h14\" /> <path d=\"M7 15a6.47 6.47 0 0 1 5 0 6.47 6.47 0 0 0 5 0\" /> <path d=\"m12 8 1-6h2\" />",
  coffee: "<path d=\"M10 2v2\" /> <path d=\"M14 2v2\" /> <path d=\"M16 8a1 1 0 0 1 1 1v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1h14a4 4 0 1 1 0 8h-1\" /> <path d=\"M6 2v2\" />",
  beer: "<path d=\"M17 11h1a3 3 0 0 1 0 6h-1\" /> <path d=\"M9 12v6\" /> <path d=\"M13 12v6\" /> <path d=\"M14 7.5c-1 0-1.44.5-3 .5s-2-.5-3-.5-1.72.5-2.5.5a2.5 2.5 0 0 1 0-5c.78 0 1.57.5 2.5.5S9.44 2 11 2s2 1.5 3 1.5 1.72-.5 2.5-.5a2.5 2.5 0 0 1 0 5c-.78 0-1.5-.5-2.5-.5Z\" /> <path d=\"M5 8v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8\" />",
  cocktail: "<path d=\"M8 21h8\" /> <path d=\"M12 15v6\" /> <path d=\"M5 5a7 2 0 1 0 14 0a7 2 0 1 0 -14 0\" /> <path d=\"M5 5v.388c0 .432 .126 .853 .362 1.206l5 7.509c.633 .951 1.88 1.183 2.785 .517c.191 -.141 .358 -.316 .491 -.517l5 -7.509c.236 -.353 .362 -.774 .362 -1.206v-.388\" />",
  bottle: "<path d=\"M10 5h4v-2a1 1 0 0 0 -1 -1h-2a1 1 0 0 0 -1 1v2\" /> <path d=\"M14 3.5c0 1.626 .507 3.212 1.45 4.537l.05 .07a8.093 8.093 0 0 1 1.5 4.694v6.199a2 2 0 0 1 -2 2h-6a2 2 0 0 1 -2 -2v-6.2c0 -1.682 .524 -3.322 1.5 -4.693l.05 -.07a7.823 7.823 0 0 0 1.45 -4.537\" /> <path d=\"M7 14.803a2.4 2.4 0 0 0 1 -.803a2.4 2.4 0 0 1 2 -1a2.4 2.4 0 0 1 2 1a2.4 2.4 0 0 0 2 1a2.4 2.4 0 0 0 2 -1a2.4 2.4 0 0 1 1 -.805\" />",
  cookie: "<path d=\"M12 2a10 10 0 1 0 10 10 4 4 0 0 1-5-5 4 4 0 0 1-5-5\" /> <path d=\"M8.5 8.5v.01\" /> <path d=\"M16 15.5v.01\" /> <path d=\"M12 12v.01\" /> <path d=\"M11 17v.01\" /> <path d=\"M7 14v.01\" />",
  megaphone: "<path d=\"M11 6a13 13 0 0 0 8.4-2.8A1 1 0 0 1 21 4v12a1 1 0 0 1-1.6.8A13 13 0 0 0 11 14H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z\" /> <path d=\"M6 14a12 12 0 0 0 2.4 7.2 2 2 0 0 0 3.2-2.4A8 8 0 0 1 10 14\" /> <path d=\"M8 6v8\" />",
  star: "<path d=\"M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z\" />",
  burrito: "<path d=\"M7 6.5c-2.8 0-5 2.5-5 5.5s2.2 5.5 5 5.5h10c2.8 0 5-2.5 5-5.5s-2.2-5.5-5-5.5z\"/><path d=\"M7 6.5c1.8 1.2 3 3.2 3 5.5s-1.2 4.3-3 5.5\"/><path d=\"M13.5 6.5 12 9\"/><path d=\"M17.5 6.5 16 9\"/>",
  fries: "<path d=\"M6.5 10.5 5 20h14l-1.5-9.5\"/><path d=\"M5.5 10.5h13\"/><path d=\"M9 10.5V5\"/><path d=\"M12 10.5V4\"/><path d=\"M15 10.5V5\"/>",
  rice: "<path d=\"M4 12h16\"/><path d=\"M4 12a8 8 0 0 0 16 0\"/><path d=\"m9 8 .8.8\"/><path d=\"m13 6 .8.8\"/><path d=\"m11.5 9.5.8.8\"/><path d=\"m15.5 8.5.8.8\"/>",
  beans: "<path d=\"M9.5 5.5a3 3 0 1 1-3.2 4\"/><path d=\"M17.5 8.5a3 3 0 1 1-3.2 4\"/><path d=\"M11.5 14.5a3 3 0 1 1-3.2 4\"/>",
  taquitos: "<rect x=\"3\" y=\"6\" width=\"15\" height=\"4\" rx=\"2\"/><rect x=\"6\" y=\"13\" width=\"15\" height=\"4\" rx=\"2\"/><path d=\"M6 8h.01\"/><path d=\"M18 15h.01\"/>",
  onion: "<path d=\"M12 8.5c-3.3 0-5.5 2.3-5.5 5.3S9 19.5 12 19.5s5.5-2.7 5.5-5.7S15.3 8.5 12 8.5z\"/><path d=\"M12 8.5c-1.4-1-1.9-2.4-1.4-4\"/><path d=\"M12 8.5c1.4-1 1.9-2.4 1.4-4\"/><path d=\"M9.8 13c0 2.4.8 4.4 2.2 5.6\"/>",
  // v15 — the two fulfillment glyphs on "¿Para aquí o para llevar?".
  utensils: "<path d=\"M7 3v6a2 2 0 0 0 2 2 2 2 0 0 0 2-2V3\"/><path d=\"M9 11v10\"/><path d=\"M17 3c-1.5 3.5-1.5 6.5 0 8v10\"/>",
  bag: "<path d=\"M6 9h12l-1.3 11.2a1 1 0 0 1-1 .8H8.3a1 1 0 0 1-1-.8z\"/><path d=\"M9 9V7a3 3 0 0 1 6 0v2\"/>",
} as const;

export type BuilderIconName = 'beef' | 'drumstick' | 'ham' | 'eggfried' | 'mushroom' | 'shrimp' | 'fish' | 'sausage' | 'pig' | 'cheese' | 'avocado' | 'pepper' | 'milk' | 'soup' | 'sun' | 'landmark' | 'cupsoda' | 'coffee' | 'beer' | 'cocktail' | 'bottle' | 'cookie' | 'megaphone' | 'star' | 'burrito' | 'fries' | 'rice' | 'beans' | 'taquitos' | 'onion' | 'utensils' | 'bag';

export const BUILDER_ICON_NAMES = Object.keys(PATHS) as BuilderIconName[];

interface BuilderIconProps {
  name: BuilderIconName;
  /** Tailwind sizing/colour classes. Defaults to 1em square so it inherits
   *  the surrounding font-size, matching the prototype's `width: 1em`. */
  className?: string;
  title?: string;
}

/** One outline glyph. Inherits colour via currentColor and size via em. */
export const BuilderIcon: React.FC<BuilderIconProps> = ({ name, className, title }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className ?? 'h-[1em] w-[1em]'}
    role={title ? 'img' : undefined}
    aria-label={title}
    aria-hidden={title ? undefined : true}
    focusable="false"
    dangerouslySetInnerHTML={{ __html: title ? `<title>${title}</title>${PATHS[name]}` : PATHS[name] }}
  />
);

export default BuilderIcon;
