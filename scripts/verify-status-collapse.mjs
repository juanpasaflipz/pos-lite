#!/usr/bin/env node
/**
 * Smoke-tests the KDS status-collapse change (commit 3c313c3):
 *   - Backend now allows pending → ready directly (was rejected pre-fix)
 *   - KDS endpoint still returns the order with status='pending'
 *
 * Steps:
 *   1. POST /api/orders                       → fresh test order, status='pending'
 *   2. GET  /api/orders/kitchen/active        → order appears
 *   3. PUT  /api/orders/:id/status {ready}    → MUST succeed (was 400 pre-fix)
 *   4. GET  /api/orders/:id                   → status='ready', ready_at set
 *   5. DELETE /api/orders/:id                 → cleanup
 *
 * Usage:
 *   BASE_URL=https://juanbertos.desktop.kitchen \
 *   AUTH_TOKEN=ey... \
 *   EMPLOYEE_ID=1094 \
 *   MENU_ITEM_ID=8421 \
 *   X_TENANT_ID=juanbertos \
 *   node scripts/verify-status-collapse.mjs
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
  console.log('Step 1: create order (status should be pending)');
  const create = await call('POST', '/api/orders', {
    employee_id: EMPLOYEE_ID,
    items: [{ menu_item_id: MENU_ITEM_ID, quantity: 1 }],
    offline_temp_id: `status-collapse-${Date.now()}`,
  });
  if (create.status !== 201) fail(`create returned ${create.status}: ${JSON.stringify(create.body)}`);
  const orderId = create.body.id;
  console.log(`  order id=${orderId} number=${create.body.order_number}`);

  console.log('Step 2: KDS poll — order must appear');
  const poll = await call('GET', '/api/orders/kitchen/active');
  if (poll.status !== 200) fail(`kitchen/active returned ${poll.status}`);
  const found = Array.isArray(poll.body) ? poll.body.find((o) => o.id === orderId) : null;
  if (!found) fail(`order ${orderId} not in kitchen/active response`);
  if (found.status !== 'pending') fail(`expected status=pending, got ${found.status}`);
  console.log(`  found status=${found.status}`);

  console.log('Step 3: pending → ready DIRECTLY (was rejected pre-fix)');
  const transition = await call('PUT', `/api/orders/${orderId}/status`, { status: 'ready' });
  if (transition.status !== 200) {
    fail(`pending → ready returned ${transition.status}: ${JSON.stringify(transition.body)} — collapse fix not live?`);
  }
  console.log(`  accepted: ${JSON.stringify(transition.body)}`);

  console.log('Step 4: verify order is now ready with ready_at stamped');
  const refetch = await call('GET', `/api/orders/${orderId}`);
  if (refetch.status !== 200) fail(`order refetch returned ${refetch.status}`);
  if (refetch.body.status !== 'ready') fail(`expected status=ready, got ${refetch.body.status}`);
  if (!refetch.body.ready_at) fail(`ready_at not set after transition`);
  console.log(`  ready_at=${refetch.body.ready_at}`);

  console.log('Step 5: cleanup');
  const del = await call('DELETE', `/api/orders/${orderId}`);
  if (del.status !== 200) fail(`delete returned ${del.status}`);

  console.log('\nPASS: pending → ready direct transition is live on prod');
  process.exit(0);
})().catch((err) => {
  console.error('Script crashed:', err);
  process.exit(2);
});
