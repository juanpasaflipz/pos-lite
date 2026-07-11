# AI Sentinel & Operator Copilot — Design

**Status:** Accepted · open questions resolved 2026-07-11 (see §12)
**Owner:** Juan
**Scope:** A real-time layer that (1) detects and remediates operational incidents autonomously, and (2) helps stuck operators in the moment. Builds on `server/agent/` and the existing sweep infrastructure — this is an extension of the platform, not a new one.

---

## 1. Product framing

The idea "an AI that watches the system in real time" is really three products. Naming them separately keeps scope honest:

| # | Product | User | Trigger | Ships in |
|---|---------|------|---------|----------|
| 1 | **Sentinel** — system health watchdog with AI triage and remediation | Juan (platform), then tenant owners | Deterministic sensors fire | Phase 1–2 |
| 2 | **Operator Copilot** — contextual help when staff get stuck | Cashiers, kitchen, managers | Client-side stuck heuristics or a help button | Phase 3 |
| 3 | **Proactive Insights** — the existing chat agent inverted to push | Tenant owners | Schedule (daily digest) + threshold events | Phase 4 |

The load-bearing design decision, repeated throughout this doc:

> **The LLM never watches. Deterministic sensors watch; the LLM wakes up when one fires.**
> Detection is SQL (cheap, exact, testable). Diagnosis, explanation, and remediation choice are AI (contextual, flexible). This keeps per-tenant marginal cost near zero and makes every sensor unit-testable against the Neon test branch like everything else in `tests/`.

### Why we're unusually well-positioned

Three things already exist in the codebase that most POS vendors would have to build first:

1. **The agent loop with approval gating** — `server/agent/route.js` already implements read-tools-execute-immediately / action-tools-queue-for-approval, `pending_actions`, and the plan gate (`getPlanLimits(plan).ai.mode`). Sentinel remediation reuses this pattern wholesale.
2. **The sweep harness** — `server/lib/autoCompleteReadyOrders.js` (and the reward/winback/review sweeps) establish the pattern: 60s `setInterval`, cross-tenant `adminSql`, `start*/stop*` wired into boot and graceful shutdown in `server/index.js`. Sensors are just more sweeps.
3. **An incident catalog written in code** — `scripts/mp-unstick.mjs`, `scripts/reconcile-unpaid-card.mjs`, `scripts/verify-kds-seen.mjs`, `scripts/mp-debug*.mjs` are the manual runbooks for every production incident so far. Each one becomes a sensor + playbook pair. Phase 1 is done when those scripts never need to be run by hand again.

---

## 2. Architecture overview

```
                     ┌─────────────────────────────────────────────┐
                     │  server/sentinel/                           │
                     │                                             │
  every 60s          │  sweep.js ──► sensors.js (pure SQL,         │
  (adminSql,         │               cross-tenant, per-sensor      │
  in-process like    │               cadence)                      │
  existing sweeps)   │      │                                      │
                     │      ▼  row matched                         │
                     │  sentinel_incidents (upsert, dedup_key)     │
                     │      │                                      │
                     │      ▼  status='open' → enqueue             │
                     │  triage.js ──► Claude + diagnostic READ     │
                     │               tools (scoped to incident)    │
                     │      │                                      │
                     │      ├─► known signature + auto-safe        │
                     │      │      playbooks.js runs it,           │
                     │      │      status='auto_fixed'             │
                     │      ├─► known signature + money-adjacent   │
                     │      │      status='waiting_approval'       │
                     │      │      → owner approves (existing      │
                     │      │        pending_actions UX)           │
                     │      └─► unknown → status='needs_human',    │
                     │             diagnosis attached, notify      │
                     │                                             │
                     │  notify.js ──► in-app alerts + WhatsApp     │
                     │               (Twilio, per-severity)        │
                     └─────────────────────────────────────────────┘
```

Everything runs in-process on the single Railway service, exactly like the four existing sweeps. At current scale that is correct; if sweep volume ever matters, `server/sentinel/` is already a seam to extract into a worker.

### 2.1 New module layout

```
server/sentinel/
  sensors.js      # sensor catalog: id, severity, cadence, SQL, dedup key fn
  sweep.js        # runs due sensors, upserts incidents, kicks triage
  triage.js       # LLM diagnosis loop (reuses callClaude pattern from agent/route.js)
  playbooks.js    # remediation functions — thin wrappers over EXISTING code paths
  notify.js       # in-app + WhatsApp notification fanout
  route.js        # /api/sentinel — list incidents, approve, dismiss (owner JWT)
server/db/migrations/
  0079_sentinel_incidents.js   # (design originally said 0072; repo was already at 0078)
```

### 2.2 Incident model

New migration `0079_sentinel_incidents.js` (RLS'd like every tenant table; the sweep writes via `adminSql`, tenant reads go through the normal RLS path):

```sql
CREATE TABLE sentinel_incidents (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
  sensor TEXT NOT NULL,                 -- e.g. 'stuck_terminal_payment'
  dedup_key TEXT NOT NULL,              -- e.g. 'order:6261'
  severity TEXT NOT NULL DEFAULT 'medium',   -- low | medium | high | critical
  status TEXT NOT NULL DEFAULT 'open',
    -- open → diagnosing → auto_fixed | waiting_approval | needs_human
    --      → resolved | dismissed
  subject_table TEXT,                   -- 'orders', 'delivery_orders', 'kds_devices', ...
  subject_id TEXT,
  evidence JSONB,                       -- rows/values captured by the sensor at fire time
  diagnosis JSONB,                      -- LLM output: {classification, confidence, explanation, proposed_playbook, proposed_input}
  actions JSONB DEFAULT '[]'::jsonb,    -- executed playbook steps + results (audit trail)
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  UNIQUE(tenant_id, sensor, dedup_key)
);
```

Dedup semantics: a sensor re-matching an existing open incident bumps `last_seen_at` only — no re-triage, no re-notification. A *resolved* incident whose condition reappears opens a **new** incident (append a generation suffix to `dedup_key` or clear on resolve). This is what stops the sweep from spamming the LLM and the owner every 60 seconds while a card terminal is being rebooted.

Every playbook execution also writes to the existing `audit_log` table (`actor_type='sentinel'`), consistent with how it's used today.

---

## 3. Sensor catalog

All sensors are single SQL statements over existing tables/columns, run cross-tenant via `adminSql` with results grouped per tenant. Severity drives notification, not detection. Thresholds are env-tunable with per-tenant overrides later (same philosophy as `AUTO_COMPLETE_READY_MINUTES`).

Columns marked ⁽ᵐ⁾ were added by migrations after the base `pg-schema.sql` (`first_kds_seen_at`, `mp_terminal_id`, `clip_payment_id`, `delivery_orders.pending_dispatch`) — sensor SQL must match the live schema, not the base file.

### Phase 1 sensors — each one retires a manual script

**S1 · `stuck_terminal_payment`** — replaces `mp-unstick.mjs` (detection half)
Order stuck waiting on a card terminal.
```sql
SELECT tenant_id, id, order_number, mp_order_id, clip_payment_id, total, created_at
FROM orders
WHERE payment_status = 'pending_terminal'
  AND (mp_order_id IS NOT NULL OR clip_payment_id IS NOT NULL)
  AND created_at < NOW() - INTERVAL '10 minutes'
```
Processor-agnostic by design (decision #5): the condition is `pending_terminal` + a processor ref + age; triage routes by which ref is present. Severity: high. Playbook: P1 (auto-safe) or P2 (approval) — triage decides which by live-pulling the processor (see §4).

**S2 · `stale_kiosk_draft`**
Kiosk draft (`status='draft_kiosk'`) that never promoted. Cash-held drafts legitimately wait for the customer to walk to the cashier, so the threshold is generous; card drafts where a payment attempt exists are suspect much sooner.
```sql
SELECT tenant_id, id, order_number, total, payment_method, created_at
FROM orders
WHERE status = 'draft_kiosk'
  AND created_at < NOW() - INTERVAL '45 minutes'
```
Severity: low (cash, likely abandoned) / high (evidence of a card payment attempt — customer may have paid for food the kitchen never made). Playbooks: P4 (notify-only) for cash / P2 for card. **The sentinel never voids a draft** (decision #2): a stale cash draft could be a customer paying slowly at the counter, and the cost of a wrong void (kitchen never makes paid-for food, trust destroyed) dwarfs the cost of clutter. Cash drafts surface in the daily digest; the human-initiated `POST /api/orders/purge-unpaid` path remains the only way drafts die.

**S3 · `kds_blind`** — generalizes `verify-kds-seen.mjs` from a manual check into a monitor
Active orders no kitchen screen has ever rendered. `first_kds_seen_at`⁽ᵐ⁾ is stamped on the first `/api/orders/kitchen/active` poll, so its absence on aging active orders means the KDS is down, offline, or logged out — food is not being made.
```sql
SELECT tenant_id, COUNT(*) AS unseen, MIN(created_at) AS oldest
FROM orders
WHERE status = 'active'
  AND first_kds_seen_at IS NULL
  AND created_at < NOW() - INTERVAL '3 minutes'
GROUP BY tenant_id
```
Corroborating signal: `kds_devices.last_seen_at` (already maintained) — if no device has polled recently, the diagnosis is "screen down," not "orders invisible." Severity: **critical** — this is the worst silent failure a restaurant can have. Playbook: P4 (notify loudly; there is no safe auto-fix for an unplugged TV).

**S4 · `stuck_courier_dispatch`**
Paid kiosk delivery order whose Uber Direct dispatch never fired: `delivery_orders.pending_dispatch`⁽ᵐ⁾ still non-NULL after the parent order is paid (`dispatchPendingCourier()` clears it on success — see `server/routes/kiosk.js`).
Severity: high (customer paid, no courier moving). Playbook: P5 (auto-safe retry — `dispatchPendingCourier` is already idempotent-shaped; it re-reads `pending_dispatch` and clears on success).

### Phase 2 sensors — operational intelligence

**S5 · `sales_flatline`** — zero paid orders during a window in which this tenant historically always has them (baseline: same weekday/hour over trailing 4 weeks; respects `tenants.timezone`). Catches: crashed terminal app, network outage, staff not opening. Severity: critical. Playbook: P4, with diagnosis distinguishing "device down" (see `kds_devices.last_seen_at`, recent auth activity) from "genuinely slow day."

**S6 · `drawer_variance_spike`** — `cash_drawer_sessions.variance_total` beyond an absolute floor and a tenant-relative multiple on close. Severity: medium. Notify owner with context (who, which shift, trend); no auto-action ever — this is a people matter.

**S7 · `zombie_shift`** — `shifts.clock_out_at IS NULL` beyond 12h (the schema comment says the UI flags these; the sentinel makes sure someone actually sees it, because payroll math silently inflates otherwise). Severity: low. Playbook: P6 (approval-gated auto-close at last order activity + note).

**S8 · `sellable_out_of_stock`** — menu items still `active=true` whose recipe (`menu_item_ingredients`) hits an `inventory_items` row at/below `low_stock_threshold` (or zero). The 86 recommendation that today waits for the owner to open the chat agent. Severity: medium. Playbook: P7 — proposes the existing `toggle_menu_item` action tool through the standard approval flow.

**S9 · `webhook_silence`** — a processor that has historically delivered webhooks for this tenant goes quiet while terminal payments continue (evidence: `order_payments.processor_response` arrival pattern). Not correctness-critical by design — live-pull is the source of truth per the payments conventions — but silence usually means a merchant's webhook registration broke, and polling load rises. Severity: low, notify only.

**S10 · `refund_burst`** — refund count/value for a rolling hour beyond tenant baseline (`refunds`). Fraud/abuse tripwire. Severity: high, notify only.

Unacknowledged `shrinkage_alerts` already exist as a table — the sentinel surfaces stale ones in the daily digest (Phase 4) rather than duplicating that system.

---

## 4. Triage: what the LLM actually does

When the sweep opens an incident, `triage.js` runs one bounded agent loop (reusing the `callClaude` + tool-loop pattern from `agent/route.js`, `MAX_ITERATIONS` ~5):

**Input:** the incident row (sensor, evidence, severity) + a context bundle assembled in SQL — related order rows, payment splits, recent `order_payments`, `kds_devices` liveness, whatever the sensor declares relevant.

**Diagnostic READ tools** (new, in `playbooks.js`, all side-effect-free):
- `pull_mp_payment_status(order_id)` — live-pulls Mercado Pago exactly like the `/orders/:id/status` fallback in `server/routes/payments.js` does
- `get_order_timeline(order_id)` — order + items + payments + audit_log rows, one bundle
- `get_device_liveness()` — `kds_devices.last_seen_at` summary for the tenant
- `get_tenant_baseline(metric, window)` — the comparison stats sensors use

**Output (structured, stored in `diagnosis`):** classification, confidence, plain-language explanation (Spanish for owner-facing text, matching the tenant's locale), proposed playbook + input, and — critically — `proposed_playbook: null` when it doesn't match a known signature. An unknown gets `status='needs_human'` and a notification. **The agent cannot invent remediations.** It chooses from the playbook registry or declines.

The S1 case shows why triage is genuinely AI-shaped rather than another `if`: a stuck `pending_terminal` order forks on what MP says. Intent cancelled/expired → unstick (P1, auto-safe). Intent **paid** but we missed it → reconcile (P2, money-adjacent, approval). Device unreachable → different message to the owner entirely. Today that fork is Juan reading `mp-debug-prod.mjs` output; the triage agent runs the same fork with the same evidence, and writes down its reasoning.

### Model + budget

- Triage runs on the same model the chat agent uses (`claude-sonnet-4-6` today, one constant to change). If cost ever matters, a cheaper/faster tier can classify and escalate to Sonnet only on low confidence — premature now.
- **Hard budget:** per-tenant daily cap on triage runs (env, default ~20/day) + global circuit breaker. Runs beyond cap create incidents with `status='needs_human'` and no LLM call. The failure mode "sensor bug opens 500 incidents → 500 API calls" must be impossible by construction.
- Kill switches: `SENTINEL_ENABLED` env (global), per-tenant flag later. Sweep-only mode (`SENTINEL_TRIAGE=off`) still records incidents — detection keeps working even with AI off.

---

## 5. Playbooks

A playbook is a named, versioned remediation function. Two classes:

**Auto-safe** — executed without approval when triage confidence is high. Qualifying bar: idempotent, no money movement, no irreversible state, mirrors an already-battle-tested code path.

**Approval-gated** — anything money-adjacent. Surfaces through the same approve/reject UX as agent `pending_actions`, via `/api/sentinel` + notification.

| ID | Playbook | Class | Implementation |
|----|----------|-------|----------------|
| P1 | `unstick_terminal_payment` — cancel MP payment intent on device, reset order to `payment_status='pending'`, clear `mp_order_id` | auto-safe | port of `mp-unstick.mjs` (generalized: terminal IDs from tenant/order rows, not hardcoded) |
| P2 | `reconcile_orphan_payment` — mark paid, insert `order_payments` audit row (`processor_response: {reconciled: true, source: 'sentinel'}`), deduct inventory | **approval** | port of `reconcile-unpaid-card.mjs` `--apply` path; same semantics as `markTerminalOrderPaid()` |
| P3 | ~~`expire_stale_draft`~~ — **cut** per decision #2: the sentinel never voids drafts. Stale cash drafts route to P4 (digest); manual `purge-unpaid` remains the only kill path. ID retired, not reused | — | — |
| P4 | `notify_only` — no mutation; the remediation *is* a well-written message | auto | `notify.js` |
| P5 | `retry_courier_dispatch` — re-run `dispatchPendingCourier(orderId, tenantId)` | auto-safe | direct call, already guarded |
| P6 | `close_zombie_shift` — clock out at last activity + note | **approval** | UPDATE + note, mirrors manual shift edit |
| P7 | `propose_86` — disable menu item out of stock | **approval** | existing `toggle_menu_item` handler in `server/agent/handlers.js` |

Rules that hold for every playbook: they are the **only** write surface the triage agent can reach (no raw SQL tool, ever); each validates its own preconditions at execution time (the world may have changed since diagnosis — e.g. P2 re-checks `payment_status != 'paid'` exactly like the script's guard); each writes `audit_log` and appends to `incident.actions`.

---

## 6. Notifications

Severity-routed, per-tenant:

- **In-app:** incident badge/panel in the owner dashboard (`GET /api/sentinel/incidents`), where approval buttons live. Phase 1. Per decision #1, the agent chat *also* surfaces incidents ("encontré y arreglé 2 problemas anoche") — panel first, chat framing layered on in Phase 2 once the incident feed is trustworthy.
- **WhatsApp:** the Twilio integration already exists (`server/routes/twilio-inbound.js`, WhatsApp voice ops). High/critical incidents send a template message with the diagnosis in Spanish and, for approval-gated fixes, a deep link into the dashboard. Phase 2. Approval stays in-app where auth is real — never "reply YES to execute" for money-adjacent actions.
- **Platform channel (Juan):** critical incidents across all tenants to an ops channel. In practice this is the first user of the whole system.

Anti-noise: dedup (§2.2), severity floor per channel, per-tenant daily digest batching for `low`.

---

## 7. Operator Copilot (Phase 3)

Different user, different moment: the cashier at 8pm with a line, not the owner reading analytics. Design constraints from that reality: Spanish-first (all copy through the existing `react-i18next` pipeline), answers in seconds, ≥40px touch targets, and it must know the *live state* of the thing the operator is fighting — generic help articles are exactly what we're not building.

**Surfaces:** mobile POS and desktop POS (staff-facing). **Not the kiosk** — the kiosk stays 100% customer-facing per the repo conventions; its equivalent is at most a "llamar al personal" escalation, no AI chat.

### Stuck detection (client-side, rule-based, zero LLM)

A small detector in the POS client scores signals and, past a threshold, shows a dismissible "¿Necesitas ayuda?" chip — it never auto-opens, never interrupts a transaction:

- same error toast ≥2 in 60s
- ≥4 taps on the same non-responding/disabled control in 10s
- payment screen dwell >90s while order sits `pending_terminal`
- offline queue (Dexie) depth >5 and not draining post-reconnect
- repeated open/abandon of the same flow (refund, split payment, drawer close) within 2 min

Signal events are logged (batched, offline-tolerant) whether or not the operator taps — that corpus later tells us which screens confuse people, which is UX gold independent of the AI.

### Assist endpoint

`POST /api/agent/assist` beside the existing chat route — same loop, different scoping:

- **Auth:** employee Bearer JWT (PIN-login path). Tool access derives from the employee's role/permissions — a cashier's copilot cannot read revenue analytics or propose price changes.
- **Context in:** screen id, order id (if any), last error, role, locale.
- **READ tools:** `get_order_state`, `get_payment_status` (reuses the live-pull), `get_printer_status`, `get_kds_liveness`, `search_howto`.
- **`search_howto`:** a curated ES/EN markdown corpus in-repo (`docs/howto/*.md`), keyed by screen/flow — versioned with the code so help never drifts from the UI. No vector DB until the corpus outgrows grep.
- **Actions:** none at launch. The copilot explains and points; mutations stay with the human. (Later: propose-with-manager-PIN for bounded things like reprint ticket.)
- **Escalation:** "no pude resolverlo" → creates a `sentinel_incident` (sensor `operator_escalation`) → owner notification, **severity-dependent** (decision #4): triage classifies the underlying issue, and high/critical (payment stuck, KDS blind) pings the owner live over WhatsApp while low/medium (how-do-I questions, UI confusion) batches into the daily digest. Copilot and sentinel share one spine.

The killer interaction, concretely: cashier stares at a card payment that won't finish → chip appears → tap → copilot live-pulls MP and answers *"La terminal sigue esperando el tap de la tarjeta — no está trabada. Si el cliente ya se fue, cancela con la X y el pedido vuelve a 'pendiente'."* That answer is only possible because the tools see the same state the sentinel watches.

### Plan gating

Copilot is a Pro-plan feature like the chat agent (`getPlanLimits().ai`), with a per-tenant daily assist budget. Stuck-detection telemetry runs for all plans (it costs nothing and feeds UX).

---

## 8. Proactive Insights (Phase 4, small)

The existing chat agent's read tools (`get_sales_summary`, `get_inventory_status`, …), invoked on a schedule instead of on demand: a daily digest per tenant (owner-configurable hour, `tenants.timezone`) composed from one agent run — yesterday vs baseline, stockout forecasts, stale `shrinkage_alerts`, open sentinel incidents. Delivered in-app + WhatsApp. Mostly wiring, no new capabilities — noted here so Phases 1–3 don't accidentally build against it.

---

## 9. Cost model

Per tenant/month, order of magnitude: sensors are SQL — zero LLM. Real incidents at healthy scale are a handful a week; triage is ~3–5 calls × small context ≈ well under $1/tenant/month. Copilot assists dominate at maybe 2–10/day worst case ≈ single-digit dollars for a heavy tenant — still gated by plan and budget caps. The architecture — not the pricing — is what guarantees this: no polling LLM, hard caps, dedup. An "AI watching everything" design done the naive way would be 40,000+ calls/tenant/month; this is ~50.

---

## 10. Testing

Follows the house rules (`vitest`, real Postgres on the test branch, single-fork, `beforeAll → dropTestTenant → closePools`):

- `tests/sentinel.test.ts` — seed a stuck order (`payment_status='pending_terminal'`, backdated `created_at`) in an ephemeral tenant → run sensor sweep once → incident exists with right sensor/severity/evidence. Run again → **same** incident (dedup), `last_seen_at` bumped. RLS: tenant B cannot read tenant A's incidents (mirrors `tests/rls.test.ts` patterns).
- Playbook guard tests — P2 refuses an already-paid order; P1 refuses when `mp_order_id IS NULL`; P5 no-ops when `pending_dispatch` already cleared. Guards are what make "auto-safe" true, so they get the densest coverage.
- Triage is tested with a stubbed model client (fixture diagnoses) — the loop, budget cap, and unknown→`needs_human` path are deterministic code; model quality is evaluated separately with recorded incident fixtures.
- Budget/circuit-breaker test — 100 incidents, cap of N → exactly N triage invocations.

CI as usual; no new secrets beyond what exists (triage stub means no Anthropic key in CI).

---

## 11. Rollout

**Phase 1 — Sentinel MVP (removes Juan from the pager path)**
Migration 0079 · sensors S1–S4 · triage · playbooks P1/P4/P5 (auto-safe only; P2 detection surfaces as `needs_human` with a prewritten plan first — watch it, then enable the approval flow) · in-app incident panel · platform notification. *Done when: the next stuck MP payment is diagnosed and unstuck with zero manual script runs.*

**Phase 2 — Owner-facing sentinel**
P2 approval flow · WhatsApp notifications · sensors S5–S10 · per-tenant thresholds · incident surfacing in agent chat (decision #1) · **free-plan teaser** (decision #3): detection runs for every tenant on every plan; free tenants see that incidents exist ("Sentinel encontró 3 problemas esta semana") with diagnosis and one-tap fixes locked behind Pro. Detection costs nothing to run, so the teaser is pure upsell surface. *Done when: a pilot tenant owner (juanbertos) approves a reconciliation from their phone.*

**Phase 3 — Operator Copilot**
Stuck-detection telemetry (ship early — it's free and informs everything) · `howto` corpus for the top 5 confusing flows (payments first) · `/api/agent/assist` + chip UI. *Done when: assisted-resolution rate >50% on payment-screen escalations for the pilot tenant.*

**Phase 4 — Proactive digest.**

Metrics that tell us it's working: manual script runs (→ 0) · median time-to-resolution for stuck payments (hours → minutes) · % incidents auto-fixed · sensor false-positive rate (each sensor with FP >20% gets retuned or demoted to digest-only) · copilot resolution-without-owner rate.

---

## 12. Decisions (resolved 2026-07-11)

1. **Incident surfacing: both, panel first.** Dashboard panel ships in Phase 1 (scannable, where approvals live); agent-chat framing ("encontré y arreglé 2 problemas anoche") layers on in Phase 2 once the feed has proven trustworthy. Wired into §6 and §11.
2. **The sentinel never voids drafts.** Gut call, and the asymmetry backs it: a wrong void burns a paying customer; a stale draft costs nothing but clutter. P3 is cut (ID retired). Stale cash drafts go to the daily digest; card-attempt drafts still triage to P2/needs_human; `purge-unpaid` stays the only — human-initiated — kill path. Wired into §3 (S2) and §5.
3. **Free-plan sentinel teaser: yes.** Detection (SQL sweeps) runs for all tenants on all plans; free tenants see incident existence, Pro unlocks diagnosis and one-tap fixes. Likely the strongest Pro-upsell surface in the product. Wired into §11 Phase 2.
4. **`operator_escalation` notifications are severity-dependent.** Triage classifies the underlying issue: high/critical → live WhatsApp ping; low/medium → daily digest. Wired into §7.
5. **Processor parity: sensor generalizes now, playbooks per-processor as traffic warrants.** S1 matches any `pending_terminal` order with a processor ref (`mp_order_id`, `clip_payment_id`, …) — detection covers every processor from day one. Live-pull + cancel playbook implementations land MP-first (where the scar tissue is), Clip next (its live status pull already exists in `payments.js`), Conekta/Getnet when they carry real terminal traffic. Until a processor has its playbook, its incidents surface as `needs_human` with the diagnosis attached — degraded gracefully, never silently ignored.
