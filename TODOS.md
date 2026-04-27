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

## Mobile UX redesign (audit 2026-04-22, revised after /plan-eng-review + codex outside voice on 2026-04-27)

Full audit in Claude memory (`mobile_ux_audit.md`). The #1 single finding: `public/menu-images/` contains one file — menu cards collapse to text-only when `image_url` is missing. Fix the content gap before the polish gap.

**Architecture decisions locked (2026-04-27):**
- **Storage:** Cloudflare R2 with custom domain `img.desktop.kitchen` (free egress, S3-compatible, already on Cloudflare DNS). Public-read bucket policy.
- **Tenant scoping:** Object keys prefixed with `<tenant_id>/menu/<uuid>/{thumb,card,hero}.webp`. Tenant ID derived server-side from JWT, never trusted from client.
- **Field naming:** snake_case `image_url` everywhere. Migration includes `CustomerOrderScreen.tsx` (currently `imageUrl`).
- **Upload arch:** Sync Express → multer → Sharp → R2 for Phase 1 (one customer). Migrate to presigned-direct-to-R2 + async at 3+ tenants OR p95 upload latency > 4s.
- **Test framework:** Vitest + React Testing Library only. Playwright deferred until first true E2E need.

---

### 0. Foundations (Tier 0 — must precede #5-#9)

**0a. Vitest + RTL setup**
- Install `vitest`, `@vitest/ui`, `@testing-library/react`, `@testing-library/user-event`, `jsdom`
- `vitest.config.ts` with jsdom + setup file (i18n mock, matchMedia mock)
- Add `"test": "vitest"` to package.json
- Document in CLAUDE.md `## Testing` section

**0b. R2 + Railway env config**
- New env vars in Railway: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_PUBLIC_HOST=img.desktop.kitchen`
- Custom domain configured via Cloudflare dashboard
- `server/lib/r2.js` with PutObject / DeleteObject helpers using `@aws-sdk/client-s3`
- **Open decision:** local dev = MinIO via docker-compose OR a separate dev R2 bucket. Pick before this lands.
- Delete the dangling `app.use('/uploads', express.static(...))` in `server/index.js` once R2 is live.

**0c. Field-name unification (`image_url` everywhere)**
- Replace `imageUrl` with `image_url` in `src/screens/CustomerOrderScreen.tsx` (lines 24, 29, 747, 813)
- Delete the duplicate `MenuItemData` interface in `CustomerOrderScreen.tsx:24` — use shared `MenuItem` from `src/types/index.ts:27`
- **Codex caution:** audit API responses, types, and any saved client assumptions before assuming this is a 3-line fix.

**0d. Schema migration — image metadata**
```sql
ALTER TABLE menu_items
  ADD COLUMN image_blurhash TEXT,
  ADD COLUMN image_width INT,
  ADD COLUMN image_height INT,
  ADD COLUMN image_uploaded_at TIMESTAMPTZ,
  ADD COLUMN image_uploaded_by INT REFERENCES users(id);
```
RLS unchanged (inherited from `menu_items`).

**0e. Feature flag scaffold**
- `FEATURE_MENU_PHOTOS` env flag in `.env.example`
- `src/lib/features.ts` reads flag, gates ImageUpload UI + image rendering
- Broken upload pipeline does NOT break menu browsing.

---

### 5. Menu photography pipeline — hybrid scope (revised 2026-04-27)

**What ships in Phase 1 (one customer):**
- `POST /api/uploads/menu-image` server route (auth required, tenant from JWT)
- Multer: 5MB max input; accept `image/jpeg`, `image/png`, `image/heic`, `image/webp`, `image/avif`
- Sharp pipeline: HEIC → WebP convert, `.rotate()` to honor EXIF orientation, `.withMetadata({})` to strip GPS/EXIF, `pixelLimit` against decompression bombs
- Generate 3 variants: `thumb-200.webp` (mobile grid), `card-800.webp` (customer menu card), `hero-1600.webp` (item detail)
- blurhash via `blurhash` npm package, stored in `menu_items.image_blurhash`
- PutObject to R2 with key `<tenant_id>/menu/<uuid>/{thumb,card,hero}.webp`
- Returns `{ url_thumb, url_card, url_hero, blurhash, width, height }`
- `DELETE /api/uploads/:tenantId/menu/:uuid` route — tenant-scoped delete on photo replace
- `MenuManagement.tsx` integration: simple `<input type="file">` with thumbnail preview, replace, error feedback (NOT a reusable `<ImageUpload>` component yet — defer until tenant #2)
- `MenuItemImage.tsx` extension: accept `category`, `blurhash` props; render `<img srcset>` for 200w/800w/1600w with `sizes`; render category-keyed gradient + icon when no src
- `MobileMenuGrid.tsx` and `CustomerOrderScreen.tsx` switch to `<MenuItemImage>` (delete inline `<img>`)
- alt text policy: food images use item name, decorative fallbacks use `alt=""`

**Tests required (gating before merge):**
- Unauthorized request → 401
- Cross-tenant key forge attempt → 403 (tenant from JWT only)
- Oversized file → 413
- MIME spoof → 400
- HEIC accepted, EXIF stripped (verify on output)
- Sharp memory cap respected; decompression-bomb input rejected
- R2 outage → 503 with retryable error message
- Sharp OOM scenarios bounded

**Why:** No photos = text-only cards that underperform Toast/Square/Slice by an order of magnitude. Lifts conversion 25-40% in food ordering. Hybrid scope keeps the durable infra (server route + R2 wiring + security model) while deferring polish (reusable upload component) until tenant #2.

**Photography (ops dependency, NOT engineering):**
- Owner: Juan
- Deadline: before design partner goes live
- Content policy: real photos only, OR clearly-labeled stock placeholders. NO AI-generated images of real menu items (codex flagged trust/misrepresentation risk).

**Trigger to migrate to async/presigned:** 3+ paying tenants OR p95 upload latency > 4s.

---

### 6. Mobile quick wins — 1-2 day batch

**What:**
- Remove `"orientation": "landscape"` from `public/manifest.json`
- Add `screenshots`, `shortcuts`, maskable icon variant to manifest
- Bump qty/delete touch targets in `MobileCartScreen.tsx:166-186` from `w-8 h-8` (32px) → 40px
- Add skeleton loaders replacing "Loading menu…" text across mobile screens
- New `<StatusPill status={...} dot={true}>` component in `src/components/ui/StatusPill.tsx` — single source of truth for status colors, includes Tier 8's colorblind-safe dot variant
- Replace inline pill markup in `KitchenDisplay.tsx`, `CustomerOrderScreen.tsx` (tracker), and `PurchaseOrderScreen.tsx` with `<StatusPill>`
- alt text policy: food images use item name; decorative fallbacks use `alt=""` (codex's nuance — empty alt is correct for decorative, wrong for content)
- **Define minimal design tokens NOW** (do not wait for Tier 9): typography scale, radius, shadow, motion duration in `tailwind.config.js`. Codex flagged that deferring tokens to Tier 9 means duplicate styling decisions get baked in during Tier 7.
- `prefers-reduced-motion` honored on cart-add bounce + status pill transitions

**Why:** All small, all independent, all visible. Best hourly ROI in the entire redesign.

**Trigger:** Any free day after Tier 0 lands.

---

### 7a. Customer QR flow — UI work

**What:**
- Restaurant hero header (cover image + logo chip + simple `is_open` boolean badge for Phase 1)
- Photo-forward menu card (16:9 hero + overlay)
- Category image pills
- Item detail sheet with hero photo
- Animated order tracker (Lottie shell with reduced-motion fallback + haptic on "Ready" via existing `src/lib/haptics.ts`)
- Mexico-specific: all copy through `t()`, peso formatting, perf budget — Lighthouse mobile perf ≥85 on mid-tier Android
- Framer Motion install **deferred** until UI actually needs animation beyond CSS transitions

**Why:** Customer-facing surface drives conversion. Currently static and forgettable.

**Pros:** Real brand differentiation. Conversion win.
**Cons:** 2-3 weeks of focused work. Requires Tier 5 (photography) in place first.

**Trigger:** After Tier 5 ships AND content (real photos) exists.

---

### 7b. Customer QR flow — data-dependent (deferred per codex 2026-04-27)

**What — each item gated on real data existing:**
- Real ETA logic — needs `prep_time_minutes` per menu item + kitchen-load model
- Restaurant business hours — needs `tenant_hours` schema (day-of-week, holiday overrides, open/close times)
- Social proof ("popular this week", review count) — needs ≥50 orders/month per item to be honest
- Pairings / "goes well with" — needs `menu_item_pairings` table + merchandising workflow

**Why deferred:** Codex flagged that shipping these for one design partner means fake/seeded data — undermines trust. Defer until real data exists.

**Trigger per item:**
- ETA: when first kitchen complains the static estimate is wrong
- Business hours: before second tenant onboards (Phase 2)
- Social proof: 3+ tenants AND ≥50 orders/month per top items
- Pairings: explicit design-partner ask, not before

---

### 8. Tier B — Merchant POS polish

**What:**
- Photos in `MobileMenuGrid` (now via `<MenuItemImage>` after Tier 5)
- Cart-add micro-interactions (motion via Framer Motion if installed in 7a, else CSS transition; haptics via `src/lib/haptics.ts`)
- Micro-bounce on cart count (with `prefers-reduced-motion` fallback)

Note: status pills (Tier 6) and dot+label colorblind variant already merged into Tier 6's StatusPill component.

**Why:** Staff recognize items by photo 2-3× faster than text — meaningful during rush.

**Trigger:** After Tier 7a ships or in parallel when 7a is blocked on content.

---

### 9. Tier C — Design system foundations (revised sequencing)

**What (sequenced per codex 2026-04-27):**
- ✅ Minimal design tokens (typography, radius, shadow, motion duration) — moved to Tier 6 to prevent duplicate styling decisions during Tier 7a
- Framer Motion install — only when proven need exists in 7a/8
- Illustration set (unDraw/Humaans) for empty/error/success states
- `<MenuItemCard variant={...} context={...} />` — unify `MobileMenuGrid` + `CustomerOrderScreen` after field-name unification (0c) ships
- `<ImageUpload>` reusable component (replaces simple file input from Tier 5) — when tenant #2 onboards

**Trigger:** Run `/design-consultation` to produce DESIGN.md first, then implement when Tier 7a + 8 are shipped and design has settled. Tier 9 is the polish layer, not the foundation.

---

### Cross-cutting requirements (added during review 2026-04-27)

**Success criteria — define before Tier 5 ships:**
- Image upload success rate ≥98% (server route logs)
- First-photo-paint < 1.5s on 4G mid-tier Android (Lighthouse mobile)
- QR-flow conversion baseline established before Tier 7a
- Add-to-cart rate lift target after Tier 7a: +15%

**Migration plan for existing items without photos:**
- Render gradient+icon fallback (no admin alarm)
- Admin workflow state in MenuManagement: badge missing/pending/failed/replaced
- Optional bulk-upload tool gated until Tier 5 stable

**Critical security gaps (gating Tier 5 merge):**
- R2 outage handling — server returns 503 with retry hint, not generic 500
- Sharp OOM bounds — `pixelLimit`, request timeout, max input size
- Cross-tenant key forge — tenant_id derived from JWT only, never client body

**Mexico-specific:**
- All user-facing copy through `t()` (Spanish + English)
- Peso formatting (existing helpers in repo — verify reuse)
- Perf budget on low-end Android (target Moto G Play class)
- WhatsApp share intent for receipts/order tracker (Phase 2 item, not Tier 7a blocker)

**Worktree parallelization:**
- Lane A (parallel): 0a Vitest, 0b R2 config, 0c field-name unify, 0d schema migration, 0e feature flag
- Lane B (sequential after A): Tier 5 server route → MenuManagement integration → MenuItemImage extension → MobileMenuGrid + CustomerOrderScreen swap
- Lane C (parallel with B): Tier 6 quick wins + StatusPill + minimal token expansion
- Conflict flag: Lane B and Lane C both touch `CustomerOrderScreen.tsx` — coordinate merge order.

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
