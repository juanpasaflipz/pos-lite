# pos-lite — Claude Code guidance

## Stack
- React + Vite + Tailwind frontend (`src/`)
- Express backend (`server/`)
- Neon Postgres, multi-tenant with RLS
- Hosted on Railway (service name `pos-lite`)

## Deploy — **important**
GitHub → Railway auto-deploy is **NOT** wired up. Pushing to `master` alone does not ship code. After every `git push origin master`, also run:
```
railway up --detach
```
from the repo root. Verify with `railway deployment list | head -3` and look for `SUCCESS` on the new deployment id. If link is lost:
```
railway link --project pos-lite --environment production --service pos-lite
```

## Tenant model
- Each tenant lives on a subdomain: `<subdomain>.desktop.kitchen`
- The platform/admin lives on `pos.desktop.kitchen`
- Tenant resolution: subdomain → `X-Tenant-ID` header → `DEFAULT_TENANT_ID` env fallback (`server/middleware/tenant.js`)
- DB isolation via Postgres RLS policies (`pg-schema.sql:700+`)
- `trust proxy` is set — `req.get('host')` returns the real tenant subdomain behind Railway

## Auth conventions
- Employee auth uses **Bearer JWT** in `Authorization` header, not cookies (`server/middleware/auth.js`)
- **OAuth initiation endpoints must return `{ auth_url }` JSON**, never `res.redirect`. Anchor-tag navigation does not send the Authorization header, so server-side redirects break for authenticated OAuth entry points. Clients fetch authenticated then do `window.location = auth_url`.
- OAuth `redirect_uri` must be derived from `req.get('host')`, not from `process.env.BASE_URL` (which is hardcoded to the platform subdomain). Each tenant whitelists their own subdomain callback URL in their own third-party app config.

## Payment integrations
- Current: Stripe (global), Conekta (Mexico), Mercado Pago Point (LATAM), Getnet scaffolding (Santander, dormant)
- Per-tenant credentials stored in `tenant_credentials` table (see `server/routes/credentials.js`)
- Platform env vars (`MP_CLIENT_ID` etc.) act as fallback when tenant has no per-tenant creds
- **Webhooks are per-tenant config** — merchants must register webhook URLs in their own processor's dashboard. Don't depend on webhooks for correctness; always implement a live-pull fallback in the status-polling endpoint (see `server/routes/payments.js` MP status pull for the pattern).

## Order deletion
- Use `DELETE /api/orders/:id` or `POST /api/orders/purge-unpaid` for test cleanup — both gated by `void_orders` permission
- They delete all child rows (order_items, order_payments, refunds, etc.) before the order row. Do NOT run raw `DELETE FROM orders` without that cascade — FK constraints will block.

## UI conventions
- Mobile touch targets ≥ **40px** (Apple HIG wants 44; we standardize at 40 as min)
- Menu items **must** have `imageUrl` populated — text-only cards are not acceptable in customer-facing surfaces. Gradient+icon fallback acceptable for imageless items on the merchant side.
- Motion: use **Framer Motion** (or Motion One). Do not add ad-hoc `@keyframes` — the existing two slide-up/pulse animations in `tailwind.config.js` are the only exceptions.
- Design tokens: prefer Tailwind tokens. No literal `#rrggbb` colors, no one-off `rounded-[13px]` values in components.
- i18n: Spanish + English via `react-i18next`. All user-facing copy goes through `t()`.

## Do not
- Do not commit `.env` files, credentials, or secrets
- Do not skip `railway up --detach` after pushing — pushing to GitHub alone does not deploy
- Do not use `process.env.BASE_URL` for OAuth `redirect_uri` — use `req.get('host')`
- Do not rely on third-party webhooks for payment status correctness — always provide a live-pull fallback
- Do not add menu photography as an afterthought — it's the single biggest engagement lever and should be treated as content infrastructure (upload pipeline, CDN, blurhash, fallback)

## Where to look
- Deferred work: `TODOS.md` at repo root (tracked, includes Phase 2/3 triggers)
- Security policies: `docs/csd-security-policy.md`
- Schema: `server/db/pg-schema.sql`
- Tenant middleware: `server/middleware/tenant.js`
- Auth middleware: `server/middleware/auth.js`
