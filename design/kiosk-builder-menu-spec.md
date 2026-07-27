# Builder Menu Spec — juanbertos tenant (kiosk burrito-builder, Phase 1)

**Date:** 2026-07-27 · **Author:** Cowork agent (with Juan)
**Prototype reference:** `design/kiosk-builder-prototype.html` (v11) — the interactive
mockup this data model mirrors. **Read it if any rule below is ambiguous; its
`PRESETS/PROTEINS/COMBO_PRICES/STYLES/FRIES_PRICES/EXTRAS` block is the source of truth.**

## Goal

Create the menu items + modifier groups that will power the new guided
burrito-builder kiosk flow, in the REAL menu system, for the **juanbertos
tenant only**. This is Phase 1 (data only) — the wizard UI (Phase 2) comes later.

## Hard requirements

1. **Everything created here must be INVISIBLE to live customers** until the
   wizard ships. The current kiosk grid, QR menu, POS, and website must not
   change. Use whichever mechanism the schema supports best: `active = false`
   on every new item, or a dedicated category that all customer surfaces filter
   out. Verify empirically (load the kiosk menu endpoint for the tenant after
   seeding) — do not assume.
2. **Do not modify or delete any existing menu item, category, or modifier.**
   Existing items keep running the shop. Coexistence, not replacement.
3. Implement as an **idempotent seed script** in the repo (e.g.
   `scripts/seed-builder-menu.mjs`): re-running updates in place rather than
   duplicating; `--dry-run` prints the full plan without writing; scoped to the
   juanbertos tenant by explicit id/subdomain, never "all tenants".
4. **Check the actual schema first.** This spec assumes modifier groups can be
   attached per item with per-item price adjustments (the kiosk's
   `modifierMap[item.id]` suggests per-item structure). If groups are shared
   across items, adapt: create one group-instance per item (suffix names
   internally) so the per-item adjustments below survive. Flag any place the
   schema can't express the spec instead of silently approximating.

## Placeholder prices (Juan must confirm — flag loudly in the script output)

Chorizo-related, fries fallbacks, and extras were never priced by Juan. They are
marked `⚠️` below. Seed them at the listed values but print a summary table of
every `⚠️` price at the end of the run so Juan has one list to correct.

## New category

`Arma tu burrito` (en: `Build your burrito`) — hidden from customer surfaces
until launch (see Hard requirement 1).

## Builder items (7) — one per protein

| Item (es) | en | Price | Notes |
|---|---|---|---|
| Burrito Carne Asada | Carne Asada Burrito | $250 | |
| Burrito Pollo Asado | Grilled Chicken Burrito | $219 | |
| Burrito Porkbelly | Pork Belly Burrito | $230 | |
| Burrito Huevo | Egg Burrito | $180 | breakfast base |
| Burrito Portobello | Portobello Burrito | $170 | |
| Burrito Camarón | Shrimp Burrito | $240 | |
| Burrito Pescado | Baja Fish Burrito | $265 | |

Each of the 7 items gets the four modifier groups below.

### Group 1 — `Estilo` (required, single-select, min 1 max 1)

Three options on every item. California and Mission always $0. **Fries carries a
per-item price adjustment** so the fries total matches the real fries menu:

| Base item | California | Mission | Fries adj | Fries total |
|---|---|---|---|---|
| Carne Asada | $0 | $0 | **+$49** | $299 (real menu) |
| Pollo | $0 | $0 | +$49 ⚠️ | $268 |
| Porkbelly | $0 | $0 | **+$69** | $299 (real menu) |
| Huevo | $0 | $0 | +$49 ⚠️ | $229 |
| Portobello | $0 | $0 | +$49 ⚠️ | $219 |
| Camarón | $0 | $0 | +$49 ⚠️ | $289 |
| Pescado | $0 | $0 | +$49 ⚠️ | $314 |

Option descriptions (shown by the wizard later, harmless in admin):
- California Style: `Papas a la francesa, queso, guacamole, pico de gallo, crema`
- Mission Style: `Arroz, frijoles, queso, guacamole, pico de gallo, crema`
- Fries: `Tu proteína sobre papas — sin tortilla (NO es burrito)` /
  en `Your protein over fries — no tortilla (NOT a burrito)`

### Group 2 — `Segunda proteína` (optional, single-select, min 0 max 1)

Per-item adjustments — **computed so base + adjustment equals the combo price**
(manual combos where Juan set them; otherwise `max(pA,pB) + $90` fallback ⚠️).
The two REAL anchors: asada+camarón = $340 (Surf-N-Turf), huevo+chorizo = $210 ⚠️
(placeholder Juan must confirm).

| Base ↓ / Add → | Asada | Pollo | Porkbelly | Huevo | Portobello | Camarón | Pescado | Chorizo |
|---|---|---|---|---|---|---|---|---|
| **Asada ($250)** | — | +90 | +90 | +90 | +90 | **+90** (=340 real) | +105 | n/a |
| **Pollo ($219)** | +121 | — | +101 | +90 | +90 | +111 | +136 | n/a |
| **Porkbelly ($230)** | +110 | +90 | — | +90 | +90 | +100 | +125 | n/a |
| **Huevo ($180)** | +160 | +129 | +140 | — | +90 | +150 | +175 | **+30** (=210 ⚠️) |
| **Portobello ($170)** | +170 | +139 | +150 | +100 | — | +160 | +185 | n/a |
| **Camarón ($240)** | +100 | +90 | +90 | +90 | +90 | — | +115 | n/a |
| **Pescado ($265)** | +90 | +90 | +90 | +90 | +90 | +90 | — | n/a |

All non-anchor cells are the +$90 fallback rule ⚠️ — include them in the
placeholder summary. Note the matrix is intentionally asymmetric per-cell but
symmetric in totals (250+105 = 265+90 = 355). **Chorizo is offered ONLY on the
Huevo item** (it is not a standalone protein — Juan removed it from the builder;
it exists purely as the breakfast add).

Interaction note: Fries + second protein prices as `base + fries adj + second adj`
(e.g. asada+camarón fries = 250+49+90 = $389 ⚠️). The prototype's fallback
produces the same number; there is no manual fries-combo override mechanism —
if Juan ever wants one, that needs the Phase-2 pricing hook. Acceptable for now.

### Group 3 — `Quitar` (optional, multi-select, min 0, max 0/unlimited, all $0)

Union of all style ingredients (the wizard will filter by chosen style
client-side in Phase 2; in admin it's one flat group):
`Sin papas a la francesa · Sin arroz · Sin frijoles · Sin queso · Sin guacamole · Sin pico de gallo · Sin crema`
(en: No fries / No rice / No beans / No cheese / No guacamole / No pico de gallo / No sour cream)

### Group 4 — `Extras` (optional, multi-select, all ⚠️ placeholder prices)

`Guacamole extra +$35 ⚠️ · Queso extra +$25 ⚠️ · Cebollita asada +$20 ⚠️`

## Fixed items (3) — plain menu items in the same hidden category

| Item (es) | en | Price | Modifier groups |
|---|---|---|---|
| Burrito de Birria | Birria Burrito | $99 | none (Quitar optional if trivial) |
| Burrito de Cochinita Pibil | Cochinita Pibil Burrito | $99 | none |
| Rollbertos — Taquitos dorados de queso | Rollbertos — Rolled cheese taquitos | $139 | ONE required single-select group `¿Con birria o cochinita?`: `Con birria $0` / `Con cochinita $0` |

## Favorites mapping (Phase 2 config, recorded here for reference)

Attract-screen favorites → El California = Burrito Carne Asada + Estilo California;
Pollos Hermanos = Pollo + Mission; Breakfast = Huevo + California (+ ask chorizo);
Surf-N-Turf = Asada + Segunda camarón + Mission; Birria; Cochinita; Rollbertos;
Carne Asada Fries = Asada + Estilo Fries.

## Acceptance checks (script must verify and print)

1. All 10 items exist under the hidden category, correct prices, `active=false`
   (or equivalent invisibility) — and the live kiosk/QR menu payloads for
   juanbertos do NOT contain them.
2. Spot-check totals via the modifier math: Asada+Fries=299; Asada+Camarón
   (any burrito style)=340; Huevo+Chorizo=210; Pescado+Asada=355; Rollbertos=139.
3. Re-running the script changes nothing (idempotent) and exits clean.
4. Print the ⚠️ placeholder-price table for Juan.

## Explicitly OUT of scope for this phase

The wizard UI, tenant `kiosk_mode` flag, favorites config, ticket-format work,
retiring/hiding today's live items, and any change visible to customers.
