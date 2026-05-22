#!/usr/bin/env node
/**
 * Verifies the KDS audit trail end-to-end:
 *   1. POST /api/orders         → create a fresh test order
 *   2. GET  /api/orders/kitchen/active (first poll) → stamps first_kds_seen_at
 *   3. Assert the order appears in the response and first_kds_seen_at != null
 *   4. GET  /api/orders/kitchen/active (second poll) → timestamp must NOT change
 *   5. DELETE /api/orders/:id   → cleanup
 *
 * Usage:
 *   BASE_URL=https://juanbertos.desktop.kitchen \
 *   AUTH_TOKEN=ey... \
 *   EMPLOYEE_ID=1094 \
 *   MENU_ITEM_ID=8421 \
 *   X_TENANT_ID=juanbertos \
 *   node scripts/verify-kds-seen.mjs
 */

const BASE_URL = process.env.BASE_URL || 'http://localhost:3001';
const AUTH_TOKEN = process.env.AUTH_TOKEN;
const EMPLOYEE_ID = Number(process.env.EMPLOYEE_ID);
const MENU_ITEM_ID = Number(process.env.MENU_ITEM_ID);
const X_TENANT_ID = process.env.X_TENANT_ID;

if (!AUTH_TOKEN || !EMPLOYEE_ID || !MENU_ITEM_ID) {
  console.error('Missing required env: AUTH_TOKEN, EMPLOYEE_ID, MENU_ITEM_ID');
  process.exit(1);
}

const headers = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${AUTH_TOKEN}`,
  ...(X_TENANT_ID ? { 'X-Tenant-ID': X_TENANT_ID } : {}),
};

async function call(method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

(async () => {
  console.log('Step 1: create order');
  const create = await call('POST', '/api/orders', {
    employee_id: EMPLOYEE_ID,
    items: [{ menu_item_id: MENU_ITEM_ID, quantity: 1 }],
    offline_temp_id: `kds-verify-${Date.now()}`,
  });
  if (create.status !== 201) fail(`create returned ${create.status}: ${JSON.stringify(create.body)}`);
  const orderId = create.body.id;
  console.log(`  order id=${orderId} number=${create.body.order_number}`);

  console.log('Step 2: first KDS poll (should stamp first_kds_seen_at)');
  const poll1 = await call('GET', '/api/orders/kitchen/active');
  if (poll1.status !== 200) fail(`kitchen/active returned ${poll1.status}`);
  const found1 = Array.isArray(poll1.body) ? poll1.body.find((o) => o.id === orderId) : null;
  if (!found1) fail(`order ${orderId} not in kitchen/active response`);
  if (!found1.first_kds_seen_at) fail(`first_kds_seen_at is null after first poll`);
  const stamp1 = found1.first_kds_seen_at;
  console.log(`  stamped at ${stamp1}`);

  console.log('Step 3: second KDS poll (timestamp must NOT change — proves idempotent)');
  await new Promise((r) => setTimeout(r, 1500));
  const poll2 = await call('GET', '/api/orders/kitchen/active');
  const found2 = Array.isArray(poll2.body) ? poll2.body.find((o) => o.id === orderId) : null;
  if (!found2) fail(`order ${orderId} disappeared from second poll`);
  if (found2.first_kds_seen_at !== stamp1) {
    fail(`first_kds_seen_at changed between polls: ${stamp1} -> ${found2.first_kds_seen_at}`);
  }
  console.log(`  unchanged: ${found2.first_kds_seen_at}`);

  console.log('Step 4: cleanup');
  const del = await call('DELETE', `/api/orders/${orderId}`);
  if (del.status !== 200) fail(`delete returned ${del.status}`);

  console.log('\nPASS: KDS audit trail end-to-end works');
  process.exit(0);
})().catch((err) => {
  console.error('Script crashed:', err);
  process.exit(2);
});
