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
- `npx tsc --noEmit -p .` — typecheck (no separate `lint` or `test` script; tsc is the gate)
- `npm run smoketest:orders` / `smoketest:kds` — load/smoke scripts under `scripts/`

There is no Jest/Vitest suite. Treat typecheck + manual flow verification as the bar before pushing.

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
- Numbering is sequential; current latest is `0071_delivery_pending_dispatch.js`. `MAX(version)` bug was fixed 2026-05-27 — set-difference tracking means renumbered/missing versions are tolerated

## Auth conventions
- Two auth surfaces: **Employee PIN login** (cashier/kitchen/bar — local POS entry) and **Owner JWT** (admin, billing, super-admin). Both end up as Bearer JWT for `/api/*` calls
- Employee auth uses **Bearer JWT** in `Authorization` header, not cookies (`server/middleware/auth.js`)
- **OAuth initiation endpoints must return `{ auth_url }` JSON**, never `res.redirect`. Anchor-tag navigation does not send the Authorization header, so server-side redirects break for authenticated OAuth entry points. Clients fetch authenticated then do `window.location = auth_url`
- OAuth `redirect_uri` must be derived from `req.get('host')`, not from `process.env.BASE_URL` (which is hardcoded to the platform subdomain). Each tenant whitelists their own subdomain callback URL in their own third-party app config

## Payment integrations
- Current: Stripe (global), Conekta (Mexico), Mercado Pago Point (LATAM), Getnet scaffolding (Santander, dormant)
- Per-tenant credentials stored in `tenant_credentials` table (see `server/routes/credentials.js`)
- Platform env vars (`MP_CLIENT_ID` etc.) act as fallback when tenant has no per-tenant creds
- **Webhooks are per-tenant config** — merchants register webhook URLs in their own processor's dashboard. Don't depend on webhooks for correctness; always implement a live-pull fallback in the status-polling endpoint (see `server/routes/payments.js` MP status pull for the pattern)

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
