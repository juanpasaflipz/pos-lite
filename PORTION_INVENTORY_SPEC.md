# Two-Stage Inventory: Expenses → Raw Stock → Portioned Components → Menu

**Status:** Draft for review · 2026-08-03
**Decision owner:** Juan
**Decisions locked:** Two-stage model (raw stock + prep runs with yield) · kitchen counts **portioned components**, menu availability derived from the limiting component · auto-86 at zero · spec-first, build in follow-up sessions

---

## 1. The problem

Today the receipt flow conflates two different facts:

1. **"I spent money"** — receipt photo → AI parse → expense. Correct.
2. **"I can sell food"** — the match step (`InventoryMatchStep` → `applyInventoryMatches`) immediately increments `inventory_items.quantity`, and that same quantity is what recipes (`menu_item_ingredients`) would theoretically deduct against. Wrong: buying 10 kg of arrachera doesn't mean you can sell a single burrito yet. Trim, marinade, cook loss, and portioning stand between the receipt and the line.

And the deduction side is worse than theoretical — it's **dormant**: `POST /api/inventory/deduct` is never called from the POS client (only the delivery manual-sales import uses recipe deduction). So today inventory drifts up with every receipt and only comes down via manual counts. The variance reports fight a model the operation doesn't follow.

## 2. The target model

Four layers, each recording only what it actually knows, connected by two explicit conversion events (purchase-match and prep):

```
RECEIPTS ────────────► EXPENSES                 money out; categories; vendor; CFDI
                          │
                          │ match step (kept, reframed): lines restock RAW stock
                          ▼
RAW STOCK ───────────► WALK-IN / DRY STORAGE    10 kg arrachera, 5 kg queso — NOT sellable
                          │
                          │ PREP RUN (new): consumes raw, produces portions, records yield %
                          ▼
PORTIONED COMPONENTS ► LINE INVENTORY           42 porciones asada, 50 tortillas, 30 conos papas
                          │
                          │ component recipe per menu item; availability = limiting component
                          ▼
MENU AVAILABILITY ───► AUTO-86                  sellable(item) = 0 → "Agotado" on POS/kiosk/QR
```

- **Expenses stay the financial truth.** Receipt scan flow is unchanged (parse, vendor match, categories, CFDI). The match step survives but now explicitly stocks the **raw** layer — which no longer gates the menu, so Juan's complaint is structurally fixed: a Costco run never makes anything sellable.
- **Prep runs are the conversion truth.** "Producción" records: consumed 10 kg arrachera (raw) → produced 42 porciones asada (component). The delta between raw cost consumed and portions produced gives **yield % and true cost per portion** with no extra bookkeeping.
- **Components, not menu items, are what the kitchen counts.** A California Burrito and a Taco de Asada both draw from the same 42 asada portions — counting components avoids the double-count that per-menu-item counts would create, and shared items (tortillas, salsas, papas) work naturally.
- **Menu availability is derived, never entered:** `sellable(menu_item) = floor(min over recipe components of on_hand / qty_needed)`. Zero → auto-86. Kitchen preps more → back on sale automatically.

## 3. Data model

Guiding choice: **reuse `inventory_items` for both layers** with a `kind` discriminator, and **reuse `menu_item_ingredients`** as the component recipe. This keeps existing screens, RLS, cost history, and waste log working, and the migration is additive.

```sql
-- Migration ~0101 (verify next number against migrations/ at build time)

ALTER TABLE inventory_items ADD COLUMN kind TEXT NOT NULL DEFAULT 'raw'
  CHECK (kind IN ('raw','component'));
-- Existing rows default to 'raw' — matches what they actually are today.
-- Components: unit = 'porción' (or 'pieza'); quantity = portions on hand.

ALTER TABLE inventory_items ADD COLUMN low_threshold_portions NUMERIC(10,2);
ALTER TABLE inventory_items ADD COLUMN auto_86 BOOLEAN NOT NULL DEFAULT true;      -- components only
ALTER TABLE inventory_items ADD COLUMN sold_out_manual BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE prep_runs (
  id          SERIAL PRIMARY KEY,
  tenant_id   TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
  prepped_at  TIMESTAMPTZ DEFAULT NOW(),
  employee_id INTEGER REFERENCES employees(id),
  notes       TEXT
);

CREATE TABLE prep_run_inputs (            -- raw consumed
  id                SERIAL PRIMARY KEY,
  tenant_id         TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
  prep_run_id       INTEGER NOT NULL REFERENCES prep_runs(id) ON DELETE CASCADE,
  inventory_item_id INTEGER NOT NULL REFERENCES inventory_items(id),  -- kind='raw'
  quantity          NUMERIC(12,4) NOT NULL CHECK (quantity > 0),      -- in the raw item's unit
  cost_at_time      NUMERIC(12,4)                                     -- snapshot of raw cost_price
);

CREATE TABLE prep_run_outputs (           -- components produced
  id                SERIAL PRIMARY KEY,
  tenant_id         TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
  prep_run_id       INTEGER NOT NULL REFERENCES prep_runs(id) ON DELETE CASCADE,
  inventory_item_id INTEGER NOT NULL REFERENCES inventory_items(id),  -- kind='component'
  portions          NUMERIC(10,2) NOT NULL CHECK (portions > 0)
);

CREATE TABLE portion_ledger (             -- append-only, audit_log pattern (mig 0100)
  id                SERIAL PRIMARY KEY,
  tenant_id         TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
  inventory_item_id INTEGER NOT NULL REFERENCES inventory_items(id),
  delta             NUMERIC(12,4) NOT NULL,
  reason            TEXT NOT NULL CHECK (reason IN
                    ('purchase','prep_consume','prep_produce','sale','refund_restore',
                     'void_restore','waste','count_adjust','carryover_discard')),
  ref_type          TEXT,                  -- 'expense' | 'prep_run' | 'order' | 'waste_log'
  ref_id            INTEGER,
  employee_id       INTEGER REFERENCES employees(id),
  created_at        TIMESTAMPTZ DEFAULT NOW()
);
```

All new tables get the standard RLS policy + `app_user` grants (copy the 0042/0100 pattern).

**Balance discipline:** one helper — `applyStockDelta(itemId, delta, reason, ref)` — inserts the ledger row and updates `inventory_items.quantity` in the same transaction. Every mutation path (purchase match, prep, sale, waste, count) goes through it; `quantity` becomes a cache over the ledger. Availability clamps at 0; the ledger keeps the true running sum so variance stays visible.

**Recipes:** `menu_item_ingredients` rows now point (by convention, enforced in UI) at `kind='component'` items with `quantity_used` in portions — typically 1. Combos resolve through their slot items' recipes. Modifiers don't deduct in v1 (listed as a competitive P0 elsewhere; the ledger design accommodates it later via `modifier_recipes`).

**Tenant setting:** `tenants.inventory_mode DEFAULT 'ingredients'` (`'ingredients'` = today's behavior, unchanged) vs `'two_stage'`. Existing tenants see zero change; Juanberto's pilots `two_stage`.

## 4. Flows

### 4.1 Receipt → expense → raw stock (kept, reframed)

`ReceiptScanModal` and `InventoryMatchStep` stay. Two changes:

- Match step is scoped to `kind='raw'` items and relabeled **"¿Qué entró a la bodega?"** — it stocks the walk-in, and the UI copy makes clear this does not touch the menu.
- Matching stays **optional and deferrable**: skipping it leaves a clean expense (the existing Unlinked Purchases surface already handles catch-up). Non-food expenses (gas, servilletas) never match — they're just expenses, as today.

`applyInventoryMatches` is refactored to run through `applyStockDelta(…, 'purchase', expense)` so purchases enter the ledger; its weighted-average `cost_price` logic is kept as-is (it feeds prep costing below).

### 4.2 Prep run → portions (new: "Producción")

New **Producción** tab in Inventory — built like a mini POS grid, big touch targets, works on the Galaxy A07:

1. **Sacamos** (inputs): pick raw items + quantities consumed (10 kg arrachera, 2 kg cebolla). Optional but encouraged — it's what buys yield % and cost/portion.
2. **Salió** (outputs): pick components + portions produced (42 porciones asada). **Required** — this is the count that matters.
3. Save → one transaction: `−` raw via `prep_consume`, `+` components via `prep_produce`, snapshot input costs.

Cost per portion computed per run: `Σ(input qty × cost_at_time) / portions produced`, rolled into the component's `cost_price` with the same weighted-average approach purchases use. Yield trend per component (portions per kg over time) surfaces in reports — "la arrachera del martes rindió 38, hoy 42."

Components with no meaningful raw input (bottled Jarritos, pre-made tamales from a supplier) are stocked either directly at the receipt match step (they can be `kind='component'` purchasable items — the match step allows both kinds for exactly this case) or via an inputs-empty prep run. One mental model: **if it's sellable-as-counted, it's a component.**

Same-day corrections by manager create compensating ledger entries; history is never mutated (matches the 1.4.x audit discipline).

### 4.3 Sales → component deduction (new: actually wired this time)

At **order creation**, server-side and transactional — `orders.js`, `kiosk.js`, `customer-order.js`, delivery ingestion: for each order item, walk `menu_item_ingredients` (component rows) and `applyStockDelta(−qty_used × qty, 'sale', order)`. The dormant `/api/inventory/deduct` endpoint stays untouched for ingredient-mode tenants; two-stage mode never calls it.

- Refund/void: `+` back via `refund_restore`/`void_restore`, hooked into the existing 1.4.x refund/void path.
- **Race handling:** single `UPDATE … SET quantity = quantity − $n` under the transaction, no read-modify-write. Last-portion collisions (two kiosks, one asada left) both succeed and drive the count to 0 — the kitchen resolves it humanly; blocking a paid kiosk order over one portion is worse than a 30-second apology. The ledger stays truthful either way.

### 4.4 Derived availability → auto-86

Never stored per menu item; computed in menu payloads:

```
sellable(item) = item has component recipe
  ? floor(min(component.quantity / qty_used))   -- 0 if any component sold_out_manual
  : ∞                                            -- items without recipes never auto-86
```

- **POS:** item cards show the sellable count badge (green / amber at threshold / red "Agotado"); sold-out disabled with manager override (they can see the kitchen). Component-level counts visible in the Inventory page as today (StockTab already renders `inventory_items`).
- **Kiosk + QR + menu board:** sold-out renders greyed "Agotado" (reuse the existing plan-locked item treatment); add-to-cart blocked; **submit-time re-check** so a stale menu can't sell a phantom portion.
- **Recovery is automatic:** prep run lands → counts rise → item back on sale. Nobody has to remember to un-86. `sold_out_manual` on a component (plancha died → 86 everything asada-based at once) always wins until cleared — a component-level kill switch is exactly what "86 the asada" means operationally.
- Availability only *derives* from components in `two_stage` mode; `active` keeps meaning "on the menu at all," unchanged.

### 4.5 End of day (P3, high-value)

Quick count screen per component: expected = carryover + produced − sold − waste; kitchen enters actual; difference posts `count_adjust` and feeds a **portion-variance report** — real AvT in units everyone understands ("faltan 3 porciones de asada"). Perishables flagged `discard_on_close` get a one-tap discard to waste (`carryover_discard`). Raw-side variance (walk-in counts) keeps using the existing CountTab/variance machinery — it already fits `kind='raw'`.

## 5. What the money side gets for free

Because prep runs snapshot input costs, the financial loop closes without any extra data entry:

- **Cost per portion, per component** — from prep runs (§4.2), weighted-average maintained.
- **Plate cost per menu item** — Σ(component cost × qty_used) over its recipe; margin vs price on the menu screen: "Burrito asada te cuesta ~$31, lo vendes en $95 → 67%."
- **Yield tracking** — portions per kg per component over time; catches supplier quality drift and over-trimming.
- **Food-cost %** — COGS-category expenses ÷ sales stays as the top-level sanity check; the two numbers (theoretical plate cost vs actual spend) bracket reality, and their gap *is* shrinkage+waste.

## 6. What happens to existing pieces

| Piece | `two_stage` mode | `ingredients` mode (all current tenants) |
|---|---|---|
| Receipt scan → expense | unchanged | unchanged |
| InventoryMatchStep / Unlinked banner | kept, scoped to raw layer, relabeled | unchanged |
| `inventory_items` | split by `kind`; all existing rows = `raw` | unchanged (`kind` invisible) |
| `menu_item_ingredients` | points at components, drives availability + deduction | unchanged |
| StockTab / counts / variance / stale / shrinkage | work as-is; gain a Raw/Componentes filter | unchanged |
| Waste log | works as-is (components are inventory_items) — routes through ledger | unchanged |
| `/api/inventory/deduct` | never called | unchanged (dormant) |
| Purchase orders / vendors / cost history | unchanged (raw layer) | unchanged |
| AI tabs (forecast) | forecasting portions is a natural v2; out of scope | unchanged |

Mode switch lives in Settings, Pro-gated — pairs with the kiosk flagship story (*"tu kiosko se apaga solo cuando se acaba la comida"*), but per the marketing-claims rule that line ships **only after** it's live and verified.

## 7. Build plan (follow-up sessions)

- **P1 — Foundation (~1 session):** migration (kind, prep tables, ledger), `applyStockDelta`, refactor `applyInventoryMatches` onto it, `POST/GET /api/prep-runs`, Producción tab, component CRUD (kind picker in inventory form), recipe editor pointing menu items at components. Tests: ledger/cache consistency, RLS, mode guards. Suite stays green (226/226 baseline).
- **P2 — Availability (~1 session):** sale deduction at order creation across POS/kiosk/QR/delivery, refund/void restore, derived sellable counts in all menu payloads, Agotado rendering + submit-time guard, `sold_out_manual` toggle, POS badges.
- **P3 — Money + variance:** EOD component count, portion-variance report, plate cost + margin on menu screen, yield trends.

Each phase independently deployable; `inventory_mode` default keeps every existing tenant untouched until Juanberto's flips the switch.

## 8. Open questions for Juan

1. **Prep inputs — required or optional?** Spec says optional (outputs are the hard requirement). Strict mode later if the yield data proves valuable enough to enforce.
2. **Who logs prep?** Recommend: any clocked-in employee can log a run; corrections need `manage_inventory` — mirrors the discount-approval split.
3. **Decimals?** Ledger supports them; recommend whole portions in the prep UI v1 (media orden handled at the recipe level, e.g. taco uses 0.5 of an asada portion? — or keep taco = 1 smaller portion and prep counts taco-portions separately. Needs Juan's call per component.)
4. **Carryover:** which components are `discard_on_close` (arroz sí, salsas depende)? Per-component flag, EOD screen handles it; default off in P1.
5. **Pilot timing** at Juanberto's — before or after the kiosk builder parity work in flight?
