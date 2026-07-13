# Wallet Pass Loyalty — Implementation Plan (pos-lite)

Apple Wallet + Google Wallet passes as a **display layer** on top of the existing stamp-card
loyalty system. Postgres stays the source of truth; the pass is a mirror that updates itself.

Direct-API build (no PassKit.com middleware) — Apple Developer account already available.
Designed multi-tenant from day one per house convention.

---

## 1. What exists today (verified against the code)

| Piece | Where | Notes |
|---|---|---|
| Customers | `loyalty_customers` (phone+name, `UNIQUE(tenant_id, phone)`) | RLS-scoped, SMS opt-in flag |
| Stamp cards | `stamp_cards`, `stamp_events` | auto-create next card on completion |
| Stamp logic choke point | `server/helpers/loyalty.js` → `addStampsForOrder()`, `addBonusStamps()`, `redeemReward()` | **every** stamp/redeem mutation funnels through these three functions |
| Stamp trigger | `POST /api/loyalty/customers/:id/stamps` — client-called from POS after payment | server does *not* auto-stamp on `payment_status='paid'` today |
| Notifications | `server/helpers/twilio.js` — fire-and-forget `.catch(() => {})` pattern | wallet push should copy this pattern |
| Config | `loyalty_config` KV per tenant (`stamps_required`, `reward_description`, `sms_enabled`) | add wallet keys here |
| Plan gating | `requirePlanFeature('loyalty')` — loyalty unlocked on free, SMS is Pro | decide gate for wallet (suggest: free = included, it's a growth loop) |
| Tenant resolution | subdomain → `X-Tenant-ID` → `DEFAULT_TENANT_ID` (`server/middleware/tenant.js`), RLS via `set_config('app.tenant_id')` | Apple's callbacks will arrive on the tenant subdomain → middleware + RLS work unchanged |
| Migrations | `server/db/migrations/NNNN_name.js` with `version`/`name`/`up(sql)` — latest is **0080** | new one is `0081_wallet_passes.js` |
| Branding | `tenants.branding_json`, `BrandingContext` | logo/colors for pass template |

Key architectural consequence: **hook pass updates inside the three helper functions**, not in
routes. POS stamps, manual stamps, referral bonuses, and redemptions all update the pass with
one integration point, exactly like SMS does today.

---

## 2. Data model — migration `0081_wallet_passes.js`

```sql
-- One row per issued pass (a customer can hold apple + google simultaneously)
CREATE TABLE IF NOT EXISTS wallet_passes (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
  customer_id INTEGER NOT NULL REFERENCES loyalty_customers(id),
  platform TEXT NOT NULL CHECK (platform IN ('apple', 'google')),
  serial_number TEXT NOT NULL UNIQUE,          -- UUID; Apple pass serial / Google object suffix
  auth_token TEXT NOT NULL,                    -- Apple: ApplePass auth (>=16 chars); Google: unused
  enroll_token TEXT UNIQUE,                    -- random token for the public download URL
  revoked BOOLEAN DEFAULT false,
  updated_at TIMESTAMPTZ DEFAULT NOW(),        -- drives Last-Modified / passesUpdatedSince
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tenant_id, customer_id, platform)
);

-- Apple device registrations (Apple web service spec)
CREATE TABLE IF NOT EXISTS wallet_registrations (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
  pass_id INTEGER NOT NULL REFERENCES wallet_passes(id),
  device_library_id TEXT NOT NULL,
  push_token TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(pass_id, device_library_id)
);
```

Plus: indexes on `tenant_id`, RLS enable/force + `tenant_isolation` policy on both tables
(copy the block from `0037_display_menu_foundation.js`), and mirror the DDL into
`pg-schema.sql` for fresh installs.

`loyalty_config` new keys: `wallet_enabled`, `store_latitude`, `store_longitude`,
`wallet_location_message` (lock-screen text, e.g. "Estás cerca — ¿se te antoja algo? 🌯").

---

## 3. Server modules

```
server/
  helpers/wallet/
    applePass.js     — build+sign .pkpass (passkit-generator), per-tenant branding
    appleApns.js     — HTTP/2 push to api.push.apple.com (empty payload, topic = pass type id)
    googleWallet.js  — LoyaltyClass/LoyaltyObject CRUD + signed "Save to Wallet" JWT
    passSync.js      — schedulePassUpdate(customerId): the one function loyalty.js calls
  routes/
    wallet.js        — public enroll/download + Apple web service endpoints
```

### 3a. Pass generation (`applePass.js`)

- Dependency: `passkit-generator` (ESM-friendly, handles manifest + signing). One
  platform-wide cert set — this is Desktop Kitchen's Pass Type ID used for all tenants
  (white-label: tenant branding is data, not a separate cert).
- Pass content (storeCard style): logo + colors from `tenants.branding_json`,
  primary field = stamps `X / Y`, secondary = reward description, back fields =
  referral code + phone. `locations: [{lat, lon, relevantText}]` from `loyalty_config`.
- `webServiceURL`: **derive from `req.get('host')`** — never `process.env.BASE_URL`
  (same lesson as OAuth redirect_uri in CLAUDE.md). Format:
  `https://<subdomain>.desktop.kitchen/api/wallet/apple`. This puts Apple's callbacks on the
  tenant subdomain, so existing tenant middleware + RLS scope them with zero special-casing.
- `authenticationToken`: the pass row's `auth_token` (crypto.randomBytes, ≥16 chars).

### 3b. Apple web service (`routes/wallet.js`, spec-defined paths)

Mounted at `/api/wallet` (tenant-scoped, after tenant middleware — subdomain resolves):

```
POST   /apple/v1/devices/:deviceLibraryId/registrations/:passTypeId/:serial   → upsert wallet_registrations
DELETE /apple/v1/devices/:deviceLibraryId/registrations/:passTypeId/:serial   → delete registration
GET    /apple/v1/devices/:deviceLibraryId/registrations/:passTypeId           → serials updated since ?passesUpdatedSince
GET    /apple/v1/passes/:passTypeId/:serial                                   → rebuild + return fresh .pkpass
POST   /apple/v1/log                                                          → console.log, return 200
```

Auth for these: `Authorization: ApplePass <auth_token>` checked against the pass row —
**not** the employee JWT (`requireAuth` does not apply here). MIME for pass responses:
`application/vnd.apple.pkpass`; support `Last-Modified`/`If-Modified-Since` via `updated_at`.

### 3c. Enrollment endpoints (same router)

```
POST /api/wallet/enroll            (requireAuth('pos_access'))  → create pass row(s), return { enroll_url, qr_payload }
GET  /api/wallet/p/:enrollToken    (public)                     → smart landing: iOS → .pkpass download,
                                                                  Android → Google Wallet save link, desktop → QR
```

The public endpoint is safe because `enroll_token` is an unguessable capability URL — same
trust model as `cfdi_invoice_tokens`.

### 3d. Update push (`passSync.js` + `appleApns.js` + `googleWallet.js`)

`schedulePassUpdate(customerId)` — called fire-and-forget from `addStampsForOrder`,
`addBonusStamps`, `redeemReward`:

1. `UPDATE wallet_passes SET updated_at = NOW() WHERE customer_id = $1`
2. Apple: for each registration, HTTP/2 POST `https://api.push.apple.com/3/device/{pushToken}`
   with header `apns-topic: <passTypeId>` and body `{}` — client-cert auth **using the same
   pass certificate**. Phone then silently re-fetches the pass from 3b. No `apn` npm package
   needed; Node's built-in `http2` + the cert is ~40 lines.
3. Google: PATCH the LoyaltyObject (`loyaltyPoints.balance`) via REST. No push infra needed —
   Google renders server state directly.
4. Failures: log and swallow (`.catch(() => {})`), exactly like SMS. Never block the payment path.

Caveat: this runs post-response in some paths (outside the request's reserved RLS connection),
so `getConn()` falls back to `adminSql`. That's acceptable but **every query in passSync must
filter `tenant_id` explicitly** — capture it via `getTenantId()` at call time and pass it in.

### 3e. Google Wallet (`googleWallet.js`)

- One-time per tenant: create a `LoyaltyClass` (`<ISSUER_ID>.<tenant_id>-loyalty`) with tenant
  branding — lazily on first enroll, cache in `loyalty_config`.
- Per customer: `LoyaltyObject` (`<ISSUER_ID>.<serial_number>`), points = stamps.
- Enrollment = signed JWT (RS256, service-account key) → `https://pay.google.com/gp/v/save/<jwt>`.
- Free API; needs a Google Pay & Wallet Console issuer account (one-time signup, ~1 day approval).

---

## 4. Frontend touchpoints

1. **LoyaltyScreen (merchant)** — in the customer detail drawer, add "Tarjeta digital" section:
   QR code (already have `qrcode.react`) pointing at `enroll_url`, so staff can show the screen
   and the customer scans it. Plus config fields (location lat/long, lock-screen message) in
   the existing loyalty config panel.
2. **POS registration flow** — after `POST /api/loyalty/customers` succeeds, show the QR
   in the confirmation modal ("scan to add your card").
3. **SMS welcome** — append the enroll short-link to `sendWelcomeSMS` (biggest reach, zero UI).
4. **Kiosk / QR customer flow** (`CustomerOrderScreen`) — has **no loyalty capture today**;
   phase 2: post-payment "join rewards" screen with phone+name → enroll link. Deliberately
   deferred; it's a bigger UX change.
5. i18n: all pass strings + UI copy via `t()`, Spanish first, per house rules.

---

## 5. Certificates, env, config

Apple Developer portal (one-time, ~30 min):
1. Identifiers → Pass Type IDs → create `pass.kitchen.desktop.loyalty`
2. Create certificate for it → export `.p12`
3. Download Apple WWDR G4 intermediate cert

Env additions (`.env.example` + Railway):

```
# ---- Wallet Passes (optional) ----
APPLE_TEAM_ID=XXXXXXXXXX
APPLE_PASS_TYPE_ID=pass.kitchen.desktop.loyalty
APPLE_PASS_CERT_P12_BASE64=...      # base64 of the .p12 (Railway-friendly, no file mounts)
APPLE_PASS_CERT_PASSWORD=...
APPLE_WWDR_CERT_BASE64=...
GOOGLE_WALLET_ISSUER_ID=...
GOOGLE_WALLET_SA_KEY_BASE64=...     # service-account JSON, base64
```

Platform-level env (not `tenant_credentials`) because the cert belongs to Desktop Kitchen,
not to tenants — consistent with the white-label decision. If a tenant ever wants passes
under their own Apple account, `tenant_credentials` already supports the override pattern.

New deps: `passkit-generator`, `google-auth-library`. (No APNs SDK — raw `http2`.)

---

## 6. Build sequence

| Step | Scope | Est. |
|---|---|---|
| 1 | Migration 0038 + `applePass.js` + enroll/download endpoints + LoyaltyScreen QR. Ships a working static Apple pass (no live updates yet — stamp count correct as of download). | 1 day |
| 2 | Apple web service endpoints + `wallet_registrations` + APNs push wired into the three loyalty helpers. Passes now update in real time. | 1 day |
| 3 | Google Wallet class/object + save link + PATCH on update; smart landing page picks platform. | 0.5–1 day |
| 4 | SMS enroll link + config UI (geofence coords, lock-screen text) + polish. | 0.5 day |
| 5 | (Phase 2) Kiosk post-payment enrollment screen. | later |

Each step is independently shippable; validate at Juanberto's after step 1–2 before
building the Google side if you want to sequence even tighter.

Testing note: Apple web service + APNs can be exercised end-to-end only with a real iPhone
and the production HTTPS domain — plan to test steps 1–2 against the deployed Railway env.
Deploy = `git push origin master` (auto-deploy is wired; do NOT run `railway up` — it creates
a competing deployment, per CLAUDE.md). DB-level coverage lives in `tests/wallet.test.ts`
(RLS boundary, uniqueness, registration cascade — same Neon-test-branch harness as rls.test.ts).

---

## 7. Gotchas mapped to house rules

- **`webServiceURL` from `req.get('host')`**, never `BASE_URL` — else every tenant's passes
  phone home to the platform subdomain (same class of bug as the OAuth redirect_uri rule).
- **Rate limiter**: `/api` global limit is 200 req/min/IP. A bulk pass update fans out Apple
  re-fetches, but they come from many devices/IPs — no exemption needed initially; revisit if
  a tenant passes ~200 registered devices.
- **RLS + background push**: post-response work uses `adminSql` (RLS bypassed) — always pass
  `tenant_id` explicitly into `passSync` queries.
- **Don't trust the update round-trip**: like payment webhooks, treat APNs as best-effort;
  the GET-pass endpoint always rebuilds from DB truth, so a missed push self-heals on next open.
- **Serial/enroll tokens are capability URLs** — generate with `crypto.randomBytes(16)+`,
  never sequential ids.
- **Order deletion**: `DELETE /api/orders/:id` cascade doesn't touch wallet tables (linked via
  customer, not order) — no change needed.

## 8. Decisions — RESOLVED 2026-07-13

1. **Plan gating: free tier** (Juan). Passes are the growth loop; SMS stays the Pro upsell.
2. **Geofence source: `loyalty_config` keys** — `store_latitude`, `store_longitude`,
   `wallet_location_message`. Editable in the existing loyalty settings UI; seeded by
   migration 0038 for existing tenants.
3. **Pass Type ID: `pass.kitchen.desktop.loyalty`** — reverse-DNS of desktop.kitchen.
   Create exactly this identifier in the Apple Developer portal.
4. **Google issuer: use a business Google account** (not personal) — ideally one owned by
   the entity being formed for Stripe live-mode (TODOS #3), since issuer ownership is
   effectively unmigratable. Deferred to step 3 regardless.

---

## 9. Implementation status (2026-07-13)

> Note: originally applied to the stale `dk-lite/pos-lite` copy by mistake, then migrated
> onto the real `~/Developer/pos-lite` repo the same day (files re-based onto current
> versions; migration renumbered 0038 → 0081; dk-lite copy reverted).

Steps 1 + 2 are **code-complete** (in the working tree, not yet deployed):

- `server/db/migrations/0081_wallet_passes.js` — tables + RLS + grants + config seed
- `server/helpers/wallet/applePass.js` — .pkpass builder (verified: builds a valid signed
  pass with a test certificate; geofence, barcode, branding colors all present)
- `server/helpers/wallet/appleApns.js` — raw-http2 APNs push
- `server/helpers/wallet/passSync.js` — choke-point hook (called from the three loyalty
  helpers; resolves tenant from the customer row when called outside a request context,
  e.g. payment webhooks promoting kiosk orders)
- `server/routes/wallet.js` — enroll + capability URL + full Apple web service
- `server/assets/pass/` — icon/logo PNGs (defaults; tenant PNG logo overrides at build time)
- `server/index.js`, `pg-schema.sql`, `package.json` (passkit-generator), `.env.example`
- `tests/wallet.test.ts` — RLS boundary + uniqueness + registration cascade
- Frontend: wallet QR in LoyaltyScreen customer detail, geofence fields in settings,
  `getWalletStatus`/`enrollWalletPass` in `src/api`, es/en i18n keys

**Juan's remaining manual steps (in order):**
1. `npm install` (picks up passkit-generator)
2. `npm run typecheck && npm test` (wallet.test.ts runs against the Neon test branch)
3. Apple portal: create Pass Type ID `pass.kitchen.desktop.loyalty` + certificate;
   download WWDR G4. Extract PEMs (`openssl` commands are in `.env.example`).
4. Set the six `APPLE_*` vars in Railway.
5. Commit + `git push origin master` — auto-deploy runs migration 0081 on boot.
   (Do NOT `railway up` — competing deployment.)
6. On an iPhone: Loyalty → customer → "Mostrar QR de Wallet" → scan → pass should install.
   Then add a stamp and watch the pass update itself (~seconds).
