#!/usr/bin/env node
/**
 * Concurrent order creation smoke test.
 *
 * Fires N parallel POST /api/orders requests, then asserts:
 *   - All requests returned 2xx
 *   - Every order_number is unique (counter table didn't race)
 *   - When --offline-temp-id is repeated, the server dedups to one order
 *
 * Usage:
 *   BASE_URL=http://localhost:3001 \
 *   AUTH_TOKEN=ey... \
 *   EMPLOYEE_ID=1 \
 *   MENU_ITEM_ID=1 \
 *   X_TENANT_ID=demo \
 *   node scripts/load-test-orders.mjs [N=50]
 *
 *   Add --dedup to fire all requests with the same offline_temp_id
 *   and assert the server returns one canonical order.
 */

const BASE_URL = process.env.BASE_URL || 'http://localhost:3001';
const AUTH_TOKEN = process.env.AUTH_TOKEN;
const EMPLOYEE_ID = Number(process.env.EMPLOYEE_ID);
const MENU_ITEM_ID = Number(process.env.MENU_ITEM_ID);
const X_TENANT_ID = process.env.X_TENANT_ID;
const N = Number(process.argv.find((a) => /^\d+$/.test(a)) || 50);
const DEDUP = process.argv.includes('--dedup');

if (!AUTH_TOKEN || !EMPLOYEE_ID || !MENU_ITEM_ID) {
  console.error('Missing required env: AUTH_TOKEN, EMPLOYEE_ID, MENU_ITEM_ID');
  process.exit(1);
}

const sharedTempId = DEDUP ? `loadtest-${Date.now()}-${Math.random().toString(36).slice(2, 10)}` : null;

function makeBody(i) {
  return {
    employee_id: EMPLOYEE_ID,
    items: [{ menu_item_id: MENU_ITEM_ID, quantity: 1 }],
    offline_temp_id: DEDUP ? sharedTempId : `loadtest-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 8)}`,
  };
}

async function fire(i) {
  const t0 = Date.now();
  const res = await fetch(`${BASE_URL}/api/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${AUTH_TOKEN}`,
      ...(X_TENANT_ID ? { 'X-Tenant-ID': X_TENANT_ID } : {}),
    },
    body: JSON.stringify(makeBody(i)),
  });
  const latency = Date.now() - t0;
  let body;
  try { body = await res.json(); } catch { body = null; }
  return { i, ok: res.ok, status: res.status, latency, body };
}

(async () => {
  console.log(`Firing ${N} concurrent POST /api/orders${DEDUP ? ' (same offline_temp_id)' : ''}...`);
  const t0 = Date.now();
  const results = await Promise.all(Array.from({ length: N }, (_, i) => fire(i)));
  const totalMs = Date.now() - t0;

  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  const latencies = results.map((r) => r.latency).sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.5)];
  const p95 = latencies[Math.floor(latencies.length * 0.95)];
  const p99 = latencies[Math.floor(latencies.length * 0.99)];

  console.log(`\nResults: ${ok.length}/${N} ok in ${totalMs}ms`);
  console.log(`Latency p50=${p50}ms p95=${p95}ms p99=${p99}ms`);

  if (failed.length > 0) {
    console.log(`\nFailures:`);
    for (const f of failed.slice(0, 10)) {
      console.log(`  #${f.i} [${f.status}] ${JSON.stringify(f.body)}`);
    }
  }

  const orderNumbers = ok.map((r) => r.body?.order_number).filter(Boolean);
  const orderIds = ok.map((r) => r.body?.id).filter(Boolean);
  const uniqueNumbers = new Set(orderNumbers);
  const uniqueIds = new Set(orderIds);

  console.log(`\nUnique order_numbers: ${uniqueNumbers.size}/${orderNumbers.length}`);
  console.log(`Unique order ids:     ${uniqueIds.size}/${orderIds.length}`);

  let exit = 0;

  if (DEDUP) {
    if (uniqueIds.size !== 1) {
      console.error(`FAIL: offline_temp_id dedup returned ${uniqueIds.size} distinct orders (expected 1)`);
      exit = 1;
    } else {
      console.log(`PASS: dedup collapsed ${N} requests to 1 order`);
    }
  } else {
    if (uniqueNumbers.size !== orderNumbers.length) {
      console.error(`FAIL: duplicate order_numbers detected`);
      const counts = orderNumbers.reduce((m, n) => (m[n] = (m[n] || 0) + 1, m), {});
      console.error('Dupes:', Object.entries(counts).filter(([, c]) => c > 1));
      exit = 1;
    } else {
      console.log(`PASS: all order_numbers unique`);
    }
    if (failed.length > 0) {
      console.error(`FAIL: ${failed.length} requests errored`);
      exit = 1;
    }
  }

  process.exit(exit);
})().catch((err) => {
  console.error('Smoke test crashed:', err);
  process.exit(2);
});
