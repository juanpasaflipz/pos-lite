# Order Flow Consolidation Plan

Goal: cut the fat in the cashier → KDS → payment pipeline without changing any user-visible behavior. Ordered by payoff vs. risk. Each phase is independently shippable.

---

## Phase 0 — Decide the status model (blocks everything else)

**Today:** 6 statuses (`pending`, `confirmed`, `preparing`, `ready`, `completed`, `cancelled`) + 1 parked (`draft_kiosk`). Three of those — `pending`, `confirmed`, `preparing` — are functionally identical from the kitchen's perspective: KDS pulls all three with the same query, paints them identically, treats them identically.

The only thing the three pre-ready statuses actually encode is **provenance + payment timing**:
- `pending` = POS-created, not yet paid OR cash-paid (path A)
- `confirmed` = kiosk-sent OR Stripe-paid (path B)
- `preparing` = cash payment flipped it (path C)

That's not state — that's metadata. We already have `source`, `payment_status`, and `paid_at` for that.

**Proposal:** collapse to **`active → ready → completed`** + `cancelled` + `draft_kiosk`.

| Old | New |
|---|---|
| `pending` | `active` |
| `confirmed` | `active` |
| `preparing` | `active` |
| `ready` | `ready` |
| `completed` | `completed` |
| `cancelled` | `cancelled` |
| `draft_kiosk` | `draft_kiosk` (unchanged — it's genuinely different: not on KDS) |

**Why this is safe:**
- KDS filter at `server/routes/orders.js:933` already treats all three as one bucket.
- The transition table at `orders.js:872-879` exists only because we have three pre-ready states; collapse removes it.
- Frontend status comparisons (13 files) all do `=== 'preparing'` or `=== 'pending'` as proxies for "in kitchen" — one constant replaces all of them.

**Verification pass (done 2026-05-31):** the collapse is safer than initially flagged and surfaces three latent bugs that it would fix.

- **Reports / payroll / admin** — none filter on `pending`/`confirmed`/`preparing`. All key off `payment_status='paid'`. Safe.
- **Historical prep-time model** (`orders.js:89-101`) — only reads terminal states `('ready', 'completed')` to compute `ready_at - created_at`. Doesn't see the pre-ready distinction. Safe.
- **Edit / cancel guards** (`orders.js:1208`, `kiosk.js:722`) — only check `completed`/`cancelled`. Safe.
- **Delivery flow** (`delivery.js:213-214`) — platform-accept writes both `orders.status='confirmed'` AND `delivery_orders.platform_status='accepted'`. The `platform_status` column is the source of truth; the order.status write is decorative and can be dropped.
- **Cashier `LiveOrdersStrip.tsx:156`** — already collapses all three into one "preparing" count. UI is consistent with the collapse.
- **Webhooks** (`getnet/webhook.js`, `mercadopago.js`, `payments.js`) — every paid-flow handler sets `status='preparing'` on confirm. Replacing with `status='active'` (or letting it stay `active` since payment doesn't need to move it) is a one-line change per site.

**Latent bugs the collapse fixes for free:**

1. `KitchenDisplay.tsx:243-251` — single-tap "Ready" does TWO API calls (`pending → preparing`, then `preparing → ready`) to walk around the backend transition table. The comment literally explains: *"Backend rejects pending → ready directly, so we walk it through preparing first."* After collapse: one call.
2. `KitchenDisplay.tsx:160,179` — new-order chime only fires for `status='pending'`. Kiosk-`confirmed` orders never chime. **Silent kitchen bug today.**
3. `KitchenDisplay.tsx:285` — `pendingCount` badge only counts `pending`. Kiosk-confirmed orders aren't counted. Undercount bug.
4. `KitchenDisplay.tsx:145` — sort order map is `{ pending: 0, preparing: 1 }`. `confirmed` missing entirely; kiosk orders sort unpredictably.

**One signal to preserve correctly:**

`StatusPill.tsx:26-28` styles `pending`/`confirmed` blue and `preparing` yellow. Looks like a kitchen-progress signal but `preparing` is only ever set by cash payment — a Stripe-paid kiosk order stays blue while a cash-paid POS order goes yellow, even though both are equally "kitchen is cooking." The yellow vs blue is really a "cash-paid" proxy in disguise.

Post-collapse: derive yellow from `payment_status='paid' && payment_method='cash'` (or just `paid_at IS NOT NULL`). One-line `getStatusStyle` change. Visual stays the same for the cases that mattered.

**Migration:**
```sql
-- one statement, idempotent
UPDATE orders
SET status = 'active'
WHERE status IN ('pending', 'confirmed', 'preparing');
```
Plus a `CHECK` constraint update. No data loss; the metadata that mattered (`source`, `paid_at`, `payment_status`) survives untouched.

**Acceptance:** KDS still renders identical tickets, no API consumer (mobile, kiosk, webhook) gets a 400 on a status it used to accept, KDS "ready" tap drops from 2 PUTs to 1, kiosk-confirmed orders now chime and count. Add an alias layer at the API edge that accepts the old names for ~2 releases, then drop.

**Phase 0 split into two PRs:**

- **PR 0a (drafted 2026-05-31, no behavior change for the data model):** transition table now allows `pending`/`confirmed`/`preparing → ready` directly; KDS double-PUT removed; KDS chime + sort + pendingCount + void-window now include `confirmed`; MobileKitchenScreen "Start" button now shows for `confirmed` (was stranding kiosk orders with no action). Files touched: `server/routes/orders.js`, `src/screens/KitchenDisplay.tsx`, `src/screens/mobile/MobileKitchenScreen.tsx`. Net +38/-24 LOC, no schema change, no migration.
- **PR 0b (drafted 2026-05-31):** introduces canonical `active` status end-to-end.
  - Migration `0066_status_collapse.js` backfills existing `pending`/`confirmed`/`preparing` → `active` and changes the `orders.status` default. Idempotent.
  - All server write sites now emit `'active'`: order INSERT, kiosk send-to-kitchen, cash/card/split/Stripe/MP/Getnet/kiosk payment handlers, claim, delivery accept. The `customer-order` confirm-payment drops the `pending → confirmed` CASE entirely — payment no longer moves status, only payment_status.
  - Transition table treats `active` as canonical (`active → ready`); old names (`pending`/`confirmed`/`preparing`) still accepted as input from older deployed clients (Android kiosk APK) and treated as equivalent to `active` so we don't 400 anyone.
  - KDS query includes `'active'` alongside the legacy values for un-migrated rows / older clients.
  - Frontend tolerance: `'active'` added to OrderStatus type, StatusPill style map (blue, same as pending), KDS sort/chime/count/void-window predicates, MobileKDS sort/count/Start-button/status-pill, LiveOrdersStrip sort/preparing-count/nextStatus, CashierOrdersPanel nextStatus, CustomerOrderScreen step-index mapping.
  - StatusPill yellow-for-`'preparing'` left as vestigial — the KDS already renders a separate paid/unpaid pill next to it, so the "cash-paid" signal is independently conveyed. No-op.
  - LiveOrdersStrip + CashierOrdersPanel `nextStatus()` dropped the old Start step (pending → preparing) entirely — `active` jumps straight to ready on the cashier panel, matching what the KDS already does. Mobile KDS keeps the two-button Start/Ready as a kitchen acknowledgement signal (handleStart still writes 'preparing', which is tolerant input).
  - Files touched: 1 migration + 6 backend routes + 8 frontend files. No new test added (no existing test harness for this flow).
- **PR 0c (future cleanup, after soak):** delete the legacy name branches from server transition table and frontend tolerance checks once we're confident no in-flight order or older client is still writing them. Pure dead-code removal.

---

## Phase 1 — `services/orderCreation.js` (the highest-payoff refactor)

**Problem:** `orders.js`, `customer-order.js`, `kiosk.js` each independently:
- Calculate `subtotal` / `tax` / `total`
- Call `estimatePrepTime()`
- Build order_items + order_item_modifiers batched inserts
- Apply discount auth checks
- Generate order numbers via `insertOrderWithNumber`

Three reimplementations means three places to fix any bug, three places where the tax model can drift, three places where modifier price logic can disagree.

**Target shape:**
```
server/services/orderCreation.js
  createOrder({ tenantId, employeeId, items, source, customerRef, discount, holdState })
    → { id, order_number, status, payment_status, totals }
```

Call sites become 5–10 lines each, just translating HTTP shape → service args.

**Order of operations:**
1. Extract `insertOrderWithNumber` + `estimatePrepTime` (already exported) into the new service file. No behavior change.
2. Pull the items+modifiers batched insert block out of `orders.js:713-750` into `service.insertOrderLines(orderId, items)`.
3. Pull the tax / subtotal / discount math into `service.computeTotals(items, discount)`.
4. Rewrite the three route handlers to call the service. Diff should be net-negative ~300 LOC.
5. The `holdState` arg is what differentiates kiosk-hold from kiosk-send from POS — single boolean instead of three code paths.

**Acceptance:** all three creation endpoints produce byte-identical DB rows pre vs post for the same input. Easiest test: snapshot a few production orders, replay the request through both code paths, diff.

**Risk:** medium. Three callers, lots of integration surface. Do this AFTER Phase 0 so you're not refactoring while also collapsing status.

---

## Phase 2 — `services/payment.js` and a single `markOrderPaid()`

**Problem:** three independent sites set `payment_status='paid'`, `paid_at`, and (sometimes) push status forward:
- `server/routes/payments.js:204` (`/payments/cash`)
- `server/routes/payments.js:~132` (`/payments/confirm` — Stripe)
- `server/routes/customer-order.js:483` (`/confirm-payment` — kiosk Stripe)

Plus split payments do their own thing inside a loop, and Mercado Pago / Conekta webhooks also flip state. That's at least 5 writers to the same two columns.

**Target:**
```
server/services/payment.js
  markOrderPaid(orderId, { method, amount, txnRef, source })
    → updates payment_status, paid_at, payment_method
    → updates status if and only if current status === 'active' (no-op after Phase 0 collapse)
    → emits one audit event
```

All callers (cash, card, kiosk-Stripe, webhook, split-finalize) funnel through this one function. The "advance status on paid?" decision is made in exactly one place.

**Acceptance:** grep for `payment_status = 'paid'` or `paid_at` writes — should return exactly 1 hit (the service) after this lands.

**Risk:** low. The function signature is narrow and the call sites are easy to find.

---

## Phase 3 — Unify the held-order states

**Problem:** `/orders/kiosk-held` at `orders.js:294-344` already conflates two things behind one endpoint:
- `status='draft_kiosk'` → kiosk parked, never sent
- `status='pending' + payment_status='pending_terminal' + >3min old` → terminal stalled

The `/claim` handler at `orders.js:350-396` then branches on which kind it was to decide cleanup. Two failure modes, one recovery surface, two code paths.

**Target:**
- Add `orders.hold_reason TEXT` (nullable enum: `'kiosk_park'`, `'terminal_stranded'`, future: `'phone_in_pending'`)
- Drop the `draft_kiosk` status — anything held is just `status='active' + hold_reason='kiosk_park'` and excluded from KDS by `hold_reason IS NULL`
- KDS query becomes `WHERE status='active' AND hold_reason IS NULL` — one predicate, never gets out of sync
- `/claim` becomes: clear `hold_reason`, optionally clear payment state, audit

**Acceptance:** `/orders/kiosk-held` returns the same payload, `/claim` has no `if (isHeld)` branch.

**Risk:** medium. `draft_kiosk` is referenced in ~5 files. Do AFTER Phase 0 — it's the natural extension of the status collapse.

---

## Phase 4 — KDS efficiency wins (small, independent)

These are quick fixes. Each one is its own commit, no dependencies on the bigger refactors.

### 4a. Move `first_kds_seen_at` off the polling read
`orders.js:924-929` does an `UPDATE` on every 5s poll for every restaurant. Stamp it once at order creation, or on the first status transition into `active`. Saves a write per poll, removes a write-on-read antipattern.

### 4b. Hide voided items immediately
`orders.js:958` keeps voided items in the KDS result for 90s as a "strike then disappear" UI. Move that to the client: emit a void event (or include a `voided_items_recent` array separately) and let the client manage the strike animation. Backend query gets one less branch.

### 4c. Stop deleting prior kiosk drafts on every hold
`kiosk.js:629-664` (per the audit) wipes prior `draft_kiosk` for the same customer on every hold call. Add an equality check first; skip the DELETE if items + total are identical.

### 4d. Single source of truth for status constants
Today `KitchenDisplay.tsx:248` and `orders.js:872` independently encode the transition table. Export a `STATUSES` + `TRANSITIONS` const from `src/shared/orderStatus.ts`, import from both client and server.

---

## What we are NOT changing

Worth being explicit so we don't scope creep:
- The two-axis model (`status` × `payment_status`). It's the right model — payment and fulfillment really are independent. We're only collapsing redundant values within `status`.
- The polling architecture. SSE/WebSocket is a separate conversation; this plan stays HTTP.
- Anything in the Stripe / Conekta / MP webhook handlers beyond routing them through `markOrderPaid`.
- The kiosk UX. No customer-facing flow changes.
- The mobile POS, KDS rendering, or printed-ticket format.

---

## Suggested execution order

1. **Phase 0** — status collapse + alias layer at API edge (1 PR, ~1 day)
2. **Phase 4a + 4d** — cheap KDS wins (1 PR, ~2 hours)
3. **Phase 2** — `markOrderPaid` service (1 PR, ~half day)
4. **Phase 1** — `orderCreation` service (1 PR, ~1–2 days, this is the big one)
5. **Phase 3** — `hold_reason` unification (1 PR, ~half day)
6. **Phase 4b + 4c** — remaining KDS polish (1 PR, ~2 hours)

Each phase is shippable to production independently. None of them require coordinated client + server releases except Phase 0, which uses the alias layer to decouple them.

---

## Estimated impact

- **~400 LOC deleted** net (creation dedup + transition table + double held-order branching)
- **~3 endpoints simpler** (`/kitchen/active`, `/kiosk-held`, `/claim`)
- **1 write removed** from the hot polling path
- **5 → 1 writers** for `payment_status='paid'`
- **Status state machine** drops from 6 to 3 active states + 2 terminals

The win isn't lines of code — it's that the next person to touch order creation has one file to read instead of three, and the next person to add a payment processor adds one call instead of finding all the places paid state gets written.
