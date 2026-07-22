#!/usr/bin/env node
/**
 * pos-lite print bridge — runs on-site (Mac mini) next to the thermal printer.
 *
 * Polls the cloud server for queued print jobs and sends the raw ESC/POS
 * bytes to the printer — over the LAN (raw TCP, port 9100) or over USB
 * through a raw CUPS queue (macOS/Linux).
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
 *     "default": "192.168.1.200:9100"        // network printer (raw TCP 9100)
 *     // "default": "usb:termica"            // USB printer via raw CUPS queue (see setup-usb-macos.sh)
 *     // "2": "192.168.1.201:9100"           // optional: printer_id → address overrides
 *   }
 * }
 */

import net from 'node:net';
import { execFile, spawn } from 'node:child_process';
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

// ==================== Printer transport ====================
//
// Two address schemes:
//   "192.168.1.200:9100"  → raw TCP to a network printer
//   "usb:QUEUE" / "cups:QUEUE" → pipe bytes through `lp -o raw` to a local
//                                CUPS queue (USB printers on macOS/Linux)

function isCupsAddress(addr) {
  return /^(usb|cups):/i.test(String(addr));
}

function cupsQueue(addr) {
  return String(addr).replace(/^(usb|cups):/i, '').trim();
}

function parseAddress(addr) {
  const [host, port] = String(addr).split(':');
  return { host, port: Number(port) || 9100 };
}

/**
 * Send raw bytes to a local CUPS queue (`lp -d <queue> -o raw`). The queue
 * must be a RAW queue (created by setup-usb-macos.sh) so CUPS passes the
 * ESC/POS bytes through untouched.
 */
function sendToCups(queue, buffer) {
  return new Promise((resolve, reject) => {
    const lp = spawn('lp', ['-d', queue, '-o', 'raw', '-s'], { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      lp.kill();
      reject(err);
    };

    const timer = setTimeout(() => fail(new Error(`CUPS queue "${queue}" timed out`)), 15_000);
    lp.stderr.on('data', (d) => { stderr += d; });
    lp.once('error', (err) => fail(new Error(`lp not available: ${err.message}`)));
    lp.once('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code === 0) resolve();
      else reject(new Error(`CUPS queue "${queue}": lp exited ${code}${stderr ? ` — ${stderr.trim().slice(0, 200)}` : ''}`));
    });

    lp.stdin.on('error', () => {}); // EPIPE if lp dies first; close handler reports it
    lp.stdin.end(buffer);
  });
}

/**
 * Connectivity check for a CUPS queue: the queue must exist and be enabled
 * (not paused). Catches "printer unplugged → CUPS paused the queue".
 */
function pingCups(queue) {
  return new Promise((resolve, reject) => {
    execFile('lpstat', ['-p', queue], { timeout: 5_000 }, (err, stdout) => {
      if (err) {
        return reject(new Error(`CUPS queue "${queue}" not found — run setup-usb-macos.sh (${String(err.message).split('\n')[0].slice(0, 120)})`));
      }
      const out = String(stdout).toLowerCase();
      if (out.includes('disabled') || out.includes('deshabilitad')) {
        return reject(new Error(`CUPS queue "${queue}" is paused — check the USB cable/power, then run: cupsenable ${queue}`));
      }
      resolve();
    });
  });
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

/**
 * Connectivity check: open a TCP socket to the printer and close it without
 * sending anything. Port 9100 accepting a connection = printer is on the LAN
 * and listening. Resolves on connect; rejects on refusal/timeout.
 */
function pingPrinter(address) {
  const { host, port } = parseAddress(address);
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      err ? reject(err) : resolve();
    };
    socket.setTimeout(5_000, () => finish(new Error(`Printer ${host}:${port} timed out`)));
    socket.once('error', (err) => finish(new Error(`Printer ${host}:${port}: ${err.message}`)));
    socket.connect(port, host, () => finish());
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
  const address = cfg.printers[String(job.printer_id)] || cfg.printers.default;

  // Connectivity check requested from the POS (Impresoras → Probar):
  // TCP connect only, nothing sent, nothing printed.
  if (payload?.format === 'ping' || job.job_type === 'ping') {
    if (isCupsAddress(address)) await pingCups(cupsQueue(address));
    else await pingPrinter(address);
    console.log(`[bridge] ✓ ping ok → ${address}`);
    return;
  }

  if (!payload?.data || payload.format !== 'escpos') {
    throw new Error(`Job ${job.id}: unsupported payload format`);
  }
  const bytes = Buffer.from(payload.data, 'base64');

  if (isCupsAddress(address)) await sendToCups(cupsQueue(address), bytes);
  else await sendToPrinter(address, bytes);
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
