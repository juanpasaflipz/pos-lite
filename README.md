# POS Lite — Lean Multi-Tenant Restaurant POS

A stripped-down, high-performance POS system built for restaurants. Multi-tenant SaaS architecture priced at **$20/month** per restaurant.

## What's Included

**Core POS**: Orders, menu management, modifiers, combos, split payments, receipts, kitchen display, QR ordering

**Payments**: Stripe (global), Conekta (Mexico), Mercado Pago (LATAM), Getnet, cash, OXXO, SPEI

**Delivery**: Uber Eats, Rappi, DidiFood integration with markup rules and commission tracking

**Inventory**: Stock tracking, low-stock alerts, waste logging, purchase orders, vendor management

**Team**: Employee PIN login, role-based permissions (admin/manager/cashier/kitchen/bar)

**Reports**: Sales analytics, COGS, margins, delivery commissions, expense tracking

**Invoicing**: CFDI electronic invoicing (Mexico SAT compliance via FacturAPI)

**Loyalty**: Customer stamps, referral program, SMS notifications

**Offline**: IndexedDB cache, offline order queue, automatic sync

**Mobile**: Responsive PWA with dedicated mobile POS interface

## What's NOT Included (vs Desktop Kitchen full)

AI suggestions, MCA financing, settlement/disbursements, dynamic pricing experiments, open banking (Plaid/Belvo), menu boards/kiosk, platform monitoring, stress testing, super-admin dashboard, sales rep tracking

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Copy environment variables
cp .env.example .env
# Edit .env with your Neon Postgres URL, Stripe keys, etc.

# 3. Run development server
npm run dev
# Client: http://localhost:5173
# Server: http://localhost:3001

# 4. Production build
npm run build
npm start
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18 + TypeScript + Vite |
| Styling | Tailwind CSS (brand-aware CSS variables) |
| Backend | Express.js (ES modules) |
| Database | PostgreSQL (Neon) with Row-Level Security |
| Offline | IndexedDB (Dexie.js) + Service Worker |
| Payments | Stripe, Conekta, Mercado Pago, Getnet |
| i18n | i18next (English + Spanish) |

## Architecture

- **Multi-tenant**: Subdomain-based tenant resolution with Postgres RLS
- **Two auth systems**: Employee PIN (local POS) + Owner JWT (admin/billing)
- **Offline-first**: Queue orders when offline, sync on reconnect
- **White-label**: CSS variable branding — one hex code generates full palette

## Database Setup (Neon)

1. Create a Neon project
2. Run `server/db/pg-schema.sql` against your database
3. Create the `app_user` role for RLS:

```sql
CREATE ROLE app_user WITH LOGIN PASSWORD 'your_password';
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
```

## Deployment

Optimized for Railway (server) + Vercel (optional static). Single `npm start` runs both API and serves the built SPA.

## License

Proprietary — Desktop Kitchen
