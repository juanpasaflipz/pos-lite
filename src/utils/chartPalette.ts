// Chart palettes for recharts categorical slices.
//
// These are PURE DIFFERENTIATION palettes — adjacent slots are perceptually
// distinct, but the colors themselves carry no semantic operational meaning.
// If a category has semantic weight (good/bad, healthy/at-risk, etc.) use the
// `cockpit-*` tokens directly instead of indexing into one of these.
//
// All colors are drawn from the project palette (cockpit semantics + enamel
// brand scale + surface.cream) so charts stay on-brand without inventing
// off-palette hues. Keep this file as the single source for chart colors so
// recharts views stay in sync.

export const CHART_PALETTE_6 = [
  '#2E5EAA', // brand-600 / enamel blue
  '#C94B1B', // cockpit.out / burnt orange
  '#D9A021', // cockpit.attention / mustard
  '#1F5B34', // cockpit.in / burrito green
  '#D8C7A3', // surface.cream / tortilla
  '#6E97DB', // brand-400 / enamel blue light
] as const;

export const CHART_PALETTE_10 = [
  '#2E5EAA', // brand-600 / enamel blue
  '#C94B1B', // cockpit.out / burnt orange
  '#D9A021', // cockpit.attention / mustard
  '#1F5B34', // cockpit.in / burrito green
  '#D8C7A3', // surface.cream / tortilla
  '#6E97DB', // brand-400 / enamel blue light
  '#4B7AC7', // brand-500 / enamel blue secondary
  '#244A88', // brand-700 / enamel blue deep
  '#87A8D8', // brand-300 / enamel blue pale
  '#F5F1E8', // ink.warm / warm white
] as const;
