#!/usr/bin/env node
/**
 * pos-lite print bridge — runs on-site (Mac mini) next to the thermal printer.
 *
 * Polls the cloud server for queued print jobs and sends the raw ESC/POS
 * bytes to the printer over the LAN (raw TCP, port 9100).
 *
 * Zero dependencies. Requires Node 18+ (built-in fetch).
 *
 * Usage:
 *   node bridge.js [path/to/config.json]     (default: ./config.json)
 *
 * Config (config.json):
 * {
 *   "server_url": "https://mirestaurante.desktop.kitchen",
 *   "agent_token": "pb_xxxxxxxx...",         // generate in POS → Printers → Print Bridge
 *   "agent_id": "macmini-cocina",
 *   "poll_ms": 3000,
 *   "printers": {
 *     "default": "192.168.1.200:9100"        // GHIA GTP801 Ethernet IP
 *     // "2": "192.168.1.201:9100"           // optional: printer_id → address overrides
 *   }
 * }
 */

import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = process.argv[2] || path.join(__dirname, 'config.json');

// ==================== Config ====================

function loadConfig() {
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch {
    console.error(`[bridge] Config not found: ${configPath}`);
    console.error('[bridge] Copy config.example.json to config.json and fill it in.');
    process.exit(1);
  }
  const cfg = JSON.parse(raw);
  for (const key of ['server_url', 'agent_token', 'printers']) {
    if (!cfg[key]) {
      console.error(`[bridge] Missing "${key}" in config.json`);
      process.exit(1);
    }
  }
  if (!cfg.printers.default) {
    console.error('[bridge] config.printers must include a "default" printer address');
    process.exit(1);
  }
  cfg.agent_id = cfg.agent_id || 'print-bridge';
  cfg.poll_ms = Math.max(Number(cfg.poll_ms) || 3000, 1000);
  cfg.server_url = cfg.server_url.replace(/\/+$/, '');
  return cfg;
}

const cfg = loadConfig();

// ==================== Printer transport (raw TCP 9100) ====================

function parseAddress(addr) {
  const [host, port] = String(addr).split(':');
  return { host, port: Number(port) || 9100 };
}

/**
 * Send raw bytes to the printer. Resolves when the socket has flushed
 * and closed; rejects on connect error or timeout.
 */
function sendToPrinter(address, buffer) {
  const { host, port } = parseAddress(address);
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(err);
    };

    socket.setTimeout(10_000, () => fail(new Error(`Printer ${host}:${port} timed out`)));
    socket.once('error', (err) => fail(new Error(`Printer ${host}:${port}: ${err.message}`)));

    socket.connect(port, host, () => {
      socket.end(buffer, () => {
        // Give the printer a beat to swallow the buffer before the socket closes fully
        setTimeout(() => {
          if (!settled) {
            settled = true;
            resolve();
          }
        }, 300);
      });
    });
  });
}

// ==================== Server API ====================

async function api(pathname, body) {
  const res = await fetch(`${cfg.server_url}/api/print-jobs${pathname}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Agent-Token': cfg.agent_token,
    },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${pathname}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// ==================== Main loop ====================

let consecutiveErrors = 0;
let printedTotal = 0;
let lastHeartbeat = 0;

async function processJob(job) {
  const payload = typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload;
  if (!payload?.data || payload.format !== 'escpos') {
    throw new Error(`Job ${job.id}: unsupported payload format`);
  }
  const bytes = Buffer.from(payload.data, 'base64');
  const address = cfg.printers[String(job.printer_id)] || cfg.printers.default;

  await sendToPrinter(address, bytes);
  printedTotal++;
  console.log(`[bridge] ✓ printed job ${job.id} (${job.source || job.job_type}) → ${address}`);
}

async function tick() {
  try {
    const { jobs } = await api('/claim', { agent_id: cfg.agent_id, max: 5 });
    consecutiveErrors = 0;

    for (const job of jobs || []) {
      try {
        await processJob(job);
        await api(`/${job.id}/result`, { ok: true });
      } catch (err) {
        console.error(`[bridge] ✗ job ${job.id} failed: ${err.message}`);
        await api(`/${job.id}/result`, { ok: false, error: err.message }).catch(() => {});
      }
    }
  } catch (err) {
    consecutiveErrors++;
    // Log the first few errors, then throttle to avoid flooding the log
    if (consecutiveErrors <= 3 || consecutiveErrors % 20 === 0) {
      console.error(`[bridge] poll error (${consecutiveErrors}x): ${err.message}`);
    }
  }

  // Heartbeat log every 5 minutes so the logfile shows liveness
  if (Date.now() - lastHeartbeat > 300_000) {
    lastHeartbeat = Date.now();
    console.log(`[bridge] alive — ${printedTotal} job(s) printed since start, polling ${cfg.server_url}`);
  }

  // Back off up to 30s when the server is unreachable
  const delay = consecutiveErrors > 0
    ? Math.min(cfg.poll_ms * consecutiveErrors, 30_000)
    : cfg.poll_ms;
  setTimeout(tick, delay);
}

console.log(`[bridge] starting — server: ${cfg.server_url}, agent: ${cfg.agent_id}`);
console.log(`[bridge] printers: ${JSON.stringify(cfg.printers)}`);
tick();
