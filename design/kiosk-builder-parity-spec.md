# Wizard Parity Spec — match prototype v15 EXACTLY (juanbertos only)

**Date:** 2026-07-27 · **Author:** Cowork agent (with Juan)
**NORMATIVE SOURCE OF TRUTH: `design/kiosk-builder-prototype.html` (v15).**
Open it in a browser and keep it side-by-side while working. Where this spec and
the prototype disagree, THE PROTOTYPE WINS. Where the current wizard and the
prototype disagree, the wizard is wrong. Juan's words: "do it exactly how you
have it here, without changes."

## Tenant scoping — NON-NEGOTIABLE, restated from Juan

This applies to the **juanbertos tenant only**. Every other tenant (and the
default `kiosk_mode='grid'`) keeps today's kiosk exactly as it is — the grid
branch of AttractScreen and all grid-mode behavior stay byte-for-byte
unchanged, and none of this work may alter any surface a grid tenant sees.
The existing per-tenant/per-device gate already enforces this; do not weaken it.

## Accepted deviations from the prototype (the ONLY one)

1. Payment continues through the existing pay pipes (hold, MP terminal, etc.).
   The *sequence and copy* around it must match v15 (see D11/D9).
Everything else matches the prototype. Add nothing, remove nothing, rename
nothing customer-visible without Juan.

## D11 — NOTHING interposed before the order; commitment questions at the END

**Juan, explicit:** tapping a favorito or "Arma tu burrito" goes STRAIGHT into
ordering — no for-here/to-go, no identify, no name first. The end of the flow,
in this exact order (v15 models it):

  cart/summary → **"¿Para aquí o para llevar?"** (two big cards, utensils/bag
  outline icons — v15 `rFulfill`) → **name capture** ("¿A qué nombre llamamos
  tu orden?") → **pay** → thanks-by-name + loyalty QR.

Implementation notes: remove the `/fulfillment` + `/identify` interpose from
the wizard-mode attract routing (the sessionStorage post-identify-path
mechanism); carry fulfillment on the order at the end instead — the kitchen
ticket still gets its para aquí/para llevar. `/identify` (loyalty phone
recognition) is REMOVED from the wizard-mode pre-order path entirely; the
post-payment loyalty QR is the loyalty touchpoint for the pilot. FLAG for Juan:
this means recognized-customer stamp accrual doesn't happen automatically on
wizard orders during the pilot — if that matters, propose (don't build) an
optional loyalty prompt on the name screen. Grid mode keeps its existing
routing untouched.

## Divergences to fix (current wizard → v15 behavior)

### D1 — Protein step is ONE multi-select grid (kills the Segunda step)
7 protein cards (asada, pollo, porkbelly, huevo, portobello, camarón, pescado).
Tap toggles selection; max 2 (third tap → toast "Máximo 2 proteínas"); selected
cards get the check badge. Hint under title: "Elige 1 o combina 2 proteínas".
Footer: primary continue button, disabled until ≥1, showing live combined price
(and "· combo" tag when 2 selected) + a ghost "← Empezar de nuevo".
Implementation: first-selected slug = base item; the second protein = the
matching option in the base item's `Segunda proteína` group (label→slug map
already exists in the wizard). Totals are symmetric by construction, so
selection order can't change the price. **Delete the separate segunda step and
the "✋ sin segunda" card.** Chorizo never appears on this grid (it exists only
via the Breakfast ask, D6) — except transiently if already selected (backing up
from Breakfast con chorizo), mirroring the prototype's hidden-protein rule.

### D2 — Birria / Cochinita / Rollbertos OUT of the wizard
Delete the "other options" section from the protein screen. These three exist
ONLY as Favoritos on the attract screen (D6/D7).

### D3 — Estilo step: v15 cards + the two-button branch
Cards exactly as v15: badge pill first (California & Mission: terracotta pill
with outline-burrito icon + "BURRITO"; Fries: gray pill "🍟 SOLO PAPAS · NO ES
BURRITO" with the outline fries icon), then icon + style name with the LIVE
TOTAL PRICE right-aligned (e.g. asada: $250 / $250 / $299 — full price, not
"+$49"/"Incluido"), then the sub kicker ("El clásico de San Diego" / "Al estilo
San Francisco" / "Tu proteína sobre papas — sin tortilla"), then ingredient
chips with outline icons. Selecting a style does NOT auto-advance. Two footer
buttons (disabled until a style is picked):
- primary **"Así está bien ✓"** → skip Quitar entirely, go to Agregar (D5)
- ghost **"¿Deseas modificar algo?"** → Quitar step (D4)

### D4 — Quitar step is OPT-IN, rows per v15
Reached only via "¿Deseas modificar algo?". Keep the style-filtered option list
(current behavior is correct). Rows match v15: ingredient outline icon + name,
right-side state label LLEVA / SIN, strikethrough + terracotta treatment when
removed. Hint: "Toca un ingrediente para quitarlo". Continue → Agregar.

### D5 — "¿Deseas agregar algo?" = extras + SIDES + DRINKS
Title "¿Deseas agregar algo?". Three sections with v15 headers:
- **Para tu burrito** — the item's Extras modifier options (guac/queso/cebollita/chorizo)
- **Complementos** — live active menu items from the tenant's sides category
- **Bebidas** — live active menu items from the drinks category
Sides/drinks are added as their own cart lines (normal menu items via the
existing fetchMenu); extras attach to the burrito as modifiers. Cards show qty
badges when added; footer is the split continue button with the running total
("No, gracias — continuar" when nothing selected/in cart). This replaces the
current extras-only step.

### D6 — Attract screen: ask overlays + the drinks door
- **Breakfast** preset tap → v15 "¿Con chorizo?" overlay first: primary
  "Con chorizo · +$30 · $210", ghost "Sin chorizo · $180", Atrás chip. Result
  carried in the preset (segundaName 'Chorizo' or none), THEN straight into
  the wizard per D11 — no fulfillment/identify first.
- **Rollbertos** preset tap → required "¿Con birria o cochinita?" overlay at
  the attract screen (both options showing $139), Atrás chip. Result carried in
  the preset. (Remove the choice-picker from the review card.)
- v15 roster change: Pollos Hermanos, Surf-N-Turf and Carne Asada Fries are
  REMOVED from favoritos — do not render them. Cerveza Fría is ADDED as a
  drink favorite (see acceptance #1).
- **FULL-SCREEN PORTRAIT LAYOUT (Juan, explicit): the kiosk tablet sits
  VERTICAL in a counter stand. The attract screen must use the ENTIRE screen
  real estate — content distributes across the full height and scales up
  (v15 has a min-height:900px media block doing exactly this: bigger logo,
  64px icons, taller cards and buttons, space-evenly distribution). No dead
  half-screen below the buttons. Verify on the Samsung in portrait.**
- Add the third door under the big button: outline-cup icon +
  **"Solo bebidas y complementos"** → routes into the Agregar-style screen
  (sides + drinks sections only) then cart, then the D11 end-sequence.
- Preset card sub lines formatted as v15: "Carne Asada · California",
  "Huevo · California", etc. Preset prices must come from the fetched builder
  data (item price + estilo adj + segunda adj), NOT hardcoded strings — the
  current hardcoded '$250'… array will silently rot when Juan edits prices.

### D7 — Preset landing = ESTILO screen, not review
Builder-backed presets (El California, Breakfast) land on the Estilo step with protein(s) + style
pre-selected — one tap from "Así está bien", everything still changeable
(back to protein keeps selections). Fixed presets (Birria, Cochinita,
Rollbertos after its choice) add straight to the cart and land on the Agregar
step as the upsell, exactly like v15.

### D8 — Icons: the v15 outline set, zero emojis
Port the prototype's `I` icon map verbatim (24×24, stroke-2, currentColor SVG
strings — includes 6 hand-drawn: burrito, fries, rice, beans, taquitos, onion)
into `kiosk/src/lib/builderIcons.tsx` as components. Where an icon is a stock
Lucide glyph, `lucide-react` (already a dep) is fine; Tabler ones (pig,
mushroom, sausage, cheese, avocado, pepper, bottle, glass-cocktail) and the 6
hand-drawn get inline SVG copied from the prototype. Tint terracotta
(brand-300) on cards per v15. No emoji may remain anywhere in wizard-mode UI.

### D9 — Close of flow: para aquí/llevar → name → pay → thanks + loyalty QR
After cart, per D11: first "¿Para aquí o para llevar?" (two big cards), then
name capture titled "¿A qué nombre llamamos tu orden?" (hint "Con
este nombre te llamaremos cuando esté lista") — if the existing name capture
differs materially from v15's full-screen keyboard, restyle it to match; then
existing payment; then the confirmation screen greets by name ("¡Listo,
{nombre}!" / "Escucha tu nombre — te llamamos cuando tu orden esté lista.")
with the loyalty QR card ("Suma puntos con esta orden") — the post-payment
loyalty QR mint already exists; make sure wizard-mode orders surface it.

### D10 — Copy: verbatim from the prototype
Every customer-facing string (es + en) comes from the prototype's `T` i18n
table — port them into the kiosk i18n JSONs verbatim, including step kickers
("Paso 1 · Proteína"…), hints, button labels, and the progress-bar step count
(4 segments: Proteína / Estilo / Ajustes / Extras).

## Acceptance — side-by-side with the prototype (browser) before handing back
1. Attract: SIX favoritos, in order: El California, Breakfast, Birria,
   Cochinita, Rollbertos, Cerveza Fría — prominent cards per v15 (3×2 grid,
   large terracotta icons, bigger label). Cerveza Fría adds the beer straight
   to the cart (qty merges with beers added later from Bebidas) then lands on
   the Agregar upsell. Computed prices, Breakfast + Rollbertos overlays, big
   "Arma tu burrito", "Solo bebidas y complementos" door.
2. Protein grid: multi-select; asada+camarón shows $340 on the continue button.
3. Estilo (asada): $250 / $250 / $299 on the cards, badges correct, "Así está
   bien" path never shows Quitar; "modificar" path does.
4. Agregar shows extras + real sides + real drinks; drinks land as separate
   cart lines.
5. Breakfast con chorizo totals $210; Rollbertos con cochinita $139 straight to
   cart + upsell.
6. All prices server-computed (no client math drift vs seeded modifiers).
7. iPad / any grid-mode device: byte-for-byte unchanged. Other tenants: unchanged.
8. Attract screen fills the full portrait height on the Samsung — no dead
   lower half (v15 media block is the reference).
8b. Flow order: favorito/Arma tap lands DIRECTLY in the wizard (no for-here/
   to-go or identify first); after the cart, the sequence is exactly
   para-aquí/para-llevar → name → pay → thanks+QR, and the kitchen ticket
   still carries the fulfillment type.
9. `npm run typecheck` + tests green; Samsung gets a fresh APK
   (`npm run android:install`) since wizard code changed.

## Deploy note
If juanbertos is already flipped to wizard tenant-wide, coordinate the deploy
with Juan for a slow hour — this reshapes the live customer flow. If still
device-piloting, deploy freely and re-test on the Samsung.
