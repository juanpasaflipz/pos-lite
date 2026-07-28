# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Stack
- React + Vite + Tailwind frontend (`src/`)
- Separate Vite app for the customer kiosk (`kiosk/`, `vite.kiosk.config.ts`)
- Express backend (`server/`)
- Neon Postgres, multi-tenant with RLS
- Hosted on Railway (service name `pos-lite`)

## Commands
- `npm run dev` — runs server (`:3001`) + client (`:5173`) concurrently (POS web)
- `npm run dev:server` / `npm run dev:client` — run either half alone
- `npm run dev:kiosk` — kiosk Vite dev server (separate app)
- `npm run build` — builds both POS and kiosk; what Railway runs
- `npm run build:client` / `npm run build:kiosk` — build either bundle alone
- `npm run start` — production server (`NODE_ENV=production node server/index.js`)
- `npm run typecheck` — `tsc --noEmit -p .`
- `npm test` — Vitest suite (see Testing section)
- `npm run test:watch` — Vitest in watch mode for iterative work
- `npm run smoketest:orders` / `smoketest:kds` — load/smoke scripts under `scripts/`

## Testing
- Framework: **Vitest**. Config: `vitest.config.ts` (single-fork pool — DB tests share the postgres pool and rely on RLS transaction semantics; parallel workers cause contention).
- DB: real Postgres against a dedicated **Neon test branch** (`br-hidden-hill-ajgpffqg`). **No mocks for the DB** — the whole safety net exists because the RLS boundary is load-bearing, and mocks can't catch that.
- Env: `.env.test` (gitignored). `tests/setup/env.ts` asserts `DATABASE_URL` contains the test-branch endpoint fragment (`ep-small-credit-ajz9ppry`) before any test runs — refuses to run against anything else.
- Fixtures: `tests/helpers/db.ts` exposes `createTestTenant()` / `dropTestTenant()` / `asTenant()`. Each test creates one-or-more ephemeral tenants in `beforeAll`, cleans up in `afterAll`. Cleanup is a single-round-trip PLPGSQL loop (~50× faster than prod's `purgeTenant`).
- CI: `.github/workflows/ci.yml` runs typecheck + full suite on every PR to `master` and every push to `master`. Concurrency group serializes runs against the shared test branch. Secrets: `TEST_DATABASE_URL`, `TEST_PG_APP_USER`, `TEST_PG_APP_PASSWORD`.
- New tests go in `tests/<domain>.test.ts`. Keep the `beforeAll → dropTestTenant → closePools` shape from existing files; deviations break the single-fork determinism.

## Versioning & app updates
- **Version scheme:** `package.json` `version` is the release semver (`MAJOR.MINOR.PATCH`). The comparison unit is `buildId` = `<semver>+<7-char commit>`, produced by `scripts/app-version.mjs` and written to `version.json` (gitignored) by `npm run build`. Both Vite builds `define` it into the bundles and the server reads the same file, so client and server always agree
- **Bump policy:** PATCH for fixes/polish, MINOR for a user-visible feature, MAJOR for a breaking API/data change. Bumping is only needed for the human-readable label and the force-update gate — a plain deploy already changes `buildId` via the commit, so update detection works without touching `package.json`
- **How a tenant gets a new version:** a plain `location.reload()`. `index.html` is served network-first by the SW and revalidated by the server, so one reload pulls new HTML → new content-hashed assets. No hard reload, no cache clearing
- **How they're told:** every `/api/*` response carries `X-App-Version`; clients compare it to their own build stamp (no polling hot path), backed by a 5-min `/api/version` poll. POS/admin shows a banner (`src/components/UpdateBanner.tsx`) and auto-reloads once idle; KDS reloads on an empty queue; kiosk reloads silently on the attract screen with an empty cart
- **Never reload mid-work.** Screens declare busy state with `useUpdateBlocker(...)` (`src/hooks/useUpdateBlocker.ts`) — open cart, payment modal, tickets on the rail. Add one to any new surface that would lose state on reload
- **Force a reload** by setting `MIN_CLIENT_VERSION` (semver) on Railway. Only for genuine API contract breaks — it interrupts whatever the user is doing after a 5-min grace
- **The SW must not `skipWaiting()` unprompted.** A new worker seizing a running tab makes the old page request chunk hashes that no longer exist in `dist/` → dead screen mid-shift. `public/sw.js` waits for a `SKIP_WAITING` message, which the client only sends on an accepted update. Its cache key is scoped per build via the `?v=<buildId>` registration query
- **Android APK is frozen** — a reload can't change its bundle. Kiosks POST `/api/kiosk/heartbeat` with their build; stale tablets show as "Outdated" on `/admin/devices` and need `npm run android:install`

## Deploy
GitHub → Railway auto-deploy is wired up (`juanpasaflipz/pos-lite`, branch `master`). `git push origin master` triggers a deploy automatically. Verify with `railway deployment list | head -3` and look for `SUCCESS` on the new deployment id.

Do **not** run `railway up --detach` after a push — it creates a competing deployment. Only use `railway up` for unpushed local builds (rare). If link is lost:
```
railway link --project pos-lite --environment production --service pos-lite
```

## Kiosk surface
The kiosk is its own app with three delivery targets:
- **Web** — served from the same backend at `<tenant>.desktop.kitchen/kiosk` after `npm run build` ships both bundles
- **iPad** — thin SwiftUI WebView shell wrapping the live web URL. Web changes propagate automatically; no Xcode rebuild needed
- **Android (Capacitor 7 APK)** — bundles the web assets at build time, so it's *frozen* between rebuilds:
  - `npm run android:apk` — builds the APK (output path printed at the end). Hardcodes `JAVA_HOME` to Android Studio's bundled JBR 21; system Zulu 17 fails Capacitor 7
  - `npm run android:install` — builds and `adb install -r`s onto the connected tablet. `adb` must be on PATH (`~/Library/Android/sdk/platform-tools`)
  - Pilot device: Samsung Tab S10 FE (`R5GYC32RBKV`)

Brand: kiosk wears Talavera Terracotta (`#A8542A`), driven by CSS variables in `kiosk/src/index.css` — repalette there, not in `tailwind.config.js`.

## Tenant model
- Each tenant lives on a subdomain: `<subdomain>.desktop.kitchen`
- The platform/admin lives on `pos.desktop.kitchen`
- Tenant resolution: subdomain → `X-Tenant-ID` header → `DEFAULT_TENANT_ID` env fallback (`server/middleware/tenant.js`)
- DB isolation via Postgres RLS policies (`server/db/pg-schema.sql:700+`)
- `trust proxy` is set — `req.get('host')` returns the real tenant subdomain behind Railway
- The tenant middleware owns the request transaction (BEGIN/COMMIT). Do not nest BEGIN/COMMIT in `/api/*` routes — the outer one is load-bearing for RLS + PgBouncer

## Migrations
- `server/db/migrations/NNNN_name.js` — each file exports `version: number`, `name: string`, `async up(sql)`. No down migrations
- Runs once at server boot (`initMigrations()` + `runMigrations()`). Uses `adminSql` (bypasses RLS) inside `adminSql.begin()` so each migration is atomic
- Numbering is sequential; check `ls server/db/migrations | sort | tail -1` for the current latest rather than trusting this file (a stale "latest is 0079" here once misled an agent into flagging a phantom numbering gap). `MAX(version)` bug was fixed 2026-05-27 — set-difference tracking means renumbered/missing versions are tolerated
- Migration 0088 codifies the nine `ai_*` tables that previously existed only in prod (pre-extraction artifacts). If a table exists in prod but not in migrations/`pg-schema.sql`, codify it the same way: introspect prod, transcribe faithfully (incl. RLS policy + `app_user` grants), keep it idempotent

## Auth conventions
- Two auth surfaces: **Employee PIN login** (cashier/kitchen/bar — local POS entry) and **Owner JWT** (admin, billing, super-admin). Both end up as Bearer JWT for `/api/*` calls
- Employee auth uses **Bearer JWT** in `Authorization` header, not cookies (`server/middleware/auth.js`)
- **OAuth initiation endpoints must return `{ auth_url }` JSON**, never `res.redirect`. Anchor-tag navigation does not send the Authorization header, so server-side redirects break for authenticated OAuth entry points. Clients fetch authenticated then do `window.location = auth_url`
- OAuth `redirect_uri` must be derived from `req.get('host')`, not from `process.env.BASE_URL` (which is hardcoded to the platform subdomain). Each tenant whitelists their own subdomain callback URL in their own third-party app config

## Payment integrations
- Current: Stripe (global), Mercado Pago Point (LATAM), Getnet scaffolding (Santander, dormant)
- Removed: Conekta (dropped 2026-07-16 — never used by a real tenant; `orders.conekta_order_id` / `refunds.conekta_refund_id` columns kept for historical rows; refunds on legacy Conekta orders return 400 and must go through the Conekta dashboard)
- Per-tenant credentials stored in `tenant_credentials` table (see `server/routes/credentials.js`)
- Platform env vars (`MP_CLIENT_ID` etc.) act as fallback when tenant has no per-tenant creds
- **Webhooks are per-tenant config** — merchants register webhook URLs in their own processor's dashboard. Don't depend on webhooks for correctness; always implement a live-pull fallback in the status-polling endpoint (see `server/routes/payments.js` MP status pull for the pattern)

## WhatsApp / voice + visual ops
- Two inbound transports, one shared engine (`server/helpers/inboundVoiceOps.js`): Twilio (`routes/twilio-inbound.js`, also SMS) and Meta Cloud API (`routes/wa-cloud-inbound.js`). Photo → `helpers/receiptVision.js` (Claude vision) → `record_purchase` or `count_inventory` → SI/NO confirm → `helpers/voiceIntent.js` executes
- **WhatsApp numbers are per-tenant.** `access_token` / `phone_number_id` / `waba_id` live in `tenant_credentials` (`service='whatsapp'`), written by the Embedded Signup flow at `/admin/wa-onboarding`. `WA_CLOUD_ACCESS_TOKEN` / `WA_CLOUD_PHONE_NUMBER_ID` env are only the platform fallback (DK's own number)
- We are our own Meta **Tech Provider**, so every tenant WABA delivers to one webhook signed with **our** `WA_CLOUD_APP_SECRET` — signature verification is platform-level, tenant routing is by `value.metadata.phone_number_id` (`resolveTenantByPhoneNumberId`). An unknown number is dropped, never guessed
- Pass `tenantId` to `resolveEmployeeByPhone()` whenever the transport knows which number received the message; without it the lookup is cross-tenant and ties break on "most recently created"
- Runbook: `docs/whatsapp-tech-provider-onboarding.md`

## Offline behavior
- Frontend caches menu + queues orders via **Dexie/IndexedDB** + a service worker; reconnect triggers automatic sync. When debugging "order missing on server" check the offline queue first before assuming a backend bug

## Order lifecycle
- Status values collapsed in migration 0066 (Phase 0b): `pending`/`confirmed`/`preparing` → `active`. Backend writes `active` only; reads still tolerate legacy values during rollout
- **Kiosk pay-first flow** (as of 2026-06-18):
  - Cart submit creates orders as `status='draft_kiosk'` — KDS does NOT render drafts
  - Card payment: `/orders/:id/status` poll calls `markKioskOrderPaid()` on success, which promotes `draft_kiosk → active` (kitchen ticket prints at that moment)
  - Cash payment: customer walks to cashier; held orders surface in `GET /api/orders/kiosk-held`; cashier `POST /api/orders/:id/claim` promotes the order
  - Delivery: same draft pattern + Uber Direct courier dispatch is gated on payment (see `dispatchPendingCourier` in `server/routes/kiosk.js`; uses `delivery_orders.pending_dispatch JSONB` stashed at order creation)
- Test cleanup: `DELETE /api/orders/:id` or `POST /api/orders/purge-unpaid` (gated by `void_orders` permission). Both cascade child rows (order_items, order_payments, refunds, etc.) before the order row. Do NOT run raw `DELETE FROM orders` without that cascade — FK constraints will block

## UI conventions
- Mobile touch targets ≥ **40px** (Apple HIG wants 44; we standardize at 40 as min)
- Menu items **must** have `imageUrl` populated — text-only cards are not acceptable in customer-facing surfaces. Gradient+icon fallback acceptable for imageless items on the merchant side
- Motion: use **Framer Motion** (or Motion One). Do not add ad-hoc `@keyframes` — the existing two slide-up/pulse animations in `tailwind.config.js` are the only exceptions
- Design tokens: prefer Tailwind tokens. No literal `#rrggbb` colors, no one-off `rounded-[13px]` values in components
- i18n: Spanish + English via `react-i18next`. All user-facing copy goes through `t()`
- No back-office surfaces in the kiosk — kiosk stays 100% customer-facing. Staff flows go to mobile POS or desktop POS

## Do not
- Do not commit `.env` files, credentials, or secrets
- Do not run `railway up --detach` after `git push` — auto-deploy is wired and a manual `railway up` creates a competing deployment
- Do not use `process.env.BASE_URL` for OAuth `redirect_uri` — use `req.get('host')`
- Do not rely on third-party webhooks for payment status correctness — always provide a live-pull fallback
- Do not add menu photography as an afterthought — it's the single biggest engagement lever and should be treated as content infrastructure (upload pipeline, CDN, blurhash, fallback)
- Do not fire kiosk orders to the kitchen before payment — use the `draft_kiosk` → `active` lifecycle above

## Where to look
- Deferred work: `TODOS.md` at repo root (tracked, includes Phase 2/3 triggers)
- Security policies: `docs/csd-security-policy.md`
- Schema: `server/db/pg-schema.sql`
- Migrations: `server/db/migrations/`
- Tenant middleware: `server/middleware/tenant.js`
- Auth middleware: `server/middleware/auth.js`
- Kiosk API surface (client): `kiosk/src/lib/kioskApi.ts`
- Kiosk routes (server): `server/routes/kiosk.js`
- AI inventory intelligence (server): `server/routes/ai.js` — the only live `/api/ai/*` surface; keep `src/api/index.ts` /ai functions 1:1 with it (dead pre-extraction endpoints were pruned 2026-07-20; rebuild server-first if a screen needs one back)

## Agent handoff (multi-agent coordination)
Multiple Claude agents work this project: Claude Code sessions in this repo, and a Cowork cloud session (Claude desktop app) with file-bridge access to the same folder. Coordination happens through `HANDOFF.md` (repo root):
- **At session start**: read `HANDOFF.md` (repo root) for open items addressed to you.
- **Before finishing**: append a dated entry if the other agent needs to know something (state changes, warnings, requests). Newest entries on top. Prune resolved items.
- Clone geography: this repo (`~/Developer/pos-lite`) is canonical. `~/Developer/dk-lite/pos-lite` and `pos-lite-lane-b` are separate clones used by Cowork lanes — they may be stale; never copy files between clones, use git.
- The Cowork agent's sandbox cannot delete files or reach the network from the Mac; it may leave `.git/*.lock` strays in `_to_delete/` — safe to empty that folder.
