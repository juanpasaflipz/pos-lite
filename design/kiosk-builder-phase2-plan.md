# Phase 2 Plan — Kiosk burrito-builder wizard UI

**Date:** 2026-07-27 · **Author:** Claude Code (scoping only — not yet implemented)
**Predecessors:** Phase 1 seed shipped `e7f148f` (10 items + 29 groups + 136 options
seeded active=false to `juanbertos`, category id **2392**). Prototype:
`design/kiosk-builder-prototype.html` v11. Spec: `design/kiosk-builder-menu-spec.md`.

## Goal

Ship the customer-facing wizard that walks a Juanberto's kiosk customer through
**protein → estilo → segunda (optional) → quitar → extras → cart**, submits as a
normal kiosk order, and lands as printable kitchen tickets. Gated per-tenant so
only juanbertos sees the wizard; every other tenant stays on today's grid.

## Success criteria (machine-verifiable where possible)

1. `tenants.kiosk_mode = 'wizard'` for juanbertos + `npm run android:install`
   → tablet boots into the wizard flow instead of the grid.
2. `tenants.kiosk_mode = 'grid'` (default for every other tenant) → zero visible
   change to those kiosks.
3. Completing the wizard for `Asada + Fries` produces a kiosk order whose
   subtotal reads **$299**; `Asada + Camarón` reads **$340**; `Huevo + Chorizo`
   reads **$210**; `Rollbertos + Con birria` reads **$139**. All computed
   server-side from the seeded modifier price_adjustments — no wizard-side
   math.
4. Kitchen ticket for `Burrito Huevo + California + Segunda Chorizo + Sin queso + Guacamole extra`
   lists the item name + all four modifier lines in that order.
5. Existing grid, POS, QR customer-order, and menu-board payloads for
   juanbertos still return zero of the 10 seeded items. (Wizard has its own
   fetch path.)
6. Super-admin can flip `kiosk_mode` grid ↔ wizard and the kiosk picks it up
   within one attract-screen cycle without a rebind.

## Architecture decisions (with rationale)

### A. Wizard reads via a dedicated endpoint, not by relaxing existing filters

New endpoint **`GET /api/kiosk/builder-menu`**. Returns the hidden category's
items + attached modifier groups + options in a single payload, using
`adminSql` and bypassing `active`. Gated on `tenants.kiosk_mode = 'wizard'` —
returns `404` otherwise so the endpoint can't be scraped.

Rejected alternative: adding `?include_hidden` to `/api/customer-order/menu`.
Widens blast radius (that endpoint is called by every QR order surface), and
we'd need per-caller gates anyway.

### B. Slug-to-item-id mapping via a small config table, not name parsing

New table **`kiosk_builder_map`** — one row per (tenant_id, slug, menu_item_id):
```
CREATE TABLE kiosk_builder_map (
  tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
  slug TEXT NOT NULL,              -- 'asada', 'pollo', ..., 'birria', 'cochinita', 'rollbertos'
  menu_item_id INTEGER NOT NULL REFERENCES menu_items(id),
  PRIMARY KEY (tenant_id, slug)
);
```
Populated by an extension to `scripts/seed-builder-menu.mjs` (add a step that
upserts these rows keyed on the slug it already knows internally).

Rejected: parse item names ("Burrito Carne Asada" → 'asada') at render time.
Brittle — one rename in Menu Management and the wizard breaks. Config table
survives menu edits.

### C. Modifier groups keyed by internal slug suffix, not by name match

The Phase 1 seed already named groups `Estilo__asada`, `Segunda proteína__asada`,
etc. The wizard's protein-to-group resolution is:
```
for group in groups_of(item):
    kind, slug = group.name.split('__', 1)  // 'Estilo' | 'Segunda proteína' | 'Quitar' | 'Extras'
```
Displayed name to the customer is the part before `__`. Suffix stays server-side.

### D. Presets on the attract screen use the same builder items

The 7 presets in the spec (El California, Pollos Hermanos, Breakfast,
Surf-N-Turf, Birria, Cochinita, Rollbertos) are stored client-side as
`{ slug, defaultStyle, defaultSecond? }`. Tapping a preset skips to the last
step with those choices pre-selected but still editable. No new table.

### E. Rollback = super-admin flag flip. No in-kiosk gesture.

Enforcement of the "no back-office in kiosk" rule (per your feedback memory).
If the wizard breaks mid-service, cashier calls the owner, owner flips
`kiosk_mode` back to `grid` from `/super-admin`, the kiosks pick it up on
next attract cycle. Web + iPad kiosks are ~5 seconds; Android is same (the
flag comes from the server, not the APK bundle — nothing to reinstall).

## Data model changes

Migration **0092** (or whatever `ls server/db/migrations | sort | tail -1 + 1`
resolves to at implementation time — see CLAUDE.md warning):

```sql
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS kiosk_mode TEXT DEFAULT 'grid';
-- values: 'grid' (today) | 'wizard' (Juanberto's Phase 2). Nullable in transit.

CREATE TABLE IF NOT EXISTS kiosk_builder_map (
  tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
  slug TEXT NOT NULL,
  menu_item_id INTEGER NOT NULL REFERENCES menu_items(id),
  PRIMARY KEY (tenant_id, slug)
);
ALTER TABLE kiosk_builder_map ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON kiosk_builder_map
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON kiosk_builder_map TO app_user;
```

Also codify in `server/db/pg-schema.sql`.

## API surface

**New:**
- `GET /api/kiosk/builder-menu` → `{ items: [{id, slug, name, name_en, price, groups: [{name, kind, required, min, max, options: [{id, name, price_adjustment}]}]}], presets: [...] }`.
  Server splits `__slug` off group names for display. Gated on
  `kiosk_mode='wizard'`. Uses adminSql, bypasses `active`.
- `GET /api/kiosk/config` → `{ mode: 'grid' | 'wizard' }` — polled by kiosk on
  attract cycle. Cheap (single row read). Existing kiosk bind response could
  also carry it, but the polled endpoint enables mid-shift rollback.

**Unchanged (reused as-is):**
- `POST /api/kiosk/orders/hold` (cart submit → draft_kiosk)
- `POST /api/kiosk/orders/send-to-kitchen` (pay-first promotion)
- `POST /api/kiosk/orders/:id/mp-charge` (MP terminal)
- All modifier submission plumbing (order_item_modifiers already captures
  price_adjustment at write time, so combo totals lock in immutably)

## Frontend components (all under `kiosk/src/`)

**New:**
- `screens/BuilderWizardScreen.tsx` — orchestrator, step state machine
- `components/wizard/ProteinPicker.tsx` — 7-tile grid + 3 fixed (birria/cochinita/rollbertos)
- `components/wizard/EstiloStep.tsx` — 3 tiles (California / Mission / Fries) with
  live price delta shown on Fries
- `components/wizard/SegundaStep.tsx` — optional; hidden if base protein has no
  segunda group (Fixed items skip this whole step)
- `components/wizard/QuitarStep.tsx` — multi-select chips, filtered by style
  (California/Mission ingredient set client-side per spec)
- `components/wizard/ExtrasStep.tsx` — multi-select chips
- `components/wizard/CartReview.tsx` — cart summary, edit-item, checkout button
- `screens/AttractScreen.tsx` — extend existing: 7 preset tiles when
  `kiosk_mode='wizard'`, otherwise renders today's content

**Changed:**
- `App.tsx` — boot fetches `/api/kiosk/config`, routes to `BuilderWizardScreen`
  vs `KioskMenuScreen` based on `mode`. Also polls every N seconds for mid-shift
  flip.
- `lib/kioskApi.ts` — add `fetchBuilderMenu()`, `fetchKioskConfig()`
- `i18n/` — add wizard-specific keys (step titles, "Sin ...", etc.), es + en

## Server-side (all under `server/`)

**New:**
- `routes/kiosk.js` — add the two endpoints described above
- `db/migrations/00NN_kiosk_wizard.js` — schema above

**Changed:**
- `scripts/seed-builder-menu.mjs` — extend to also upsert `kiosk_builder_map`
  rows keyed on the slugs it already tracks internally. Same idempotency shape.
- `routes/tenants.js` (or the super-admin route) — expose `kiosk_mode` as a
  toggleable field on the tenant detail screen

## Milestones (rough)

| # | Milestone | Est. |
|---|---|---|
| M1 | Migration + `kiosk_builder_map` seeding + super-admin toggle | 3h |
| M2 | `/api/kiosk/builder-menu` + `/api/kiosk/config` endpoints + tests | 3h |
| M3 | BuilderWizardScreen + 5 step components (skeleton, no polish) | 6h |
| M4 | AttractScreen preset tiles + preset → wizard state seeding | 2h |
| M5 | Cart review + submit through existing hold + pay-first pipes | 2h |
| M6 | i18n keys, Talavera terracotta polish, mobile touch targets ≥40px | 3h |
| M7 | Vitest for the two new endpoints + kiosk_mode gate | 2h |
| M8 | APK rebuild, sideload to Samsung, dogfood a real order end-to-end | 2h |

**Total: ~23 hours** = ~3 dev days including QA. Longer if the 67 ⚠️
placeholder prices are still open by then and Juan wants to sit and confirm
them alongside the build.

## Rollout sequence

1. Land Phase 2 code on master with default `kiosk_mode='grid'` — every kiosk
   in the world is unchanged.
2. Manual QA on a dev workstation against a Neon branch: `UPDATE tenants SET kiosk_mode='wizard' WHERE id='juanbertos'` on the branch, run the kiosk locally, walk every flow.
3. Flip juanbertos to `wizard` on prod during a slow hour. iPad + web kiosks
   pick it up in ≤10s. Android needs `npm run android:install` for any code
   change but reads the flag live.
4. Watch first live service. Grid is one super-admin flip away for the entire
   service — that's the whole rollback plan.

## Explicit non-goals

- Recipe wiring for the 10 builder items (needed for COGS/inventory but doesn't
  block a working wizard; separate work per `project_juanbertos_recipe_wiring_state`).
- Retiring today's live items (Breakfast, Pollos Hermanos, etc.) — coexistence
  is fine for the pilot; those stay POS-only, wizard is the customer surface.
- Kitchen printer template changes — default ESC/POS rendering ("Burrito Huevo"
  + indented modifiers) is acceptable for the pilot. Bench for feedback from
  Juanberto's kitchen crew after 1 week.
- Voice-ops integration with the wizard (out of Phase 2, likely never — voice
  is for back-office).
- Loyalty QR camera scan integration (already shipped for Customer Lookup in
  `3cf5add`; kiosk pass-scan lives at a different entry point and is unblocked
  independently).

## Risks

- **APK cadence.** Any wizard bug found in prod means new APK, adb install,
  redistribute. Web + iPad are one push away. Mitigation: fix in `kiosk/src/`
  runs on iPad WebView immediately; only bail out to APK reinstall if the fix
  touches native config or Android manifest.
- **Modifier map size.** 136 options × ~30 bytes each = ~4KB, plus items and
  groups. Well under any cache limit. Sanity-verify with a real payload dump.
- **Second-protein UX confusion.** Test whether real customers understand
  "Segunda proteína" is optional and additive-priced. If churn on that step is
  high, may need a "Solo una proteína" first-tap toggle. Watch conversion.
- **Rollback muscle memory.** Make sure at least two people at Juanberto's
  know the super-admin URL and password before wizard goes live. Solo owner
  going home with the password = no rollback.
