#!/usr/bin/env node
/**
 * Portal watcher — scrapes Didi/Rappi merchant portals for new orders and
 * pushes them into pos-lite (POST /api/delivery/ingest).
 *
 * See README.md. Selectors in selectors.js are a SCAFFOLD and must be tuned
 * on-site against the live portals.
 *
 * Usage:
 *   node watcher.js --login    # first run: log in to the portals manually
 *   node watcher.js            # normal watching mode
 *   node watcher.js --debug    # also dump portal HTML to ./debug/ for selector tuning
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { PLATFORMS } from './selectors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(__dirname, 'config.json');
const profileDir = path.join(__dirname, 'profile');
const debugDir = path.join(__dirname, 'debug');

const LOGIN_MODE = process.argv.includes('--login');
const DEBUG = process.argv.includes('--debug');

// ==================== Config ====================

if (!fs.existsSync(configPath)) {
  console.error('[watcher] config.json not found — copy config.example.json and fill it in.');
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
for (const key of ['server_url', 'agent_token']) {
  if (!cfg[key]) {
    console.error(`[watcher] Missing "${key}" in config.json`);
    process.exit(1);
  }
}
cfg.poll_ms = Math.max(Number(cfg.poll_ms) || 20_000, 5_000);
cfg.server_url = cfg.server_url.replace(/\/+$/, '');
const enabledPlatforms = (cfg.platforms || Object.keys(PLATFORMS)).filter((p) => PLATFORMS[p]);

// ==================== Ingest ====================

const seen = new Set(); // external ids already pushed this session (server also dedups)

async function ingest(platform, order) {
  const res = await fetch(`${cfg.server_url}/api/delivery/ingest`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Agent-Token': cfg.agent_token,
    },
    body: JSON.stringify({ platform, ...order, raw: { scraped_at: new Date().toISOString() } }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}

// ==================== Main ====================

(async () => {
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: !LOGIN_MODE, // headful for login so captchas can be solved
    viewport: { width: 1400, height: 900 },
  });

  const pages = {};
  for (const name of enabledPlatforms) {
    const page = await context.newPage();
    await page.goto(PLATFORMS[name].url, { waitUntil: 'domcontentloaded' }).catch((e) =>
      console.error(`[watcher] ${name}: failed to open portal: ${e.message}`)
    );
    pages[name] = page;
  }

  if (LOGIN_MODE) {
    console.log('[watcher] LOGIN MODE — log in to each portal in the opened browser.');
    console.log('[watcher] When done, close the browser window. Sessions persist in ./profile');
    await new Promise((resolve) => context.on('close', resolve));
    process.exit(0);
  }

  if (DEBUG) fs.mkdirSync(debugDir, { recursive: true });
  console.log(`[watcher] watching: ${enabledPlatforms.join(', ')} — every ${cfg.poll_ms / 1000}s`);

  async function poll() {
    for (const name of enabledPlatforms) {
      const page = pages[name];
      try {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
        await page.waitForTimeout(3_000); // let SPA render

        if (DEBUG) {
          fs.writeFileSync(path.join(debugDir, `${name}.html`), await page.content());
        }

        const orders = await PLATFORMS[name].extractOrders(page);
        for (const order of orders) {
          const key = `${name}:${order.external_order_id}`;
          if (seen.has(key)) continue;
          try {
            const result = await ingest(name, order);
            seen.add(key);
            if (result.duplicate) continue;
            console.log(`[watcher] ✓ ${name} order ${order.external_order_id} → POS order ${result.order_number} (ticket queued)`);
          } catch (err) {
            console.error(`[watcher] ✗ ingest failed for ${key}: ${err.message}`);
          }
        }
      } catch (err) {
        console.error(`[watcher] ${name}: poll error: ${err.message}`);
      }
    }
    setTimeout(poll, cfg.poll_ms);
  }

  poll();
})();
