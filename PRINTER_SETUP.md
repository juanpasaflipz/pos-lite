# Kitchen Printer Setup — GHIA GTP801 + Didi/Rappi/Uber tickets

Goal: every take-out/delivery order (Didi, Rappi, soon Uber) prints a kitchen
ticket automatically on the GHIA GTP801, so the kitchen sees the order and the
ticket gets attached to the delivery bag.

## Architecture

```
Didi / Rappi / Uber
  │
  ├── (today, no API creds)  portal-watcher on Mac mini reads merchant portals
  │                          → POST /api/delivery/ingest
  └── (later, official APIs) platform webhooks → /api/delivery/webhook/*  [already built]
                                    │
                          pos-lite (Railway, Neon)
                          creates order → KDS tablet shows it
                          enqueues print_jobs (ESC/POS, rendered server-side)
                                    │  polled every 3s
                          print-bridge on Mac mini
                                    │  raw TCP 9100
                          GHIA GTP801 (Ethernet) 🖨
```

POS orders print through the same pipe (the existing "print ticket" action now
enqueues a physical job too).

## Deploy checklist (one time)

1. **Deploy the server** (from repo root):
   ```bash
   git add -A && git commit -m "printer pipeline" && git push origin master
   railway up --detach          # remember: push alone does NOT deploy
   ```
   Migration `0038_print_jobs` runs automatically on boot.

2. **Run the i18n patch** before building (adds the Print Bridge labels):
   ```bash
   node scripts/patch-i18n-print-bridge.mjs
   ```

3. **Printer**: Ethernet cable to the router, power on, print self-test page
   (hold FEED while powering on) → note the IP. Reserve that IP in the router.

4. **Mac mini** (the one that runs the POS):
   ```bash
   cd print-bridge
   node test-printer.js <PRINTER_IP>        # must print "PRUEBA DIRECTA"
   cp config.example.json config.json       # fill in URL, token, printer IP
   node bridge.js                           # run once in foreground to verify
   ./install-macos.sh                       # then install as auto-start service
   ```
   The agent token comes from the POS: **Admin → Impresoras → Puente de
   Impresión → Generar token** (shown once).

5. **Smoke test**: in the POS, Impresoras → *Impresión de prueba* → ticket
   should print in ~3 seconds. Then create a POS order and print it.

## Getting Didi/Rappi orders in (until official API access)

- `portal-watcher/` on the Mac mini scrapes the merchant portals and pushes
  orders through `/api/delivery/ingest` (same agent token). **The scraping
  selectors are scaffolded and must be tuned on-site** — see
  `portal-watcher/README.md`. Until that's tuned, keep using the platform
  tablets; every order the watcher ingests prints automatically and counts
  toward commission tracking.
- In parallel, apply for official integration credentials — the webhook
  handlers are already built and tested for signature verification:
  - **DiDi Food Open Platform** (open-platform application via DiDi Food MX
    merchant support)
  - **Rappi Developers** (dev-portal.rappi.com — "integraciones" for partners)
  - **Uber Eats Marketplace API** (when you onboard with Uber)
  Once credentials are saved in Admin → Credentials, point each platform's
  webhook to `https://<sub>.desktop.kitchen/api/delivery/webhook/<didi|rappi|uber-eats>`
  and the watcher can be retired.

## What was added (code map)

| Piece | Where |
|---|---|
| `print_jobs` queue table (+RLS) | `server/db/migrations/0038_print_jobs.js`, `pg-schema.sql` |
| ESC/POS renderer (80mm, CP850 accents) | `server/lib/escpos.js` |
| Enqueue helper | `server/lib/printQueue.js` |
| Agent auth (X-Agent-Token) | `server/middleware/agentAuth.js` |
| Claim/ack/test/token/status API | `server/routes/print-jobs.js` (mounted `/api/print-jobs`) |
| Auto-print on Didi/Rappi/Uber webhook orders | `server/routes/delivery.js` |
| Generic ingest for portal watcher | `POST /api/delivery/ingest` in `server/routes/delivery.js` |
| POS print → physical job | `server/routes/printers.js` |
| Bridge UI (token, status, test print) | `src/screens/PrinterManagement.tsx`, `src/api/index.ts` |
| On-site print agent | `print-bridge/` |
| Portal watcher scaffold | `portal-watcher/` |

## Ops notes

- Bridge offline? Tickets queue server-side and print when it reconnects
  (jobs retry 3× then park as `error`, visible in Impresoras).
- Rotating the agent token disconnects bridge + watcher until their
  config.json is updated.
- Printer IP changed? Update `print-bridge/config.json` and restart
  (`launchctl unload/load` — see print-bridge/README.md).
