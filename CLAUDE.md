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

### Triple Auth System
Three independent auth systems, each with its own JWT type:
- **Employee PIN** (POS usage): 6-digit bcrypt PIN → JWT 24h (`type: 'employee'`)
- **Owner email/password** (admin/billing): bcrypt password → JWT 7d (`type: 'owner'`), stored as `owner_token`
- **Sales rep email/password** (CRM portal): bcrypt password → JWT 12h (`type: 'sales_rep'`)
- Auth middleware: `requireAuth('manage_menu')` for tenant routes, `requireSalesAuth()` for sales routes
- Offline PIN login: SHA-256 hash cached in IndexedDB
- Demo token auto-login: `?demo_token=X` → `DemoTokenHandler` in `App.tsx` exchanges via `/api/demo/demo-login`

### Frontend
- React 18 + TypeScript + Vite + Tailwind CSS
- **HashRouter** (required for Capacitor compatibility)
- Lazy-loaded screens via `React.lazy()`
- Device detection branches to mobile routes (`/m/*`) via `MobileShell` on phones
- Context provider order matters: Theme → Branding → Plan → Toast → Auth → Sync
- i18n: i18next with 10 namespaces (`common`, `pos`, `kitchen`, `admin`, `inventory`, `reports`, `financing`, `settlement`, `superAdmin`, `sales`) in `src/i18n/locales/{en,es}/`
- Offline-first: Dexie.js IndexedDB (`src/lib/offlineDb.ts`) for employees, menu cache, offline order queue
- Neon returns NUMERIC columns as strings — `NUMERIC_FIELDS` set in `src/api/index.ts` auto-coerces known fields (price, total, amount, wage_rate, commission_percent, commission_amount, mrr_amount, threshold, etc.) to numbers at the API boundary via `coerceNumerics()`. Add new numeric column names to this set when creating new tables.

### Route Structure (App.tsx)
Three top-level route branches before tenant routes:
```
/#/sales/*        → SalesPortal (separate auth, sessionStorage)
/#/super-admin/*  → SuperAdminPortal (ADMIN_SECRET auth)
/#/*              → TenantRoutes (employee/owner auth)
```

### Sales CRM Portal (`/#/sales/*`)
Separate portal for sales reps at `/#/sales`. Uses its own auth context (`SalesAuthContext`) with JWT in `sessionStorage`. API client: `src/api/salesApi.ts`.

Key screens: Dashboard, Leads, Lead Detail, Clients, Client Detail, Onboard Wizard, Commissions, Leaderboard, Team Manager (managers only), Demo Access.

Backend routes (bypass tenant middleware, use `adminSql`):
- `server/routes/sales-auth.js` — login/me
- `server/routes/sales-api.js` — leads, dashboard, commissions, clients, reps
- `server/routes/sales-onboard.js` — tenant creation wizard
- `server/routes/sales-demo.js` — demo tenant setup/reset/access

### Super Admin Portal (`/#/super-admin/*`)
Admin dashboard at `/#/super-admin`. Auth via `ADMIN_SECRET` env var (stored in `sessionStorage`). API client: `src/api/superAdmin.ts` (uses existing `/admin/*` backend routes).

Key screens: Overview KPIs, Tenants list, Tenant Detail, Revenue charts, System Health, Demo Config, Sales Reps, Agent Monitoring, Alerts.

### Demo System
- Persistent demo tenant (`demo-sales`) auto-resets daily at 4am UTC
- `server/lib/demoDataGenerator.js` generates realistic Mexican taqueria data (orders, loyalty, inventory, financials)
- Sales reps generate 2hr demo tokens → prospects open URL → `DemoTokenHandler` exchanges token → auto-login
- `DemoTokenHandler` stores `tenant_id` in localStorage (required for `PlanContext` to send correct `X-Tenant-ID` header)
- Lean POS compatibility: AI tables and optional feature tables wrapped in try/catch (may not exist)

### Backend
- Express.js (ES modules) — `server/index.js`
- 35+ route files in `server/routes/`
- Schema: `server/db/pg-schema.sql` (48+ tables) + additional tables from migrations
- Migrations: `server/db/migrations/*.js` — lightweight, no down migrations, runs at startup
- Payments: Stripe, Conekta, Mercado Pago, Getnet
- Invoicing: FacturAPI (CFDI/SAT Mexico)
- SMS: Twilio (loyalty)
- AI: Anthropic Batch API for nightly reports (`server/agent/`)

### Route Mounting Order (server/index.js)
Platform routes mount BEFORE tenant middleware:
1. `/api/sales/auth` — sales rep login (public)
2. `/api/demo` — demo token exchange (public)
3. `/admin/*` — super admin routes (ADMIN_SECRET)
4. `/api/sales/onboard` — tenant creation (salesAuth)
5. `/api/sales/demo` — demo access (salesAuth + admin)
6. `/api/sales/*` — CRM API (salesAuth)
7. Tenant middleware applies
8. All other `/api/*` routes (tenant-scoped with RLS)

### Scheduled Jobs (`server/agent/scheduler.js`)
- **Hourly**: Agent report generation (Anthropic Batch API)
- **Daily 4am UTC**: Demo tenant data reset
- **Monthly 1st 2am UTC**: Commission calculation for sales reps
- **Every 6 hours**: Platform monitoring (agent alerts)

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
| Auth middleware (tenant) | `server/middleware/auth.js` |
| Auth middleware (sales) | `server/middleware/salesAuth.js` |
| Tenant/permission seeding | `server/tenants.js` |
| Demo data generator | `server/lib/demoDataGenerator.js` |
| Scheduler (cron jobs) | `server/agent/scheduler.js` |
| Frontend entry | `src/main.tsx` → `src/App.tsx` |
| Tenant API client | `src/api/index.ts` |
| Sales API client | `src/api/salesApi.ts` |
| Super Admin API client | `src/api/superAdmin.ts` |
| Sales auth context | `src/context/SalesAuthContext.tsx` |
| Types | `src/types/index.ts` |
| Offline DB | `src/lib/offlineDb.ts` |
| Capacitor config | `capacitor.config.ts` |
| Railway config | `railway.json` |

## Column Name Gotchas

These column names differ from what you might expect:
| Table | Actual Column | NOT This |
|-------|--------------|----------|
| `modifiers` | `group_id` | `modifier_group_id` |
| `printers` | `printer_type` | `type` |
| `printers` | `address` | `ip_address` |
| `inventory_items` | `low_stock_threshold` | `reorder_level` |
| `employees` | `pin` (stores bcrypt hash) | `pin_hash` |
| `demo_tokens` | `token` (UUID type) | — use `crypto.randomUUID()` with `::uuid` cast |

Missing columns (don't exist despite seeming logical):
- `menu_items.cost_price` — does not exist
- `menu_items.sort_order` — does not exist
- `inventory_items.active` — does not exist

## Conventions

- All tenant-scoped queries go through the reserved connection with RLS — never bypass tenant context
- Sales/admin routes use `adminSql` directly (no tenant context) — scoped by `rep_id` or `ADMIN_SECRET`
- New tables with tenant_id need: RLS enabled + forced, tenant_isolation policy, GRANT to `app_user`, sequence grant
- Platform-level tables (sales_reps, sales_commissions, agent_alerts, demo_config) have NO RLS — like `tenants` and `leads`
- Route handlers: `{ error: 'message' }` for errors, standard HTTP status codes
- Frontend strings use `useTranslation('namespace')` — no hardcoded user-facing text
- Feature gating via `PlanContext.isFeatureLocked()` (free: 50 items, 3 employees, 1 printer)
- API base URL auto-resolves: localhost in dev, subdomain-based in production
- Vite proxies `/api`, `/admin`, `/uploads` to `:3001` in dev
- New numeric DB columns: add field name to `NUMERIC_FIELDS` set in `src/api/index.ts`
- PINs are 6 digits (not 4)

## Dev Credentials

- Tenant: `demo`
- Owner: `admin@demo.com` / `demo1234`
- Employee PIN: `123456` (admin role)
- Demo token auto-login: `?demo_token=X` → `/api/demo/demo-login`
- Super Admin: `ADMIN_SECRET` env var → `/#/super-admin`
- Sales demo tenant: `demo-sales` (auto-resets daily)
