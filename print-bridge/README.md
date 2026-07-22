# Print Bridge

Runs on the restaurant's Mac mini. Polls the pos-lite cloud server for queued
kitchen tickets and prints them on the local thermal printer (GHIA or any
Epson-ESC/POS-compatible printer) — over Ethernet (raw TCP 9100) or over
**USB** through a raw CUPS queue.

```
Didi/Rappi/Uber → pos-lite (Railway) → print_jobs queue
                                            ↑ poll every 3s
                              Mac mini (bridge.js) ─┬→ Ethernet: 192.168.x.x:9100
                                                    └→ USB: cola CUPS raw (lp -o raw)
```

Zero npm dependencies. Needs Node 18+.

## 1-USB. Printer hardware setup (USB thermal, e.g. GHIA)

1. Connect the printer to the Mac by **USB** and power it on with paper loaded.
2. Create a raw CUPS queue (one-time):

   ```bash
   ./setup-usb-macos.sh            # creates queue "termica"
   ```

   The script finds the USB printer and creates a pass-through queue using a
   minimal PPD (`raw-passthrough.ppd`) whose filter line disables all
   filtering — recent macOS removed `-m raw` queues, so this is the supported
   route to byte-exact ESC/POS output. macOS may warn that PPD drivers are
   deprecated — it still works.
3. Verify hardware (no server needed):

   ```bash
   node test-printer.js usb:termica
   ```

   If a "PRUEBA DIRECTA" ticket prints, the printer + queue are good.
4. In `config.json` use `"default": "usb:termica"` and continue at step 3
   (Configure the bridge) below.

> If the USB cable is unplugged, macOS pauses the queue and jobs error out.
> Re-plug and run `cupsenable termica`. "Probar conexión" in the POS surfaces
> this state ("queue is paused").

## 1-Ethernet. Printer hardware setup (GHIA GTP801, network)

1. Connect the printer to the router/switch with an **Ethernet cable** (the
   USB cable is not needed for this setup).
2. Power it on with paper loaded.
3. Print the **self-test page**: turn the printer off, hold the FEED button,
   turn it on while holding FEED, release after ~2 seconds. The page shows the
   printer's current **IP address**.
4. Ideally give it a **fixed IP**: in the router's admin page, add a DHCP
   reservation for the printer's MAC address (also on the self-test page).
   If the IP changes later, tickets stop printing until config.json is updated.

## 2. Verify the printer works (no server needed)

From this folder on the Mac mini:

```bash
node test-printer.js 192.168.1.200     # use the IP from the self-test page
```

If a "PRUEBA DIRECTA" ticket prints, hardware + network are good.

## 3. Configure the bridge

```bash
cp config.example.json config.json
```

Edit `config.json`:

- `server_url` — the tenant URL, e.g. `https://mirestaurante.desktop.kitchen`
- `agent_token` — generate it in the POS: **Admin → Impresoras → Print Bridge →
  Generar token**. It is shown once; paste it here.
- `printers.default` — `usb:termica` for USB (the CUPS queue from
  `setup-usb-macos.sh`), or the printer's IP for Ethernet, e.g.
  `192.168.1.200:9100`

Run it manually first to confirm:

```bash
node bridge.js
```

Then in the POS press **Impresión de prueba** — a test ticket should print
within ~3 seconds.

## 4. Install as a service (starts at login, auto-restarts)

```bash
./install-macos.sh
```

Logs: `tail -f ~/Library/Logs/print-bridge/bridge.log`

> Note: LaunchAgents run when the user is logged in. Set the Mac mini to
> auto-login and to never sleep (System Settings → Energy) so printing
> survives reboots/power cuts.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `test-printer.js` times out | Wrong IP, printer off, or different network/VLAN. Re-print self-test page. |
| USB: `lp exited 1` / queue not found | Run `./setup-usb-macos.sh`; check `lpstat -p`. |
| USB: job "sent" but nothing prints | Queue paused (unplugged cable pauses it): `cupsenable termica`. Stuck jobs: `cancel -a termica`. |
| Bridge logs `HTTP 401` | Token wrong/rotated. Generate a new token in the POS and update config.json. |
| Tickets queue but don't print | Is the bridge running? `launchctl list \| grep print-bridge`; check logs. |
| Accents print as `?` | The printer isn't honoring CP850 — tell the dev, we can switch codepage per printer. |
| Duplicated tickets | Job retried after a slow print. Check `last_error` in Admin → print jobs. |

## Connectivity check (Probar conexión)

The POS (Impresoras → **Probar conexión**) enqueues a `ping` job. The bridge
answers it by opening a TCP socket to the printer and closing it — nothing
prints. Result shows in the POS within a few seconds (claim poll + socket
timeout). Requires this bridge version or newer; older bridges report
"unsupported payload format" — update `bridge.js` and restart the agent.
