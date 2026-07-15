# Portal Watcher (scaffold — needs on-site tuning)

Reads the **DiDi Food** and **Rappi** merchant web portals in a real browser on
the Mac mini, detects new orders, and pushes them into pos-lite via
`POST /api/delivery/ingest` — which creates the internal order, tracks the
commission, feeds the KDS, **and prints the kitchen ticket** through the print
bridge.

This exists because the restaurant does not (yet) have official Didi/Rappi API
credentials. Once integration credentials are approved, the webhooks in
`server/routes/delivery.js` take over and this watcher can be retired.

```
Didi/Rappi merchant portal (browser, logged in)
        ↓ scrape new orders (Playwright)
watcher.js → POST /api/delivery/ingest (X-Agent-Token)
        ↓
pos-lite order + delivery_order + print job → GHIA printer
```

## Status: SCAFFOLD

`selectors.js` contains **placeholder selectors** — the portals' real DOM must
be inspected while logged in at the restaurant. The framework (login session
persistence, polling, dedup, ingest, error handling) is done; only the
`extractOrders()` functions need tuning against the live portals.

## Setup

```bash
cd portal-watcher
npm install            # installs playwright
npx playwright install chromium
cp config.example.json config.json   # fill in server_url + agent_token (same token as print bridge)
```

First run — log in manually once (sessions persist in `./profile`):

```bash
node watcher.js --login
```

A browser opens with tabs for each portal. Log in to Didi/Rappi, solve any
captchas, then close the browser. After that:

```bash
node watcher.js
```

## Tuning the selectors

Run `node watcher.js --debug` — it dumps each portal's order-list HTML to
`./debug/` every poll so the selectors in `selectors.js` can be written against
the real markup. Update `extractOrders()` per platform until orders parse.

## Caveats

- Portals change their DOM without notice — expect occasional re-tuning.
- Keep the platform tablets as backup until this has run reliably for a while.
- The watcher only *reads*; accepting orders still happens on the platform
  tablet/portal as today.
