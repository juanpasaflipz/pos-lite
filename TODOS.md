# TODOS

Deferred work with explicit triggers. Nothing here is hidden or silently de-scoped —
every item has a **why** and a condition that makes it real.

Generated from /plan-ceo-review (2026-04-20) + /plan-eng-review (2026-04-21).

---

## Phase 2 triggers (open when Phase 1 exit gate passes)

### 1. Delivery commission reconciliation — real implementation

**What:** Real Uber Eats / Rappi / DidiFood webhook handlers that write
`platform_commission` + `platform_status` to `delivery_orders` on order lifecycle events.
Today: table exists, routes exist, but webhook logic is placeholder/demo
(`server/lib/demoDataGenerator.js:87-89, 1442-1451`).

**Why:** Real commission tracking is a concrete differentiator vs Alegra/Bind.
"I know exactly what Uber took this month" is a feature an accounting ERP cannot do.

**Pros:** Visible operational win for the restaurant; pulls delivery-heavy buyers.
**Cons:** Three separate integrations, each with own auth shape, webhook contract,
and order-state semantics. ~1-2 weeks of work.

**Depends on / blocked by:** Design partner profile (Q1 answer) confirming they use
≥ 1 delivery app. If they're dine-in only, demote further.

**Trigger:** Design partner explicitly says "I need delivery commission tracked."
Or: second restaurant signals same need.

---

### 2. Phase 2 observability (Grafana + 5-metric dashboard)

**What:** Grafana Cloud free tier dashboard with 5 metrics: orders/day per tenant,
CFDI success rate per tenant, Stripe/FacturAPI error rate, RLS query p95, DAU tenants.
Deferred from Phase 1 (Sentry-only).

**Why:** At 3+ tenants, Sentry's per-event view stops being enough — you need
per-tenant rate trends, cross-tenant comparisons, and a single place to watch
the fleet.

**Pros:** Fleet-level visibility; catches "one tenant slowly degrading" before
Sentry's alert rule trips.
**Cons:** Grafana queries are ongoing maintenance; one more system to log into.

**Depends on / blocked by:** Phase 1 exit gate + 3+ paying tenants.

**Trigger:** 3 paying tenants OR any single tenant with > 100 orders/day.

---

### 3. Stripe live-mode activation

**What:** Mexican legal entity (SA de CV or existing), SAT RFC, Mexican bank account
in entity name, director identity docs, beneficial owner disclosures, Stripe
onboarding submission, Stripe platform activation confirmation.

**Why:** Phase 2 needs self-serve billing when the second restaurant onboards.
SPEI/cash works for 1 pilot customer; doesn't scale to 5+.

**Pros:** Unlocks self-serve onboarding at scale.
**Cons:** 3-8 weeks of Mexican bureaucracy. Bank/SAT timelines are outside our control.

**Depends on / blocked by:** External (SA de CV formation ~1-2 weeks, SAT RFC 1-3 weeks,
bank account 2-4 weeks).

**Trigger:** Start May 1, 2026. Target: ready-to-charge by Phase 2 open (July 1, 2026).
Juan owns; weekly status check.

**Sub-tasks (sequence):**
- [ ] Decide entity: create new SA de CV OR use existing entity if Juan has one
- [ ] SAT RFC registration (if new entity)
- [ ] Open Mexican bank account in entity name
- [ ] Collect director identity docs + beneficial owner disclosures
- [ ] Submit Stripe Mexico onboarding
- [ ] Pass Stripe identity verification
- [ ] Flip pos-lite's Stripe keys from test to live in Railway env
- [ ] Migrate design partner from SPEI to Stripe Checkout (optional handoff)

---

## Phase 3+ triggers

### 4. Vault-based secret migration (pgcrypto → Doppler/Infisical)

**What:** Move `tenant_credentials` values entirely out of Postgres into a real
secret manager. `tenant_credentials` table becomes `tenant_secret_refs (tenant_id,
service, key, secret_ref)`; `getCredential()` fetches via vault SDK.

**Why:** CP5 (pgcrypto encryption) is enough at 1-10 tenants. Beyond that, a
compliance review (SOC 2, enterprise contract, SAT audit) will push toward
vault-grade separation.

**Pros:** Industry standard. Auditable access logs. No plaintext-in-DB footprint at all.
**Cons:** $7-20/tenant/month at typical pricing. Second infra system to operate.

**Depends on / blocked by:** CP5 shipping first.

**Trigger:** 10+ paying tenants OR any enterprise customer explicitly asks for
vault-backed secrets.

---

## Carryover from design doc / CEO plan

These were explicitly deferred in the original plan — re-listed here so TODOS.md
is the single truth for deferred work.

- **Contador channel exploration** — 3 contador interviews required before any
  channel work. Phase 2+.
- **DK feature ports** (grok-4-1 AI agent, super-admin, menu boards, MCA financing) —
  each gated on restaurant-asked evidence. Phase 2, default = defer.
- **Pricing tier ladder** — single $20/mo through Phase 1. Ladder at 5+ paying
  customers.
- **CFDI 4.0 compliance audit** — required eventually, not Phase 1 blocker.
- **`pg-schema.sql` → numbered migrations** — convert monolithic schema to one
  migration per domain. Phase 2, retroactively.
- **Rebrand (path C)** — conditional on both earned triggers in Phase 3
  (design partner paid 3+ months AND 10+ paying restaurants).
- **Tenant offboarding / refund logic** — needed before first paying customer
  churns. Phase 2 at latest.
- **Structured logger (pino)** — Phase 2 code quality upgrade. Sentry breadcrumbs
  cover Phase 1.
- **Disaster recovery plan** — Neon has point-in-time recovery; documented backup
  policy is Phase 2 work.
