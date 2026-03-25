# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

POS Lite — lean multi-tenant restaurant POS SaaS ($20/mo). Stripped-down version of Desktop Kitchen.

- **Repo**: `github.com/dchosenjuan1/desktop-kitchen`
- **Deployment**: Railway → `pos.desktop.kitchen`
- **DB**: Neon Postgres with RLS (multi-tenant)

## Commands

```bash
npm run dev          # Concurrent client (Vite :5173) + server (Express :3001)
npm run dev:client   # Frontend only
npm run dev:server   # Backend only
npm run build        # Vite build → dist/
npm start            # Production: NODE_ENV=production node server/index.js

# Capacitor (mobile)
npm run cap:sync     # Sync web assets to native
npm run cap:android  # Open Android Studio
npm run cap:ios      # Open Xcode

# Deploy (Railway CLI — no GitHub auto-deploy connected)
railway up -s pos-lite -d   # Upload & deploy to production
```

No automated test suite — manual testing via browser + API calls.

## Architecture

### Multi-Tenancy & RLS
- Tenant resolved from: subdomain → `X-Tenant-ID` header → `DEFAULT_TENANT_ID` env
- Two DB pools in `server/db/index.js`:
  - `adminSql` — Neon owner role, bypasses RLS (auth, admin, migrations)
  - `tenantSql` — `app_user` role, RLS enforced via `SET_CONFIG('app.tenant_id', ...)` in BEGIN/COMMIT block
- Tenant middleware (`server/middleware/tenant.js`) reserves a connection and sets RLS config on every request

### Dual Auth System
- **Employee PIN** (POS usage): 4-6 digit bcrypt PIN → JWT 24h, `type: 'employee'`
- **Owner email/password** (admin/billing): bcrypt password → JWT 7d, stored as `owner_token`
- Auth middleware: `requireAuth('manage_menu')` checks JWT + role permissions
- Offline PIN login: SHA-256 hash cached in IndexedDB

### Frontend
- React 18 + TypeScript + Vite + Tailwind CSS
- **HashRouter** (required for Capacitor compatibility)
- Lazy-loaded screens via `React.lazy()`
- Device detection branches to mobile routes (`/m/*`) via `MobileShell` on phones
- Context provider order matters: Theme → Branding → Plan → Toast → Auth → Sync
- i18n: i18next with 9 namespaces (`common`, `pos`, `kitchen`, `admin`, `inventory`, `reports`, `financing`, `settlement`, `superAdmin`) in `src/i18n/locales/{en,es}/`
- Offline-first: Dexie.js IndexedDB (`src/lib/offlineDb.ts`) for employees, menu cache, offline order queue
- Neon returns NUMERIC columns as strings — `NUMERIC_FIELDS` set in `src/api/index.ts` auto-coerces known fields (price, total, amount, wage_rate, etc.) to numbers at the API boundary via `coerceNumerics()`. Add new numeric column names to this set when creating new tables.

### Backend
- Express.js (ES modules) — `server/index.js`
- 30+ route files in `server/routes/`
- Schema: `server/db/pg-schema.sql` (48+ tables)
- Migrations: `server/db/migrations/*.js` — lightweight, no down migrations, runs at startup via `initMigrations()` + `runMigrations()`
- Payments: Stripe, Conekta, Mercado Pago, Getnet
- Invoicing: FacturAPI (CFDI/SAT Mexico)
- SMS: Twilio (loyalty)

### Migrations
Runner: `server/db/migrate.js`. Each migration file exports:
- `version` (number) — sequential, determines execution order
- `name` (string) — descriptive label (e.g. `'add-payroll'`)
- `up(sql)` (async function) — receives a postgres.js transaction scope

Migrations run inside `adminSql.begin()` (atomic). No down migrations — design forward-compatible changes. When adding new permissions, seed them for all existing tenants in the migration (query `tenants` table, insert into `role_permissions` with `ON CONFLICT DO NOTHING`).

### Permission System
- Source of truth: `allPermissions` array in `server/tenants.js` → `seedTenantDefaults()`
- Stored in `role_permissions` table: `(tenant_id, role, permission, granted)`
- Role defaults: admin = all, manager = all except `manage_permissions`, cashier = `pos_access` + `view_dashboard`, kitchen = `kitchen_access`, bar = `bar_access`
- Adding a new permission requires 3 changes:
  1. Add to `allPermissions` in `server/tenants.js` (for new tenants)
  2. Create a migration that seeds it for existing tenants
  3. Use `requireAuth('permission_name')` in route handlers

### Key Files
| Purpose | Path |
|---------|------|
| Server entry | `server/index.js` |
| DB schema | `server/db/pg-schema.sql` |
| DB connection | `server/db/index.js` |
| Migration runner | `server/db/migrate.js` |
| Tenant middleware | `server/middleware/tenant.js` |
| Auth middleware | `server/middleware/auth.js` |
| Tenant/permission seeding | `server/tenants.js` |
| Frontend entry | `src/main.tsx` → `src/App.tsx` |
| API client | `src/api/index.ts` |
| Types | `src/types/index.ts` |
| Offline DB | `src/lib/offlineDb.ts` |
| Capacitor config | `capacitor.config.ts` |
| Railway config | `railway.json` |

## Conventions

- All tenant-scoped queries go through the reserved connection with RLS — never bypass tenant context
- New tables with tenant_id need: RLS enabled + forced, tenant_isolation policy, GRANT to `app_user`, sequence grant
- Route handlers: `{ error: 'message' }` for errors, standard HTTP status codes
- Frontend strings use `useTranslation('namespace')` — no hardcoded user-facing text
- Feature gating via `PlanContext.isFeatureLocked()` (free: 50 items, 3 employees, 1 printer)
- API base URL auto-resolves: localhost in dev, subdomain-based in production
- Vite proxies `/api`, `/admin`, `/uploads` to `:3001` in dev
- New numeric DB columns: add field name to `NUMERIC_FIELDS` set in `src/api/index.ts`

## Dev Credentials

- Tenant: `demo`
- Owner: `admin@demo.com` / `demo1234`
- Employee PIN: `1234` (admin role)
- Demo token auto-login: `?demo_token=X` → `/api/demo/demo-login`
